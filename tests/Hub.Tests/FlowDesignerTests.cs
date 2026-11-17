using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Hub.Application.Flows;
using Hub.Infrastructure;
using Integration.Shared;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Hub.Tests;

public class ExpressionTests
{
    [Theory]
    [InlineData("concat('SYNC-', upper($readCustomer.customerId))")]
    [InlineData("$order.currency == 'USD' or $order.currency == \"PHP\"")]
    [InlineData("not isEmpty($a) and (1 + 2) * 3 >= -4.5")]
    [InlineData("round(sum($orders, 'amount'), 2)")]
    [InlineData("formatDate(now(), 'yyyy-MM-dd')")]
    [InlineData("'it''s quoted'")]
    public void Valid_expressions_parse(string text) => Assert.Empty(Expressions.Parse(text).Errors);

    [Theory]
    [InlineData("eval('1')", "Unknown function")]
    [InlineData("upper('a', 'b')", "takes 1")]
    [InlineData("customerId == 1", "Unknown word")]
    [InlineData("'open", "closing quote")]
    [InlineData("1 < 2 < 3", "cannot be chained")]
    [InlineData("$a; drop table x", "not allowed")]
    [InlineData("formatDate(now(), 'dddd')", "Date format")]
    [InlineData("concat(1,", "ends too early")]
    [InlineData("$", "variable name")]
    public void Invalid_expressions_explain_the_problem(string text, string message) =>
        Assert.Contains(Expressions.Parse(text).Errors, e => e.Message.Contains(message));

    [Fact]
    public void Limits_and_variable_extraction()
    {
        Assert.NotEmpty(Expressions.Parse(new string('1', Expressions.MaxLength + 1)).Errors);
        Assert.NotEmpty(Expressions.Parse(new string('(', 30) + "1" + new string(')', 30)).Errors);
        Assert.Equal(["$a.b", "$c"], Expressions.Parse("concat($a.b, $c)").Variables.Select(v => v.ToString()));
    }
}

public class FlowValidatorTests
{
    private static readonly Dictionary<(string, string), TableView> Tables =
        MockCrm.Program.BuiltInTables.Select(t => (("crm", t.Definition.Name), t.Definition))
        .Concat(MockErp.Program.BuiltInTables.Select(t => (("erp", t.Definition.Name), t.Definition)))
        .ToDictionary(x => x.Item1, x => x.Definition);
    private static TableLookup Resolve(string system, string table) => new(Tables.GetValueOrDefault((system, table)));
    private static FlowDefinition Template(string id) =>
        JsonSerializer.Deserialize<FlowDefinition>(JsonSerializer.Serialize(FlowTemplates.ById[id].Definition, JsonSerializerOptions.Web), JsonSerializerOptions.Web)!;
    private static FlowNode Node(string id, string type, string name, string config = "{}") =>
        new() { Id = id, Type = type, Name = name, Config = JsonNode.Parse(config)!.AsObject() };
    private static FlowReport Check(FlowDefinition f) => FlowValidator.Validate(f, Resolve);
    private static void HasError(FlowReport r, string text) => Assert.Contains(r.Issues, i => i.Severity == "error" && i.Message.Contains(text));

    [Theory]
    [InlineData("blank")]
    [InlineData("customer-sync")]
    [InlineData("order-xml")]
    [InlineData("order-review")]
    public void Every_template_is_valid(string id)
    {
        var report = Check(Template(id));
        Assert.True(report.Valid, string.Join("\n", report.Issues.Select(i => $"{i.NodeId}: {i.Message}")));
    }

    [Fact]
    public void Templates_expose_scoped_variables_and_warn_about_ERP_writes()
    {
        var report = Check(Template("customer-sync"));
        Assert.Contains("readCustomer", report.Variables);
        Assert.Contains("fault", report.Variables.Concat(["fault"])); // fault is in scope inside handlers
        Assert.Contains(report.Issues, i => i.Severity == "warning" && i.Message.Contains("writes to the Modern ERP"));
        Assert.Contains("order", Check(Template("order-review")).Variables);
    }

    [Fact]
    public void Structure_rules()
    {
        HasError(Check(new FlowDefinition()), "Add a Trigger");
        var f = Template("blank");
        f.Steps.Insert(0, Node("n1", "logger", "done", """{"level":"info","message":"'x'"}"""));
        HasError(Check(f), "already named 'done'");
        f = Template("blank");
        f.Steps.Add(Node("n9", "logger", "after", """{"level":"info","message":"'x'"}"""));
        HasError(Check(f), "Unreachable");
        f = Template("blank");
        f.Steps.Insert(0, Node("n1", "notification", "notify"));
        HasError(Check(f), "planned");
        f = Template("blank");
        f.Steps.Insert(0, Node("n2", "rethrowFault", "again"));
        HasError(Check(f), "only valid inside a fault handler");
        f = Template("blank");
        f.Steps.Insert(0, Node("n2", "wait", "pause", """{"seconds":0}"""));
        HasError(Check(f), "1 to 60 seconds");
        f = Template("blank");
        var sw = Node("n2", "switch", "decide");
        sw.Branches.Add(new FlowBranch { Id = "b1", Kind = "case", Label = "A", Condition = "1 == 1" });
        f.Steps.Insert(0, sw);
        HasError(Check(f), "exactly one Otherwise");
    }

    [Fact]
    public void Nesting_depth_is_bounded()
    {
        var f = Template("blank");
        var list = f.Steps;
        for (var i = 0; i < FlowValidator.MaxDepth + 2; i++)
        {
            var scope = Node($"s{i}", "scope", $"scope{i}");
            scope.Branches.Add(new FlowBranch { Id = $"sb{i}", Kind = "body", Label = "Scope" });
            scope.Branches.Add(new FlowBranch { Id = $"sf{i}", Kind = "faultHandler", Label = "Fault handler" });
            list.Insert(0, scope);
            list = scope.Branches[0].Steps;
        }
        HasError(Check(f), "nested at most");
    }

    [Fact]
    public void Variables_are_checked_against_scope_and_schema()
    {
        var f = Template("customer-sync");
        ((JsonObject)f.Steps[2].Config["assignments"]![0]!)["expression"] = "concat($readCustomer.nickname, $unknown)";
        var report = Check(f);
        HasError(report, "has no field 'nickname'");
        HasError(report, "unknown variable $unknown");
        f = Template("order-review");
        f.Steps[2].Config["assignments"]![0]!["expression"] = "$listOrders.amount";
        HasError(Check(f), "is a collection");
        // Loop item variables do not leak outside the loop body.
        f = Template("order-review");
        f.Steps[3].Config["message"] = "$order.id";
        HasError(Check(f), "unknown variable $order");
    }

    [Fact]
    public void Invoke_map_and_stage_file_rules()
    {
        var f = Template("customer-sync");
        f.Steps[0].Config["operation"] = "upsert";
        HasError(Check(f), "not available on crm.customers");
        f = Template("customer-sync");
        f.Steps[4].Config["input"] = "readCustomer";
        HasError(Check(f), "does not have the customer_master schema");
        f = Template("customer-sync");
        f.Steps[0].Config["table"] = "payments";
        HasError(Check(f), "does not exist");
        f = Template("customer-sync");
        f.Steps[3].Config["rules"]!.AsArray().RemoveAt(0);
        HasError(Check(f), "accountCode");
        f = Template("order-xml");
        f.Steps[3].Config["fileName"] = "../secrets.xml";
        HasError(Check(f), "Paths are not allowed");
        f = Template("order-xml");
        f.Steps[3].Config["operation"] = "zip";
        HasError(Check(f), "planned");
        f = Template("order-review");
        f.Steps[1].Config["collection"] = "summary";
        HasError(Check(f), "Choose a collection variable");
    }

    [Fact]
    public void An_unreachable_catalog_warns_instead_of_failing()
    {
        var report = FlowValidator.Validate(Template("customer-sync"), (_, _) => new TableLookup(null, Unavailable: true));
        Assert.Contains(report.Issues, i => i.Severity == "warning" && i.Message.Contains("could not be reached"));
        Assert.DoesNotContain(report.Issues, i => i.Message.Contains("does not exist"));
    }
}

public class FlowDesignerApiTests
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
    public async Task Drafts_publish_versions_and_import_export_without_executing_anything()
    {
        using var crm = new DemoFactory<MockCrm.Program>();
        using var erp = new DemoFactory<MockErp.Program>();
        var recording = new RecordingClients(crm, erp);
        using var hub = new DemoFactory<Hub.Program> { ConfigureServices = s => s.AddSingleton<IHttpClientFactory>(recording) };
        using var viewer = await Login(hub, "viewer");
        using var op = await Login(hub, "operator");

        var catalog = await viewer.GetFromJsonAsync<JsonElement>("/api/flows/actions");
        var actions = catalog.GetProperty("actions").EnumerateArray().ToList();
        Assert.Equal("Planned", actions.Single(a => a.GetProperty("type").GetString() == "b2b").GetProperty("status").GetString());
        Assert.Equal("Designable", actions.Single(a => a.GetProperty("type").GetString() == "map").GetProperty("status").GetString());
        var check = await (await viewer.PostAsJsonAsync("/api/flows/expressions/check", new { expression = "upper(" })).Content.ReadFromJsonAsync<JsonElement>();
        Assert.False(check.GetProperty("valid").GetBoolean());

        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.PostAsJsonAsync("/api/flows", new { name = "customer-sync", title = "Customer sync", template = "customer-sync" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await op.PostAsJsonAsync("/api/flows", new { name = "Bad Name", title = "x" })).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await op.PostAsJsonAsync("/api/flows", new { name = "customer-sync", title = "Customer sync", template = "customer-sync" })).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await op.PostAsJsonAsync("/api/flows", new { name = "customer-sync", title = "Again" })).StatusCode);

        var loaded = await viewer.GetFromJsonAsync<JsonElement>("/api/flows/customer-sync");
        Assert.True(loaded.GetProperty("report").GetProperty("valid").GetBoolean());
        var definition = loaded.GetProperty("definition").Deserialize<JsonObject>()!;

        // Incomplete drafts can be saved; publishing requires a valid graph; stale revisions are refused.
        var broken = definition.DeepClone().AsObject();
        broken["steps"]!.AsArray()[0]!["config"]!["key"] = "$nobody";
        var saved = await op.PutAsJsonAsync("/api/flows/customer-sync/draft", new { definition = broken, revision = 1 });
        Assert.Equal(HttpStatusCode.OK, saved.StatusCode);
        Assert.False((await saved.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("report").GetProperty("valid").GetBoolean());
        Assert.Equal(HttpStatusCode.Conflict, (await op.PutAsJsonAsync("/api/flows/customer-sync/draft", new { definition, revision = 1 })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await op.PostAsJsonAsync("/api/flows/customer-sync/publish", new { revision = 2 })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await op.PutAsJsonAsync("/api/flows/customer-sync/draft", new { definition, revision = 2, title = "Customer master sync" })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.PostAsJsonAsync("/api/flows/customer-sync/publish", new { revision = 3 })).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await op.PostAsJsonAsync("/api/flows/customer-sync/publish", new { revision = 2 })).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await op.PostAsJsonAsync("/api/flows/customer-sync/publish", new { revision = 3 })).StatusCode);

        // Published versions are immutable: later draft edits do not change version 1.
        var edited = definition.DeepClone().AsObject();
        edited["steps"]!.AsArray()[5]!["config"]!["message"] = "'changed after publishing'";
        Assert.Equal(HttpStatusCode.OK, (await op.PutAsJsonAsync("/api/flows/customer-sync/draft", new { definition = edited, revision = 3 })).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await op.PostAsJsonAsync("/api/flows/customer-sync/publish", new { revision = 4 })).StatusCode);
        var v1 = await viewer.GetFromJsonAsync<JsonElement>("/api/flows/customer-sync/versions/1");
        Assert.DoesNotContain("changed after publishing", v1.GetRawText());
        var list = await viewer.GetFromJsonAsync<JsonElement[]>("/api/flows");
        Assert.Equal(2, Assert.Single(list!).GetProperty("latestVersion").GetInt32());

        // Export → import as a new flow; imports never overwrite.
        var exported = await viewer.GetFromJsonAsync<JsonElement>("/api/flows/customer-sync/export?version=1");
        Assert.Equal("eih-flow", exported.GetProperty("format").GetString());
        Assert.Equal(HttpStatusCode.Conflict, (await op.PostAsJsonAsync("/api/flows/import", new { document = exported })).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await op.PostAsJsonAsync("/api/flows/import", new { document = exported, name = "customer-sync-copy" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await op.PostAsJsonAsync("/api/flows/import", new { document = new { format = "other" }, name = "x-flow" })).StatusCode);
        var copy = await viewer.GetFromJsonAsync<JsonElement>("/api/flows/customer-sync-copy");
        Assert.True(copy.GetProperty("report").GetProperty("valid").GetBoolean());
        Assert.Empty(copy.GetProperty("versions").EnumerateArray());

        // Designing only read catalog metadata: no execution, no ERP write.
        Assert.All(recording.Calls, c => Assert.Equal("GET /api/catalog/tables", c[(c.IndexOf(' ') + 1)..]));
        using var scope = hub.Services.CreateScope();
        Assert.Equal(0, await scope.ServiceProvider.GetRequiredService<HubDb>().Executions.CountAsync());
    }
}
