using Hub.Application;
using Hub.Domain;
using Microsoft.EntityFrameworkCore;

namespace Hub.Infrastructure;
// Single-replica worker backed by SQLite. No fire-and-forget request tasks.
public sealed class ExecutionWorker(IServiceScopeFactory scopes, ILogger<ExecutionWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Crash recovery is safe because ERP retains a durable idempotency record.
        using (var recovery = scopes.CreateScope())
        {
            var db = recovery.ServiceProvider.GetRequiredService<HubDb>();
            await db.Executions.Where(x => x.Status == "Running")
                .ExecuteUpdateAsync(s => s.SetProperty(x => x.Status, "Retrying")
                    .SetProperty(x => x.AvailableAt, DateTime.UtcNow), stoppingToken);
        }
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var scope = scopes.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<HubDb>();
                var now = DateTime.UtcNow;
                var item = await db.Executions.AsNoTracking()
                    .Where(x => (x.Status == "Pending" || x.Status == "Retrying") && x.AvailableAt <= now)
                    .OrderBy(x => x.CreatedAt).FirstOrDefaultAsync(stoppingToken);
                if (item is null) { await Task.Delay(250, stoppingToken); continue; }
                var claimed = await db.Executions.Where(x => x.Id == item.Id &&
                    (x.Status == "Pending" || x.Status == "Retrying"))
                    .ExecuteUpdateAsync(s => s.SetProperty(x => x.Status, "Running"), stoppingToken);
                if (claimed == 0) continue;
                var tracked = await db.Executions.SingleAsync(x => x.Id == item.Id, stoppingToken);
                try
                {
                    await scope.ServiceProvider.GetRequiredService<IntegrationRunner>().ProcessAsync(tracked, stoppingToken);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { throw; }
                catch (Exception ex)
                {
                    logger.LogError("Worker failed for {ExecutionId} with {ErrorType}", tracked.Id, ex.GetType().Name);
                    db.ChangeTracker.Clear();
                    await db.Executions.Where(x => x.Id == item.Id).ExecuteUpdateAsync(s => s
                        .SetProperty(x => x.Status, "Failed")
                        .SetProperty(x => x.EndedAt, DateTime.UtcNow)
                        .SetProperty(x => x.ErrorClass, "Internal")
                        .SetProperty(x => x.Troubleshooting, "Inspect structured server logs using the execution ID."), stoppingToken);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception ex)
            {
                logger.LogError("Worker loop error {ErrorType}", ex.GetType().Name);
                await Task.Delay(1000, stoppingToken);
            }
        }
    }
}
