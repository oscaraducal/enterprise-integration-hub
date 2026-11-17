using System.Security.Cryptography;
using System.Text.Json;
using Integration.Shared;
using Microsoft.EntityFrameworkCore;

namespace MockErp;
/// <summary>
/// Fictional "Modern ERP" target system. Stores the mapped business payloads it imports (orders and customer
/// master records), keeps an import audit history, and enforces target-side business rules.
/// </summary>
public partial class Program
{
    public static async Task Main(string[] args)
    {
        var builder = WebApplication.CreateBuilder(args);
        builder.AddDemoDefaults();
        builder.Services.AddDbContext<ErpDb>(o => o.UseSqlite(
            builder.Configuration.GetConnectionString("Database") ?? "Data Source=erp.db"));
        var app = builder.Build();
        app.UseDemoDefaults();
        using (var scope = app.Services.CreateScope())
            await ErpDb.InitializeAsync(scope.ServiceProvider.GetRequiredService<ErpDb>());
        app.MapCatalog(BuiltInTables);

        // ----- Imported sales orders -----
        app.MapGet("/api/orders", async (ErpDb db) => await db.Accepted.AsNoTracking().OrderByDescending(x => x.AcceptedAt).ToListAsync());
        app.MapGet("/api/orders/{id}", async (string id, ErpDb db) =>
            await db.Accepted.AsNoTracking().SingleOrDefaultAsync(x => x.ExternalOrderId == id) is { } order ? Results.Ok(order) : Results.NotFound());
        app.MapPost("/api/orders", async (ErpOrder input, HttpRequest request, HttpResponse response,
            ErpDb db, CancellationToken ct) =>
        {
            var errors = Hosting.Validate(input);
            if (errors.Count > 0) return Results.ValidationProblem(errors);
            if (!Mapping.SupportedCurrencies.Contains(input.CurrencyCode)) return Results.BadRequest();
            var fingerprint = Fingerprint(input);
            var existing = await db.Accepted.FindAsync([input.ExternalOrderId], ct);
            if (existing is not null) return Replay(existing, fingerprint);
            var scenario = request.Headers["X-Demo-Scenario"].ToString();
            if (await Simulate(scenario, response, ct) is { } simulated) return simulated;
            if (scenario == "Duplicate") return Results.Conflict(new { code = "DuplicateConflict" });
            // Target-side business rules: an order needs an existing, active customer account.
            var account = await db.Customers.AsNoTracking().SingleOrDefaultAsync(x => x.AccountCode == input.AccountCode, ct);
            if (account is null)
                return Results.UnprocessableEntity(new { code = "UnknownAccount", accountCode = input.AccountCode,
                    error = $"Account {input.AccountCode} does not exist in Modern ERP. Synchronize the customer master (SCN-001) first." });
            if (account.AccountStatus != "ACTIVE")
                return Results.UnprocessableEntity(new { code = "AccountBlocked", accountCode = input.AccountCode,
                    error = $"Account {input.AccountCode} is {account.AccountStatus}; Modern ERP does not accept new orders for it." });
            var accepted = new AcceptedOrder { ExternalOrderId = input.ExternalOrderId, Fingerprint = fingerprint,
                ReceiptId = Guid.NewGuid().ToString("N"), AcceptedAt = DateTime.UtcNow,
                AccountCode = input.AccountCode, CurrencyCode = input.CurrencyCode, TotalMinorUnits = input.TotalMinorUnits,
                ExecutionId = Header(request, "X-Execution-Id", 64), SourceSystem = "LEGACY-CRM" };
            db.Accepted.Add(accepted);
            try { await db.SaveChangesAsync(ct); }
            catch (DbUpdateException)
            {
                db.ChangeTracker.Clear();
                var winner = await db.Accepted.FindAsync([input.ExternalOrderId], ct);
                if (winner is null) throw;
                return Replay(winner, fingerprint);
            }
            return Results.Created($"/api/orders/{input.ExternalOrderId}",
                new Receipt(input.ExternalOrderId, accepted.ReceiptId, false));
        });

        // ----- Customer master -----
        app.MapGet("/api/customers", async (ErpDb db) => await db.Customers.AsNoTracking().OrderBy(x => x.AccountCode).ToListAsync());
        app.MapGet("/api/customers/{code}", async (string code, ErpDb db) =>
        {
            var customer = await db.Customers.AsNoTracking().SingleOrDefaultAsync(x => x.AccountCode == code);
            if (customer is null) return Results.NotFound();
            var history = await db.History.AsNoTracking().Where(x => x.AccountCode == code).OrderByDescending(x => x.Id).Take(50).ToListAsync();
            return Results.Ok(new { customer, history });
        });
        // Import history across all accounts, newest first and bounded, for the ERP Import History screen.
        app.MapGet("/api/history", async (int? take, ErpDb db) =>
            await db.History.AsNoTracking().OrderByDescending(x => x.Id).Take(Math.Clamp(take ?? 100, 1, 200)).ToListAsync());
        // Integration import (upsert). Policy: create if missing; apply when the source version is the same or newer;
        // never let an older source version overwrite a newer one; identical data is recorded as Unchanged.
        app.MapPut("/api/customers/{code}", async (string code, ErpCustomer input, HttpRequest request, HttpResponse response,
            ErpDb db, CancellationToken ct) =>
        {
            var errors = Hosting.Validate(input);
            if (!AccountStatuses.All.Contains(input.AccountStatus)) errors["AccountStatus"] = ["Unknown account status."];
            if (errors.Count > 0) return Results.ValidationProblem(errors);
            if (input.AccountCode != code) return Results.BadRequest(new { error = "Route and body account codes must match." });
            if (await Simulate(request.Headers["X-Demo-Scenario"].ToString(), response, ct) is { } simulated) return simulated;
            int? version = int.TryParse(request.Headers["X-Source-Version"], out var v) && v > 0 ? v : null;
            var executionId = Header(request, "X-Execution-Id", 64);
            for (var attempt = 0; ; attempt++)
            {
                try { return Results.Ok(await Upsert(db, input, version, executionId, ct)); }
                catch (DbUpdateException) when (attempt == 0) { db.ChangeTracker.Clear(); } // lost a create race: retry as update
            }
        });
        // Manual maintenance is allowed only for records explicitly designated as synthetic fixtures.
        app.MapPut("/api/fixtures/customers/{code}", async (string code, ErpCustomer input, HttpRequest request, ErpDb db) =>
        {
            var errors = Hosting.Validate(input);
            if (!AccountStatuses.All.Contains(input.AccountStatus)) errors["AccountStatus"] = ["Unknown account status."];
            if (errors.Count > 0) return Results.ValidationProblem(errors);
            if (input.AccountCode != code) return Results.BadRequest(new { error = "Account codes cannot be changed." });
            var record = await db.Customers.SingleOrDefaultAsync(x => x.AccountCode == code);
            if (record is null) return Results.NotFound();
            if (record.Origin != "Fixture")
                return Results.Conflict(new { code = "NotAFixture", error = "This record is owned by the integration. Change it in the Legacy CRM and synchronize it." });
            var before = Snapshot(record);
            var changed = Diff(record, input);
            if (changed.Length == 0) return Results.Ok(record);
            Apply(record, input);
            record.UpdatedAt = DateTime.UtcNow;
            db.History.Add(new CustomerHistory { AccountCode = code, Action = "FixtureEdit", ChangedFields = string.Join(", ", changed),
                Before = before, After = Snapshot(record), At = record.UpdatedAt, Actor = Header(request, "X-Actor", 60) ?? "unknown" });
            await db.SaveChangesAsync();
            return Results.Ok(record);
        });
        await app.RunAsync();
    }

    /// <summary>The ERP's code-defined tables, published in the Data Catalog for schema discovery (read-only there).</summary>
    public static readonly BuiltInTable<ErpDb>[] BuiltInTables =
    [
        new(new TableView("customer_master", "Customer master", "ERP accounts. Imported records are owned by the integration; migrated fixtures are synthetic.", "accountCode",
            [new("accountCode", "string", true), new("displayName", "string", true), new("emailAddress", "string", true),
             new("contactNumber", "string"), new("accountStatus", "enum", true, AccountStatuses.All),
             new("origin", "enum", true, ["Fixture", "Import"], ReadOnly: true), new("sourceSystem", "string", ReadOnly: true),
             new("sourceReference", "string", Description: "Source record ID", ReadOnly: true), new("sourceVersion", "integer", Description: "Highest applied source version", ReadOnly: true),
             new("lastExecutionId", "string", ReadOnly: true), new("lastSyncedAt", "datetime", ReadOnly: true),
             new("createdAt", "datetime", true, ReadOnly: true), new("updatedAt", "datetime", true, ReadOnly: true)], 1, true, null, null),
            "/api/customers", (db, ct) => db.Customers.CountAsync(ct)),
        new(new TableView("imported_orders", "Imported sales orders", "Mapped orders accepted exactly once, with the receipt and the delivering execution.", "externalOrderId",
            [new("externalOrderId", "string", true, Description: "Source order ID"), new("accountCode", "string", true),
             new("currencyCode", "string", true), new("totalMinorUnits", "integer", true, Description: "e.g. 41025 = 410.25"),
             new("receiptId", "string", true, ReadOnly: true), new("executionId", "string", ReadOnly: true),
             new("sourceSystem", "string", ReadOnly: true), new("acceptedAt", "datetime", true, ReadOnly: true)], 1, true, null, null),
            "/api/orders", (db, ct) => db.Accepted.CountAsync(ct)),
    ];
    private static async Task<CustomerSyncResult> Upsert(ErpDb db, ErpCustomer input, int? version, string? executionId, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var record = await db.Customers.SingleOrDefaultAsync(x => x.AccountCode == input.AccountCode, ct);
        CustomerHistory history;
        string outcome;
        string[] changed;
        if (record is null)
        {
            record = new ErpCustomerRecord { AccountCode = input.AccountCode, Origin = "Import", CreatedAt = now };
            Apply(record, input);
            changed = ["displayName", "emailAddress", "contactNumber", "accountStatus"];
            outcome = "Created";
            db.Customers.Add(record);
            history = new() { Action = outcome, Before = null };
        }
        else if (version is int incoming && record.SourceVersion is int stored && incoming < stored)
        {
            changed = [];
            outcome = "SkippedStale";
            history = new() { Action = outcome, Before = Snapshot(record), Note = $"Source version {incoming} is older than applied version {stored}; record unchanged." };
            history.After = history.Before!;
        }
        else
        {
            var before = Snapshot(record);
            changed = Diff(record, input);
            var wasFixture = record.Origin == "Fixture";
            outcome = changed.Length == 0 && !wasFixture ? "Unchanged" : "Updated";
            Apply(record, input);
            record.Origin = "Import";
            history = new() { Action = outcome, Before = before,
                Note = wasFixture ? "Synthetic fixture record is now owned by the integration." : null };
        }
        if (outcome != "SkippedStale")
        {
            record.SourceSystem = "LEGACY-CRM";
            record.SourceReference = input.AccountCode;
            record.SourceVersion = version is int applied ? Math.Max(applied, record.SourceVersion ?? 0) : record.SourceVersion;
            record.LastExecutionId = executionId;
            record.LastSyncedAt = now;
            if (outcome != "Unchanged") record.UpdatedAt = now;
            history.After = Snapshot(record);
        }
        history.AccountCode = input.AccountCode;
        history.ChangedFields = string.Join(", ", changed);
        history.ExecutionId = executionId;
        history.SourceVersion = version;
        history.At = now;
        history.Actor = "integration";
        db.History.Add(history);
        await db.SaveChangesAsync(ct);
        return new(input.AccountCode, outcome, changed, record.SourceVersion, $"SYNC-{history.Id:000000}");
    }
    private static string[] Diff(ErpCustomerRecord r, ErpCustomer c) =>
        new (string Field, bool Changed)[]
        {
            ("displayName", r.DisplayName != c.DisplayName), ("emailAddress", r.EmailAddress != c.EmailAddress),
            ("contactNumber", r.ContactNumber != c.ContactNumber), ("accountStatus", r.AccountStatus != c.AccountStatus)
        }.Where(x => x.Changed).Select(x => x.Field).ToArray();
    private static void Apply(ErpCustomerRecord r, ErpCustomer c)
    {
        r.DisplayName = c.DisplayName; r.EmailAddress = c.EmailAddress;
        r.ContactNumber = c.ContactNumber; r.AccountStatus = c.AccountStatus;
    }
    internal static string Snapshot(ErpCustomerRecord r) => JsonSerializer.Serialize(
        new ErpCustomer(r.AccountCode, r.DisplayName, r.EmailAddress, r.ContactNumber, r.AccountStatus), JsonSerializerOptions.Web);
    private static string Fingerprint(ErpOrder input) => Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(input)));
    private static string? Header(HttpRequest request, string name, int max)
    {
        var value = request.Headers[name].ToString();
        return string.IsNullOrWhiteSpace(value) ? null : value.Length > max ? value[..max] : value;
    }
    private static async Task<IResult?> Simulate(string scenario, HttpResponse response, CancellationToken ct)
    {
        if (scenario == "Timeout") await Task.Delay(TimeSpan.FromSeconds(10), ct);
        if (Scenarios.Status(scenario) is not int status) return null;
        if (status == 429) response.Headers.RetryAfter = "1";
        return Results.StatusCode(status);
    }
    private static IResult Replay(AcceptedOrder existing, string fingerprint) =>
        existing.Fingerprint == fingerprint
            ? Results.Ok(new Receipt(existing.ExternalOrderId, existing.ReceiptId, true))
            : Results.Conflict(new { code = "DuplicateConflict", error = "Order ID already has a different payload." });
}
/// <summary>An imported order: idempotency record plus the mapped business payload (null for pre-v2 imports).</summary>
public class AcceptedOrder
{
    public string ExternalOrderId { get; set; } = "";
    public string Fingerprint { get; set; } = "";
    public string ReceiptId { get; set; } = "";
    public DateTime AcceptedAt { get; set; }
    public string? AccountCode { get; set; }
    public string? CurrencyCode { get; set; }
    public long? TotalMinorUnits { get; set; }
    public string? ExecutionId { get; set; }
    public string? SourceSystem { get; set; }
}
public class ErpCustomerRecord
{
    public string AccountCode { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public string EmailAddress { get; set; } = "";
    public string? ContactNumber { get; set; }
    public string AccountStatus { get; set; } = "ACTIVE";
    /// <summary>"Fixture" (synthetic, manually maintainable) or "Import" (owned by the integration).</summary>
    public string Origin { get; set; } = "Import";
    public string? SourceSystem { get; set; }
    public string? SourceReference { get; set; }
    public int? SourceVersion { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
    public string? LastExecutionId { get; set; }
    public DateTime? LastSyncedAt { get; set; }
}
public class CustomerHistory
{
    public long Id { get; set; }
    public string AccountCode { get; set; } = "";
    public string Action { get; set; } = "";
    public string? ExecutionId { get; set; }
    public int? SourceVersion { get; set; }
    public string ChangedFields { get; set; } = "";
    public string? Before { get; set; }
    public string After { get; set; } = "";
    public string? Note { get; set; }
    public string Actor { get; set; } = "";
    public DateTime At { get; set; }
}
public class ErpDb(DbContextOptions<ErpDb> options) : DbContext(options), ICatalogDb
{
    public DbSet<CatalogTable> CatalogTables => Set<CatalogTable>();
    public DbSet<CatalogTableVersion> CatalogTableVersions => Set<CatalogTableVersion>();
    public DbSet<CatalogRecord> CatalogRecords => Set<CatalogRecord>();
    public DbSet<AcceptedOrder> Accepted => Set<AcceptedOrder>();
    public DbSet<ErpCustomerRecord> Customers => Set<ErpCustomerRecord>();
    public DbSet<CustomerHistory> History => Set<CustomerHistory>();
    protected override void ConfigureConventions(ModelConfigurationBuilder configuration)
        => configuration.Properties<DateTime>().HaveConversion<UtcDateTimeConverter>();
    protected override void OnModelCreating(ModelBuilder model)
    {
        model.Entity<AcceptedOrder>().HasKey(x => x.ExternalOrderId);
        model.Entity<ErpCustomerRecord>().ToTable("ErpCustomers").HasKey(x => x.AccountCode);
        model.Entity<CustomerHistory>().ToTable("CustomerHistory").HasIndex(x => x.AccountCode);
        CatalogModel.Configure(model);
    }
    public static async Task InitializeAsync(ErpDb db)
    {
        await db.Database.EnsureCreatedAsync();
        await SchemaUpgrade.AddColumnsAsync(db, "Accepted", ("AccountCode", "TEXT NULL"), ("CurrencyCode", "TEXT NULL"),
            ("TotalMinorUnits", "INTEGER NULL"), ("ExecutionId", "TEXT NULL"), ("SourceSystem", "TEXT NULL"));
        await SchemaUpgrade.ExecuteAsync(db, """
            CREATE TABLE IF NOT EXISTS "ErpCustomers" (
                "AccountCode" TEXT NOT NULL CONSTRAINT "PK_ErpCustomers" PRIMARY KEY,
                "DisplayName" TEXT NOT NULL, "EmailAddress" TEXT NOT NULL, "ContactNumber" TEXT NULL,
                "AccountStatus" TEXT NOT NULL, "Origin" TEXT NOT NULL, "SourceSystem" TEXT NULL, "SourceReference" TEXT NULL,
                "SourceVersion" INTEGER NULL, "CreatedAt" TEXT NOT NULL, "UpdatedAt" TEXT NOT NULL,
                "LastExecutionId" TEXT NULL, "LastSyncedAt" TEXT NULL)
            """);
        await SchemaUpgrade.ExecuteAsync(db, """
            CREATE TABLE IF NOT EXISTS "CustomerHistory" (
                "Id" INTEGER NOT NULL CONSTRAINT "PK_CustomerHistory" PRIMARY KEY AUTOINCREMENT,
                "AccountCode" TEXT NOT NULL, "Action" TEXT NOT NULL, "ExecutionId" TEXT NULL, "SourceVersion" INTEGER NULL,
                "ChangedFields" TEXT NOT NULL, "Before" TEXT NULL, "After" TEXT NOT NULL, "Note" TEXT NULL,
                "Actor" TEXT NOT NULL, "At" TEXT NOT NULL)
            """);
        await SchemaUpgrade.ExecuteAsync(db, """CREATE INDEX IF NOT EXISTS "IX_CustomerHistory_AccountCode" ON "CustomerHistory" ("AccountCode")""");
        await CatalogModel.EnsureSchemaAsync(db);
        // Synthetic "migrated at go-live" fixtures so existing order demos keep working before any customer sync.
        var now = DateTime.UtcNow;
        foreach (var (code, name, email) in new[] { ("C-100", "Northstar Demo Labs", "ap@northstar-demo.example"),
                                                    ("C-200", "Harborlight Fictional Supply", "orders@harborlight.example") })
            if (!await db.Customers.AnyAsync(x => x.AccountCode == code))
            {
                var fixture = new ErpCustomerRecord { AccountCode = code, DisplayName = name, EmailAddress = email,
                    AccountStatus = "ACTIVE", Origin = "Fixture", SourceSystem = "MIGRATION", SourceReference = code,
                    CreatedAt = now, UpdatedAt = now };
                db.Customers.Add(fixture);
                db.History.Add(new CustomerHistory { AccountCode = code, Action = "FixtureSeeded", ChangedFields = "",
                    After = Program.Snapshot(fixture), Note = "Synthetic go-live migration fixture.", Actor = "seed", At = now });
            }
        await db.SaveChangesAsync();
    }
}
