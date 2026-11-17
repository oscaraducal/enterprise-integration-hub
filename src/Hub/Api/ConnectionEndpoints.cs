using System.Diagnostics;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text.Json;
using System.Text.RegularExpressions;
using Hub.Application.Connections;
using Hub.Application.Flows;
using Hub.Domain;
using Hub.Infrastructure;
using Integration.Shared;
using Microsoft.EntityFrameworkCore;

namespace Hub.Api;

/// <summary>Both applications' catalogs, loaded once per request. Null for a system that could not be reached.</summary>
public sealed record CatalogSnapshot(List<TableView>? Crm, List<TableView>? Erp)
{
    public List<TableView>? For(string system) => system == "crm" ? Crm : system == "erp" ? Erp : null;
    public TableLookup Resolve(string system, string table)
    {
        var tables = For(system);
        return tables is null ? new TableLookup(null, Unavailable: system is "crm" or "erp") : new TableLookup(tables.FirstOrDefault(t => t.Name == table));
    }
    public static async Task<CatalogSnapshot> LoadAsync(IHttpClientFactory f, CancellationToken ct)
    {
        async Task<List<TableView>?> Load(string client)
        {
            try
            {
                using var response = await f.CreateClient(client).GetAsync("api/catalog/tables", ct);
                return response.IsSuccessStatusCode ? await response.Content.ReadFromJsonAsync<List<TableView>>(JsonSerializerOptions.Web, ct) : null;
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested) { return null; }
        }
        var crm = Load("CRM"); var erp = Load("ERP");
        return new(await crm, await erp);
    }
}

/// <summary>
/// Connection Manager: reusable connections to approved internal applications only. A browser user picks an application
/// from the allowlist; the Hub resolves its URL and credentials. Tests perform safe health and metadata reads only.
/// </summary>
public static partial class ConnectionEndpoints
{
    [GeneratedRegex("^[A-Z][A-Z0-9_]{1,49}$")] private static partial Regex Identifier();
    public record ConnectionInput(string? Identifier, string? Name, string? Description, string? Adapter, string? Role, string? Application);
    public record ConnectionUpdate(string? Name, string? Description, string? Role, int Revision);

    public static void MapConnections(this RouteGroupBuilder api)
    {
        var group = api.MapGroup("/connections");
        group.MapGet("/applications", () => ConnectionCatalog.Applications.Select(a => new
        {
            a.Id, a.Name, a.Adapter, supportedRoles = a.Roles, connectionRoles = ConnectionCatalog.AllowedConnectionRoles(a), a.Description, a.Security, a.Endpoint,
            unsupportedRoles = ConnectionCatalog.Roles.Except(ConnectionCatalog.AllowedConnectionRoles(a)).Select(r => new { role = r,
                reason = r == "Trigger" ? $"{a.Name} cannot start integrations." : r == "Invoke" ? $"{a.Name} cannot be called by an integration (Integration Call is planned)." : $"{a.Name} supports only {string.Join(" or ", a.Roles)}." })
        }));
        group.MapGet("/applications/{app}/operations", async (string app, IHttpClientFactory f, CancellationToken ct) =>
            ConnectionCatalog.ById.TryGetValue(app, out var def) ? await Operations(def, f, ct) : Results.NotFound());
        group.MapPost("/applications/{app}/test", async (string app, IHttpClientFactory f, HubDb db, CancellationToken ct) =>
            ConnectionCatalog.ById.TryGetValue(app, out var def) ? Results.Ok(await Test(def, f, db, ct)) : Results.NotFound())
            .RequireAuthorization("Operate").RequireRateLimiting("mutations");

        group.MapGet("", async (HubDb db) => (await db.Connections.AsNoTracking().OrderBy(c => c.Name).ToListAsync()).Select(View));
        group.MapGet("/{id}", async (string id, HubDb db, CancellationToken ct) =>
        {
            var c = await db.Connections.AsNoTracking().SingleOrDefaultAsync(x => x.Identifier == id, ct);
            return c is null ? Results.NotFound() : Results.Ok(new { connection = View(c), usage = await Usage(db, id, ct) });
        });
        group.MapGet("/{id}/operations", async (string id, HubDb db, IHttpClientFactory f, CancellationToken ct) =>
        {
            var c = await db.Connections.AsNoTracking().SingleOrDefaultAsync(x => x.Identifier == id, ct);
            return c is null ? Results.NotFound() : await Operations(ConnectionCatalog.ById[c.Application], f, ct);
        });
        group.MapPost("", async (ConnectionInput input, ClaimsPrincipal user, HubDb db, CancellationToken ct) =>
        {
            var errors = new Dictionary<string, string[]>();
            if (!Identifier().IsMatch(input.Identifier ?? "")) errors["identifier"] = ["Use 2-50 upper-case letters, digits or '_', starting with a letter (e.g. LEGACY_CRM_REST)."];
            if (string.IsNullOrWhiteSpace(input.Name) || input.Name.Length > 80) errors["name"] = ["Name is required (max 80 characters)."];
            if (input.Description?.Length > 300) errors["description"] = ["Max 300 characters."];
            if ((input.Adapter ?? "REST") != "REST") errors["adapter"] = ["Only the REST adapter is available in this release."];
            if (!ConnectionCatalog.ById.TryGetValue(input.Application ?? "", out var app)) errors["application"] = ["Choose an approved internal application. External URLs are not accepted."];
            else if (!ConnectionCatalog.AllowedConnectionRoles(app).Contains(input.Role)) errors["role"] = [$"{app.Name} supports the role(s): {string.Join(", ", ConnectionCatalog.AllowedConnectionRoles(app))}."];
            if (errors.Count > 0) return Results.ValidationProblem(errors);
            if (await db.Connections.AnyAsync(x => x.Identifier == input.Identifier, ct)) return Results.Conflict(new { code = "ConnectionExists", error = $"A connection with identifier {input.Identifier} already exists." });
            var now = DateTime.UtcNow; var who = user.Identity?.Name ?? "unknown";
            var c = new Connection { Identifier = input.Identifier!, Name = input.Name!.Trim(), Description = input.Description?.Trim(), Adapter = "REST", Role = input.Role!,
                Application = input.Application!, Status = "Draft", CreatedAt = now, CreatedBy = who, UpdatedAt = now, UpdatedBy = who };
            db.Connections.Add(c);
            try { await db.SaveChangesAsync(ct); }
            catch (DbUpdateException) { return Results.Conflict(new { code = "ConnectionExists", error = $"A connection with identifier {input.Identifier} already exists." }); }
            return Results.Created($"/api/connections/{c.Identifier}", View(c));
        }).RequireAuthorization("Operate").RequireRateLimiting("mutations");
        group.MapPut("/{id}", async (string id, ConnectionUpdate input, ClaimsPrincipal user, HubDb db, CancellationToken ct) =>
        {
            var c = await db.Connections.SingleOrDefaultAsync(x => x.Identifier == id, ct);
            if (c is null) return Results.NotFound();
            if (c.Revision != input.Revision) return Results.Conflict(new { code = "ConnectionChanged", revision = c.Revision, error = "The connection was changed by someone else. Reload it." });
            if (string.IsNullOrWhiteSpace(input.Name) || input.Name.Length > 80) return Results.ValidationProblem(new Dictionary<string, string[]> { ["name"] = ["Name is required (max 80 characters)."] });
            if (input.Description?.Length > 300) return Results.ValidationProblem(new Dictionary<string, string[]> { ["description"] = ["Max 300 characters."] });
            var app = ConnectionCatalog.ById[c.Application];
            if (input.Role is { } role && role != c.Role)
            {
                if (!ConnectionCatalog.AllowedConnectionRoles(app).Contains(role)) return Results.ValidationProblem(new Dictionary<string, string[]> { ["role"] = [$"{app.Name} supports: {string.Join(", ", ConnectionCatalog.AllowedConnectionRoles(app))}."] });
                var usage = await Usage(db, id, ct);
                if (usage.Count > 0) return Results.Conflict(new { code = "ConnectionInUse", usage, error = $"The role cannot change while {usage.Count} integration(s) use this connection." });
                c.Role = role;
            }
            c.Name = input.Name.Trim(); c.Description = input.Description?.Trim();
            c.Revision++; c.UpdatedAt = DateTime.UtcNow; c.UpdatedBy = user.Identity?.Name ?? "unknown";
            try { await db.SaveChangesAsync(ct); }
            catch (DbUpdateConcurrencyException) { return Results.Conflict(new { code = "ConnectionChanged", error = "The connection was changed by someone else. Reload it." }); }
            return Results.Ok(View(c));
        }).RequireAuthorization("Operate").RequireRateLimiting("mutations");
        group.MapDelete("/{id}", async (string id, HubDb db, CancellationToken ct) =>
        {
            var c = await db.Connections.SingleOrDefaultAsync(x => x.Identifier == id, ct);
            if (c is null) return Results.NotFound();
            var usage = await Usage(db, id, ct);
            if (usage.Count > 0) return Results.Conflict(new { code = "ConnectionInUse", usage, error = $"Used by {string.Join(", ", usage)}. Remove it from those integrations (drafts and published versions) first." });
            db.Connections.Remove(c);
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        }).RequireAuthorization("Operate").RequireRateLimiting("mutations");
        group.MapPost("/{id}/test", async (string id, HubDb db, IHttpClientFactory f, CancellationToken ct) =>
        {
            var c = await db.Connections.SingleOrDefaultAsync(x => x.Identifier == id, ct);
            if (c is null) return Results.NotFound();
            var result = await Test(ConnectionCatalog.ById[c.Application], f, db, ct);
            c.Status = result.Ok ? "Configured" : "Failed"; c.LastTestedAt = DateTime.UtcNow;
            c.LastTestSummary = string.Join("; ", result.Checks.Select(x => $"{x.Name}: {(x.Ok ? "ok" : "failed")}"));
            await db.SaveChangesAsync(ct);
            return Results.Ok(new { result.Ok, result.Checks, connection = View(c) });
        }).RequireAuthorization("Operate").RequireRateLimiting("mutations");
    }

    private static object View(Connection c) => new
    {
        c.Identifier, c.Name, c.Description, c.Adapter, c.Role, c.Application, applicationName = ConnectionCatalog.ById.GetValueOrDefault(c.Application)?.Name,
        c.Status, c.LastTestedAt, c.LastTestSummary, c.Revision, c.CreatedAt, c.CreatedBy, c.UpdatedAt, c.UpdatedBy,
        security = ConnectionCatalog.ById.GetValueOrDefault(c.Application)?.Security
    };
    private static async Task<IResult> Operations(ApplicationDef app, IHttpClientFactory f, CancellationToken ct)
    {
        if (app.Id == "integration-hub") return Results.Ok(new { application = app.Id, operations = Array.Empty<OperationDef>(),
            note = "Trigger connections define inbound endpoints in the integration's trigger wizard." });
        var snapshot = await CatalogSnapshot.LoadAsync(f, ct);
        var ops = ConnectionCatalog.Discover(app, snapshot.For);
        return ops is null ? Results.Problem(statusCode: 503, title: $"{app.Name} metadata is unavailable. Try again when the service is up.")
            : Results.Ok(new { application = app.Id, operations = ops });
    }
    public sealed record TestCheck(string Name, bool Ok, long Ms, string Detail);
    public sealed record TestResult(bool Ok, List<TestCheck> Checks);
    /// <summary>Safe checks only: service health and a catalog metadata read. No business data is read or written.</summary>
    private static async Task<TestResult> Test(ApplicationDef app, IHttpClientFactory f, HubDb db, CancellationToken ct)
    {
        var checks = new List<TestCheck>();
        async Task Probe(string client, string path, string name)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                using var response = await f.CreateClient(client).GetAsync(path, ct);
                checks.Add(new(name, response.IsSuccessStatusCode, sw.ElapsedMilliseconds,
                    response.IsSuccessStatusCode ? "Reachable" : (int)response.StatusCode is 401 or 403 ? "Rejected the Hub's service credentials" : $"HTTP {(int)response.StatusCode}"));
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
            { checks.Add(new(name, false, sw.ElapsedMilliseconds, "Unreachable")); }
        }
        switch (app.Id)
        {
            case "legacy-crm": await Probe("CRM", "health", "CRM health"); await Probe("CRM", "api/catalog/tables", "CRM metadata (authenticated)"); break;
            case "modern-erp": await Probe("ERP", "health", "ERP health"); await Probe("ERP", "api/catalog/tables", "ERP metadata (authenticated)"); break;
            case "data-catalog": await Probe("CRM", "api/catalog/tables", "CRM catalog"); await Probe("ERP", "api/catalog/tables", "ERP catalog"); break;
            case "integration-hub":
                var sw = Stopwatch.StartNew();
                checks.Add(new("Hub design store", await db.Database.CanConnectAsync(ct), sw.ElapsedMilliseconds, "Integration designs can be stored"));
                checks.Add(new("Inbound endpoints", true, 0, "Design-time only: no endpoint is activated or exposed"));
                break;
        }
        return new(checks.All(c => c.Ok), checks);
    }
    /// <summary>Integrations (drafts and published versions) that reference a connection.</summary>
    public static async Task<List<string>> Usage(HubDb db, string id, CancellationToken ct)
    {
        var needle = $"\"connection\":\"{id}\"";
        var drafts = await db.FlowDesigns.AsNoTracking().Where(d => d.DraftJson.Contains(needle)).Select(d => d.Name + " (draft)").ToListAsync(ct);
        var versions = await db.FlowVersions.AsNoTracking().Where(v => v.DefinitionJson.Contains(needle)).Select(v => v.FlowName + " v" + v.Version).ToListAsync(ct);
        return [.. drafts, .. versions];
    }
    /// <summary>Connection lookup for flow validation.</summary>
    public static async Task<ConnectionResolver> Resolver(HubDb db, CancellationToken ct)
    {
        var all = await db.Connections.AsNoTracking().ToDictionaryAsync(c => c.Identifier, c => new ConnectionRef(c.Identifier, c.Name, c.Application, c.Role), ct);
        return id => all.GetValueOrDefault(id);
    }
}
