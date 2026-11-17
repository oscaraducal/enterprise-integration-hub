using Hub.Domain;
using Hub.Infrastructure;
using Microsoft.EntityFrameworkCore;

namespace Hub.Application;
/// <summary>
/// Crash-recovery and unexpected-failure transitions for the single worker. Every decision writes an
/// audit log entry in the same SaveChanges call as the state change, so history never disagrees with state.
/// </summary>
public static class ExecutionRecovery
{
    /// <summary>
    /// Resolves executions left in Running by a stopped or crashed worker. An interrupted attempt has
    /// already consumed retry budget (Attempts is persisted when an attempt starts), so recovery resumes
    /// only while budget remains; otherwise the execution fails terminally and needs an explicit operator retry.
    /// </summary>
    public static async Task<int> RecoverInterruptedAsync(HubDb db, CancellationToken ct)
    {
        var interrupted = await db.Executions.Where(x => x.Status == "Running").ToListAsync(ct);
        var now = DateTime.UtcNow;
        foreach (var e in interrupted)
        {
            if (e.Attempts >= IntegrationRunner.MaxAttempts)
            {
                e.Status = "Failed";
                e.ErrorClass = "Interrupted";
                e.Troubleshooting = "The worker stopped during the final automatic attempt, so the retry budget is exhausted. " +
                    "ERP idempotency makes an operator retry safe; it will return the existing receipt if the order was already accepted.";
                e.EndedAt = now;
                if (e.StartedAt is not null) e.DurationMs = (now - e.StartedAt.Value).TotalMilliseconds;
                db.Logs.Add(new ExecutionLog { ExecutionId = e.Id, Timestamp = now, Stage = "RecoveryExhausted", Level = "Error",
                    Attempt = e.Attempts, Message = $"Worker restarted after attempt {e.Attempts} of {IntegrationRunner.MaxAttempts} was interrupted. " +
                        "Retry budget exhausted; marked Failed. Manual retry required." });
            }
            else
            {
                e.Status = "Retrying";
                e.AvailableAt = now;
                db.Logs.Add(new ExecutionLog { ExecutionId = e.Id, Timestamp = now, Stage = "RecoveryScheduled", Level = "Warning",
                    Attempt = e.Attempts, Message = e.Attempts == 0
                        ? "Worker restarted before the first attempt began; execution re-queued."
                        : $"Worker restarted while attempt {e.Attempts} of {IntegrationRunner.MaxAttempts} was running. " +
                          "Resuming with the remaining budget; ERP idempotency prevents a duplicate order." });
            }
        }
        await db.SaveChangesAsync(ct);
        return interrupted.Count;
    }

    /// <summary>Marks an execution Failed after an unexpected (non-classified) worker exception.</summary>
    public static async Task FailUnexpectedAsync(HubDb db, string executionId, CancellationToken ct)
    {
        db.ChangeTracker.Clear();
        var e = await db.Executions.SingleOrDefaultAsync(x => x.Id == executionId, ct);
        if (e is null || e.Status is "Completed" or "Failed") return;
        var now = DateTime.UtcNow;
        e.Status = "Failed";
        e.ErrorClass = "Internal";
        e.Troubleshooting = "Inspect structured server logs using the execution ID.";
        e.EndedAt = now;
        if (e.StartedAt is not null) e.DurationMs = (now - e.StartedAt.Value).TotalMilliseconds;
        // The exception message is deliberately not stored: it may contain upstream content.
        db.Logs.Add(new ExecutionLog { ExecutionId = e.Id, Timestamp = now, Stage = "Failed", Level = "Error",
            Attempt = e.Attempts, Message = "Unexpected internal error; execution stopped without automatic retry. Inspect server logs by execution ID." });
        await db.SaveChangesAsync(ct);
    }
}
