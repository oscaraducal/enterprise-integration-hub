using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Hub.Application;
using Hub.Infrastructure;
using Integration.Shared;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Hub.Tests;

/// <summary>Identifier, type and record validation of the Dynamic Data Catalog (pure functions).</summary>
public class CatalogRuleTests
{
    private static TableInput Table(params ColumnDef[] columns) => new("vendor_accounts", "Vendor accounts", null, "vendorId", [.. columns]);
    private static readonly ColumnDef[] Vendor =
    [
        new("vendorId", "string", true), new("vendorName", "string", true), new("rating", "integer"), new("creditLimit", "decimal"),
        new("preferred", "boolean"), new("since", "date"), new("reviewedAt", "datetime"), new("tier", "enum", true, ["Gold", "Silver"])
    ];

    [Fact]
    public void Valid_table_passes() => Assert.Empty(CatalogRules.ValidateTable(Table(Vendor), ["customers"]));

    [Theory]
    [InlineData("Vendor")]          // uppercase
    [InlineData("1vendor")]         // starts with digit
    [InlineData("v")]               // too short
    [InlineData("drop table x;--")] // never SQL
    [InlineData("customers")]       // reserved built-in
    public void Invalid_or_reserved_names_are_rejected(string name) =>
        Assert.Contains("name", CatalogRules.ValidateTable(Table(Vendor) with { Name = name }, ["customers"]).Keys);

    [Fact]
    public void Primary_key_types_duplicates_and_enums_are_checked()
    {
        Assert.Contains("primaryKey", CatalogRules.ValidateTable(Table(Vendor) with { PrimaryKey = "missing" }, []).Keys);
        Assert.Contains("primaryKey", CatalogRules.ValidateTable(Table(new ColumnDef("vendorId", "string")) , []).Keys); // optional key
        Assert.Contains("primaryKey", CatalogRules.ValidateTable(Table(new ColumnDef("vendorId", "boolean", true)), []).Keys);
        Assert.Contains("columns", CatalogRules.ValidateTable(Table([.. Vendor, new("VENDORNAME", "string")]), []).Keys);
        Assert.NotEmpty(CatalogRules.ValidateColumn(new("tier", "enum")));
        Assert.NotEmpty(CatalogRules.ValidateColumn(new("blob", "binary")));
        Assert.NotEmpty(CatalogRules.ValidateColumn(new("x", "string", ReadOnly: true)));
        Assert.NotEmpty(CatalogRules.ValidateColumn(new("bad name", "string")));
    }

    [Fact]
    public void Records_are_type_checked_and_canonicalized()
    {
        var good = JsonDocument.Parse("""
            { "vendorId": "V-1", "vendorName": "Acme Demo", "rating": 4, "creditLimit": 1500.50, "preferred": true,
              "since": "2024-02-29", "reviewedAt": "2026-01-02T03:04:05+08:00", "tier": "Gold" }
            """).RootElement;
        var (data, key, errors) = CatalogRules.ValidateRecord(Vendor, "vendorId", good);
        Assert.Empty(errors);
        Assert.Equal("V-1", key);
        Assert.Equal("2026-01-01T19:04:05Z", data!["reviewedAt"]!.GetValue<string>()); // normalized to UTC
        var bad = JsonDocument.Parse("""
            { "vendorId": "V-2", "rating": 4.5, "creditLimit": "lots", "preferred": "yes", "since": "29/02/2024",
              "reviewedAt": "soon", "tier": "Bronze", "extra": 1 }
            """).RootElement;
        var (_, _, problems) = CatalogRules.ValidateRecord(Vendor, "vendorId", bad);
        Assert.Equal(["creditLimit", "extra", "preferred", "rating", "reviewedAt", "since", "tier", "vendorName"], problems.Keys.Order().ToArray());
        var (_, _, keyError) = CatalogRules.ValidateRecord(Vendor, "vendorId",
            JsonDocument.Parse("""{ "vendorId": "../etc", "vendorName": "x", "tier": "Gold" }""").RootElement);
        Assert.Contains("vendorId", keyError.Keys);
    }
}

/// <summary>Catalog API of the fictional applications: CRUD, approved schema operations and data protection.</summary>
public class CatalogApiTests
{
    private static HttpClient Keyed<T>(DemoFactory<T> factory) where T : class
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Service-Key", DemoFactory<T>.ServiceKey);
        return client;
    }
    private static readonly TableInput Contacts = new("crm_contacts", "Contacts", "People at customer accounts", "contactId",
        [new("contactId", "string", true), new("fullName", "string", true), new("email", "string"),
         new("role", "enum", true, ["Buyer", "Finance"]), new("age", "integer")]);

    [Fact]
    public async Task Tables_records_and_schema_versions_through_the_CRM_catalog()
    {
        using var factory = new DemoFactory<MockCrm.Program>();
        using var client = Keyed(factory);
        var tables = await client.GetFromJsonAsync<JsonElement[]>("/api/catalog/tables");
        Assert.Equal(["customers", "sales_orders"], tables!.Select(t => t.GetProperty("name").GetString()));
        Assert.True(tables![0].GetProperty("builtIn").GetBoolean());
        Assert.Equal(5, tables[0].GetProperty("recordCount").GetInt32()); // seeded customers are visible, not copied

        Assert.Equal(HttpStatusCode.Created, (await client.PostAsJsonAsync("/api/catalog/tables", Contacts)).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsJsonAsync("/api/catalog/tables", Contacts)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/catalog/tables", Contacts with { Name = "customers" })).StatusCode);

        // Records: validated, unique keys, immutable key, pagination and search.
        var records = "/api/catalog/tables/crm_contacts/records";
        for (var i = 1; i <= 7; i++)
            Assert.Equal(HttpStatusCode.Created, (await client.PostAsJsonAsync(records,
                new { contactId = $"P-{i}", fullName = $"Demo Person {i}", role = i % 2 == 0 ? "Finance" : "Buyer", email = i == 3 ? "p3@demo.example" : null })).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsJsonAsync(records, new { contactId = "P-1", fullName = "Dup", role = "Buyer" })).StatusCode);
        var invalid = await client.PostAsJsonAsync(records, new { contactId = "P-9", role = "Owner", age = "old" });
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        var problem = await invalid.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(problem.GetProperty("errors").TryGetProperty("fullName", out _));
        var page = await client.GetFromJsonAsync<JsonElement>(records + "?page=2&pageSize=5");
        Assert.Equal((7, 2, 2), (page.GetProperty("total").GetInt32(), page.GetProperty("page").GetInt32(), page.GetProperty("items").GetArrayLength()));
        Assert.Equal(1, (await client.GetFromJsonAsync<JsonElement>(records + "?search=p3@demo")).GetProperty("total").GetInt32());
        Assert.Equal(3, (await client.GetFromJsonAsync<JsonElement>(records + "?search=Finance")).GetProperty("total").GetInt32());
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PutAsJsonAsync(records + "/P-1", new { contactId = "P-100", fullName = "X", role = "Buyer" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync(records + "/P-1", new { contactId = "P-1", fullName = "Renamed", role = "Finance", age = 40 })).StatusCode);
        Assert.Equal(40, (await client.GetFromJsonAsync<JsonElement>(records + "/P-1")).GetProperty("data").GetProperty("age").GetInt32());

        // Approved schema operations protect existing records.
        async Task<HttpResponseMessage> Change(object body) => await client.PostAsJsonAsync("/api/catalog/tables/crm_contacts/schema", body);
        Assert.Equal(HttpStatusCode.Conflict, (await Change(new { operation = "AddColumn", column = new { name = "region", type = "string", required = true } })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await Change(new { operation = "AddColumn", column = new { name = "region", type = "string" } })).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await Change(new { operation = "SetRequired", columnName = "email", required = true })).StatusCode);
        var inUse = await Change(new { operation = "RemoveColumn", columnName = "age" });
        Assert.Equal(HttpStatusCode.Conflict, inUse.StatusCode);
        Assert.Equal("ColumnInUse", (await inUse.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
        Assert.Equal(HttpStatusCode.OK, (await Change(new { operation = "RemoveColumn", columnName = "region" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Change(new { operation = "RemoveColumn", columnName = "contactId" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await Change(new { operation = "AddEnumValues", columnName = "role", values = new[] { "Owner" } })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Change(new { operation = "ChangeType", columnName = "age" })).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await client.PostAsJsonAsync(records, new { contactId = "P-8", fullName = "Owner Person", role = "Owner" })).StatusCode);
        var detail = await client.GetFromJsonAsync<JsonElement>("/api/catalog/tables/crm_contacts");
        Assert.Equal(4, detail.GetProperty("table").GetProperty("version").GetInt32());
        Assert.Equal([4, 3, 2, 1], detail.GetProperty("versions").EnumerateArray().Select(v => v.GetProperty("version").GetInt32()));
        Assert.Equal(8, detail.GetProperty("table").GetProperty("recordCount").GetInt32());

        // Generated contract.
        var contract = await client.GetFromJsonAsync<JsonElement>("/api/catalog/tables/crm_contacts/contract");
        Assert.Equal(5, contract.GetProperty("endpoints").GetArrayLength());
        Assert.Equal(["contactId", "fullName", "role"], contract.GetProperty("schema").GetProperty("required").EnumerateArray().Select(x => x.GetString()));

        // Tables with data are never dropped; built-in tables cannot be changed through the catalog.
        Assert.Equal(HttpStatusCode.Conflict, (await client.DeleteAsync("/api/catalog/tables/crm_contacts")).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsJsonAsync("/api/catalog/tables/customers/schema", new { operation = "RemoveColumn", columnName = "email" })).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsJsonAsync("/api/catalog/tables/customers/records", new { customerId = "X" })).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await client.DeleteAsync("/api/catalog/tables/customers")).StatusCode);
        for (var i = 1; i <= 8; i++) Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync($"{records}/P-{i}")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync("/api/catalog/tables/crm_contacts")).StatusCode);
        // Existing CRM data is untouched by catalog activity.
        Assert.Equal(5, (await client.GetFromJsonAsync<JsonElement[]>("/api/customers"))!.Length);
        Assert.Equal(15, (await client.GetFromJsonAsync<JsonElement[]>("/api/orders"))!.Length);
    }

    [Fact]
    public async Task ERP_publishes_its_built_in_tables_and_requires_the_service_key()
    {
        using var factory = new DemoFactory<MockErp.Program>();
        using var client = Keyed(factory);
        var tables = await client.GetFromJsonAsync<JsonElement[]>("/api/catalog/tables");
        Assert.Equal(["customer_master", "imported_orders"], tables!.Select(t => t.GetProperty("name").GetString()));
        var master = tables![0].GetProperty("columns").EnumerateArray().ToArray();
        Assert.True(master.Single(c => c.GetProperty("name").GetString() == "origin").GetProperty("readOnly").GetBoolean());
        Assert.Equal(HttpStatusCode.Unauthorized, (await factory.CreateClient().GetAsync("/api/catalog/tables")).StatusCode);
    }

    [Fact]
    public async Task Record_limit_is_enforced()
    {
        using var factory = new DemoFactory<MockErp.Program>();
        using var client = Keyed(factory);
        await client.PostAsJsonAsync("/api/catalog/tables", new TableInput("erp_limits", "Limits", null, "id", [new("id", "integer", true)]));
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MockErp.ErpDb>();
            var now = DateTime.UtcNow;
            db.CatalogRecords.AddRange(Enumerable.Range(1, CatalogRules.MaxRecords).Select(i => new CatalogRecord
                { TableName = "erp_limits", RecordKey = i.ToString(), DataJson = $"{{\"id\":{i}}}", SchemaVersion = 1, CreatedAt = now, UpdatedAt = now }));
            await db.SaveChangesAsync();
        }
        var over = await client.PostAsJsonAsync("/api/catalog/tables/erp_limits/records", new { id = 9999 });
        Assert.Equal(HttpStatusCode.Conflict, over.StatusCode);
        Assert.Equal("RecordLimit", (await over.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
        Assert.Equal(100, (await client.GetFromJsonAsync<JsonElement>("/api/catalog/tables/erp_limits/records?pageSize=1000")).GetProperty("pageSize").GetInt32());
    }
}

/// <summary>Mapping suggestions, validation and side-effect-free preview over the built-in schemas.</summary>
public class SchemaMappingTests
{
    private static TableView Crm(string name) => MockCrm.Program.BuiltInTables.Single(t => t.Definition.Name == name).Definition;
    private static TableView Erp(string name) => MockErp.Program.BuiltInTables.Single(t => t.Definition.Name == name).Definition;
    private static Dictionary<string, Suggestion?> Suggested(TableView s, TableView t) =>
        SchemaMapping.Suggest(s, t).Fields.ToDictionary(f => f.Target, f => f.Suggestion);

    [Fact]
    public void Customer_suggestions_match_names_semantics_types_and_keys()
    {
        var s = Suggested(Crm("customers"), Erp("customer_master"));
        Assert.Equal(("customerId", "Uppercase"), (s["accountCode"]!.Source, s["accountCode"]!.Transform));
        Assert.Contains(s["accountCode"]!.Reasons, r => r.Contains("Primary key"));
        Assert.Equal(("customerName", "Trim"), (s["displayName"]!.Source, s["displayName"]!.Transform));
        Assert.Equal(("email", "Lowercase"), (s["emailAddress"]!.Source, s["emailAddress"]!.Transform));
        Assert.Equal("phone", s["contactNumber"]!.Source);
        var status = s["accountStatus"]!;
        Assert.Equal(("status", "Lookup"), (status.Source, status.Transform));
        Assert.Equal("ACTIVE", status.Lookup!["Active"]);
        Assert.Contains(status.Reasons, r => r.Contains("OnHold")); // unmatched value flagged for review
        Assert.DoesNotContain("origin", s.Keys); // read-only target columns are never suggested
    }

    [Fact]
    public void Order_suggestions_convert_major_to_minor_units()
    {
        var s = Suggested(Crm("sales_orders"), Erp("imported_orders"));
        Assert.Equal("id", s["externalOrderId"]!.Source);
        Assert.Equal("customerId", s["accountCode"]!.Source);
        Assert.Equal(("currency", "Uppercase"), (s["currencyCode"]!.Source, s["currencyCode"]!.Transform));
        Assert.Equal(("amount", "Multiply", 100m), (s["totalMinorUnits"]!.Source, s["totalMinorUnits"]!.Transform, s["totalMinorUnits"]!.Factor));
    }

    private static MappingDraft Draft(params FieldRule[] fields) =>
        new("Order import", null, new("crm", "sales_orders"), new("erp", "imported_orders"), [.. fields]);
    private static readonly FieldRule[] OrderRules =
    [
        new("externalOrderId", "Copy", "id"), new("accountCode", "Uppercase", "customerId"),
        new("currencyCode", "Uppercase", "currency"), new("totalMinorUnits", "Multiply", "amount", Factor: 100)
    ];

    [Fact]
    public void Validation_reports_missing_required_readonly_unknown_and_incompatible_rules()
    {
        Assert.True(SchemaMapping.Validate(Draft(OrderRules), Crm("sales_orders"), Erp("imported_orders")).Valid);
        var report = SchemaMapping.Validate(Draft(
            new("externalOrderId", "Copy", "id"), new("accountCode", "Script", "customerId"),
            new("totalMinorUnits", "Copy", "currency"), new("receiptId", "Copy", "id"), new("nope", "Copy", "id"),
            new("currencyCode", "Multiply", "amount", Factor: 0)),
            Crm("sales_orders"), Erp("imported_orders"));
        Assert.False(report.Valid);
        var fields = report.Errors.Select(e => e.Field).ToHashSet();
        Assert.Superset(new HashSet<string> { "accountCode", "totalMinorUnits", "receiptId", "nope", "currencyCode" }, fields);
        Assert.Contains(report.Errors, e => e.Field == "accountCode" && e.Message.Contains("not allowed"));
        Assert.Contains(report.Errors, e => e.Field == "receiptId" && e.Message.Contains("set by the target"));
        var lookup = SchemaMapping.Validate(new MappingDraft("Customers", null, new("crm", "customers"), new("erp", "customer_master"),
            [new("accountCode", "Copy", "customerId"), new("displayName", "Copy", "customerName"), new("emailAddress", "Copy", "email"),
             new("accountStatus", "Lookup", "status", Lookup: new() { ["Active"] = "ACTIVE", ["OnHold"] = "ONHOLD" })]),
            Crm("customers"), Erp("customer_master"));
        Assert.Contains(lookup.Errors, e => e.Field == "accountStatus" && e.Message.Contains("ONHOLD"));
        Assert.Contains(lookup.Warnings, w => w.Field == "accountStatus" && w.Message.Contains("Inactive"));
        Assert.Contains(lookup.Warnings, w => w.Field == "emailAddress"); // optional source → required target
    }

    [Fact]
    public void Preview_applies_allowlisted_transformations_only()
    {
        var sample = JsonNode.Parse("""{ "id": "ORD-013", "customerId": "c-300", "currency": "usd", "amount": 410.255 }""")!.AsObject();
        var (output, errors) = SchemaMapping.Apply(OrderRules, Erp("imported_orders").Columns, sample);
        Assert.Empty(errors);
        Assert.Equal(41026, output["totalMinorUnits"]!.GetValue<long>()); // 41025.5 rounds half away from zero
        Assert.Equal(("C-300", "USD"), (output["accountCode"]!.GetValue<string>(), output["currencyCode"]!.GetValue<string>()));
        ColumnDef[] target = [new("label", "string", true), new("day", "date"), new("half", "decimal"), new("tier", "enum", Values: ["GOLD"]), new("note", "string")];
        var record = JsonNode.Parse("""{ "first": " Ana ", "last": "Cruz", "at": "2026-03-04T23:30:00Z", "n": "9", "level": "g" }""")!.AsObject();
        var (o2, e2) = SchemaMapping.Apply([
            new("label", "Concatenate", Sources: ["first", "last"], Separator: " "), new("day", "FormatDate", "at", Format: "yyyy-MM-dd"),
            new("half", "Divide", "n", Factor: 2), new("tier", "Lookup", "level", Lookup: new() { ["g"] = "GOLD" }), new("note", "Default", Value: "synthetic")],
            target, record);
        Assert.Empty(e2);
        Assert.Equal(("Ana Cruz", "2026-03-04", 4.5m, "GOLD", "synthetic"),
            (o2["label"]!.GetValue<string>(), o2["day"]!.GetValue<string>(), o2["half"]!.GetValue<decimal>(), o2["tier"]!.GetValue<string>(), o2["note"]!.GetValue<string>()));
        var (_, e3) = SchemaMapping.Apply([new("tier", "Lookup", "level", Lookup: new() { ["x"] = "GOLD" })], target, record);
        Assert.Equal("tier", Assert.Single(e3).Field);
    }
}

/// <summary>Routes the hub's named HTTP clients to in-process CRM and ERP servers.</summary>
public sealed class InProcessClients(DemoFactory<MockCrm.Program> crm, DemoFactory<MockErp.Program> erp) : IHttpClientFactory
{
    public HttpClient CreateClient(string name)
    {
        var client = name == "CRM" ? crm.CreateClient() : erp.CreateClient();
        client.DefaultRequestHeaders.Add("X-Service-Key", name == "CRM" ? DemoFactory<MockCrm.Program>.ServiceKey : DemoFactory<MockErp.Program>.ServiceKey);
        return client;
    }
}

/// <summary>Middleware gateway, mapping designer and versioned definitions against real in-process CRM and ERP APIs.</summary>
public class CatalogGatewayTests
{
    private static async Task<HttpClient> Login(DemoFactory<Hub.Program> factory, string user)
    {
        var client = factory.CreateClient();
        var auth = await (await client.PostAsJsonAsync("/api/auth/login", new { username = user, password = DemoFactory<Hub.Program>.Password }))
            .Content.ReadFromJsonAsync<JsonElement>();
        client.DefaultRequestHeaders.Authorization = new("Bearer", auth.GetProperty("token").GetString());
        return client;
    }

    [Fact]
    public async Task Gateway_enforces_roles_and_mapping_definitions_are_versioned_without_side_effects()
    {
        using var crm = new DemoFactory<MockCrm.Program>();
        using var erp = new DemoFactory<MockErp.Program>();
        using var hub = new DemoFactory<Hub.Program> { ConfigureServices = s => s.AddSingleton<IHttpClientFactory>(new InProcessClients(crm, erp)) };
        using var viewer = await Login(hub, "viewer");
        using var operatorClient = await Login(hub, "operator");

        // Discovery for both roles; changes for Operators only; fixed system allowlist.
        Assert.Equal(2, (await viewer.GetFromJsonAsync<JsonElement[]>("/api/catalog/erp/tables"))!.Length);
        Assert.Equal(HttpStatusCode.NotFound, (await viewer.GetAsync("/api/catalog/payments/tables")).StatusCode);
        var vendors = new TableInput("erp_vendors", "Vendors", null, "vendorCode", [new("vendorCode", "string", true), new("vendorName", "string", true)]);
        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.PostAsJsonAsync("/api/catalog/erp/tables", vendors)).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await operatorClient.PostAsJsonAsync("/api/catalog/erp/tables", vendors)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.PostAsJsonAsync("/api/catalog/erp/tables/erp_vendors/records", new { vendorCode = "V1", vendorName = "X" })).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await operatorClient.PostAsJsonAsync("/api/catalog/erp/tables/erp_vendors/records", new { vendorCode = "V1", vendorName = "X" })).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await operatorClient.DeleteAsync("/api/catalog/erp/tables/erp_vendors/records/V1")).StatusCode);
        Assert.Equal(1, (await viewer.GetFromJsonAsync<JsonElement>("/api/catalog/erp/tables/erp_vendors/contract")).GetProperty("schema").GetProperty("properties").EnumerateObject().Count(p => p.Name == "vendorName"));

        // Suggestions are discovered from the live catalogs.
        var suggest = await viewer.PostAsJsonAsync("/api/mapping-designer/suggest", new { source = new { system = "crm", table = "sales_orders" }, target = new { system = "erp", table = "imported_orders" } });
        var suggestions = (await suggest.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("suggestions").GetProperty("fields").EnumerateArray()
            .ToDictionary(f => f.GetProperty("target").GetString()!, f => f.GetProperty("suggestion"));
        Assert.Equal("Multiply", suggestions["totalMinorUnits"].GetProperty("transform").GetString());
        Assert.Equal(HttpStatusCode.NotFound, (await viewer.PostAsJsonAsync("/api/mapping-designer/suggest", new { source = new { system = "crm", table = "missing_table" }, target = new { system = "erp", table = "imported_orders" } })).StatusCode);

        var draft = new
        {
            name = "CRM order to ERP import", description = "Milestone B demo",
            source = new { system = "crm", table = "sales_orders" }, target = new { system = "erp", table = "imported_orders" },
            fields = new object[]
            {
                new { target = "externalOrderId", transform = "Copy", source = "id" }, new { target = "accountCode", transform = "Uppercase", source = "customerId" },
                new { target = "currencyCode", transform = "Uppercase", source = "currency" }, new { target = "totalMinorUnits", transform = "Multiply", source = "amount", factor = 100 }
            }
        };
        var preview = await (await viewer.PostAsJsonAsync("/api/mapping-designer/preview",
            new { draft, sample = new { id = "ORD-013", customerId = "C-300", currency = "USD", amount = 410.25 } })).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(41025, preview.GetProperty("output").GetProperty("totalMinorUnits").GetInt64());
        Assert.True(preview.GetProperty("report").GetProperty("valid").GetBoolean());

        // Saving: Operators only, invalid drafts refused, each save is a new immutable version.
        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.PostAsJsonAsync("/api/mapping-definitions", draft)).StatusCode);
        var invalid = await operatorClient.PostAsJsonAsync("/api/mapping-definitions", new { draft.name, draft.source, draft.target, fields = new object[] { new { target = "externalOrderId", transform = "Copy", source = "id" } } });
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await operatorClient.PostAsJsonAsync("/api/mapping-definitions", draft)).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await operatorClient.PostAsJsonAsync("/api/mapping-definitions", draft)).StatusCode);
        var versions = await viewer.GetFromJsonAsync<JsonElement[]>("/api/mapping-definitions/" + Uri.EscapeDataString(draft.name));
        Assert.Equal([2, 1], versions!.Select(v => v.GetProperty("version").GetInt32()));
        Assert.Equal("operator", versions![0].GetProperty("createdBy").GetString());
        var list = await viewer.GetFromJsonAsync<JsonElement[]>("/api/mapping-definitions");
        Assert.Equal(2, Assert.Single(list!).GetProperty("latestVersion").GetInt32());

        // Nothing was executed or delivered: no executions, ERP imported orders unchanged.
        using var scope = hub.Services.CreateScope();
        Assert.Equal(0, await scope.ServiceProvider.GetRequiredService<HubDb>().Executions.CountAsync());
        Assert.Empty((await viewer.GetFromJsonAsync<JsonElement[]>("/api/target/orders"))!);
    }
}
