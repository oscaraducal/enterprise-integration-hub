using Hub.Application;
using Hub.Domain;
using Hub.Infrastructure;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;

namespace Hub.Tests;
/// <summary>Crash recovery, retry-budget and audit-trail regression tests.</summary>
public class RecoveryTests : IAsyncLifetime
{
    private readonly SqliteConnection connection = new("Data Source=:memory:");
    private HubDb NewDb() => new(new DbContextOptionsBuilder<HubDb>().UseSqlite(connection).Options);
    public async Task InitializeAsync()
    {
        await connection.OpenAsync();
        await using var db = NewDb();
        await db.Database.EnsureCreatedAsync();
    }
    public async Task DisposeAsync() => await connection.DisposeAsync();

    private async Task<string> Seed(string status, int attempts, string orderId = "ORD-001")
    {
        await using var db = NewDb();
        var e = new Execution { OrderId = orderId, Status = status, Attempts = attempts,
            StartedAt = attempts > 0 ? DateTime.UtcNow.AddSeconds(-5) : null };
        db.Executions.Add(e);
        await db.SaveChangesAsync();
        return e.Id;
    }
    private async Task<Execution> Load(string id)
    {
        await using var db = NewDb();
        return await db.Executions.AsNoTracking().Include(x => x.Logs.OrderBy(l => l.Id)).SingleAsync(x => x.Id == id);
    }
    private async Task Process(string id, FakeClients fake)
    {
        await using var db = NewDb();
        var e = await db.Executions.SingleAsync(x => x.Id == id);
        e.Status = "Running"; // what the worker's atomic claim does
        await new IntegrationRunner(db, fake, NullLogger<IntegrationRunner>.Instance).ProcessAsync(e, default);
    }
    private async Task Recover() { await using var db = NewDb(); await ExecutionRecovery.RecoverInterruptedAsync(db, default); }

    [Fact]
    public async Task Interrupted_attempt_below_budget_is_resumed_and_audited()
    {
        var id = await Seed("Running", 1);
        await Recover();
        var e = await Load(id);
        Assert.Equal("Retrying", e.Status);
        Assert.True(e.AvailableAt <= DateTime.UtcNow);
        var log = Assert.Single(e.Logs);
        Assert.Equal("RecoveryScheduled", log.Stage);
        Assert.Equal(1, log.Attempt);
        await Process(id, new FakeClients());
        e = await Load(id);
        Assert.Equal("Completed", e.Status);
        Assert.Equal(2, e.Attempts);
    }

    [Fact]
    public async Task Interrupted_final_attempt_fails_terminally_without_another_attempt()
    {
        var id = await Seed("Running", IntegrationRunner.MaxAttempts);
        await Recover();
        var e = await Load(id);
        Assert.Equal("Failed", e.Status);
        Assert.Equal("Interrupted", e.ErrorClass);
        Assert.NotNull(e.EndedAt);
        Assert.NotNull(e.DurationMs);
        Assert.Equal(IntegrationRunner.MaxAttempts, e.Attempts);
        Assert.Equal("RecoveryExhausted", Assert.Single(e.Logs).Stage);
    }

    [Fact]
    public async Task Repeated_crashes_never_exceed_retry_budget()
    {
        var id = await Seed("Pending", 0);
        var crashing = new FakeClients { CrashAfterCrm = true };
        for (var restart = 0; restart < 10; restart++)
        {
            var current = await Load(id);
            if (current.Status == "Failed") break;
            await Assert.ThrowsAsync<InvalidOperationException>(() => Process(id, crashing));
            await Recover();
        }
        var e = await Load(id);
        Assert.Equal("Failed", e.Status);
        Assert.Equal(IntegrationRunner.MaxAttempts, e.Attempts);
        Assert.Equal(IntegrationRunner.MaxAttempts, e.Logs.Count(l => l.Stage == "Started"));
        Assert.Equal("RecoveryExhausted", e.Logs[^1].Stage);
    }

    [Fact]
    public async Task Crash_after_ERP_acceptance_recovers_idempotently_with_one_ERP_order()
    {
        var id = await Seed("Pending", 0);
        var fake = new FakeClients { CrashAfterErp = true };
        await Assert.ThrowsAsync<InvalidOperationException>(() => Process(id, fake));
        Assert.Equal("Running", (await Load(id)).Status);
        await Recover();
        fake.CrashAfterErp = false;
        fake.Amount = 999; // CRM data changed after the first delivery; the frozen payload must still be used.
        await Process(id, fake);
        var e = await Load(id);
        Assert.Equal("Completed", e.Status);
        Assert.Equal("receipt-001", e.ReceiptId);
        Assert.Equal(1, fake.ErpOrdersCreated);
        Assert.Equal(fake.Payloads[0], fake.Payloads[1]);
        Assert.Contains("no duplicate created", e.Logs[^1].Message);
        Assert.Equal(["Started", "Retrieved", "Mapped", "RecoveryScheduled", "Started", "Retrieved", "Mapped", "Completed"],
            e.Logs.Select(l => l.Stage).ToArray());
    }

    [Fact]
    public async Task Runner_refuses_attempt_beyond_budget()
    {
        var id = await Seed("Retrying", IntegrationRunner.MaxAttempts);
        var fake = new FakeClients();
        await Process(id, fake);
        var e = await Load(id);
        Assert.Equal("Failed", e.Status);
        Assert.Equal(IntegrationRunner.MaxAttempts, e.Attempts);
        Assert.Equal(0, fake.CrmCalls);
        Assert.Equal("RetryExhausted", Assert.Single(e.Logs).Stage);
    }

    [Fact]
    public async Task Transient_exhaustion_and_permanent_failure_are_audited_distinctly()
    {
        var transient = await Seed("Pending", 0);
        var timeout = new FakeClients { Timeout = true };
        for (var i = 0; i < IntegrationRunner.MaxAttempts; i++) await Process(transient, timeout);
        var t = await Load(transient);
        Assert.Equal("Failed", t.Status);
        Assert.Equal(2, t.Logs.Count(l => l.Stage == "RetryScheduled"));
        Assert.Equal("RetryExhausted", t.Logs[^1].Stage);

        var permanent = await Seed("Pending", 0, "ORD-002");
        await Process(permanent, new FakeClients { FailStatus = 400, Failures = 3 });
        var p = await Load(permanent);
        Assert.Equal("Failed", p.Status);
        Assert.DoesNotContain(p.Logs, l => l.Stage is "RetryScheduled" or "RetryExhausted");
        Assert.Contains("permanent", p.Logs[^1].Message);
    }

    [Fact]
    public async Task Unexpected_worker_failure_is_terminal_audited_and_not_left_running()
    {
        var id = await Seed("Running", 2);
        await using (var db = NewDb()) await ExecutionRecovery.FailUnexpectedAsync(db, id, default);
        var e = await Load(id);
        Assert.Equal("Failed", e.Status);
        Assert.Equal("Internal", e.ErrorClass);
        Assert.NotNull(e.DurationMs);
        var log = Assert.Single(e.Logs);
        Assert.Equal(("Failed", "Error", 2), (log.Stage, log.Level, log.Attempt));
    }

    [Fact]
    public async Task Audit_entries_never_contain_service_keys_or_auth_headers()
    {
        var id = await Seed("Pending", 0);
        await Process(id, new FakeClients { FailStatus = 503, Failures = 1 });
        await Process(id, new FakeClients());
        var text = string.Join("\n", (await Load(id)).Logs.Select(l => l.Message));
        Assert.DoesNotContain("X-Service-Key", text);
        Assert.DoesNotContain("Bearer", text);
        Assert.DoesNotContain("Authorization", text);
    }
}
