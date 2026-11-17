using System.Text.Json;
using Integration.Shared;
using Microsoft.EntityFrameworkCore;

namespace MockCrm;
/// <summary>Fictional "Legacy CRM" source system: customers (versioned, with revisions) and sales orders.</summary>
public partial class Program
{
    public static async Task Main(string[] args)
    {
        var builder = WebApplication.CreateBuilder(args);
        builder.AddDemoDefaults();
        builder.Services.AddDbContext<CrmDb>(o => o.UseSqlite(
            builder.Configuration.GetConnectionString("Database") ?? "Data Source=crm.db"));
        var app = builder.Build();
        app.UseDemoDefaults();
        using (var scope = app.Services.CreateScope())
            await CrmDb.InitializeAsync(scope.ServiceProvider.GetRequiredService<CrmDb>());
        app.MapCatalog(BuiltInTables);

        app.MapGet("/api/customers", async (CrmDb db) => await db.Customers.AsNoTracking().OrderBy(x => x.Id).ToListAsync());
        app.MapGet("/api/customers/{id}", async (string id, HttpRequest request, CrmDb db, CancellationToken ct) =>
        {
            var scenario = request.Headers["X-Demo-Scenario"].ToString();
            if (scenario == "Timeout") await Task.Delay(TimeSpan.FromSeconds(10), ct);
            if (Scenarios.Status(scenario) is int status) return Results.StatusCode(status);
            var customer = await db.Customers.AsNoTracking().SingleOrDefaultAsync(x => x.Id == id, ct);
            return customer is null ? Results.NotFound() :
                Results.Ok(scenario == "Validation" ? customer with { Email = null } : customer);
        });
        app.MapGet("/api/customers/{id}/revisions", async (string id, CrmDb db) =>
            await db.Customers.AnyAsync(x => x.Id == id)
                ? Results.Ok(await db.Revisions.AsNoTracking().Where(x => x.CustomerId == id).OrderByDescending(x => x.Version).ToListAsync())
                : Results.NotFound());
        app.MapPost("/api/customers", async (CustomerInput input, CrmDb db) =>
        {
            var errors = ValidateCustomer(input);
            if (errors.Count > 0) return Results.ValidationProblem(errors);
            if (await db.Customers.AnyAsync(x => x.Id == input.Id)) return Results.Conflict(new { error = $"Customer {input.Id} already exists." });
            var customer = new Customer(input.Id, input.Name) { Email = Blank(input.Email), Phone = Blank(input.Phone),
                Status = input.Status, Version = 1, UpdatedAt = DateTime.UtcNow };
            db.Customers.Add(customer);
            db.Revisions.Add(Revision(customer));
            try { await db.SaveChangesAsync(); }
            catch (DbUpdateException) { return Results.Conflict(new { error = $"Customer {input.Id} already exists." }); }
            return Results.Created($"/api/customers/{customer.Id}", customer);
        });
        app.MapPut("/api/customers/{id}", async (string id, CustomerInput input, CrmDb db) =>
        {
            var errors = ValidateCustomer(input);
            if (errors.Count > 0) return Results.ValidationProblem(errors);
            if (id != input.Id) return Results.BadRequest(new { error = "Route and body customer IDs must match; IDs cannot be changed." });
            var current = await db.Customers.SingleOrDefaultAsync(x => x.Id == id);
            if (current is null) return Results.NotFound();
            var updated = current with { Name = input.Name, Email = Blank(input.Email), Phone = Blank(input.Phone), Status = input.Status };
            if (updated == current) return Results.Ok(current); // no business change: version stays
            updated = updated with { Version = current.Version + 1, UpdatedAt = DateTime.UtcNow };
            db.Entry(current).CurrentValues.SetValues(updated);
            db.Revisions.Add(Revision(updated));
            // Version is a concurrency token: two simultaneous edits cannot both become version n+1.
            try { await db.SaveChangesAsync(); }
            catch (DbUpdateConcurrencyException) { return Results.Conflict(new { error = "Customer was changed by someone else. Reload and try again." }); }
            return Results.Ok(updated);
        });

        app.MapGet("/api/orders", async (CrmDb db) => await db.Orders.AsNoTracking().OrderBy(x => x.Id).ToListAsync());
        app.MapGet("/api/orders/{id}", async (string id, HttpRequest request, CrmDb db, CancellationToken ct) =>
        {
            var scenario = request.Headers["X-Demo-Scenario"].ToString();
            if (scenario == "Timeout") await Task.Delay(TimeSpan.FromSeconds(10), ct);
            if (Scenarios.Status(scenario) is int status) return Results.StatusCode(status);
            var order = await db.Orders.FindAsync([id], ct);
            return order is null ? Results.NotFound() :
                Results.Ok(scenario == "Validation" ? order with { Amount = -1 } : order);
        });
        app.MapPost("/api/orders", async (CrmOrder input, CrmDb db) =>
        {
            var errors = Hosting.Validate(input);
            if (errors.Count > 0) return Results.ValidationProblem(errors);
            if (!await db.Customers.AnyAsync(x => x.Id == input.CustomerId))
                return Results.BadRequest(new { error = $"Unknown fictional customer {input.CustomerId}." });
            if (await db.Orders.AnyAsync(x => x.Id == input.Id)) return Results.Conflict(new { error = $"Order {input.Id} already exists." });
            db.Orders.Add(input);
            try { await db.SaveChangesAsync(); }
            catch (DbUpdateException) { return Results.Conflict(new { error = $"Order {input.Id} already exists." }); }
            return Results.Created($"/api/orders/{input.Id}", input);
        });
        app.MapPut("/api/orders/{id}", async (string id, CrmOrder input, CrmDb db) =>
        {
            var errors = Hosting.Validate(input);
            if (errors.Count > 0) return Results.ValidationProblem(errors);
            if (id != input.Id) return Results.BadRequest(new { error = "Route and body order IDs must match." });
            if (!await db.Customers.AnyAsync(c => c.Id == input.CustomerId))
                return Results.BadRequest(new { error = $"Unknown fictional customer {input.CustomerId}." });
            var old = await db.Orders.FindAsync(id);
            if (old is null) return Results.NotFound();
            db.Entry(old).CurrentValues.SetValues(input);
            await db.SaveChangesAsync();
            return Results.Ok(input);
        });
        await app.RunAsync();
    }
    /// <summary>The CRM's code-defined tables, published in the Data Catalog for schema discovery (read-only there).</summary>
    public static readonly BuiltInTable<CrmDb>[] BuiltInTables =
    [
        new(new TableView("customers", "Customers", "Customer master owned by the CRM. Every edit increments the version and stores a revision.", "customerId",
            [new("customerId", "string", true, Description: "e.g. C-300"), new("customerName", "string", true),
             new("email", "string", Description: "Optional in the CRM, required by the ERP"), new("phone", "string"),
             new("status", "enum", true, CustomerStatuses.All), new("version", "integer", true, Description: "Increments on every change", ReadOnly: true),
             new("updatedAt", "datetime", ReadOnly: true)], 1, true, null, null),
            "/api/customers", (db, ct) => db.Customers.CountAsync(ct)),
        new(new TableView("sales_orders", "Sales orders", "Sales orders captured in the CRM. Each references a customer.", "id",
            [new("id", "string", true, Description: "e.g. ORD-013"), new("customerId", "string", true, Description: "References customers.customerId"),
             new("currency", "string", true, Description: "ISO 4217 code"), new("amount", "decimal", true, Description: "Major units, e.g. 410.25")], 1, true, null, null),
            "/api/orders", (db, ct) => db.Orders.CountAsync(ct)),
    ];
    private static string? Blank(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    private static Dictionary<string, string[]> ValidateCustomer(CustomerInput input)
    {
        var errors = Hosting.Validate(input);
        if (!CustomerStatuses.All.Contains(input.Status))
            errors["Status"] = [$"Status must be one of {string.Join(", ", CustomerStatuses.All)}."];
        return errors;
    }
    internal static CustomerRevision Revision(Customer c) => new()
    {
        CustomerId = c.Id, Version = c.Version, ChangedAt = c.UpdatedAt ?? DateTime.UtcNow,
        Snapshot = JsonSerializer.Serialize(c, JsonSerializerOptions.Web)
    };
}
public class CrmDb(DbContextOptions<CrmDb> options) : DbContext(options), ICatalogDb
{
    public DbSet<CatalogTable> CatalogTables => Set<CatalogTable>();
    public DbSet<CatalogTableVersion> CatalogTableVersions => Set<CatalogTableVersion>();
    public DbSet<CatalogRecord> CatalogRecords => Set<CatalogRecord>();
    public DbSet<Customer> Customers => Set<Customer>();
    public DbSet<CrmOrder> Orders => Set<CrmOrder>();
    public DbSet<CustomerRevision> Revisions => Set<CustomerRevision>();
    protected override void ConfigureConventions(ModelConfigurationBuilder configuration)
        => configuration.Properties<DateTime>().HaveConversion<UtcDateTimeConverter>();
    protected override void OnModelCreating(ModelBuilder model)
    {
        model.Entity<Customer>().HasKey(x => x.Id);
        model.Entity<Customer>().Property(x => x.Version).IsConcurrencyToken();
        model.Entity<CrmOrder>().HasKey(x => x.Id);
        model.Entity<CrmOrder>().HasOne<Customer>().WithMany().HasForeignKey(x => x.CustomerId);
        model.Entity<CustomerRevision>().ToTable("CustomerRevisions").HasIndex(x => x.CustomerId);
        CatalogModel.Configure(model);
    }

    /// <summary>Creates or additively upgrades the schema, then inserts any missing synthetic seed records.</summary>
    public static async Task InitializeAsync(CrmDb db)
    {
        await db.Database.EnsureCreatedAsync();
        await SchemaUpgrade.AddColumnsAsync(db, "Customers",
            ("Email", "TEXT NULL"), ("Phone", "TEXT NULL"), ("Status", "TEXT NOT NULL DEFAULT 'Active'"),
            ("Version", "INTEGER NOT NULL DEFAULT 1"), ("UpdatedAt", "TEXT NULL"));
        await SchemaUpgrade.ExecuteAsync(db, """
            CREATE TABLE IF NOT EXISTS "CustomerRevisions" (
                "Id" INTEGER NOT NULL CONSTRAINT "PK_CustomerRevisions" PRIMARY KEY AUTOINCREMENT,
                "CustomerId" TEXT NOT NULL, "Version" INTEGER NOT NULL, "Snapshot" TEXT NOT NULL, "ChangedAt" TEXT NOT NULL)
            """);
        await SchemaUpgrade.ExecuteAsync(db, """CREATE INDEX IF NOT EXISTS "IX_CustomerRevisions_CustomerId" ON "CustomerRevisions" ("CustomerId")""");
        await CatalogModel.EnsureSchemaAsync(db);

        var now = DateTime.UtcNow;
        Customer[] seedCustomers =
        [
            new("C-100", "Northstar Demo Labs") { Email = "ap@northstar-demo.example", Phone = "+1 (555) 010-1000", Status = "Active" },
            new("C-200", "Harborlight Fictional Supply") { Email = "orders@harborlight.example", Phone = "+63 2 8555 0200", Status = "Active" },
            new("C-300", "Bluefin  Fictional Outfitters") { Email = " Buyer@Bluefin-Outfitters.example ", Phone = "555-0300", Status = "Active" },
            new("C-400", "Quarry Lane Demo Traders") { Email = null, Phone = "+1 555 0400", Status = "Active" },
            new("C-500", "Cinderpeak Sample Wholesale") { Email = "finance@cinderpeak.example", Phone = null, Status = "OnHold" },
        ];
        var existing = await db.Customers.ToDictionaryAsync(x => x.Id);
        foreach (var seed in seedCustomers)
        {
            if (!existing.TryGetValue(seed.Id, out var current))
                db.Customers.Add(seed with { Version = 1, UpdatedAt = now });
            else if (current.Email is null && current.Phone is null && current.Version == 1 && seed.Id is "C-100" or "C-200")
                // v1 databases stored only ID and name for the two original seed customers; fill their synthetic contact fields once.
                db.Entry(current).CurrentValues.SetValues(current with { Email = seed.Email, Phone = seed.Phone, UpdatedAt = now });
        }
        await db.SaveChangesAsync();
        var withRevisions = await db.Revisions.Select(r => r.CustomerId).Distinct().ToListAsync();
        foreach (var c in await db.Customers.AsNoTracking().Where(c => !withRevisions.Contains(c.Id)).ToListAsync())
            db.Revisions.Add(Program.Revision(c));
        var orderIds = await db.Orders.Select(o => o.Id).ToListAsync();
        var seedOrders = Enumerable.Range(1, 12).Select(i => new CrmOrder($"ORD-{i:000}", i % 2 == 0 ? "C-100" : "C-200", "USD", 125.50m * i))
            .Append(new CrmOrder("ORD-013", "C-300", "USD", 410.25m))   // SCN-002: customer must be synchronized first
            .Append(new CrmOrder("ORD-014", "C-100", "JPY", 5000m))     // unsupported currency
            .Append(new CrmOrder("ORD-015", "C-500", "EUR", 99.90m));   // ERP rejects orders for BLOCKED accounts
        db.Orders.AddRange(seedOrders.Where(o => !orderIds.Contains(o.Id)));
        await db.SaveChangesAsync();
    }
}
