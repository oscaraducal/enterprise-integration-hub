using Hub.Domain;
using Microsoft.EntityFrameworkCore;

namespace Hub.Infrastructure;
public class HubDb(DbContextOptions<HubDb> options) : DbContext(options)
{
    public DbSet<Execution> Executions => Set<Execution>();
    public DbSet<ExecutionLog> Logs => Set<ExecutionLog>();
    public DbSet<JobRun> Jobs => Set<JobRun>();
    protected override void ConfigureConventions(ModelConfigurationBuilder configuration)
        => configuration.Properties<DateTime>().HaveConversion<Integration.Shared.UtcDateTimeConverter>();
    protected override void OnModelCreating(ModelBuilder model)
    {
        // One durable execution per source order, also across concurrent submissions.
        model.Entity<Execution>().HasIndex(x => x.OrderId).IsUnique();
        model.Entity<Execution>().HasIndex(x => new { x.Status, x.AvailableAt });
        model.Entity<Execution>().HasMany(x => x.Logs).WithOne().HasForeignKey(x => x.ExecutionId);
        model.Entity<Execution>().Property(x => x.Kind).HasMaxLength(20);
        // At most one active (queued, running or retrying) sync per customer; completed/failed history is unlimited.
        model.Entity<Execution>().HasIndex(x => new { x.Kind, x.SourceId }).IsUnique()
            .HasDatabaseName(ActiveSyncIndex).HasFilter(ActiveSyncFilter);
    }
    public const string ActiveSyncIndex = "IX_Executions_ActiveCustomerSync";
    public const string ActiveSyncFilter = "\"Kind\" = 'CustomerSync' AND \"Status\" IN ('Pending', 'Running', 'Retrying')";

    /// <summary>Creates a fresh schema, or additively upgrades a v1 (orders-only) database without touching its rows.</summary>
    public static async Task InitializeAsync(HubDb db)
    {
        await db.Database.EnsureCreatedAsync();
        await Integration.Shared.SchemaUpgrade.AddColumnsAsync(db, "Executions",
            ("Kind", "TEXT NOT NULL DEFAULT 'SalesOrder'"), ("SourceId", "TEXT NULL"),
            ("SourceVersion", "INTEGER NULL"), ("SourcePayload", "TEXT NULL"));
        // v1 rows are sales orders whose source ID is the order ID.
        await Integration.Shared.SchemaUpgrade.ExecuteAsync(db,
            "UPDATE \"Executions\" SET \"SourceId\" = \"OrderId\" WHERE \"SourceId\" IS NULL AND \"Kind\" = 'SalesOrder'");
        await Integration.Shared.SchemaUpgrade.ExecuteAsync(db,
            $"CREATE UNIQUE INDEX IF NOT EXISTS \"{ActiveSyncIndex}\" ON \"Executions\" (\"Kind\", \"SourceId\") WHERE {ActiveSyncFilter}");
    }
}
