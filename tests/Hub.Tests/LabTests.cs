using System.ComponentModel.DataAnnotations;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Hub.Application;
using Hub.Domain;
using Hub.Infrastructure;
using Integration.Shared;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Hub.Tests;

/// <summary>Mapping rules shared by executions and the Mapping Studio preview.</summary>
public class CustomerMappingTests
{
    [Fact]
    public void Customer_mapping_normalizes_every_field()
    {
        var mapped = Mapping.Transform(new Customer(" c-300 ", "  Bluefin   Fictional  Outfitters ")
            { Email = " Buyer@Bluefin.Example ", Phone = "+1 (555) 010-0300", Status = "OnHold" });
        Assert.Equal(new ErpCustomer("C-300", "Bluefin Fictional Outfitters", "buyer@bluefin.example", "+15550100300", "BLOCKED"), mapped);
    }
    [Theory]
    [InlineData("Active", "ACTIVE")]
    [InlineData("Inactive", "INACTIVE")]
    [InlineData("OnHold", "BLOCKED")]
    public void Status_lookup(string crm, string erp) =>
        Assert.Equal(erp, Mapping.Transform(new Customer("C-1", "A") { Email = "a@b.example", Status = crm }).AccountStatus);
    [Fact]
    public void Missing_email_and_unknown_status_are_reported_per_field_without_values()
    {
        var (mapped, errors) = Mapping.TryTransform(new Customer("C-400", "Quarry") { Email = null, Status = "Archived", Phone = "12" });
        Assert.Null(mapped);
        Assert.Equal(["email", "phone", "status"], errors.Select(e => e.Field).ToArray());
        Assert.All(errors, e => Assert.DoesNotContain("Archived", e.Message)); // messages name fields, never source values
        Assert.Throws<ValidationException>(() => Mapping.Transform(new Customer("C-400", "Quarry")));
    }
    [Fact]
    public void Order_errors_name_the_field()
    {
        var (_, errors) = Mapping.TryTransform(new CrmOrder("ORD-014", "C-100", "JPY", 5000m));
        Assert.Equal("currency", Assert.Single(errors).Field);
        Assert.Contains("JPY", errors[0].Message);
    }
    [Fact]
    public void Mapping_catalog_matches_contract_fields()
    {
        Assert.Equal(["customerId", "customerName", "email", "phone", "status"], MappingCatalog.Customer.Select(f => f.SourceField));
        Assert.Equal(["accountCode", "displayName", "emailAddress", "contactNumber", "accountStatus"], MappingCatalog.Customer.Select(f => f.TargetField));
        Assert.Equal(["externalOrderId", "accountCode", "currencyCode", "totalMinorUnits"], MappingCatalog.SalesOrder.Select(f => f.TargetField));
        // The CRM JSON contract uses the same names the catalog documents.
        var json = JsonSerializer.Serialize(new Customer("C-1", "A"), JsonSerializerOptions.Web);
        Assert.Contains("\"customerId\"", json); Assert.Contains("\"customerName\"", json);
    }
    [Theory]
    [InlineData("UnknownAccount", "MissingCustomer")]
    [InlineData("AccountBlocked", "TargetRejected")]
    [InlineData(null, "TargetRejected")]
    public void Target_business_rejections_are_permanent(string? code, string classification)
    {
        var failure = FailurePolicy.Classify(422, code, "C-300");
        Assert.Equal(classification, failure.Classification);
        Assert.False(failure.Transient);
        if (code is not null) Assert.Contains("C-300", failure.Guidance);
    }
}

/// <summary>Runner behaviour for SCN-001/003 customer sync and SCN-002 target rejections.</summary>
public class CustomerSyncRunnerTests : IAsyncLifetime
{
    private readonly SqliteConnection connection = new("Data Source=:memory:");
    private HubDb NewDb() => new(new DbContextOptionsBuilder<HubDb>().UseSqlite(connection).Options);
    public async Task InitializeAsync() { await connection.OpenAsync(); await using var db = NewDb(); await HubDb.InitializeAsync(db); }
    public async Task DisposeAsync() => await connection.DisposeAsync();
    private async Task<string> Queue(string kind, string sourceId)
    {
        await using var db = NewDb();
        var e = new Execution { Kind = kind, SourceId = sourceId, OrderId = kind == Kinds.SalesOrder ? sourceId : $"CUSTOMER:{sourceId}:{Guid.NewGuid():N}", Status = "Running" };
        db.Executions.Add(e); await db.SaveChangesAsync(); return e.Id;
    }
    private async Task<Execution> Run(string id, FakeClients fake)
    {
        await using (var db = NewDb())
        {
            var e = await db.Executions.SingleAsync(x => x.Id == id);
            e.Status = "Running";
            await new IntegrationRunner(db, fake, NullLogger<IntegrationRunner>.Instance).ProcessAsync(e, default);
        }
        await using var read = NewDb();
        return await read.Executions.AsNoTracking().Include(x => x.Logs.OrderBy(l => l.Id)).SingleAsync(x => x.Id == id);
    }

    [Fact]
    public async Task Customer_sync_maps_delivers_with_version_and_execution_id_and_records_outcome()
    {
        var id = await Queue(Kinds.CustomerSync, "C-300");
        var fake = new FakeClients();
        var e = await Run(id, fake);
        Assert.Equal("Completed", e.Status);
        Assert.Equal(2, e.SourceVersion);
        Assert.Equal("SYNC-000001", e.ReceiptId);
        var put = Assert.Single(fake.CustomerPuts);
        Assert.Equal("2", put.SourceVersion);
        Assert.Equal(id, put.ExecutionId);
        var sent = JsonSerializer.Deserialize<ErpCustomer>(put.Body, JsonSerializerOptions.Web)!;
        Assert.Equal(new ErpCustomer("C-300", "Bluefin Fictional Outfitters", "buyer@bluefin.example", "5550300", "ACTIVE"), sent);
        Assert.Contains("\"customerId\":\"C-300\"", e.SourcePayload);
        Assert.Equal(["Started", "Retrieved", "Mapped", "Completed"], e.Logs.Select(l => l.Stage));
        Assert.Contains("created customer C-300 from source version 2", e.Logs[^1].Message);
    }
    [Fact]
    public async Task Missing_required_email_fails_validation_before_the_ERP_is_called()
    {
        var id = await Queue(Kinds.CustomerSync, "C-400");
        var fake = new FakeClients { Customer = new Customer("C-400", "Quarry Lane") { Email = null } };
        var e = await Run(id, fake);
        Assert.Equal("Failed", e.Status);
        Assert.Equal("Validation", e.ErrorClass);
        Assert.Contains("Email is required", e.Troubleshooting);
        Assert.Equal(0, fake.ErpCalls);
        Assert.Null(e.MappedPayload);
    }
    [Fact]
    public async Task Retry_reuses_frozen_customer_mapping_and_version_even_if_CRM_changed()
    {
        var id = await Queue(Kinds.CustomerSync, "C-300");
        var fake = new FakeClients { FailStatus = 503, Failures = 1 };
        var first = await Run(id, fake);
        Assert.Equal("Retrying", first.Status);
        fake.Customer = fake.Customer with { Email = "changed@bluefin.example", Version = 3 };
        var second = await Run(id, fake);
        Assert.Equal("Completed", second.Status);
        Assert.Equal(fake.CustomerPuts[0].Body, fake.CustomerPuts[1].Body);
        Assert.All(fake.CustomerPuts, p => Assert.Equal("2", p.SourceVersion));
        Assert.Contains(second.Logs, l => l.Stage == "Mapped" && l.Message.Contains("CRM is now at version 3"));
    }
    [Theory]
    [InlineData("Unchanged", "identical data")]
    [InlineData("SkippedStale", "newer source version 9")]
    [InlineData("Updated", "updated C-300 from source version 2: emailAddress")]
    public async Task Upsert_outcomes_are_explained_in_the_audit_trail(string outcome, string expected)
    {
        var id = await Queue(Kinds.CustomerSync, "C-300");
        var e = await Run(id, new FakeClients { CustomerOutcome = outcome });
        Assert.Equal("Completed", e.Status);
        Assert.Contains(expected, e.Logs[^1].Message);
    }
    [Fact]
    public async Task Order_for_unknown_ERP_account_fails_as_MissingCustomer_with_prerequisite_guidance()
    {
        var id = await Queue(Kinds.SalesOrder, "ORD-013");
        var e = await Run(id, new FakeClients { RejectOrderCode = "UnknownAccount" });
        Assert.Equal("Failed", e.Status);
        Assert.Equal("MissingCustomer", e.ErrorClass);
        Assert.Contains("SCN-001", e.Troubleshooting);
        Assert.Equal(1, e.Attempts); // permanent: no automatic retry
        Assert.NotNull(e.MappedPayload); // frozen for the later safe retry
    }
    [Fact]
    public async Task Frozen_v1_PascalCase_order_payload_is_still_reused_on_retry()
    {
        var id = await Queue(Kinds.SalesOrder, "ORD-001");
        await using (var db = NewDb())
            await db.Executions.Where(x => x.Id == id).ExecuteUpdateAsync(s => s.SetProperty(x => x.MappedPayload,
                "{\"ExternalOrderId\":\"ORD-001\",\"AccountCode\":\"C-100\",\"CurrencyCode\":\"USD\",\"TotalMinorUnits\":12550}"));
        var fake = new FakeClients { Amount = 999m }; // CRM changed since the original mapping
        var e = await Run(id, fake);
        Assert.Equal("Completed", e.Status);
        var sent = JsonSerializer.Deserialize<ErpOrder>(Assert.Single(fake.Payloads), JsonSerializerOptions.Web)!;
        Assert.Equal(12550, sent.TotalMinorUnits);
    }
    [Fact]
    public async Task Only_one_active_sync_per_customer_is_allowed()
    {
        await using var db = NewDb();
        db.Executions.Add(new Execution { Kind = Kinds.CustomerSync, SourceId = "C-300", OrderId = "CUSTOMER:C-300:a", Status = "Pending" });
        await db.SaveChangesAsync();
        db.Executions.Add(new Execution { Kind = Kinds.CustomerSync, SourceId = "C-300", OrderId = "CUSTOMER:C-300:b", Status = "Pending" });
        await Assert.ThrowsAsync<DbUpdateException>(() => db.SaveChangesAsync());
        db.ChangeTracker.Clear();
        // Finished syncs do not block a new one.
        await db.Executions.Where(x => x.OrderId == "CUSTOMER:C-300:a").ExecuteUpdateAsync(s => s.SetProperty(x => x.Status, "Completed"));
        db.Executions.Add(new Execution { Kind = Kinds.CustomerSync, SourceId = "C-300", OrderId = "CUSTOMER:C-300:c", Status = "Pending" });
        await db.SaveChangesAsync();
    }
}

/// <summary>EnsureCreated never alters an existing database; these prove the additive upgrades keep v1 data.</summary>
public class SchemaUpgradeTests
{
    private static async Task<SqliteConnection> Open(string ddl)
    {
        var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = ddl;
        await command.ExecuteNonQueryAsync();
        return connection;
    }
    [Fact]
    public async Task Hub_v1_database_is_upgraded_in_place()
    {
        await using var connection = await Open("""
            CREATE TABLE "Executions" ("Id" TEXT NOT NULL CONSTRAINT "PK_Executions" PRIMARY KEY, "OrderId" TEXT NOT NULL, "Status" TEXT NOT NULL,
              "Environment" TEXT NOT NULL, "Scenario" TEXT NOT NULL, "Target" TEXT NOT NULL, "FailuresBeforeSuccess" INTEGER NOT NULL,
              "Attempts" INTEGER NOT NULL, "RetryCount" INTEGER NOT NULL, "CreatedAt" TEXT NOT NULL, "StartedAt" TEXT NULL, "EndedAt" TEXT NULL,
              "AvailableAt" TEXT NOT NULL, "DurationMs" REAL NULL, "ErrorClass" TEXT NULL, "Troubleshooting" TEXT NULL, "ReceiptId" TEXT NULL, "MappedPayload" TEXT NULL);
            CREATE TABLE "Jobs" ("Id" TEXT NOT NULL CONSTRAINT "PK_Jobs" PRIMARY KEY, "Name" TEXT NOT NULL, "Environment" TEXT NOT NULL, "Status" TEXT NOT NULL,
              "StartedAt" TEXT NOT NULL, "EndedAt" TEXT NOT NULL, "Details" TEXT NOT NULL);
            CREATE TABLE "Logs" ("Id" INTEGER NOT NULL CONSTRAINT "PK_Logs" PRIMARY KEY AUTOINCREMENT, "ExecutionId" TEXT NOT NULL, "Timestamp" TEXT NOT NULL,
              "Stage" TEXT NOT NULL, "Level" TEXT NOT NULL, "Message" TEXT NOT NULL, "Attempt" INTEGER NOT NULL,
              CONSTRAINT "FK_Logs_Executions_ExecutionId" FOREIGN KEY ("ExecutionId") REFERENCES "Executions" ("Id") ON DELETE CASCADE);
            CREATE UNIQUE INDEX "IX_Executions_OrderId" ON "Executions" ("OrderId");
            INSERT INTO "Executions" VALUES ('e1','ORD-001','Completed','DEV','None','ERP',1,1,0,'2026-11-17 08:00:00','2026-11-17 08:00:00','2026-11-17 08:00:01','2026-11-17 08:00:00',100,NULL,NULL,'r1','{}');
            INSERT INTO "Logs" ("ExecutionId","Timestamp","Stage","Level","Message","Attempt") VALUES ('e1','2026-11-17 08:00:00','Queued','Information','v1 log',0);
            """);
        await using var db = new HubDb(new DbContextOptionsBuilder<HubDb>().UseSqlite(connection).Options);
        await HubDb.InitializeAsync(db);
        await HubDb.InitializeAsync(db); // idempotent
        var e = await db.Executions.Include(x => x.Logs).SingleAsync();
        Assert.Equal((Kinds.SalesOrder, "ORD-001", "r1"), (e.Kind, e.SourceId, e.ReceiptId));
        Assert.Equal("v1 log", Assert.Single(e.Logs).Message);
        db.Executions.Add(new Execution { Kind = Kinds.CustomerSync, SourceId = "C-1", OrderId = "CUSTOMER:C-1:x", Status = "Pending" });
        await db.SaveChangesAsync();
        db.Executions.Add(new Execution { Kind = Kinds.CustomerSync, SourceId = "C-1", OrderId = "CUSTOMER:C-1:y", Status = "Running" });
        await Assert.ThrowsAsync<DbUpdateException>(() => db.SaveChangesAsync()); // partial index created by the upgrade
    }
    [Fact]
    public async Task CRM_v1_database_keeps_rows_backfills_seed_contacts_and_adds_new_seed_records()
    {
        await using var connection = await Open("""
            CREATE TABLE "Customers" ("Id" TEXT NOT NULL CONSTRAINT "PK_Customers" PRIMARY KEY, "Name" TEXT NOT NULL);
            CREATE TABLE "Orders" ("Id" TEXT NOT NULL CONSTRAINT "PK_Orders" PRIMARY KEY, "CustomerId" TEXT NOT NULL, "Currency" TEXT NOT NULL, "Amount" TEXT NOT NULL,
              CONSTRAINT "FK_Orders_Customers_CustomerId" FOREIGN KEY ("CustomerId") REFERENCES "Customers" ("Id") ON DELETE CASCADE);
            INSERT INTO "Customers" VALUES ('C-100','Northstar Demo Labs'),('C-200','Harborlight Fictional Supply');
            INSERT INTO "Orders" VALUES ('ORD-001','C-200','USD','999.99');
            """);
        await using var db = new MockCrm.CrmDb(new DbContextOptionsBuilder<MockCrm.CrmDb>().UseSqlite(connection).Options);
        await MockCrm.CrmDb.InitializeAsync(db);
        await MockCrm.CrmDb.InitializeAsync(db);
        var c100 = await db.Customers.SingleAsync(x => x.Id == "C-100");
        Assert.Equal(("ap@northstar-demo.example", "Active", 1), (c100.Email, c100.Status, c100.Version));
        Assert.Equal(999.99m, (await db.Orders.SingleAsync(x => x.Id == "ORD-001")).Amount); // existing data untouched
        Assert.Equal(15, await db.Orders.CountAsync());
        Assert.Equal(5, await db.Customers.CountAsync());
        Assert.Equal(5, await db.Revisions.CountAsync()); // one baseline revision per customer, not duplicated
        Assert.Null((await db.Customers.SingleAsync(x => x.Id == "C-400")).Email);
    }
    [Fact]
    public async Task ERP_v1_database_keeps_receipts_and_gains_customer_master()
    {
        await using var connection = await Open("""
            CREATE TABLE "Accepted" ("ExternalOrderId" TEXT NOT NULL CONSTRAINT "PK_Accepted" PRIMARY KEY, "Fingerprint" TEXT NOT NULL, "ReceiptId" TEXT NOT NULL, "AcceptedAt" TEXT NOT NULL);
            INSERT INTO "Accepted" VALUES ('ORD-001','ABC','receipt-v1','2026-11-17 08:00:00');
            """);
        await using var db = new MockErp.ErpDb(new DbContextOptionsBuilder<MockErp.ErpDb>().UseSqlite(connection).Options);
        await MockErp.ErpDb.InitializeAsync(db);
        await MockErp.ErpDb.InitializeAsync(db);
        var order = await db.Accepted.SingleAsync();
        Assert.Equal(("receipt-v1", (long?)null), (order.ReceiptId, order.TotalMinorUnits));
        Assert.Equal(["C-100", "C-200"], await db.Customers.OrderBy(x => x.AccountCode).Select(x => x.AccountCode).ToArrayAsync());
        Assert.All(await db.Customers.ToListAsync(), c => Assert.Equal("Fixture", c.Origin));
        Assert.Equal(2, await db.History.CountAsync(h => h.Action == "FixtureSeeded"));
    }
}

/// <summary>Legacy CRM and Modern ERP APIs against real SQLite.</summary>
public class LabMockApiTests
{
    private static HttpClient Keyed<T>(DemoFactory<T> factory) where T : class
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Service-Key", DemoFactory<T>.ServiceKey);
        return client;
    }
    [Fact]
    public async Task CRM_customer_create_update_versions_and_revisions()
    {
        using var factory = new DemoFactory<MockCrm.Program>();
        using var client = Keyed(factory);
        var input = new CustomerInput("C-600", "Lantern Demo Co", "ops@lantern.example", "+1 555 0600", "Active");
        Assert.Equal(HttpStatusCode.Created, (await client.PostAsJsonAsync("/api/customers", input)).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsJsonAsync("/api/customers", input)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/customers", input with { Id = "C-601", Email = "not-an-email" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/customers", input with { Id = "C-602", Status = "Archived" })).StatusCode);
        var same = await (await client.PutAsJsonAsync("/api/customers/C-600", input)).Content.ReadFromJsonAsync<Customer>();
        Assert.Equal(1, same!.Version); // no change, no new version
        var updated = await (await client.PutAsJsonAsync("/api/customers/C-600", input with { Email = "billing@lantern.example" })).Content.ReadFromJsonAsync<Customer>();
        Assert.Equal(2, updated!.Version);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PutAsJsonAsync("/api/customers/C-600", input with { Id = "C-999" })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.PutAsJsonAsync("/api/customers/C-998", input with { Id = "C-998" })).StatusCode);
        var revisions = (await client.GetFromJsonAsync<CustomerRevision[]>("/api/customers/C-600/revisions"))!;
        Assert.Equal([2, 1], revisions.Select(r => r.Version));
        Assert.Contains("billing@lantern.example", revisions[0].Snapshot);
        var raw = await client.GetStringAsync("/api/customers/C-600");
        Assert.Contains("\"customerId\":\"C-600\"", raw);
    }
    [Fact]
    public async Task ERP_customer_upsert_policy_and_history()
    {
        using var factory = new DemoFactory<MockErp.Program>();
        using var client = Keyed(factory);
        async Task<CustomerSyncResult> Put(ErpCustomer c, int version, string exec)
        {
            using var request = new HttpRequestMessage(HttpMethod.Put, "/api/customers/" + c.AccountCode) { Content = JsonContent.Create(c) };
            request.Headers.Add("X-Source-Version", version.ToString()); request.Headers.Add("X-Execution-Id", exec);
            var response = await client.SendAsync(request);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            return (await response.Content.ReadFromJsonAsync<CustomerSyncResult>())!;
        }
        var v1 = new ErpCustomer("C-300", "Bluefin", "buyer@bluefin.example", null, "ACTIVE");
        Assert.Equal("Created", (await Put(v1, 1, "exec-1")).Outcome);
        Assert.Equal("Unchanged", (await Put(v1, 1, "exec-2")).Outcome);
        var v3 = v1 with { EmailAddress = "new@bluefin.example", ContactNumber = "5550300" };
        var updated = await Put(v3, 3, "exec-3");
        Assert.Equal(("Updated", (int?)3), (updated.Outcome, updated.AppliedVersion));
        Assert.Equal(["emailAddress", "contactNumber"], updated.ChangedFields);
        var stale = await Put(v1 with { DisplayName = "Old name" }, 2, "exec-4");
        Assert.Equal(("SkippedStale", (int?)3), (stale.Outcome, stale.AppliedVersion));
        var detail = await client.GetFromJsonAsync<JsonElement>("/api/customers/C-300");
        Assert.Equal("new@bluefin.example", detail.GetProperty("customer").GetProperty("emailAddress").GetString());
        Assert.Equal("exec-3", detail.GetProperty("customer").GetProperty("lastExecutionId").GetString());
        Assert.Equal(["SkippedStale", "Updated", "Unchanged", "Created"],
            detail.GetProperty("history").EnumerateArray().Select(h => h.GetProperty("action").GetString()!).ToArray());
        Assert.Equal(1, (await client.GetFromJsonAsync<JsonElement[]>("/api/customers"))!.Count(c => c.GetProperty("accountCode").GetString() == "C-300"));
        // Global import history (ERP Import History screen): newest first across accounts, bounded by take.
        var all = (await client.GetFromJsonAsync<JsonElement[]>("/api/history"))!;
        Assert.Equal("SkippedStale", all[0].GetProperty("action").GetString());
        Assert.Contains(all, h => h.GetProperty("action").GetString() == "FixtureSeeded");
        Assert.Equal(2, (await client.GetFromJsonAsync<JsonElement[]>("/api/history?take=2"))!.Length);
        Assert.Single((await client.GetFromJsonAsync<JsonElement[]>("/api/history?take=0"))!);
    }
    [Fact]
    public async Task ERP_stores_mapped_orders_and_enforces_account_rules()
    {
        using var factory = new DemoFactory<MockErp.Program>();
        using var client = Keyed(factory);
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/orders") { Content = JsonContent.Create(new ErpOrder("ORD-001", "C-100", "USD", 12550)) };
        request.Headers.Add("X-Execution-Id", "exec-9");
        Assert.Equal(HttpStatusCode.Created, (await client.SendAsync(request)).StatusCode);
        var stored = await client.GetFromJsonAsync<JsonElement>("/api/orders/ORD-001");
        Assert.Equal(12550, stored.GetProperty("totalMinorUnits").GetInt64());
        Assert.Equal(("C-100", "USD", "exec-9"), (stored.GetProperty("accountCode").GetString(), stored.GetProperty("currencyCode").GetString(), stored.GetProperty("executionId").GetString()));
        var unknown = await client.PostAsJsonAsync("/api/orders", new ErpOrder("ORD-013", "C-300", "USD", 41025));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, unknown.StatusCode);
        Assert.Equal("UnknownAccount", (await unknown.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
        using (var block = new HttpRequestMessage(HttpMethod.Put, "/api/customers/C-500") { Content = JsonContent.Create(new ErpCustomer("C-500", "Cinderpeak", "f@c.example", null, "BLOCKED")) })
            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(block)).StatusCode);
        var blocked = await client.PostAsJsonAsync("/api/orders", new ErpOrder("ORD-015", "C-500", "EUR", 9990));
        Assert.Equal("AccountBlocked", (await blocked.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/orders/ORD-013")).StatusCode);
    }
    [Fact]
    public async Task Only_fixture_records_can_be_edited_by_hand_and_edits_are_audited()
    {
        using var factory = new DemoFactory<MockErp.Program>();
        using var client = Keyed(factory);
        using var edit = new HttpRequestMessage(HttpMethod.Put, "/api/fixtures/customers/C-100")
            { Content = JsonContent.Create(new ErpCustomer("C-100", "Northstar Demo Labs (fixture)", "ap@northstar-demo.example", null, "ACTIVE")) };
        edit.Headers.Add("X-Actor", "operator");
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(edit)).StatusCode);
        var history = (await client.GetFromJsonAsync<JsonElement>("/api/customers/C-100")).GetProperty("history")[0];
        Assert.Equal(("FixtureEdit", "operator"), (history.GetProperty("action").GetString(), history.GetProperty("actor").GetString()));
        // An import takes ownership; afterwards manual edits are refused.
        await client.PutAsJsonAsync("/api/customers/C-100", new ErpCustomer("C-100", "Northstar Demo Labs", "ap@northstar-demo.example", null, "ACTIVE"));
        var refused = await client.PutAsJsonAsync("/api/fixtures/customers/C-100", new ErpCustomer("C-100", "Hand edit", "ap@northstar-demo.example", null, "ACTIVE"));
        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
        Assert.Equal("NotAFixture", (await refused.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
    }
}

/// <summary>Middleware API for the lab: permissions, customer-sync queueing and side-effect-free preview.</summary>
public class LabHubApiTests
{
    private static async Task<HttpClient> Login(DemoFactory<Hub.Program> factory, string user = "operator")
    {
        var client = factory.CreateClient();
        var auth = await (await client.PostAsJsonAsync("/api/auth/login", new { username = user, password = DemoFactory<Hub.Program>.Password }))
            .Content.ReadFromJsonAsync<JsonElement>();
        client.DefaultRequestHeaders.Authorization = new("Bearer", auth.GetProperty("token").GetString());
        return client;
    }
    [Fact]
    public async Task Customer_sync_queueing_rules()
    {
        using var factory = new DemoFactory<Hub.Program>();
        using var client = await Login(factory);
        var first = await client.PostAsJsonAsync("/api/executions", new { kind = "CustomerSync", sourceId = "C-300" });
        Assert.Equal(HttpStatusCode.Accepted, first.StatusCode);
        var firstId = (await first.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString();
        var second = await client.PostAsJsonAsync("/api/executions", new { kind = "CustomerSync", sourceId = "C-300" });
        Assert.Equal(HttpStatusCode.Conflict, second.StatusCode);
        Assert.Equal(firstId, (await second.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("executionId").GetString());
        Assert.Equal(HttpStatusCode.Accepted, (await client.PostAsJsonAsync("/api/executions", new { kind = "CustomerSync", sourceId = "C-400" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/executions", new { kind = "CustomerSync", sourceId = "C-500", scenario = "Duplicate", target = "ERP" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/executions", new { kind = "Unknown", sourceId = "C-500" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/executions", new { kind = "CustomerSync", sourceId = "../x" })).StatusCode);
        var detail = await client.GetFromJsonAsync<JsonElement>("/api/executions/" + firstId);
        Assert.Equal(("CustomerSync", "C-300"), (detail.GetProperty("kind").GetString(), detail.GetProperty("sourceId").GetString()));
        Assert.Contains("Customer sync for C-300 queued by operator (Operator)", detail.GetProperty("logs")[0].GetProperty("message").GetString());
        var page = await client.GetFromJsonAsync<JsonElement>("/api/executions?search=C-300");
        Assert.Equal(1, page.GetProperty("total").GetInt32());
        // v1 contract still works for orders.
        Assert.Equal(HttpStatusCode.Accepted, (await client.PostAsJsonAsync("/api/executions", new { orderId = "ORD-013" })).StatusCode);
    }
    [Fact]
    public async Task Viewer_cannot_change_source_or_target_data()
    {
        using var factory = new DemoFactory<Hub.Program>();
        using var client = await Login(factory, "viewer");
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync("/api/source/customers", new CustomerInput("C-700", "X Co", null, null, "Active"))).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PutAsJsonAsync("/api/source/customers/C-300", new CustomerInput("C-300", "X Co", null, null, "Active"))).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync("/api/source/orders", new CrmOrder("ORD-700", "C-100", "USD", 1))).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PutAsJsonAsync("/api/target/fixtures/customers/C-100", new ErpCustomer("C-100", "X", "x@y.example", null, "ACTIVE"))).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync("/api/executions", new { kind = "CustomerSync", sourceId = "C-300" })).StatusCode);
        using var anonymous = factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/source/customers")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.PostAsJsonAsync("/api/mappings/customer/preview", new { source = new { customerId = "C-1" } })).StatusCode);
    }
    [Fact]
    public async Task Mapping_preview_has_no_side_effects()
    {
        var fake = new FakeClients();
        using var factory = new DemoFactory<Hub.Program> { ConfigureServices = s => s.AddSingleton<IHttpClientFactory>(fake) };
        using var client = await Login(factory, "viewer");
        var spec = await client.GetFromJsonAsync<JsonElement>("/api/mappings");
        Assert.Equal(5, spec.GetProperty("customer").GetProperty("fields").GetArrayLength());
        var inline = await client.PostAsJsonAsync("/api/mappings/customer/preview",
            new { source = new { customerId = "C-900", customerName = " Preview  Co ", email = "A@B.example", phone = "555-0900", status = "OnHold" } });
        var result = await inline.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(result.GetProperty("valid").GetBoolean());
        Assert.Equal("BLOCKED", result.GetProperty("output").GetProperty("accountStatus").GetString());
        Assert.Equal("Preview Co", result.GetProperty("output").GetProperty("displayName").GetString());
        var invalid = await (await client.PostAsJsonAsync("/api/mappings/sales-order/preview",
            new { source = new { id = "ORD-1", customerId = "C-100", currency = "JPY", amount = 10 } })).Content.ReadFromJsonAsync<JsonElement>();
        Assert.False(invalid.GetProperty("valid").GetBoolean());
        Assert.Equal("currency", invalid.GetProperty("errors")[0].GetProperty("field").GetString());
        // By ID: reads the CRM, never the ERP.
        var byId = await (await client.PostAsJsonAsync("/api/mappings/customer/preview", new { sourceId = "C-300" })).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("buyer@bluefin.example", byId.GetProperty("output").GetProperty("emailAddress").GetString());
        Assert.Equal(1, fake.CrmCalls);
        Assert.Equal(0, fake.ErpCalls);
        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsJsonAsync("/api/mappings/invoice/preview", new { sourceId = "X" })).StatusCode);
        using var scope = factory.Services.CreateScope();
        Assert.Equal(0, await scope.ServiceProvider.GetRequiredService<HubDb>().Executions.CountAsync());
    }
}
