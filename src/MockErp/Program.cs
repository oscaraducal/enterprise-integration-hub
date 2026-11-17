using System.Security.Cryptography;
using System.Text.Json;
using Integration.Shared;
using Microsoft.EntityFrameworkCore;

namespace MockErp;
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
            await scope.ServiceProvider.GetRequiredService<ErpDb>().Database.EnsureCreatedAsync();
        app.MapGet("/api/orders", async (ErpDb db) => await db.Accepted.AsNoTracking().ToListAsync());
        app.MapPost("/api/orders", async (ErpOrder input, HttpRequest request, HttpResponse response,
            ErpDb db, CancellationToken ct) =>
        {
            var errors = Hosting.Validate(input);
            if (errors.Count > 0) return Results.ValidationProblem(errors);
            if (input.CurrencyCode is not ("USD" or "PHP" or "EUR")) return Results.BadRequest();
            var fingerprint = Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(input)));
            var existing = await db.Accepted.FindAsync([input.ExternalOrderId], ct);
            if (existing is not null) return Replay(existing, fingerprint);
            var scenario = request.Headers["X-Demo-Scenario"].ToString();
            if (scenario == "Timeout") await Task.Delay(TimeSpan.FromSeconds(10), ct);
            if (Scenarios.Status(scenario) is int status)
            {
                if (status == 429) response.Headers.RetryAfter = "1";
                return Results.StatusCode(status);
            }
            if (scenario == "Duplicate") return Results.Conflict(new { code = "DuplicateConflict" });
            var accepted = new AcceptedOrder { ExternalOrderId = input.ExternalOrderId,
                Fingerprint = fingerprint, ReceiptId = Guid.NewGuid().ToString("N"), AcceptedAt = DateTime.UtcNow };
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
        await app.RunAsync();
    }
    private static IResult Replay(AcceptedOrder existing, string fingerprint) =>
        existing.Fingerprint == fingerprint
            ? Results.Ok(new Receipt(existing.ExternalOrderId, existing.ReceiptId, true))
            : Results.Conflict(new { code = "DuplicateConflict", error = "Order ID already has a different payload." });
}
public class AcceptedOrder
{
    public string ExternalOrderId { get; set; } = "";
    public string Fingerprint { get; set; } = "";
    public string ReceiptId { get; set; } = "";
    public DateTime AcceptedAt { get; set; }
}
public class ErpDb(DbContextOptions<ErpDb> options) : DbContext(options)
{
    public DbSet<AcceptedOrder> Accepted => Set<AcceptedOrder>();
    protected override void ConfigureConventions(ModelConfigurationBuilder configuration)
        => configuration.Properties<DateTime>().HaveConversion<UtcDateTimeConverter>();
    protected override void OnModelCreating(ModelBuilder model) => model.Entity<AcceptedOrder>().HasKey(x => x.ExternalOrderId);
}
