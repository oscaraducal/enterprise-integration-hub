using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Hub.Application.Connections;
using Hub.Application.Flows;
using Hub.Infrastructure;
using Integration.Shared;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Hub.Tests;

/// <summary>Milestone C.1: blank starts, trigger modes, connection-backed invokes and context-aware mapping (validator only).</summary>
public class DesignerRefinementTests
{
    private static readonly Dictionary<(string, string), TableView> Tables =
        MockCrm.Program.BuiltInTables.Select(t => (("crm", t.Definition.Name), t.Definition))
        .Concat(MockErp.Program.BuiltInTables.Select(t => (("erp", t.Definition.Name), t.Definition)))
        .ToDictionary(x => x.Item1, x => x.Definition);
    private static TableLookup Resolve(string system, string table) => new(Tables.GetValueOrDefault((system, table)));
    private static readonly Dictionary<string, ConnectionRef> Connections = new()
    {
        ["CRM_REST"] = new("CRM_REST", "Legacy CRM", "legacy-crm", "Invoke"),
        ["ERP_REST"] = new("ERP_REST", "Modern ERP", "modern-erp", "Invoke"),
        ["HUB_TRIGGER"] = new("HUB_TRIGGER", "Hub trigger", "integration-hub", "Trigger"),
        ["CATALOG"] = new("CATALOG", "Catalog", "data-catalog", "Invoke"),
    };
    private static FlowReport Check(FlowDefinition f) => FlowValidator.Validate(f, Resolve, id => Connections.GetValueOrDefault(id));
    private static FlowNode Node(string id, string type, string name, string config = "{}") => new() { Id = id, Type = type, Name = name, Config = JsonNode.Parse(config)!.AsObject() };
    private static void HasError(FlowReport r, string text) => Assert.Contains(r.Issues, i => i.Severity == "error" && i.Message.Contains(text));
    private static void NoError(FlowReport r) => Assert.True(r.Valid, string.Join("\n", r.Issues.Where(i => i.Severity == "error").Select(i => i.Message)));

    [Theory]
    [InlineData("application", "rest")]
    [InlineData("schedule", "schedule")]
    [InlineData("manual", "manual")]
    public void Blank_integrations_contain_only_the_start_trigger(string style, string mode)
    {
        var f = FlowTemplates.Blank(style);
        Assert.Equal(("trigger", mode), (f.Trigger!.Type, f.Trigger.Config["mode"]!.GetValue<string>()));
        Assert.Empty(f.Steps); Assert.Empty(f.GlobalFaultHandler);
        Assert.Empty(FlowTemplates.ById["blank"].Definition.Steps);
        var report = Check(f);
        HasError(report, "Add at least one action");
        if (style == "application") HasError(report, "Configure the Start trigger");
    }

    private static FlowDefinition WithTrigger(string config, params FlowNode[] steps) => new()
    {
        Trigger = Node("t1", "trigger", "start", config), Steps = [.. steps, Node("r1", "return", "done")]
    };

    [Fact]
    public void Schedule_trigger_rules()
    {
        NoError(Check(WithTrigger("""{"mode":"schedule","frequency":"weekly","time":"06:30","daysOfWeek":["MON","FRI"],"timezone":"Asia/Manila","parameters":[{"name":"batchSize","type":"integer","sample":"50"}]}""", Node("l1", "logger", "log", """{"level":"info","message":"toString($trigger.batchSize)"}"""))));
        var r = Check(WithTrigger("""{"mode":"schedule","frequency":"weekly","time":"25:00","daysOfWeek":[],"timezone":"Mars/Olympus"}"""));
        HasError(r, "HH:mm"); HasError(r, "weekdays"); HasError(r, "Unknown time zone");
        HasError(Check(WithTrigger("""{"mode":"schedule","frequency":"monthly","time":"01:00","dayOfMonth":31,"timezone":"UTC"}""")), "1 to 28");
        Assert.Contains(Check(WithTrigger("""{"mode":"schedule","frequency":"manual","timezone":"UTC"}""")).Issues, i => i.Message.Contains("design-time only"));
    }

    [Fact]
    public void Application_REST_trigger_rules()
    {
        var good = """{"mode":"rest","connection":"HUB_TRIGGER","endpoint":{"name":"syncCustomer","method":"POST","path":"/customers/{customerId}/sync","parameters":[{"name":"customerId","type":"string"}],"request":{"system":"crm","table":"customers"},"response":{"system":"erp","table":"customer_master"}}}""";
        NoError(Check(WithTrigger(good, Node("l1", "logger", "log", """{"level":"info","message":"concat($trigger.customerId, $request.customerName)"}"""))));
        HasError(Check(WithTrigger("""{"mode":"rest"}""")), "Configure the Start trigger");
        HasError(Check(WithTrigger(good.Replace("HUB_TRIGGER", "CRM_REST"))), "a trigger needs Trigger");
        HasError(Check(WithTrigger(good.Replace("\"POST\"", "\"GET\""))), "GET endpoint cannot have a request body");
        HasError(Check(WithTrigger(good.Replace("[{\"name\":\"customerId\",\"type\":\"string\"}]", "[]"))), "{customerId} is not declared");
        HasError(Check(WithTrigger(good.Replace("/customers/", "https://evil.example/"))), "internal path");
    }

    private const string RequestMap = """{"purpose":"invokeRequest","for":"i2","input":"readCustomer","targetSystem":"erp","targetTable":"customer_master","rules":[{"target":"accountCode","transform":"Uppercase","source":"customerId"},{"target":"displayName","transform":"Trim","source":"customerName"},{"target":"emailAddress","transform":"Lowercase","source":"email"},{"target":"accountStatus","transform":"Lookup","source":"status","lookup":{"Active":"ACTIVE","Inactive":"INACTIVE","OnHold":"BLOCKED"}}]}""";
    private static FlowDefinition Sync(string upsertConfig, string map = RequestMap, bool mapFirst = true)
    {
        var read = Node("i1", "invoke", "readCustomer", """{"connection":"CRM_REST","system":"crm","table":"customers","operation":"get","key":"$trigger.id"}""");
        var request = Node("m1", "map", "mapRequest", map);
        var upsert = Node("i2", "invoke", "upsertCustomer", upsertConfig);
        return WithTrigger("""{"mode":"manual","parameters":[{"name":"id","type":"string"}]}""", mapFirst ? [read, request, upsert] : [read, upsert, request]);
    }
    private const string Upsert = """{"connection":"ERP_REST","system":"erp","table":"customer_master","operation":"upsert","key":"$mapRequest.accountCode","input":"mapRequest"}""";

    [Fact]
    public void Connection_backed_invokes_and_request_mapping_points()
    {
        NoError(Check(Sync(Upsert)));
        HasError(Check(Sync(Upsert.Replace("ERP_REST", "MISSING"))), "does not exist");
        HasError(Check(Sync(Upsert.Replace("ERP_REST", "HUB_TRIGGER"))), "an Invoke needs Invoke");
        HasError(Check(Sync(Upsert.Replace("ERP_REST", "CRM_REST"))), "reaches the CRM");
        // Placement: a request mapping must sit directly before its Invoke.
        HasError(Check(Sync(Upsert, mapFirst: false)), "directly before the Invoke");
        // A body operation without its request mapping.
        var noMap = Sync(Upsert.Replace(",\"input\":\"mapRequest\"", "")); noMap.Steps.RemoveAt(1);
        HasError(Check(noMap), "add a request mapping");
        // Operation changed to one without a body: the mapping and its rules are kept but flagged.
        var changed = Sync(Upsert.Replace("\"upsert\"", "\"get\""));
        HasError(Check(changed), "no longer sends a request body");
        Assert.Equal(4, changed.Steps[1].Config["rules"]!.AsArray().Count);
        // Target changed: rules are kept and the contract mismatch is reported.
        HasError(Check(Sync(Upsert.Replace("customer_master", "imported_orders").Replace("upsert", "create"))), "now expects erp.imported_orders");
        // Unconfigured request mapping created by the endpoint wizard.
        var blankMap = """{"purpose":"invokeRequest","for":"i2","input":"","targetSystem":"erp","targetTable":"customer_master","rules":[]}""";
        HasError(Check(Sync(Upsert, blankMap)), "not configured yet");
    }

    [Fact]
    public void Legacy_invokes_without_a_connection_still_validate_with_a_warning()
    {
        foreach (var t in new[] { "customer-sync", "order-xml", "order-review" })
        {
            var report = Check(JsonSerializer.Deserialize<FlowDefinition>(JsonSerializer.Serialize(FlowTemplates.ById[t].Definition, JsonSerializerOptions.Web), JsonSerializerOptions.Web)!);
            NoError(report);
            Assert.Contains(report.Issues, i => i.Severity == "warning" && i.Message.Contains("Not linked to a connection"));
        }
    }

    [Fact]
    public void Data_catalog_invokes_and_trigger_response_mapping()
    {
        var catalog = Node("i1", "invoke", "tables", """{"connection":"CATALOG","system":"crm","operation":"catalogTables"}""");
        var log = Node("l1", "logger", "log", """{"level":"info","message":"toString(count($tables))"}""");
        NoError(Check(WithTrigger("""{"mode":"manual"}""", catalog, log)));
        var responseMap = Node("m1", "map", "mapResponse", """{"purpose":"triggerResponse","input":"readCustomer","targetSystem":"erp","targetTable":"customer_master","rules":[]}""");
        var read = Node("i2", "invoke", "readCustomer", """{"connection":"CRM_REST","system":"crm","table":"customers","operation":"get","key":"'C-100'"}""");
        HasError(Check(WithTrigger("""{"mode":"manual"}""", read, responseMap)), "no response schema");
    }

    [Fact]
    public void Discovery_only_advertises_supported_operations()
    {
        List<TableView> Of(string s) => Tables.Where(t => t.Key.Item1 == s).Select(t => t.Value).ToList();
        var crm = ConnectionCatalog.Discover(ConnectionCatalog.ById["legacy-crm"], Of)!;
        Assert.Equal(["GET"], crm.Select(o => o.Method).Distinct());
        Assert.All(crm, o => Assert.False(o.RequestBody));
        var erp = ConnectionCatalog.Discover(ConnectionCatalog.ById["modern-erp"], Of)!;
        var upsert = erp.Single(o => o.Id == "erp.customer_master.upsert");
        Assert.Equal(("PUT", "/customer_master/{accountCode}", true), (upsert.Method, upsert.Path, upsert.RequestBody));
        Assert.DoesNotContain(upsert.Request!.Fields, f => f.ReadOnly); // request contract excludes application-managed fields
        Assert.Equal("POST", erp.Single(o => o.Id == "erp.imported_orders.create").Method);
        Assert.Null(ConnectionCatalog.Discover(ConnectionCatalog.ById["modern-erp"], _ => null));
        Assert.Equal(4, ConnectionCatalog.Discover(ConnectionCatalog.ById["data-catalog"], Of)!.Count);
    }
}

/// <summary>Connection Manager and integration creation through the Hub API against in-process CRM and ERP.</summary>
public class ConnectionManagerApiTests
{
    private static async Task<HttpClient> Login(DemoFactory<Hub.Program> hub, string user)
    {
        var client = hub.CreateClient();
        var auth = await (await client.PostAsJsonAsync("/api/auth/login", new { username = user, password = DemoFactory<Hub.Program>.Password }))
            .Content.ReadFromJsonAsync<JsonElement>();
        client.DefaultRequestHeaders.Authorization = new("Bearer", auth.GetProperty("token").GetString());
        return client;
    }

    [Fact]
    public async Task Connections_are_managed_safely_and_integrations_start_blank()
    {
        using var crm = new DemoFactory<MockCrm.Program>();
        using var erp = new DemoFactory<MockErp.Program>();
        var recording = new RecordingClients(crm, erp);
        using var hub = new DemoFactory<Hub.Program> { ConfigureServices = s => s.AddSingleton<IHttpClientFactory>(recording) };
        using var viewer = await Login(hub, "viewer");
        using var op = await Login(hub, "operator");

        // Applications are an allowlist; no secrets or URLs are exposed.
        var apps = await viewer.GetStringAsync("/api/connections/applications");
        Assert.Contains("legacy-crm", apps); Assert.Contains("integration-hub", apps);
        Assert.DoesNotContain(DemoFactory<Hub.Program>.ServiceKey, apps); Assert.DoesNotContain(DemoFactory<MockCrm.Program>.ServiceKey, apps);
        Assert.DoesNotContain("http://", apps);
        var ops = await viewer.GetFromJsonAsync<JsonElement>("/api/connections/applications/modern-erp/operations");
        Assert.Contains(ops.GetProperty("operations").EnumerateArray(), o => o.GetProperty("id").GetString() == "erp.customer_master.upsert");

        // CRUD and role rules.
        var crmConnection = new { identifier = "LEGACY_CRM_REST", name = "Legacy CRM REST", description = "Source system", adapter = "REST", role = "Invoke", application = "legacy-crm" };
        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.PostAsJsonAsync("/api/connections", crmConnection)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await op.PostAsJsonAsync("/api/connections", crmConnection with { role = "Trigger" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await op.PostAsJsonAsync("/api/connections", crmConnection with { application = "https://evil.example" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await op.PostAsJsonAsync("/api/connections", crmConnection with { identifier = "lower" })).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await op.PostAsJsonAsync("/api/connections", crmConnection)).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await op.PostAsJsonAsync("/api/connections", crmConnection)).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await op.PostAsJsonAsync("/api/connections",
            new { identifier = "HUB_TRIGGER", name = "Hub REST trigger", adapter = "REST", role = "Trigger", application = "integration-hub" })).StatusCode);

        // Safe test: health and metadata only.
        recording.Calls.Clear();
        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.PostAsync("/api/connections/LEGACY_CRM_REST/test", null)).StatusCode);
        var test = await (await op.PostAsync("/api/connections/LEGACY_CRM_REST/test", null)).Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(test.GetProperty("ok").GetBoolean());
        Assert.Equal("Configured", test.GetProperty("connection").GetProperty("status").GetString());
        Assert.Equal(["CRM GET /health", "CRM GET /api/catalog/tables"], recording.Calls.ToArray());
        var connOps = await viewer.GetFromJsonAsync<JsonElement>("/api/connections/LEGACY_CRM_REST/operations");
        Assert.All(connOps.GetProperty("operations").EnumerateArray(), o => Assert.Equal("GET", o.GetProperty("method").GetString()));

        // A new Application integration is blank: only an unconfigured Start trigger.
        var created = await op.PostAsJsonAsync("/api/flows", new { title = "Customer sync", identifier = "CUSTOMER_SYNC", versionLabel = "01.00.0000",
            style = "application", tags = new[] { "crm", "erp" }, description = "Practice" });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var flow = await viewer.GetFromJsonAsync<JsonElement>("/api/flows/customer-sync");
        Assert.Equal(("application", "CUSTOMER_SYNC", "01.00.0000"), (flow.GetProperty("style").GetString(), flow.GetProperty("identifier").GetString(), flow.GetProperty("versionLabel").GetString()));
        Assert.Equal(0, flow.GetProperty("definition").GetProperty("steps").GetArrayLength());
        Assert.Equal("rest", flow.GetProperty("definition").GetProperty("trigger").GetProperty("config").GetProperty("mode").GetString());
        Assert.False(flow.GetProperty("report").GetProperty("valid").GetBoolean());
        Assert.Equal(HttpStatusCode.BadRequest, (await op.PostAsJsonAsync("/api/flows", new { title = "x", identifier = "X_FLOW", style = "application", template = "customer-sync" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await op.PostAsJsonAsync("/api/flows", new { title = "x", identifier = "Y_FLOW", versionLabel = "1.0" })).StatusCode);
        // The Milestone C request shape still works.
        Assert.Equal(HttpStatusCode.Created, (await op.PostAsJsonAsync("/api/flows", new { name = "legacy-shape", title = "Legacy", template = "order-xml" })).StatusCode);
        Assert.Equal("manual", (await viewer.GetFromJsonAsync<JsonElement>("/api/flows/legacy-shape")).GetProperty("style").GetString());

        // Configure the trigger with the connection and save an incomplete draft; the connection is now in use.
        var definition = flow.GetProperty("definition").Deserialize<JsonObject>()!;
        definition["trigger"]!["config"] = JsonNode.Parse("""{"mode":"rest","connection":"HUB_TRIGGER","endpoint":{"name":"sync","method":"POST","path":"/customers","parameters":[],"request":{"system":"crm","table":"customers"}}}""");
        var saved = await op.PutAsJsonAsync("/api/flows/customer-sync/draft", new { definition, revision = 1 });
        Assert.Equal(HttpStatusCode.OK, saved.StatusCode);
        var report = (await saved.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("report");
        Assert.DoesNotContain(report.GetProperty("issues").EnumerateArray(), i => i.GetProperty("message").GetString()!.Contains("Configure the Start trigger"));
        var inUse = await op.DeleteAsync("/api/connections/HUB_TRIGGER");
        Assert.Equal(HttpStatusCode.Conflict, inUse.StatusCode);
        Assert.Contains("customer-sync (draft)", await inUse.Content.ReadAsStringAsync());
        Assert.Equal(HttpStatusCode.BadRequest, (await op.PutAsJsonAsync("/api/connections/HUB_TRIGGER", new { name = "Hub", role = "Invoke", revision = 1 })).StatusCode); // the Hub trigger application cannot be invoked
        Assert.Equal(HttpStatusCode.OK, (await op.PutAsJsonAsync("/api/connections/HUB_TRIGGER", new { name = "Hub REST trigger (renamed)", revision = 1 })).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await op.DeleteAsync("/api/connections/LEGACY_CRM_REST")).StatusCode);

        // Designing and testing never executed anything or wrote to the ERP.
        Assert.All(recording.Calls, c => Assert.Matches(@"^(CRM|ERP) GET /(health|api/catalog/tables)$", c));
        using var scope = hub.Services.CreateScope();
        Assert.Equal(0, await scope.ServiceProvider.GetRequiredService<HubDb>().Executions.CountAsync());
    }
}
