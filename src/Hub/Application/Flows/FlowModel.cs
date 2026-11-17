using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Integration.Shared;

namespace Hub.Application.Flows;

// =====================================================================================================================
// Integration Designer model. A flow is a structured orchestration tree: a trigger, an ordered sequence of actions,
// container actions whose children are named sequences (Switch cases, loop bodies, Scope body and fault handler,
// Parallel branches) and an optional global fault handler. Order is the connection, so every graph is well-formed.
// Milestone C designs and validates flows; nothing here executes them.
// =====================================================================================================================

public sealed class FlowDefinition
{
    public int SchemaVersion { get; set; } = 1;
    public FlowNode? Trigger { get; set; }
    public List<FlowNode> Steps { get; set; } = [];
    public List<FlowNode> GlobalFaultHandler { get; set; } = [];
}
public sealed class FlowNode
{
    public string Id { get; set; } = "";
    public string Type { get; set; } = "";
    public string Name { get; set; } = "";
    public string? Description { get; set; }
    public JsonObject Config { get; set; } = [];
    public List<FlowBranch> Branches { get; set; } = [];
}
public sealed class FlowBranch
{
    public string Id { get; set; } = "";
    /// <summary>case, otherwise, body, faultHandler or branch.</summary>
    public string Kind { get; set; } = "body";
    public string Label { get; set; } = "";
    public string? Condition { get; set; }
    public List<FlowNode> Steps { get; set; } = [];
}
public sealed record FlowIssue(string? NodeId, string Severity, string Message, string? Field = null);
public sealed record FlowReport(bool Valid, List<FlowIssue> Issues, int NodeCount, List<string> Variables);

public sealed record BranchTemplate(string Kind, string Label);
public sealed record ActionDef(string Type, string Label, string Category, string Status, string Description,
    BranchTemplate[] Branches, string? Planned = null, string[]? Operations = null);

/// <summary>Every action in the backlog, with an honest status. "Designable" actions can be configured and validated;
/// none execute before Milestone D. "Planned" actions are listed but cannot be added to a flow.</summary>
public static class ActionCatalog
{
    private const string D = "Designable", P = "Planned";
    private static readonly BranchTemplate[] None = [];
    public static readonly ActionDef[] All =
    [
        new("trigger", "Trigger", "Connectivity", D, "Starts the flow manually with typed sample parameters.", None),
        new("invoke", "Invoke", "Connectivity", D, "Calls an allowlisted operation on a Legacy CRM or Modern ERP table.", None, Operations: ["list", "get", "create", "update", "upsert"]),
        new("assign", "Assign", "Actions", D, "Sets named variables from safe expressions.", None),
        new("map", "Map", "Actions", D, "Transforms records to a target table schema with allowlisted field rules.", None),
        new("logger", "Logger", "Actions", D, "Writes a message to the execution log.", None),
        new("note", "Note", "Actions", D, "A design-time annotation. It never executes.", None),
        new("wait", "Wait", "Actions", D, "Pauses for 1 to 60 seconds.", None),
        new("stageFile", "Stage File", "Actions", D, "Writes or reads XML, JSON or CSV files in the sandboxed stage area.", None,
            Operations: ["writeFile", "readFile", "listFiles", "readSegments", "zip", "unzip", "encrypt", "decrypt"]),
        new("switch", "Switch", "Logic", D, "Runs the first branch whose condition is true, otherwise the Otherwise branch.",
            [new("case", "Case 1"), new("otherwise", "Otherwise")]),
        new("forEach", "For Each", "Logic", D, "Repeats its body for each item of a bounded collection.", [new("body", "For each item")]),
        new("while", "While", "Logic", D, "Repeats its body while a condition holds, up to a fixed iteration limit.", [new("body", "While")]),
        new("scope", "Scope", "Logic", D, "Groups actions with their own fault handler.", [new("body", "Scope"), new("faultHandler", "Fault handler")]),
        new("parallel", "Parallel", "Logic", D, "Independent branches (Milestone D runs them one after another, bounded).", [new("branch", "Branch 1"), new("branch", "Branch 2")]),
        new("throwFault", "Throw New Fault", "Error Handling", D, "Raises a named business fault.", None),
        new("rethrowFault", "Re-throw Fault", "Error Handling", D, "Inside a fault handler: passes the current fault outward.", None),
        new("return", "Return", "End", D, "Ends the flow successfully, optionally with an output value.", None),
        new("faultReturn", "Fault Return", "End", D, "Ends the flow with a named fault.", None),
        new("stop", "Stop", "End", D, "Ends the flow immediately.", None),
        new("dataStitch", "Data Stitch", "Actions", P, "Merge partial payloads into a variable.", None, "Milestone E"),
        new("dataTranslate", "Data Translate", "Actions", P, "Convert between data formats.", None, "Milestone E"),
        new("notification", "Notification", "Actions", P, "Send a notification (would need a local mail sink).", None, "Future"),
        new("integrationCall", "Integration Call", "Connectivity", P, "Call another published flow.", None, "Milestone E"),
        new("jsFunction", "Safe Functions", "Connectivity", P, "Reusable allowlisted function libraries (no executable JavaScript).", None, "Milestone E"),
        new("fileServer", "File Server", "Connectivity", P, "Read files from a local sandboxed file server.", None, "Future"),
        new("decision", "Decision", "Connectivity", P, "Evaluate a decision table.", None, "Future"),
        new("publishEvent", "Publish Event", "Connectivity", P, "Publish a business event to local subscribers.", None, "Future"),
        new("humanApproval", "Human Approval", "Connectivity", P, "Wait for an Operator approval task.", None, "Future"),
        new("process", "Process", "Connectivity", P, "Start a long-running business process.", None, "Unsupported in this portfolio"),
        new("robotFlow", "Robot Flow", "Connectivity", P, "Robotic process automation.", None, "Unsupported in this portfolio"),
        new("b2b", "B2B", "Actions", P, "Trading-partner document exchange.", None, "Unsupported in this portfolio"),
        new("healthcare", "Healthcare", "Actions", P, "Healthcare message standards.", None, "Unsupported in this portfolio"),
        new("ociFunction", "Cloud Functions", "Connectivity", P, "Serverless functions. No external services are used.", None, "Unsupported in this portfolio"),
        new("callback", "Callback", "End", P, "Asynchronous response to the caller.", None, "Milestone E"),
    ];
    public static readonly Dictionary<string, ActionDef> ByType = All.ToDictionary(a => a.Type);
    public static readonly string[] DesignableStageOperations = ["writeFile", "readFile", "listFiles"];
    public static readonly string[] Terminal = ["return", "faultReturn", "stop", "throwFault", "rethrowFault"];
    public static readonly string[] Containers = ["switch", "forEach", "while", "scope", "parallel"];
}

/// <summary>What a variable holds, so references and Map/Invoke inputs can be checked before anything runs.</summary>
public sealed record VarType(string Kind, TableView? Table, string Source, IReadOnlyList<string>? Fields = null)
{
    public static VarType Scalar(string source) => new("scalar", null, source);
}

/// <summary>Resolves a catalog table; null when the table does not exist, Unavailable when the system could not be reached.</summary>
public delegate TableLookup TableResolver(string system, string table);
public sealed record TableLookup(TableView? Table, bool Unavailable = false);
/// <summary>A saved connection, as the validator needs it (no secrets exist on connections).</summary>
public sealed record ConnectionRef(string Identifier, string Name, string Application, string Role);
public delegate ConnectionRef? ConnectionResolver(string identifier);

public static partial class FlowValidator
{
    public const int MaxNodes = 150, MaxDepth = 6, MaxDefinitionBytes = 262_144;
    [GeneratedRegex("^[a-z][A-Za-z0-9_]{0,39}$")] private static partial Regex Identifier();
    [GeneratedRegex("^[A-Za-z0-9_-]{1,60}$")] private static partial Regex NodeId();
    [GeneratedRegex("^[A-Za-z][A-Za-z0-9_]{0,39}$")] private static partial Regex FaultCode();
    [GeneratedRegex("^[A-Za-z0-9][A-Za-z0-9_-]{0,59}\\.(xml|json|csv)$")] private static partial Regex FileName();
    [GeneratedRegex("^[A-Za-z_][A-Za-z0-9_.-]{0,59}$")] private static partial Regex XmlName();
    public static bool ValidIdentifier(string? s) => s is not null && Identifier().IsMatch(s);
    private static readonly string[] ParamTypes = ["string", "integer", "decimal", "boolean", "date"];
    private static readonly string[] Reserved = ["trigger", "fault", "flow", "item"];

    /// <summary>Allowlisted operations per table: built-in tables expose only what their application's API supports.</summary>
    public static string[] Operations(string system, TableView table) => (system, table.Name, table.BuiltIn) switch
    {
        ("crm", "customers" or "sales_orders", true) => ["list", "get"],
        ("erp", "customer_master", true) => ["list", "get", "upsert"],
        ("erp", "imported_orders", true) => ["list", "get", "create"],
        (_, _, true) => ["list", "get"],
        _ => ["list", "get", "create", "update"],
    };

    public static FlowReport Validate(FlowDefinition? flow, TableResolver tables, ConnectionResolver? connections = null)
    {
        var ctx = new Context(tables, connections ?? (_ => null));
        if (flow is null) return new(false, [new(null, "error", "The flow definition is missing.")], 0, []);
        if (flow.SchemaVersion != 1) ctx.Error(null, "Unsupported flow schema version.");
        var scope = new Dictionary<string, VarType>();
        if (flow.Trigger is null) ctx.Error(null, "Add a Trigger: every flow starts with one.");
        else
        {
            ctx.Register(flow.Trigger);
            ctx.TriggerNode = flow.Trigger;
            if (flow.Trigger.Type != "trigger") ctx.Error(flow.Trigger.Id, "The first action must be a Trigger.");
            else Trigger(flow.Trigger, scope, ctx);
        }
        if (flow.Steps.Count == 0) ctx.Error(null, "Add at least one action after the Start trigger (use + on the canvas).");
        Sequence(flow.Steps, scope, ctx, depth: 0, inFault: false, inLoop: false);
        if (flow.GlobalFaultHandler.Count > 0)
        {
            var faultScope = new Dictionary<string, VarType>(scope) { ["fault"] = new("record", null, "fault", ["code", "message", "nodeId"]) };
            Sequence(flow.GlobalFaultHandler, faultScope, ctx, depth: 0, inFault: true, inLoop: false);
        }
        if (ctx.NodeCount > MaxNodes) ctx.Error(null, $"Flows are limited to {MaxNodes} actions.");
        return new(ctx.Issues.All(i => i.Severity != "error"), ctx.Issues, ctx.NodeCount, ctx.AllVariables.Order().ToList());
    }

    private sealed class Context(TableResolver tables, ConnectionResolver connections)
    {
        public List<FlowIssue> Issues { get; } = [];
        public HashSet<string> Ids { get; } = [];
        public HashSet<string> Names { get; } = [];
        public HashSet<string> AllVariables { get; } = [];
        public TableResolver Tables { get; } = tables;
        public ConnectionResolver Connections { get; } = connections;
        public FlowNode? TriggerNode;
        public int NodeCount;
        public void Error(string? node, string message, string? field = null) => Issues.Add(new(node, "error", message, field));
        public void Warning(string? node, string message, string? field = null) => Issues.Add(new(node, "warning", message, field));
        public void Register(FlowNode node)
        {
            NodeCount++;
            if (!NodeId().IsMatch(node.Id ?? "")) Error(node.Id, "Action IDs use 1-60 letters, digits, '_' or '-'.");
            else if (!Ids.Add(node.Id!)) Error(node.Id, $"Duplicate action ID '{node.Id}'.");
            if (!ValidIdentifier(node.Name)) Error(node.Id, "Name the action with a letter-first identifier (e.g. readCustomer); it is also its output variable.", "name");
            else if (Reserved.Contains(node.Name)) Error(node.Id, $"'{node.Name}' is reserved.", "name");
            else if (!Names.Add(node.Name)) Error(node.Id, $"Another action is already named '{node.Name}'.", "name");
            if (node.Description?.Length > 500) Error(node.Id, "Descriptions are limited to 500 characters.", "description");
        }
    }

    private static string? Str(JsonObject c, string key) => c.TryGetPropertyValue(key, out var v) && v is JsonValue j && j.TryGetValue<string>(out var s) ? s : null;
    private static int? Int(JsonObject c, string key) => c.TryGetPropertyValue(key, out var v) && v is JsonValue j && j.TryGetValue<int>(out var i) ? i
        : c.TryGetPropertyValue(key, out v) && v is JsonValue d && d.TryGetValue<double>(out var dd) && dd == Math.Floor(dd) ? (int)dd : null;
    private static JsonArray Arr(JsonObject c, string key) => c.TryGetPropertyValue(key, out var v) && v is JsonArray a ? a : [];

    /// <summary>Internal relative path: lowercase literal segments and {parameter} segments, e.g. /customers/{customerId}/sync.</summary>
    [GeneratedRegex(@"^(/([a-z0-9][a-z0-9_-]*|\{[A-Za-z][A-Za-z0-9_]{0,39}\}))+$")] private static partial Regex EndpointPath();
    [GeneratedRegex("\\{([A-Za-z][A-Za-z0-9_]{0,39})\\}")] private static partial Regex PathParam();
    [GeneratedRegex("^([01][0-9]|2[0-3]):[0-5][0-9]$")] private static partial Regex TimeOfDay();
    public static readonly string[] TriggerModes = ["manual", "rest", "schedule"];
    public static readonly string[] Frequencies = ["manual", "daily", "weekly", "monthly"];
    public static readonly string[] WeekDays = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

    private static List<string> Parameters(FlowNode node, JsonArray list, string label, Context ctx)
    {
        var parameters = list.OfType<JsonObject>().ToList();
        if (parameters.Count > 10) ctx.Error(node.Id, $"At most 10 {label}.", "parameters");
        var names = new List<string>();
        foreach (var p in parameters)
        {
            var name = Str(p, "name");
            if (!ValidIdentifier(name)) { ctx.Error(node.Id, $"Parameter name '{name}' must be a letter-first identifier.", "parameters"); continue; }
            if (names.Contains(name!)) ctx.Error(node.Id, $"Parameter '{name}' is defined twice.", "parameters");
            if (!ParamTypes.Contains(Str(p, "type"))) ctx.Error(node.Id, $"Parameter '{name}' needs a type: {string.Join(", ", ParamTypes)}.", "parameters");
            if (Str(p, "sample")?.Length > 200) ctx.Error(node.Id, $"Sample or default value for '{name}' is limited to 200 characters.", "parameters");
            names.Add(name!);
        }
        return names;
    }

    /// <summary>Start of the flow: a manual practice trigger, an Application REST endpoint (design-time) or a schedule (design-time).</summary>
    private static void Trigger(FlowNode node, Dictionary<string, VarType> scope, Context ctx)
    {
        var c = node.Config ?? [];
        var mode = Str(c, "mode") ?? "manual";
        var fields = new List<string>();
        switch (mode)
        {
            case "manual":
                fields = Parameters(node, Arr(c, "parameters"), "trigger parameters", ctx);
                break;
            case "schedule":
                var frequency = Str(c, "frequency") ?? "manual";
                if (!Frequencies.Contains(frequency)) ctx.Error(node.Id, $"Choose a frequency: {string.Join(", ", Frequencies)}.", "frequency");
                if (frequency != "manual" && !TimeOfDay().IsMatch(Str(c, "time") ?? "")) ctx.Error(node.Id, "Set the run time as HH:mm (24-hour).", "time");
                if (frequency == "weekly")
                {
                    var days = Arr(c, "daysOfWeek").Select(d => d?.ToString()).ToList();
                    if (days.Count == 0 || days.Any(d => !WeekDays.Contains(d))) ctx.Error(node.Id, "Choose one or more weekdays (MON-SUN).", "daysOfWeek");
                }
                if (frequency == "monthly" && Int(c, "dayOfMonth") is not (>= 1 and <= 28)) ctx.Error(node.Id, "Choose a day of the month from 1 to 28.", "dayOfMonth");
                var tz = Str(c, "timezone") ?? "UTC";
                if (tz.Length > 64 || !TimeZoneInfo.TryFindSystemTimeZoneById(tz, out _)) ctx.Error(node.Id, $"Unknown time zone '{tz}'. Use an IANA name such as Asia/Manila or UTC.", "timezone");
                fields = Parameters(node, Arr(c, "parameters"), "schedule parameters", ctx);
                ctx.Warning(node.Id, "The schedule is design-time only: no background job is created until a later runtime milestone.");
                break;
            case "rest":
                var connectionId = Str(c, "connection");
                if (connectionId is null) { ctx.Error(node.Id, "Configure the Start trigger: choose an Application connection and define its REST endpoint.", "connection"); break; }
                var connection = ctx.Connections(connectionId);
                if (connection is null) { ctx.Error(node.Id, $"Connection {connectionId} does not exist.", "connection"); break; }
                if (!Connections.ConnectionCatalog.AllowsRole(connection.Role, "Trigger")) { ctx.Error(node.Id, $"Connection {connectionId} has the role {connection.Role}; a trigger needs Trigger.", "connection"); break; }
                if (c["endpoint"] is not JsonObject e) { ctx.Error(node.Id, "Define the inbound REST endpoint (trigger wizard).", "endpoint"); break; }
                var method = Str(e, "method");
                if (method is not ("GET" or "POST" or "PUT")) ctx.Error(node.Id, "Choose GET, POST or PUT for the endpoint.", "endpoint");
                var path = Str(e, "path") ?? "";
                if (path.Length > 100 || !EndpointPath().IsMatch(path)) ctx.Error(node.Id, "The internal path starts with '/', uses lowercase letters, digits, '-', '_', '/' and {parameters}, max 100 characters.", "endpoint");
                var pathParams = PathParam().Matches(path).Select(m => m.Groups[1].Value).ToList();
                var declared = Parameters(node, Arr(e, "parameters"), "path and query parameters", ctx);
                foreach (var missing in pathParams.Except(declared)) ctx.Error(node.Id, $"Path parameter {{{missing}}} is not declared.", "endpoint");
                fields = declared;
                if (e["request"] is JsonObject req)
                {
                    if (method == "GET") ctx.Error(node.Id, "A GET endpoint cannot have a request body.", "endpoint");
                    else if (TableRef(req, ctx, node, "request") is { } t) { scope["request"] = new("record", t, node.Name); ctx.AllVariables.Add("request"); }
                }
                if (e["response"] is JsonObject res) TableRef(res, ctx, node, "response");
                break;
            default:
                ctx.Error(node.Id, $"Unknown trigger mode '{mode}'.", "mode");
                break;
        }
        scope["trigger"] = new("record", null, node.Name, fields);
        ctx.AllVariables.Add("trigger");
    }
    /// <summary>Resolves a {system, table} contract reference.</summary>
    private static TableView? TableRef(JsonObject r, Context ctx, FlowNode node, string what)
    {
        var system = Str(r, "system"); var table = Str(r, "table");
        if (system is not ("crm" or "erp") || !CatalogRules.ValidTableName(table)) { ctx.Error(node.Id, $"Choose a {what} schema table.", what); return null; }
        var lookup = ctx.Tables(system, table!);
        if (lookup.Unavailable) { ctx.Warning(node.Id, $"The {system.ToUpperInvariant()} catalog could not be reached; the {what} schema was not verified.", what); return null; }
        if (lookup.Table is null) ctx.Error(node.Id, $"The {what} schema table '{table}' does not exist.", what);
        return lookup.Table;
    }
    /// <summary>Request contract of an Invoke: its target table and whether its operation sends a body.</summary>
    private static (string System, TableView? Table, bool Body)? InvokeContract(FlowNode invoke, Context ctx)
    {
        var c = invoke.Config ?? [];
        if (Str(c, "system") is not ("crm" or "erp") || !CatalogRules.ValidTableName(Str(c, "table"))) return null;
        var lookup = ctx.Tables(Str(c, "system")!, Str(c, "table")!);
        return (Str(c, "system")!, lookup.Table, Str(c, "operation") is "create" or "update" or "upsert");
    }

    private static void Sequence(List<FlowNode> steps, Dictionary<string, VarType> scope, Context ctx, int depth, bool inFault, bool inLoop)
    {
        if (depth > MaxDepth) { ctx.Error(null, $"Containers can be nested at most {MaxDepth} levels deep."); return; }
        string? terminatedBy = null;
        steps ??= [];
        for (var i = 0; i < steps.Count; i++)
        {
            var node = steps[i];
            if (node is null) { ctx.Error(null, "Empty action entry."); continue; }
            ctx.Register(node);
            if (terminatedBy is not null) ctx.Error(node.Id, $"Unreachable: it follows '{terminatedBy}', which ends this path.");
            if (!ActionCatalog.ByType.TryGetValue(node.Type ?? "", out var def)) { ctx.Error(node.Id, $"Unknown action type '{node.Type}'."); continue; }
            if (def.Status == "Planned") { ctx.Error(node.Id, $"{def.Label} is planned ({def.Planned}) and not available in this release."); continue; }
            if (node.Type == "trigger") { ctx.Error(node.Id, "Only the first action can be a Trigger."); continue; }
            Action(node, scope, ctx, depth, inFault, inLoop, previous: i > 0 ? steps[i - 1] : null, next: i + 1 < steps.Count ? steps[i + 1] : null, root: depth == 0 && !inFault);
            if (ActionCatalog.Terminal.Contains(node.Type)) terminatedBy = node.Name;
        }
    }

    private static void Action(FlowNode n, Dictionary<string, VarType> scope, Context ctx, int depth, bool inFault, bool inLoop,
        FlowNode? previous = null, FlowNode? next = null, bool root = false)
    {
        var c = n.Config ?? [];
        void Expression(string? text, string field, bool required = true)
        {
            if (string.IsNullOrWhiteSpace(text)) { if (required) ctx.Error(n.Id, $"Enter an expression for {field}.", field); return; }
            CheckExpression(text, field, n.Id, scope, ctx);
        }
        void Define(string name, VarType type) { scope[name] = type; ctx.AllVariables.Add(name); }
        if (!ActionCatalog.Containers.Contains(n.Type) && n.Branches.Count > 0) ctx.Error(n.Id, $"{n.Type} cannot contain other actions.");
        switch (n.Type)
        {
            case "assign":
                var assignments = Arr(c, "assignments").OfType<JsonObject>().ToList();
                if (assignments.Count is 0 or > 20) ctx.Error(n.Id, "Add 1 to 20 assignments.", "assignments");
                foreach (var a in assignments)
                {
                    var variable = Str(a, "variable");
                    if (!ValidIdentifier(variable) || Reserved.Contains(variable)) { ctx.Error(n.Id, $"Variable name '{variable}' must be a letter-first identifier and not reserved.", "assignments"); continue; }
                    if (scope.TryGetValue(variable!, out var existing) && existing.Kind != "scalar")
                        ctx.Error(n.Id, $"'{variable}' already holds {existing.Kind} data from {existing.Source}; choose another name.", "assignments");
                    Expression(Str(a, "expression"), $"{variable} expression");
                    Define(variable!, VarType.Scalar(n.Name));
                }
                break;
            case "invoke":
                var system = Str(c, "system"); var tableName = Str(c, "table"); var operation = Str(c, "operation");
                // Connection-backed invokes (Milestone C.1). Invokes without a connection come from earlier designs or templates.
                var connectionId = Str(c, "connection");
                if (connectionId is null) ctx.Warning(n.Id, "Not linked to a connection. Use Edit endpoint to choose a configured connection.", "connection");
                else if (ctx.Connections(connectionId) is not { } conn) { ctx.Error(n.Id, $"Connection {connectionId} does not exist.", "connection"); break; }
                else if (!Connections.ConnectionCatalog.AllowsRole(conn.Role, "Invoke")) { ctx.Error(n.Id, $"Connection {connectionId} has the role {conn.Role}; an Invoke needs Invoke.", "connection"); break; }
                else if (conn.Application == "data-catalog")
                {
                    if (system is not ("crm" or "erp") || operation is not ("catalogTables" or "catalogTable")) { ctx.Error(n.Id, "Choose a Data Catalog operation.", "operation"); break; }
                    if (operation == "catalogTable") Expression(Str(c, "key"), "table name");
                    Define(n.Name, new(operation == "catalogTables" ? "collection" : "record", null, n.Name, ["name", "title", "primaryKey", "version", "builtIn", "recordCount"]));
                    break;
                }
                else if (Connections.ConnectionCatalog.ById.GetValueOrDefault(conn.Application)?.System is { } connSystem && connSystem != system)
                { ctx.Error(n.Id, $"Connection {connectionId} reaches the {connSystem.ToUpperInvariant()}, but the operation targets the {system?.ToUpperInvariant()}.", "connection"); break; }
                if (system is not ("crm" or "erp")) { ctx.Error(n.Id, "Choose the Legacy CRM or the Modern ERP.", "system"); break; }
                if (!CatalogRules.ValidTableName(tableName)) { ctx.Error(n.Id, "Choose a table.", "table"); break; }
                var lookup = ctx.Tables(system, tableName!);
                if (lookup.Unavailable) { ctx.Warning(n.Id, $"The {system.ToUpperInvariant()} catalog could not be reached, so '{tableName}' was not verified.", "table"); Define(n.Name, new("record", null, n.Name)); break; }
                if (lookup.Table is not { } table) { ctx.Error(n.Id, $"Table '{tableName}' does not exist in the {system.ToUpperInvariant()} catalog.", "table"); break; }
                var allowed = Operations(system, table);
                if (!allowed.Contains(operation)) { ctx.Error(n.Id, $"Operation '{operation}' is not available on {system}.{table.Name}. Allowed: {string.Join(", ", allowed)}.", "operation"); break; }
                if (operation is "get" or "update") Expression(Str(c, "key"), "key");
                if (operation is "create" or "update" or "upsert")
                {
                    var input = Str(c, "input");
                    if (input is null && !(previous is { Type: "map" } p && Str(p.Config, "purpose") == "invokeRequest" && Str(p.Config, "for") == n.Id))
                        ctx.Error(n.Id, "This operation sends a request body: add a request mapping directly before the Invoke (Edit endpoint adds one).", "input");
                    else if (input is null || !scope.TryGetValue(input, out var inputType)) ctx.Error(n.Id, "Choose the input variable to send (usually a Map output).", "input");
                    else if (inputType.Table is null || inputType.Table.Name != table.Name)
                        ctx.Error(n.Id, $"'{input}' does not have the {table.Name} schema. Map it to {system}.{table.Name} first.", "input");
                    else if (inputType.Kind == "collection") ctx.Error(n.Id, $"'{input}' is a collection; send one record per call inside a For Each.", "input");
                    if (system == "erp") ctx.Warning(n.Id, "This call writes to the Modern ERP when the flow runs (Milestone D). Nothing is sent while designing.");
                }
                if (operation == "list" && Int(c, "limit") is int limit && limit is < 1 or > 500) ctx.Error(n.Id, "List limit must be 1 to 500.", "limit");
                Define(n.Name, new(operation == "list" ? "collection" : "record", table, n.Name));
                break;
            case "map":
                // Mapping points give the map its contract: the request of the next Invoke, the response of an Invoke,
                // the Application trigger's response, or the structure of the next Stage File write.
                var purpose = Str(c, "purpose") ?? "explicit";
                var forId = Str(c, "for");
                switch (purpose)
                {
                    case "explicit": break;
                    case "invokeRequest":
                        if (next is not { Type: "invoke" } || next.Id != forId) { ctx.Error(n.Id, "A request mapping must sit directly before the Invoke it feeds. Move it back, or change it to an explicit Map.", "purpose"); break; }
                        var contract = InvokeContract(next, ctx);
                        if (contract is { Body: false }) ctx.Error(n.Id, $"Invoke {next.Name} no longer sends a request body. This mapping is kept with its rules; delete it or choose an operation with a body.", "purpose");
                        else if (contract is { Table: { } ct } && (Str(c, "targetSystem") != contract.Value.System || Str(c, "targetTable") != ct.Name))
                            ctx.Error(n.Id, $"Invoke {next.Name} now expects {contract.Value.System}.{ct.Name}. Review this mapping: its rules are kept until you change them.", "purpose");
                        if (Str(next.Config, "input") != n.Name) ctx.Warning(n.Id, $"Invoke {next.Name} does not send this mapping's output (${n.Name}).", "purpose");
                        break;
                    case "invokeResponse":
                        if (forId is null || Str(c, "input") is not { } respInput || !scope.TryGetValue(respInput, out var resp) || resp.Source != respInput)
                            ctx.Error(n.Id, "A response mapping reads the output of an earlier Invoke. Choose that Invoke's output as the input.", "input");
                        break;
                    case "triggerResponse":
                        var responseRef = ctx.TriggerNode?.Config?["endpoint"]?["response"] as JsonObject;
                        if (responseRef is null) { ctx.Error(n.Id, "The Start trigger has no response schema. Configure one in the trigger wizard, or change this to an explicit Map.", "purpose"); break; }
                        if (Str(responseRef, "system") != Str(c, "targetSystem") || Str(responseRef, "table") != Str(c, "targetTable"))
                            ctx.Error(n.Id, "The trigger response schema changed. Review this mapping: its rules are kept.", "purpose");
                        if (!root) ctx.Warning(n.Id, "Trigger response mappings normally sit in the main flow, before Return.", "purpose");
                        break;
                    case "stageFile":
                        if (next is not { Type: "stageFile" } || next.Id != forId) ctx.Error(n.Id, "A file structure mapping must sit directly before its Stage File write.", "purpose");
                        else if (Str(next.Config, "input") != n.Name) ctx.Warning(n.Id, $"Stage File {next.Name} does not write this mapping's output (${n.Name}).", "purpose");
                        break;
                    default: ctx.Error(n.Id, $"Unknown mapping purpose '{purpose}'.", "purpose"); break;
                }
                var inputName = Str(c, "input");
                if (inputName is null || !scope.TryGetValue(inputName, out var source) || source.Table is null)
                { ctx.Error(n.Id, purpose == "explicit" ? "Choose an input variable that holds table records (an Invoke output or a For Each item)."
                    : "This mapping is not configured yet: choose its source variable and map the fields.", "input"); break; }
                var targetSystem = Str(c, "targetSystem"); var targetTable = Str(c, "targetTable");
                if (targetSystem is not ("crm" or "erp") || !CatalogRules.ValidTableName(targetTable)) { ctx.Error(n.Id, "Choose a target table.", "targetTable"); break; }
                var target = ctx.Tables(targetSystem, targetTable!);
                if (target.Unavailable) { ctx.Warning(n.Id, "The target catalog could not be reached; the mapping was not verified.", "targetTable"); Define(n.Name, new(source.Kind, null, n.Name)); break; }
                if (target.Table is null) { ctx.Error(n.Id, $"Target table '{targetTable}' does not exist.", "targetTable"); break; }
                List<FieldRule> rules;
                try { rules = (c["rules"] as JsonArray)?.Deserialize<List<FieldRule>>(JsonSerializerOptions.Web) ?? []; }
                catch (JsonException) { ctx.Error(n.Id, "The field rules are malformed.", "rules"); break; }
                var report = SchemaMapping.Validate(new(n.Name, null, new("flow", source.Table.Name), new(targetSystem, targetTable!), rules), source.Table, target.Table);
                foreach (var e in report.Errors.Where(e => e.Field != "name")) ctx.Error(n.Id, $"{e.Field}: {e.Message}", "rules");
                foreach (var w in report.Warnings) ctx.Warning(n.Id, $"{w.Field}: {w.Message}", "rules");
                Define(n.Name, new(source.Kind, target.Table, n.Name));
                break;
            case "logger":
                if (Str(c, "level") is not ("info" or "warning" or "error")) ctx.Error(n.Id, "Choose a log level: info, warning or error.", "level");
                Expression(Str(c, "message"), "message");
                break;
            case "note":
                if (string.IsNullOrWhiteSpace(Str(c, "text")) || Str(c, "text")!.Length > 1000) ctx.Error(n.Id, "Write the note (max 1000 characters).", "text");
                break;
            case "wait":
                if (Int(c, "seconds") is not (>= 1 and <= 60)) ctx.Error(n.Id, "Wait 1 to 60 seconds.", "seconds");
                if (inLoop) ctx.Warning(n.Id, "A Wait inside a loop multiplies the run time.");
                break;
            case "stageFile":
                var op = Str(c, "operation");
                if (op is not null && !ActionCatalog.DesignableStageOperations.Contains(op) && ActionCatalog.ByType["stageFile"].Operations!.Contains(op))
                { ctx.Error(n.Id, $"Stage File '{op}' is planned for a later milestone.", "operation"); break; }
                if (!ActionCatalog.DesignableStageOperations.Contains(op)) { ctx.Error(n.Id, "Choose writeFile, readFile or listFiles.", "operation"); break; }
                if (op != "listFiles")
                {
                    var file = Str(c, "fileName");
                    if (file is null || !FileName().IsMatch(file)) ctx.Error(n.Id, "File names are 1-60 letters, digits, '_' or '-' with .xml, .json or .csv. Paths are not allowed: files live in the sandboxed stage area.", "fileName");
                    else if (Str(c, "format") is { } fmt && !file.EndsWith("." + fmt, StringComparison.Ordinal)) ctx.Error(n.Id, $"The file extension must match the {fmt} format.", "fileName");
                    if (Str(c, "format") is not ("xml" or "json" or "csv")) ctx.Error(n.Id, "Choose xml, json or csv.", "format");
                }
                if (op == "writeFile")
                {
                    var data = Str(c, "input");
                    if (data is null || !scope.TryGetValue(data, out var dataType) || dataType.Kind == "scalar") ctx.Error(n.Id, "Choose a record or collection variable to write (usually a Map output).", "input");
                    if (Str(c, "format") == "xml")
                    {
                        if (!XmlName().IsMatch(Str(c, "rootElement") ?? "")) ctx.Error(n.Id, "Name the XML root element (letters, digits, '_', '-' or '.').", "rootElement");
                        if (!XmlName().IsMatch(Str(c, "recordElement") ?? "")) ctx.Error(n.Id, "Name the XML element for each record.", "recordElement");
                    }
                    Define(n.Name, new("record", null, n.Name, ["fileName", "format", "sizeBytes", "records"]));
                }
                else if (op == "readFile") Define(n.Name, new("collection", null, n.Name));
                else Define(n.Name, new("collection", null, n.Name, ["fileName", "format", "sizeBytes", "createdAt"]));
                break;
            case "switch":
                var cases = n.Branches.Where(b => b.Kind == "case").ToList();
                if (cases.Count == 0) ctx.Error(n.Id, "A Switch needs at least one case.");
                if (cases.Count > 10) ctx.Error(n.Id, "A Switch has at most 10 cases.");
                if (n.Branches.Count(b => b.Kind == "otherwise") != 1 || n.Branches.LastOrDefault()?.Kind != "otherwise")
                    ctx.Error(n.Id, "A Switch ends with exactly one Otherwise branch.");
                foreach (var b in n.Branches.Where(b => b.Kind is not ("case" or "otherwise"))) ctx.Error(n.Id, $"Switch branches are cases or Otherwise, not '{b.Kind}'.");
                foreach (var b in cases)
                {
                    if (string.IsNullOrWhiteSpace(b.Condition)) ctx.Error(n.Id, $"Case '{b.Label}' needs a condition.", "condition:" + b.Id);
                    else CheckExpression(b.Condition, $"condition of '{b.Label}'", n.Id, scope, ctx, "condition:" + b.Id);
                }
                Branches(n, scope, ctx, depth, inFault, inLoop);
                break;
            case "forEach":
                var collection = Str(c, "collection")?.TrimStart('$');
                var item = Str(c, "itemVariable");
                if (collection is null || !scope.TryGetValue(collection, out var listType) || listType.Kind != "collection")
                    ctx.Error(n.Id, "Choose a collection variable to iterate (for example an Invoke 'list' output).", "collection");
                if (!ValidIdentifier(item) || Reserved.Contains(item) || scope.ContainsKey(item!)) ctx.Error(n.Id, "Name the item variable with a new identifier (e.g. order).", "itemVariable");
                if (Int(c, "maxItems") is not (>= 1 and <= 500)) ctx.Error(n.Id, "Set a maximum of 1 to 500 items.", "maxItems");
                Body(n, ["body"], scope, ctx, depth, inFault, inLoop: true,
                    extra: ValidIdentifier(item) && collection is not null && scope.TryGetValue(collection, out var lt) ? new() { [item!] = lt with { Kind = "record", Source = n.Name } } : null);
                break;
            case "while":
                Expression(Str(c, "condition"), "condition");
                if (Int(c, "maxIterations") is not (>= 1 and <= 1000)) ctx.Error(n.Id, "Set a maximum of 1 to 1000 iterations.", "maxIterations");
                Body(n, ["body"], scope, ctx, depth, inFault, inLoop: true);
                break;
            case "scope":
                if (n.Branches.Count != 2 || n.Branches[0].Kind != "body" || n.Branches[1].Kind != "faultHandler") { ctx.Error(n.Id, "A Scope has a body and a fault handler."); break; }
                Sequence(n.Branches[0].Steps, new(scope), ctx, depth + 1, inFault, inLoop);
                if (n.Branches[0].Steps.Count == 0) ctx.Warning(n.Id, "The Scope body is empty.");
                Sequence(n.Branches[1].Steps, new(scope) { ["fault"] = new("record", null, "fault", ["code", "message", "nodeId"]) }, ctx, depth + 1, inFault: true, inLoop);
                break;
            case "parallel":
                if (n.Branches.Count is < 2 or > 5 || n.Branches.Any(b => b.Kind != "branch")) ctx.Error(n.Id, "A Parallel has 2 to 5 branches.");
                Branches(n, scope, ctx, depth, inFault, inLoop);
                break;
            case "throwFault":
            case "faultReturn":
                if (!FaultCode().IsMatch(Str(c, "code") ?? "")) ctx.Error(n.Id, "Name the fault code (e.g. CustomerNotFound).", "code");
                Expression(Str(c, "message"), "message");
                break;
            case "rethrowFault":
                if (!inFault) ctx.Error(n.Id, "Re-throw Fault is only valid inside a fault handler.");
                break;
            case "return":
                Expression(Str(c, "output"), "output", required: false);
                break;
            case "stop":
                break;
        }
    }
    private static void Branches(FlowNode n, Dictionary<string, VarType> scope, Context ctx, int depth, bool inFault, bool inLoop)
    {
        foreach (var b in n.Branches) Sequence(b.Steps, new(scope), ctx, depth + 1, inFault, inLoop);
    }
    private static void Body(FlowNode n, string[] kinds, Dictionary<string, VarType> scope, Context ctx, int depth, bool inFault, bool inLoop,
        Dictionary<string, VarType>? extra = null)
    {
        if (n.Branches.Count != 1 || !kinds.Contains(n.Branches[0].Kind)) { ctx.Error(n.Id, $"{n.Type} has exactly one body."); return; }
        var inner = new Dictionary<string, VarType>(scope);
        foreach (var (k, v) in extra ?? []) { inner[k] = v; ctx.AllVariables.Add(k); }
        if (n.Branches[0].Steps.Count == 0) ctx.Warning(n.Id, "The loop body is empty.");
        Sequence(n.Branches[0].Steps, inner, ctx, depth + 1, inFault, inLoop);
    }

    /// <summary>Parses an expression and checks every variable reference against the variables in scope at that point.</summary>
    private static void CheckExpression(string text, string field, string nodeId, Dictionary<string, VarType> scope, Context ctx, string? fieldKey = null)
    {
        var parsed = Expressions.Parse(text);
        foreach (var e in parsed.Errors) ctx.Error(nodeId, $"{field}: {e.Message} (position {e.Position + 1})", fieldKey ?? field);
        foreach (var v in parsed.Variables)
        {
            if (!scope.TryGetValue(v.Name, out var type))
            { ctx.Error(nodeId, $"{field}: unknown variable ${v.Name}. Available here: {(scope.Count == 0 ? "none" : string.Join(", ", scope.Keys.Order().Select(k => "$" + k)))}.", fieldKey ?? field); continue; }
            if (v.Path.Length == 0) continue;
            if (type.Kind == "scalar") { ctx.Error(nodeId, $"{field}: ${v.Name} is a single value and has no field '{v.Path[0]}'.", fieldKey ?? field); continue; }
            if (type.Kind == "collection") { ctx.Error(nodeId, $"{field}: ${v.Name} is a collection. Use For Each, or count()/sum()/first().", fieldKey ?? field); continue; }
            var fields = type.Table?.Columns.Select(col => col.Name).ToList() ?? type.Fields?.ToList();
            if (fields is not null && !fields.Contains(v.Path[0]))
                ctx.Error(nodeId, $"{field}: ${v.Name} has no field '{v.Path[0]}'. Fields: {string.Join(", ", fields)}.", fieldKey ?? field);
            else if (v.Path.Length > 1) ctx.Error(nodeId, $"{field}: nested paths are not supported ('{v}').", fieldKey ?? field);
        }
    }
}
