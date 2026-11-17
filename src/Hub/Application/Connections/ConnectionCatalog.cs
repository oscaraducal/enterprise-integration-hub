using Integration.Shared;
using Hub.Application.Flows;

namespace Hub.Application.Connections;

/// <summary>An approved internal application a connection can point at. URLs and credentials are resolved server-side.</summary>
public sealed record ApplicationDef(string Id, string Name, string Adapter, string[] Roles, string? System, string Description, string Security, string Endpoint);
public sealed record ParamDef(string Name, string Type, bool Required, string Description);
/// <summary>A request or response contract: one record or a collection of records with known fields.</summary>
public sealed record SchemaRef(string Kind, string? System, string? Table, IReadOnlyList<ColumnDef> Fields);
public sealed record OperationDef(string Id, string Method, string Path, string Operation, string? System, string? Table, bool RequestBody,
    SchemaRef? Request, SchemaRef? Response, ParamDef[] PathParams, ParamDef[] QueryParams, string Description);

public static class ConnectionCatalog
{
    public static readonly string[] Roles = ["Trigger", "Invoke", "TriggerAndInvoke"];
    public const string ServiceKeySecurity = "API key header added by the Integration Hub on every call. The key is held server-side and is never sent to the browser.";
    public static readonly ApplicationDef[] Applications =
    [
        new("legacy-crm", "Legacy CRM", "REST", ["Invoke"], "crm", "The fictional source application: customers, sales orders and logical Data Catalog tables.",
            ServiceKeySecurity, "Internal CRM service (resolved by the Hub; not configurable)"),
        new("modern-erp", "Modern ERP", "REST", ["Invoke"], "erp", "The fictional target application: customer master, imported orders and logical tables.",
            ServiceKeySecurity, "Internal ERP service (resolved by the Hub; not configurable)"),
        new("data-catalog", "Data Catalog metadata", "REST", ["Invoke"], null, "Read-only table metadata of both applications (tables, columns, keys, schema versions).",
            ServiceKeySecurity, "Internal CRM and ERP catalog routes (resolved by the Hub)"),
        new("integration-hub", "Integration Hub REST trigger", "REST", ["Trigger"], null,
            "An inbound REST endpoint that starts an integration. Design-time only: endpoints are not activated or reachable from outside.",
            "Callers would authenticate with a Hub JWT (Operator role). No endpoint is published in this release.", "Integration Hub (local)"),
    ];
    public static readonly Dictionary<string, ApplicationDef> ById = Applications.ToDictionary(a => a.Id);
    public static bool AllowsRole(string connectionRole, string needed) => connectionRole == needed || connectionRole == "TriggerAndInvoke";
    public static string[] AllowedConnectionRoles(ApplicationDef app) =>
        app.Roles.Contains("Trigger") && app.Roles.Contains("Invoke") ? Roles : app.Roles;

    private static readonly ColumnDef[] TableMetaFields =
    [
        new("name", "string", true), new("title", "string", true), new("primaryKey", "string", true),
        new("version", "integer", true), new("builtIn", "boolean", true), new("recordCount", "integer")
    ];

    /// <summary>Operations an application genuinely supports, derived from the live catalogs. Null when a needed catalog is unreachable.</summary>
    public static List<OperationDef>? Discover(ApplicationDef app, Func<string, List<TableView>?> catalog)
    {
        var ops = new List<OperationDef>();
        switch (app.Id)
        {
            case "legacy-crm" or "modern-erp":
                var tables = catalog(app.System!);
                if (tables is null) return null;
                foreach (var t in tables) ops.AddRange(TableOperations(app.System!, t));
                break;
            case "data-catalog":
                foreach (var system in new[] { "crm", "erp" })
                {
                    if (catalog(system) is null) return null;
                    ops.Add(new($"catalog.{system}.tables", "GET", $"/catalog/{system}/tables", "catalogTables", system, null, false, null,
                        new("collection", system, null, TableMetaFields), [], [], $"List the {system.ToUpperInvariant()} Data Catalog tables."));
                    ops.Add(new($"catalog.{system}.table", "GET", $"/catalog/{system}/tables/{{name}}", "catalogTable", system, null, false, null,
                        new("record", system, null, TableMetaFields), [new("name", "string", true, "Table name")], [], $"Get one {system.ToUpperInvariant()} table definition."));
                }
                break;
        }
        return ops;
    }
    public static IEnumerable<OperationDef> TableOperations(string system, TableView t)
    {
        var record = new SchemaRef("record", system, t.Name, t.Columns);
        var collection = new SchemaRef("collection", system, t.Name, t.Columns);
        var request = new SchemaRef("record", system, t.Name, t.Columns.Where(c => !c.ReadOnly).ToList());
        var key = new ParamDef(t.PrimaryKey, t.Columns.FirstOrDefault(c => c.Name == t.PrimaryKey)?.Type ?? "string", true, $"Primary key of {t.Name}");
        foreach (var op in FlowValidator.Operations(system, t))
            yield return op switch
            {
                "list" => new($"{system}.{t.Name}.list", "GET", $"/{t.Name}", op, system, t.Name, false, null, collection, [],
                    [new("limit", "integer", false, "Maximum rows (1-500)")], $"List {t.Title}."),
                "get" => new($"{system}.{t.Name}.get", "GET", $"/{t.Name}/{{{t.PrimaryKey}}}", op, system, t.Name, false, null, record, [key], [], $"Get one {t.Title} record."),
                "create" => new($"{system}.{t.Name}.create", "POST", $"/{t.Name}", op, system, t.Name, true, request, record, [], [], $"Create a {t.Title} record."),
                "update" => new($"{system}.{t.Name}.update", "PUT", $"/{t.Name}/{{{t.PrimaryKey}}}", op, system, t.Name, true, request, record, [key], [], $"Replace a {t.Title} record."),
                "upsert" => new($"{system}.{t.Name}.upsert", "PUT", $"/{t.Name}/{{{t.PrimaryKey}}}", op, system, t.Name, true, request, record, [key], [],
                    $"Create or update a {t.Title} record (versioned upsert)."),
                _ => throw new InvalidOperationException(op)
            };
    }
}
