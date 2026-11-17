using Integration.Shared;
using Microsoft.EntityFrameworkCore;

namespace MockCrm;
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
        {
            var db = scope.ServiceProvider.GetRequiredService<CrmDb>();
            await db.Database.EnsureCreatedAsync();
            if (!await db.Customers.AnyAsync())
            {
                db.Customers.AddRange(new Customer("C-100", "Northstar Demo Labs"),
                    new Customer("C-200", "Harborlight Fictional Supply"));
                db.Orders.AddRange(Enumerable.Range(1, 12).Select(i =>
                    new CrmOrder($"ORD-{i:000}", i % 2 == 0 ? "C-100" : "C-200", "USD", 125.50m * i)));
                await db.SaveChangesAsync();
            }
        }
        app.MapGet("/api/customers", async (CrmDb db) => await db.Customers.AsNoTracking().ToListAsync());
        app.MapPost("/api/customers", async (Customer input, CrmDb db) =>
        {
            var errors = Hosting.Validate(input);
            if (errors.Count > 0) return Results.ValidationProblem(errors);
            if (await db.Customers.AnyAsync(x => x.Id == input.Id)) return Results.Conflict();
            db.Customers.Add(input);
            try { await db.SaveChangesAsync(); }
            catch (DbUpdateException) { return Results.Conflict(); }
            return Results.Created($"/api/customers/{input.Id}", input);
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
                return Results.BadRequest(new { error = "Unknown fictional customer." });
            if (await db.Orders.AnyAsync(x => x.Id == input.Id)) return Results.Conflict();
            db.Orders.Add(input);
            try { await db.SaveChangesAsync(); }
            catch (DbUpdateException) { return Results.Conflict(); }
            return Results.Created($"/api/orders/{input.Id}", input);
        });
        app.MapPut("/api/orders/{id}", async (string id, CrmOrder input, CrmDb db) =>
        {
            var errors = Hosting.Validate(input);
            if (errors.Count > 0) return Results.ValidationProblem(errors);
            if (id != input.Id || !await db.Customers.AnyAsync(c => c.Id == input.CustomerId))
                return Results.BadRequest();
            var old = await db.Orders.FindAsync(id);
            if (old is null) return Results.NotFound();
            db.Entry(old).CurrentValues.SetValues(input);
            await db.SaveChangesAsync();
            return Results.Ok(input);
        });
        await app.RunAsync();
    }
}
public class CrmDb(DbContextOptions<CrmDb> options) : DbContext(options)
{
    public DbSet<Customer> Customers => Set<Customer>();
    public DbSet<CrmOrder> Orders => Set<CrmOrder>();
    protected override void OnModelCreating(ModelBuilder model)
    {
        model.Entity<Customer>().HasKey(x => x.Id);
        model.Entity<CrmOrder>().HasKey(x => x.Id);
        model.Entity<CrmOrder>().HasOne<Customer>().WithMany().HasForeignKey(x => x.CustomerId);
    }
}
