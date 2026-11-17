using System.Net;
using System.Net.Http.Json;
using Hub.Application;
using Hub.Domain;
using Hub.Infrastructure;
using Integration.Shared;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;

namespace Hub.Tests;
public class RunnerTests
{
    private static async Task<(SqliteConnection, HubDb, Execution)> Create()
    {
        var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        var db = new HubDb(new DbContextOptionsBuilder<HubDb>().UseSqlite(connection).Options);
        await db.Database.EnsureCreatedAsync();
        var execution = new Execution { OrderId = "ORD-001", Status = "Running" };
        db.Executions.Add(execution);
        await db.SaveChangesAsync();
        return (connection, db, execution);
    }
    [Fact]
    public async Task Successful_run_persists_receipt_mapping_and_ordered_logs()
    {
        var (connection, db, e) = await Create();
        await using var ownedConnection = connection; await using var ownedDb = db;
        var fake = new FakeClients();
        await new IntegrationRunner(db, fake, NullLogger<IntegrationRunner>.Instance).ProcessAsync(e, default);
        Assert.Equal("Completed", e.Status);
        Assert.Equal("receipt-001", e.ReceiptId);
        Assert.Contains("12550", e.MappedPayload!);
        Assert.Equal(["Started", "Retrieved", "Mapped", "Completed"],
            await db.Logs.OrderBy(x => x.Id).Select(x => x.Stage).ToArrayAsync());
        Assert.DoesNotContain("X-Service-Key", string.Join("", await db.Logs.Select(x => x.Message).ToArrayAsync()));
    }
    [Theory]
    [InlineData(429)]
    [InlineData(500)]
    [InlineData(503)]
    public async Task Transient_failure_is_retried_and_recovers(int status)
    {
        var (connection, db, e) = await Create();
        await using var ownedConnection = connection; await using var ownedDb = db;
        var fake = new FakeClients { FailStatus = status, Failures = 1 };
        var runner = new IntegrationRunner(db, fake, NullLogger<IntegrationRunner>.Instance);
        await runner.ProcessAsync(e, default);
        Assert.Equal("Retrying", e.Status);
        Assert.True(e.AvailableAt > DateTime.UtcNow);
        await runner.ProcessAsync(e, default);
        Assert.Equal("Completed", e.Status);
        Assert.Equal(2, e.Attempts);
        Assert.Equal(fake.Payloads[0], fake.Payloads[1]);
    }
    [Fact]
    public async Task Timeout_exhausts_three_attempts()
    {
        var (connection, db, e) = await Create();
        await using var ownedConnection = connection; await using var ownedDb = db;
        var runner = new IntegrationRunner(db, new FakeClients { Timeout = true }, NullLogger<IntegrationRunner>.Instance);
        for (var i = 0; i < IntegrationRunner.MaxAttempts; i++) await runner.ProcessAsync(e, default);
        Assert.Equal("Failed", e.Status);
        Assert.Equal("Timeout", e.ErrorClass);
        Assert.Equal(3, e.Attempts);
    }
    [Theory]
    [InlineData(400)]
    [InlineData(401)]
    [InlineData(404)]
    [InlineData(409)]
    public async Task Permanent_failure_does_not_automatically_retry(int status)
    {
        var (connection, db, e) = await Create();
        await using var ownedConnection = connection; await using var ownedDb = db;
        await new IntegrationRunner(db, new FakeClients { FailStatus = status, Failures = 3 },
            NullLogger<IntegrationRunner>.Instance).ProcessAsync(e, default);
        Assert.Equal("Failed", e.Status);
        Assert.Equal(1, e.Attempts);
        Assert.NotEmpty(e.Troubleshooting!);
    }
    [Fact]
    public async Task Validation_failure_never_reaches_ERP()
    {
        var (connection, db, e) = await Create();
        await using var ownedConnection = connection; await using var ownedDb = db;
        var fake = new FakeClients { InvalidOrder = true };
        await new IntegrationRunner(db, fake, NullLogger<IntegrationRunner>.Instance).ProcessAsync(e, default);
        Assert.Equal("Validation", e.ErrorClass);
        Assert.Empty(fake.Payloads);
    }
    [Fact]
    public async Task Malformed_JSON_is_a_validation_failure()
    {
        var (connection, db, e) = await Create();
        await using var ownedConnection = connection; await using var ownedDb = db;
        await new IntegrationRunner(db, new FakeClients { MalformedJson = true },
            NullLogger<IntegrationRunner>.Instance).ProcessAsync(e, default);
        Assert.Equal("Failed", e.Status);
        Assert.Equal("Validation", e.ErrorClass);
    }
    [Fact]
    public async Task Retry_retains_frozen_payload_when_CRM_changes()
    {
        var (connection, db, e) = await Create();
        await using var ownedConnection = connection; await using var ownedDb = db;
        var fake = new FakeClients { FailStatus = 503, Failures = 1 };
        var runner = new IntegrationRunner(db, fake, NullLogger<IntegrationRunner>.Instance);
        await runner.ProcessAsync(e, default);
        fake.Amount = 999;
        await runner.ProcessAsync(e, default);
        Assert.Equal(fake.Payloads[0], fake.Payloads[1]);
    }
}
public sealed class FakeClients : HttpMessageHandler, IHttpClientFactory
{
    public int FailStatus { get; set; }
    public int Failures { get; set; }
    public bool Timeout { get; set; }
    public bool InvalidOrder { get; set; }
    public bool MalformedJson { get; set; }
    public decimal Amount { get; set; } = 125.50m;
    public List<string> Payloads { get; } = [];
    public HttpClient CreateClient(string name) => new(this, false) { BaseAddress = new Uri("http://" + name.ToLowerInvariant() + "/") };
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        if (request.RequestUri!.Host == "crm")
        {
            if (MalformedJson) return new(HttpStatusCode.OK) { Content = new StringContent("{ invalid") };
            return new(HttpStatusCode.OK) { Content = JsonContent.Create(new CrmOrder("ORD-001", "C-100", "USD", InvalidOrder ? -1 : Amount)) };
        }
        Payloads.Add(await request.Content!.ReadAsStringAsync(ct));
        if (Timeout) throw new TaskCanceledException("simulated");
        if (Failures-- > 0) return new((HttpStatusCode)FailStatus);
        return new(HttpStatusCode.Created) { Content = JsonContent.Create(new Receipt("ORD-001", "receipt-001", false)) };
    }
}
