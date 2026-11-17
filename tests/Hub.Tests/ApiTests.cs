using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Hub.Infrastructure;
using Integration.Shared;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Tokens;

namespace Hub.Tests;
public class DemoFactory<T> : WebApplicationFactory<T> where T : class
{
    public static readonly string Key = Convert.ToHexString(RandomNumberGenerator.GetBytes(48));
    public static readonly string Password = Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
    public static readonly string ServiceKey = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
    private readonly string path = Path.Combine(Path.GetTempPath(), $"integration-test-{Guid.NewGuid():N}.db");
    public Dictionary<string, string?> Overrides { get; } = [];
    /// <summary>Replaces services for one test (e.g. a counting fake IHttpClientFactory).</summary>
    public Action<IServiceCollection>? ConfigureServices { get; set; }
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        builder.UseSetting("Jwt:Key", Key);
        builder.UseSetting("Demo:Password", Password);
        builder.UseSetting("Services:ApiKey", ServiceKey);
        builder.UseSetting("Worker:Enabled", "false");
        foreach (var (key, value) in Overrides) builder.UseSetting(key, value);
        builder.ConfigureTestServices(services => ConfigureServices?.Invoke(services));
        builder.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string,string?>
        {
            ["Jwt:Key"] = Key, ["Demo:Password"] = Password, ["Services:ApiKey"] = ServiceKey,
            ["Worker:Enabled"] = "false", ["Services:CRM"] = "http://localhost:5101/",
            ["Services:ERP"] = "http://localhost:5102/", ["ConnectionStrings:Database"] = $"Data Source={path};Pooling=False"
        }).AddInMemoryCollection(Overrides));
    }
    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing && File.Exists(path)) File.Delete(path);
    }
}
public class ApiTests
{
    private static async Task<HttpClient> Login(DemoFactory<Hub.Program> factory, string user = "operator")
    {
        var client = factory.CreateClient();
        var result = await client.PostAsJsonAsync("/api/auth/login", new { username = user, password = DemoFactory<Hub.Program>.Password });
        result.EnsureSuccessStatusCode();
        var auth = await result.Content.ReadFromJsonAsync<JsonElement>();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", auth.GetProperty("token").GetString());
        return client;
    }
    [Fact]
    public async Task Anonymous_and_invalid_credentials_are_rejected()
    {
        using var factory = new DemoFactory<Hub.Program>();
        using var client = factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/metrics")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsJsonAsync("/api/auth/login",
            new { username = "operator", password = "invalid" })).StatusCode);
    }
    [Fact]
    public async Task Login_is_rate_limited_by_default()
    {
        using var factory = new DemoFactory<Hub.Program>();
        using var client = factory.CreateClient();
        var statuses = new List<HttpStatusCode>();
        for (var i = 0; i < 11; i++)
            statuses.Add((await client.PostAsJsonAsync("/api/auth/login", new { username = "viewer", password = "invalid" })).StatusCode);
        Assert.All(statuses.Take(10), s => Assert.Equal(HttpStatusCode.Unauthorized, s));
        Assert.Equal(HttpStatusCode.TooManyRequests, statuses[10]);
    }
    [Fact]
    public async Task Viewer_can_monitor_but_cannot_run_or_retry()
    {
        using var factory = new DemoFactory<Hub.Program>();
        using var client = await Login(factory, "viewer");
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/metrics")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync("/api/executions", new { orderId = "ORD-001" })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync("/api/executions/x/retry", new { })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync("/api/jobs/simulate", new { environment = "DEV", fail = true })).StatusCode);
    }
    [Fact]
    public async Task Expired_token_is_rejected()
    {
        using var factory = new DemoFactory<Hub.Program>();
        using var client = factory.CreateClient();
        var expired = new JwtSecurityToken("integration-hub-demo", "integration-dashboard",
            [new Claim(ClaimTypes.Role, "Operator")], expires: DateTime.UtcNow.AddMinutes(-5),
            signingCredentials: new SigningCredentials(new SymmetricSecurityKey(Encoding.UTF8.GetBytes(DemoFactory<Hub.Program>.Key)),
                SecurityAlgorithms.HmacSha256));
        client.DefaultRequestHeaders.Authorization = new("Bearer", new JwtSecurityTokenHandler().WriteToken(expired));
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/metrics")).StatusCode);
    }
    [Fact]
    public async Task Submission_is_durable_searchable_and_deduplicated()
    {
        using var factory = new DemoFactory<Hub.Program>();
        using var client = await Login(factory);
        var start = await client.PostAsJsonAsync("/api/executions", new { orderId = "ORD-001" });
        Assert.Equal(HttpStatusCode.Accepted, start.StatusCode);
        var id = (await start.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString();
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsJsonAsync("/api/executions", new { orderId = "ORD-001" })).StatusCode);
        var page = await client.GetFromJsonAsync<JsonElement>("/api/executions?search=" + id);
        Assert.Equal(1, page.GetProperty("total").GetInt32());
        var detail = await client.GetFromJsonAsync<JsonElement>("/api/executions/" + id);
        Assert.Equal("Queued", detail.GetProperty("logs")[0].GetProperty("stage").GetString());
        Assert.EndsWith("Z", detail.GetProperty("createdAt").GetString());
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsJsonAsync("/api/executions/" + id + "/retry", new { })).StatusCode);
        var metrics = await client.GetFromJsonAsync<JsonElement>("/api/metrics");
        Assert.Equal(1, metrics.GetProperty("total").GetInt32());
    }
    [Fact]
    public async Task Retry_is_atomic_and_preserves_identity()
    {
        using var factory = new DemoFactory<Hub.Program>();
        using var client = await Login(factory);
        var start = await client.PostAsJsonAsync("/api/executions", new { orderId = "ORD-001" });
        var id = (await start.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString();
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<HubDb>();
            var e = await db.Executions.SingleAsync();
            e.Status = "Failed"; e.Scenario = "ServerError"; e.MappedPayload = "{\"frozen\":true}";
            await db.SaveChangesAsync();
        }
        Assert.Equal(HttpStatusCode.Accepted, (await client.PostAsJsonAsync("/api/executions/" + id + "/retry", new { })).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsJsonAsync("/api/executions/" + id + "/retry", new { })).StatusCode);
        var detail = await client.GetFromJsonAsync<JsonElement>("/api/executions/" + id);
        Assert.Equal("None", detail.GetProperty("scenario").GetString());
        Assert.Equal("{\"frozen\":true}", detail.GetProperty("mappedPayload").GetString());
        Assert.Equal(1, detail.GetProperty("retryCount").GetInt32());
    }
    [Theory]
    [InlineData("PROD", "None", "ERP")]
    [InlineData("DEV", "Unrecognized", "ERP")]
    [InlineData("DEV", "Validation", "ERP")]
    [InlineData("DEV", "Duplicate", "CRM")]
    public async Task Invalid_simulation_request_is_rejected(string environment, string scenario, string target)
    {
        using var factory = new DemoFactory<Hub.Program>();
        using var client = await Login(factory);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/executions",
            new { orderId = "ORD-001", environment, scenario, target })).StatusCode);
    }
    [Fact]
    public async Task Concurrent_submissions_create_exactly_one_execution()
    {
        using var factory = new DemoFactory<Hub.Program>();
        using var client = await Login(factory);
        var responses = await Task.WhenAll(Enumerable.Range(0, 6).Select(_ =>
            client.PostAsJsonAsync("/api/executions", new { orderId = "ORD-001" })));
        Assert.Single(responses, r => r.StatusCode == HttpStatusCode.Accepted);
        Assert.Equal(5, responses.Count(r => r.StatusCode == HttpStatusCode.Conflict));
        using var scope = factory.Services.CreateScope();
        Assert.Equal(1, await scope.ServiceProvider.GetRequiredService<HubDb>().Executions.CountAsync());
    }
    [Fact]
    public async Task CRM_outage_does_not_block_history_metrics_or_workloads()
    {
        using var factory = new DemoFactory<Hub.Program>();
        // Port 9 (discard) has no listener: connection refused, the same as a stopped CRM container.
        factory.Overrides["Services:CRM"] = "http://127.0.0.1:9/";
        using var client = await Login(factory, "viewer");
        var orders = await client.GetAsync("/api/orders");
        Assert.Equal(HttpStatusCode.BadGateway, orders.StatusCode);
        Assert.Equal("Mock CRM unavailable", (await orders.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("title").GetString());
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/metrics")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/executions?page=1")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/jobs")).StatusCode);
    }
    [Fact]
    public async Task Creation_and_manual_retry_are_attributed_in_the_audit_trail()
    {
        using var factory = new DemoFactory<Hub.Program>();
        using var client = await Login(factory);
        var start = await client.PostAsJsonAsync("/api/executions", new { orderId = "ORD-004", scenario = "ServerError", failuresBeforeSuccess = 3 });
        var id = (await start.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString();
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<HubDb>();
            var e = await db.Executions.SingleAsync();
            e.Status = "Failed"; e.Attempts = 3; e.ErrorClass = "UpstreamUnavailable";
            await db.SaveChangesAsync();
        }
        Assert.Equal(HttpStatusCode.Accepted, (await client.PostAsJsonAsync("/api/executions/" + id + "/retry", new { })).StatusCode);
        var detail = await client.GetFromJsonAsync<JsonElement>("/api/executions/" + id);
        var logs = detail.GetProperty("logs").EnumerateArray().ToArray();
        Assert.Contains("operator (Operator)", logs[0].GetProperty("message").GetString());
        Assert.Contains("ServerError", logs[0].GetProperty("message").GetString());
        var retry = logs[^1];
        Assert.Equal("ManualRetry", retry.GetProperty("stage").GetString());
        var message = retry.GetProperty("message").GetString()!;
        Assert.Contains("#1", message);
        Assert.Contains("operator (Operator)", message);
        Assert.Contains("UpstreamUnavailable on attempt 3", message);
        Assert.Equal(0, detail.GetProperty("attempts").GetInt32());
        Assert.Equal("Pending", detail.GetProperty("status").GetString());
        Assert.DoesNotContain("Bearer", string.Join("", logs.Select(l => l.GetProperty("message").GetString())));
    }
    [Fact]
    public async Task Workloads_are_synthetic_and_filterable()
    {
        using var factory = new DemoFactory<Hub.Program>();
        using var client = await Login(factory);
        var response = await client.PostAsJsonAsync("/api/jobs/simulate", new { environment = "TEST", fail = true });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var jobs = await client.GetFromJsonAsync<JsonElement[]>("/api/jobs?environment=TEST");
        Assert.All(jobs!, j => Assert.Equal("TEST", j.GetProperty("environment").GetString()));
        Assert.Equal("Failed", jobs![0].GetProperty("status").GetString());
    }
}
public class MockApiTests
{
    [Fact]
    public async Task ERP_replays_identical_payload_but_rejects_conflicting_payload()
    {
        using var factory = new DemoFactory<MockErp.Program>();
        using var client = factory.CreateClient();
        var order = new ErpOrder("O-1", "C-100", "USD", 5000);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsJsonAsync("/api/orders", order)).StatusCode);
        client.DefaultRequestHeaders.Add("X-Service-Key", DemoFactory<MockErp.Program>.ServiceKey);
        var first = await client.PostAsJsonAsync("/api/orders", order);
        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        var firstReceipt = await first.Content.ReadFromJsonAsync<Receipt>();
        var replay = await client.PostAsJsonAsync("/api/orders", order);
        var receipt = await replay.Content.ReadFromJsonAsync<Receipt>();
        Assert.True(receipt!.Duplicate);
        Assert.Equal(firstReceipt!.ReceiptId, receipt.ReceiptId);
        Assert.Equal(HttpStatusCode.Conflict,
            (await client.PostAsJsonAsync("/api/orders", order with { TotalMinorUnits = 999 })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest,
            (await client.PostAsJsonAsync("/api/orders", order with { ExternalOrderId = "O-2", TotalMinorUnits = -1 })).StatusCode);
    }
    [Fact]
    public async Task Concurrent_ERP_requests_return_one_durable_receipt()
    {
        using var factory = new DemoFactory<MockErp.Program>();
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Service-Key", DemoFactory<MockErp.Program>.ServiceKey);
        var responses = await Task.WhenAll(Enumerable.Range(0, 6).Select(_ =>
            client.PostAsJsonAsync("/api/orders", new ErpOrder("O-race", "C-100", "USD", 5000))));
        Assert.Single(responses, r => r.StatusCode == HttpStatusCode.Created);
        Assert.All(responses, r => Assert.True(r.IsSuccessStatusCode));
        var receipts = await Task.WhenAll(responses.Select(r => r.Content.ReadFromJsonAsync<Receipt>()));
        Assert.Single(receipts.Select(r => r!.ReceiptId).Distinct());
    }
    [Fact]
    public async Task CRM_exposes_seeded_orders_validates_and_simulates_errors()
    {
        using var factory = new DemoFactory<MockCrm.Program>();
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Service-Key", DemoFactory<MockCrm.Program>.ServiceKey);
        var orders = await client.GetFromJsonAsync<CrmOrder[]>("/api/orders");
        Assert.Equal(15, orders!.Length); // ORD-001…012 plus the lab scenarios ORD-013…015
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/orders",
            new CrmOrder("O-new", "missing", "USD", 1))).StatusCode);
        client.DefaultRequestHeaders.Add("X-Demo-Scenario", "Unavailable");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await client.GetAsync("/api/orders/ORD-001")).StatusCode);
    }
}
