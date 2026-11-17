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
    }
}
