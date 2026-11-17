using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Hub.Application;
using Hub.Infrastructure;
using Integration.Shared;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Hub.Tests;

/// <summary>Milestone B defect-review regressions: concurrent schema and record writes, value-only search, definition limits.</summary>
public class CatalogConcurrencyTests
{
    private static HttpClient Keyed<T>(DemoFactory<T> factory) where T : class
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Service-Key", DemoFactory<T>.ServiceKey);
        return client;
    }

    [Fact]
    public async Task Concurrent_schema_changes_never_fail_or_lose_a_version()
    {
        using var factory = new DemoFactory<MockCrm.Program>();
        using var client = Keyed(factory);
        await client.PostAsJsonAsync("/api/catalog/tables", new TableInput("crm_parallel", "Parallel", null, "id", [new("id", "string", true)]));
        var responses = await Task.WhenAll(Enumerable.Range(1, 12).Select(i =>
            client.PostAsJsonAsync("/api/catalog/tables/crm_parallel/schema", new { operation = "AddColumn", column = new { name = $"c{i}", type = "string" } })));
        Assert.All(responses, r => Assert.Equal(HttpStatusCode.OK, r.StatusCode));
        var detail = await client.GetFromJsonAsync<JsonElement>("/api/catalog/tables/crm_parallel");
        Assert.Equal(13, detail.GetProperty("table").GetProperty("version").GetInt32());
        Assert.Equal(13, detail.GetProperty("table").GetProperty("columns").GetArrayLength()); // every column kept: no lost update
        Assert.Equal(Enumerable.Range(1, 13).Reverse(), detail.GetProperty("versions").EnumerateArray().Select(v => v.GetProperty("version").GetInt32()));
    }

    [Fact]
    public async Task Record_writes_racing_a_column_removal_never_leave_orphaned_values()
    {
        using var factory = new DemoFactory<MockErp.Program>();
        using var client = Keyed(factory);
        for (var round = 0; round < 5; round++)
        {
            var table = $"erp_race_{round}";
            await client.PostAsJsonAsync("/api/catalog/tables", new TableInput(table, "Race", null, "id", [new("id", "string", true), new("note", "string")]));
            var writes = Enumerable.Range(1, 8).Select(i => client.PostAsJsonAsync($"/api/catalog/tables/{table}/records", new { id = $"R{i}", note = "keep me" }));
            var remove = client.PostAsJsonAsync($"/api/catalog/tables/{table}/schema", new { operation = "RemoveColumn", columnName = "note" });
            var all = await Task.WhenAll(writes.Append(remove));
            Assert.All(all, r => Assert.True((int)r.StatusCode < 500, $"Unexpected status {(int)r.StatusCode}"));
            var columns = (await client.GetFromJsonAsync<JsonElement>($"/api/catalog/tables/{table}")).GetProperty("table").GetProperty("columns")
                .EnumerateArray().Select(c => c.GetProperty("name").GetString()!).ToHashSet();
            var rows = (await client.GetFromJsonAsync<JsonElement>($"/api/catalog/tables/{table}/records?pageSize=100")).GetProperty("items").EnumerateArray().ToList();
            // Invariant: either the column survived (a row used it first) or no stored row holds a value for it.
            Assert.All(rows, r => Assert.All(r.GetProperty("data").EnumerateObject(), p => Assert.Contains(p.Name, columns)));
        }
    }

    [Fact]
    public async Task Search_matches_values_not_field_names()
    {
        using var factory = new DemoFactory<MockCrm.Program>();
        using var client = Keyed(factory);
        await client.PostAsJsonAsync("/api/catalog/tables", new TableInput("crm_search", "Search", null, "id",
            [new("id", "string", true), new("role", "enum", true, ["Buyer", "Finance"]), new("score", "integer")]));
        await client.PostAsJsonAsync("/api/catalog/tables/crm_search/records", new { id = "A-1", role = "Buyer", score = 42 });
        await client.PostAsJsonAsync("/api/catalog/tables/crm_search/records", new { id = "A-2", role = "Finance" });
        async Task<int> Total(string term) =>
            (await client.GetFromJsonAsync<JsonElement>("/api/catalog/tables/crm_search/records?search=" + term)).GetProperty("total").GetInt32();
        Assert.Equal(0, await Total("role"));   // a field name: previously matched every row
        Assert.Equal(1, await Total("buyer"));  // case-insensitive value match
        Assert.Equal(1, await Total("42"));     // numbers are searchable
        Assert.Equal(2, await Total("A-"));     // keys are values too
    }

    [Fact]
    public void Overlong_mapping_description_is_an_error_not_silently_dropped()
    {
        var crm = MockCrm.Program.BuiltInTables.Single(t => t.Definition.Name == "sales_orders").Definition;
        var erp = MockErp.Program.BuiltInTables.Single(t => t.Definition.Name == "imported_orders").Definition;
        var draft = new MappingDraft("Orders", new string('x', 301), new("crm", "sales_orders"), new("erp", "imported_orders"),
            [new("externalOrderId", "Copy", "id"), new("accountCode", "Copy", "customerId"), new("currencyCode", "Copy", "currency"),
             new("totalMinorUnits", "Multiply", "amount", Factor: 100)]);
        Assert.Contains(SchemaMapping.Validate(draft, crm, erp).Errors, e => e.Field == "description");
        Assert.True(SchemaMapping.Validate(draft with { Description = "ok" }, crm, erp).Valid);
    }
}

/// <summary>Records every request the Hub sends to the in-process CRM and ERP.</summary>
public sealed class RecordingClients(DemoFactory<MockCrm.Program> crm, DemoFactory<MockErp.Program> erp) : IHttpClientFactory
{
    public ConcurrentQueue<string> Calls { get; } = new();
    private sealed class Recorder(ConcurrentQueue<string> calls, string system) : DelegatingHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            calls.Enqueue($"{system} {request.Method} {request.RequestUri!.AbsolutePath}");
            return base.SendAsync(request, ct);
        }
    }
    public HttpClient CreateClient(string name)
    {
        var client = name == "CRM" ? crm.CreateDefaultClient(new Recorder(Calls, name)) : erp.CreateDefaultClient(new Recorder(Calls, name));
        client.DefaultRequestHeaders.Add("X-Service-Key", name == "CRM" ? DemoFactory<MockCrm.Program>.ServiceKey : DemoFactory<MockErp.Program>.ServiceKey);
        return client;
    }
}

/// <summary>Mapping previews and saved definitions are configuration only: they never write to the ERP or start an execution.</summary>
public class MappingIsolationTests
{
    [Fact]
    public async Task Previews_and_saved_definitions_only_read_catalog_metadata_and_never_write_to_the_ERP()
    {
        using var crm = new DemoFactory<MockCrm.Program>();
        using var erp = new DemoFactory<MockErp.Program>();
        var recording = new RecordingClients(crm, erp);
        using var hub = new DemoFactory<Hub.Program> { ConfigureServices = s => s.AddSingleton<IHttpClientFactory>(recording) };
        var client = hub.CreateClient();
        var auth = await (await client.PostAsJsonAsync("/api/auth/login", new { username = "operator", password = DemoFactory<Hub.Program>.Password }))
            .Content.ReadFromJsonAsync<JsonElement>();
        client.DefaultRequestHeaders.Authorization = new("Bearer", auth.GetProperty("token").GetString());
        using var erpDirect = erp.CreateClient();
        erpDirect.DefaultRequestHeaders.Add("X-Service-Key", DemoFactory<MockErp.Program>.ServiceKey);
        var customersBefore = await erpDirect.GetStringAsync("/api/customers");
        var historyBefore = await erpDirect.GetStringAsync("/api/history?take=200");

        var draft = new
        {
            name = "Customer master", source = new { system = "crm", table = "customers" }, target = new { system = "erp", table = "customer_master" },
            fields = new object[]
            {
                new { target = "accountCode", transform = "Uppercase", source = "customerId" },
                new { target = "displayName", transform = "Trim", source = "customerName" },
                new { target = "emailAddress", transform = "Lowercase", source = "email" },
                new { target = "accountStatus", transform = "Lookup", source = "status",
                      lookup = new Dictionary<string, string> { ["Active"] = "ACTIVE", ["Inactive"] = "INACTIVE", ["OnHold"] = "BLOCKED" } }
            }
        };
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/mapping-designer/suggest", new { draft.source, draft.target })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/mapping-designer/validate", draft)).StatusCode);
        var preview = await client.PostAsJsonAsync("/api/mapping-designer/preview",
            new { draft, sample = new { customerId = "c-900", customerName = " Preview Only Co ", email = "NEW@PREVIEW.example", status = "Active" } });
        Assert.Equal("C-900", (await preview.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("output").GetProperty("accountCode").GetString());
        Assert.Equal(HttpStatusCode.Created, (await client.PostAsJsonAsync("/api/mapping-definitions", draft)).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await client.PostAsJsonAsync("/api/mapping-definitions", draft)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/mapping-definitions/Customer%20master")).StatusCode);

        // Every upstream call was a read of catalog metadata; nothing reached the ERP's import, order or fixture routes.
        Assert.NotEmpty(recording.Calls);
        Assert.All(recording.Calls, c => Assert.Matches(@"^(CRM|ERP) GET /api/catalog/tables/[a-z_]+$", c));
        Assert.Equal(customersBefore, await erpDirect.GetStringAsync("/api/customers"));
        Assert.Equal(historyBefore, await erpDirect.GetStringAsync("/api/history?take=200"));
        Assert.Empty((await erpDirect.GetFromJsonAsync<JsonElement[]>("/api/orders"))!);
        Assert.DoesNotContain("C-900", await erpDirect.GetStringAsync("/api/customers"));
        using var scope = hub.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HubDb>();
        Assert.Equal(0, await db.Executions.CountAsync());
        Assert.Equal(2, await db.MappingDefinitions.CountAsync());
    }
}
