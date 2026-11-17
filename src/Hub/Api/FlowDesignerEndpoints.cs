using System.Net.Http.Json;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Hub.Application.Flows;
using Hub.Domain;
using Hub.Infrastructure;
using Integration.Shared;
using Microsoft.EntityFrameworkCore;

namespace Hub.Api;
/// <summary>
/// Integration Designer API: action catalog, expression checks, graph validation, draft/publish versioning and
/// import/export of the portfolio's own "eih-flow" format. Designs are configuration only: nothing here executes a flow.
/// </summary>
public static partial class FlowDesignerEndpoints
{
    private static readonly JsonSerializerOptions Json = JsonSerializerOptions.Web;
    public const string Format = "eih-flow";
    [GeneratedRegex("^[a-z][a-z0-9-]{2,59}$")] private static partial Regex FlowName();

    public record CreateFlow(string Name, string Title, string? Description, string? Template);
    public record SaveDraft(string? Title, string? Description, FlowDefinition? Definition, int Revision);
    public record Publish(int Revision);
    public record ValidateRequest(FlowDefinition? Definition);
    public record CheckExpression(string? Expression);
    public record ImportRequest(JsonElement Document, string? Name);

    public static void MapFlowDesigner(this RouteGroupBuilder api)
    {
        var flows = api.MapGroup("/flows");
        flows.MapGet("/actions", () => new
        {
            actions = ActionCatalog.All, functions = Expressions.Functions, dateFormats = Expressions.DateFormats,
            templates = FlowTemplates.All.Select(t => new { t.Id, t.Title, t.Description, t.Scenario }),
            limits = new { FlowValidator.MaxNodes, FlowValidator.MaxDepth, FlowValidator.MaxDefinitionBytes, Expressions.MaxLength },
            execution = "Designs are validated and versioned. Execution of supported actions arrives in Milestone D."
        });
        flows.MapPost("/expressions/check", (CheckExpression request) =>
        {
            var parsed = Expressions.Parse(request.Expression);
            return Results.Ok(new { valid = parsed.Errors.Count == 0, errors = parsed.Errors, variables = parsed.Variables.Select(v => v.ToString()).Distinct() });
        }).RequireRateLimiting("mutations");
        flows.MapPost("/validate", async (ValidateRequest request, IHttpClientFactory f, CancellationToken ct) =>
        {
            if (TooLarge(request.Definition)) return Results.BadRequest(new { error = $"Flow definitions are limited to {FlowValidator.MaxDefinitionBytes / 1024} KB." });
            return Results.Ok(FlowValidator.Validate(request.Definition, await Catalogs(f, ct)));
        }).RequireRateLimiting("mutations");

        flows.MapGet("", async (HubDb db) =>
        {
            var designs = await db.FlowDesigns.AsNoTracking().OrderBy(d => d.Name).ToListAsync();
            var latest = await db.FlowVersions.AsNoTracking().GroupBy(v => v.FlowName)
                .Select(g => new { Name = g.Key, Version = g.Max(v => v.Version) }).ToDictionaryAsync(x => x.Name, x => x.Version);
            return designs.Select(d => new { d.Name, d.Title, d.Description, d.DraftRevision, d.DraftUpdatedAt, d.DraftUpdatedBy,
                latestVersion = latest.GetValueOrDefault(d.Name), status = latest.ContainsKey(d.Name) ? "Published · draft editable" : "Draft only" });
        });
        flows.MapGet("/{name}", async (string name, HubDb db, IHttpClientFactory f, CancellationToken ct) =>
        {
            var d = await db.FlowDesigns.AsNoTracking().SingleOrDefaultAsync(x => x.Name == name, ct);
            if (d is null) return Results.NotFound();
            var definition = JsonSerializer.Deserialize<FlowDefinition>(d.DraftJson, Json);
            var versions = await db.FlowVersions.AsNoTracking().Where(v => v.FlowName == name).OrderByDescending(v => v.Version)
                .Select(v => new { v.Version, v.Title, v.PublishedAt, v.PublishedBy, v.NodeCount }).ToListAsync(ct);
            return Results.Ok(new { d.Name, d.Title, d.Description, revision = d.DraftRevision, d.DraftUpdatedAt, d.DraftUpdatedBy,
                definition, versions, report = FlowValidator.Validate(definition, await Catalogs(f, ct)) });
        });
        flows.MapGet("/{name}/versions/{version:int}", async (string name, int version, HubDb db) =>
        {
            var v = await db.FlowVersions.AsNoTracking().SingleOrDefaultAsync(x => x.FlowName == name && x.Version == version);
            return v is null ? Results.NotFound() : Results.Ok(new { v.FlowName, v.Version, v.Title, v.Description, v.PublishedAt, v.PublishedBy,
                definition = JsonSerializer.Deserialize<FlowDefinition>(v.DefinitionJson, Json) });
        });
        flows.MapPost("", async (CreateFlow input, ClaimsPrincipal user, HubDb db, CancellationToken ct) =>
        {
            if (!FlowName().IsMatch(input.Name ?? "")) return Invalid("name", "Use 3-60 lowercase letters, digits or '-', starting with a letter (e.g. customer-sync).");
            if (string.IsNullOrWhiteSpace(input.Title) || input.Title.Length > 80) return Invalid("title", "Title is required (max 80 characters).");
            if (input.Description?.Length > 300) return Invalid("description", "Max 300 characters.");
            if (!FlowTemplates.ById.TryGetValue(input.Template ?? "blank", out var template)) return Invalid("template", "Unknown template.");
            return await Create(db, input.Name!, input.Title.Trim(), input.Description?.Trim(), template.Definition, User(user), ct);
        }).RequireAuthorization("Operate").RequireRateLimiting("mutations");
        flows.MapPut("/{name}/draft", async (string name, SaveDraft input, ClaimsPrincipal user, HubDb db, IHttpClientFactory f, CancellationToken ct) =>
        {
            if (input.Definition is null) return Invalid("definition", "The flow definition is missing.");
            if (TooLarge(input.Definition)) return Invalid("definition", $"Flow definitions are limited to {FlowValidator.MaxDefinitionBytes / 1024} KB.");
            if (input.Title is { } t && (string.IsNullOrWhiteSpace(t) || t.Length > 80)) return Invalid("title", "Title is required (max 80 characters).");
            if (input.Description?.Length > 300) return Invalid("description", "Max 300 characters.");
            var d = await db.FlowDesigns.SingleOrDefaultAsync(x => x.Name == name, ct);
            if (d is null) return Results.NotFound();
            if (d.DraftRevision != input.Revision) return DraftChanged(d);
            d.DraftJson = JsonSerializer.Serialize(input.Definition, Json);
            if (input.Title is not null) d.Title = input.Title.Trim();
            if (input.Description is not null) d.Description = input.Description.Trim();
            d.DraftRevision++; d.DraftUpdatedAt = DateTime.UtcNow; d.DraftUpdatedBy = User(user);
            try { await db.SaveChangesAsync(ct); }
            catch (DbUpdateConcurrencyException) { db.ChangeTracker.Clear(); return DraftChanged((await db.FlowDesigns.AsNoTracking().SingleAsync(x => x.Name == name, ct))); }
            // Drafts may be saved while incomplete; the report says what blocks publishing.
            return Results.Ok(new { revision = d.DraftRevision, d.DraftUpdatedAt, report = FlowValidator.Validate(input.Definition, await Catalogs(f, ct)) });
        }).RequireAuthorization("Operate").RequireRateLimiting("mutations");
        flows.MapPost("/{name}/publish", async (string name, Publish input, ClaimsPrincipal user, HubDb db, IHttpClientFactory f, CancellationToken ct) =>
        {
            var d = await db.FlowDesigns.AsNoTracking().SingleOrDefaultAsync(x => x.Name == name, ct);
            if (d is null) return Results.NotFound();
            if (d.DraftRevision != input.Revision) return DraftChanged(d);
            var definition = JsonSerializer.Deserialize<FlowDefinition>(d.DraftJson, Json);
            var report = FlowValidator.Validate(definition, await Catalogs(f, ct));
            if (!report.Valid) return Results.BadRequest(new { error = "Only a valid flow can be published. Fix the errors and try again.", report });
            if (report.Issues.Any(i => i.Message.Contains("could not be reached")))
                return Results.Problem(statusCode: 503, title: "A catalog was unavailable, so the flow could not be fully verified. Try again when the CRM and ERP are up.");
            for (var attempt = 0; ; attempt++)
            {
                var next = (await db.FlowVersions.Where(v => v.FlowName == name).MaxAsync(v => (int?)v.Version, ct) ?? 0) + 1;
                var version = new FlowVersion { FlowName = name, Version = next, Title = d.Title, Description = d.Description, DefinitionJson = d.DraftJson,
                    NodeCount = report.NodeCount, PublishedAt = DateTime.UtcNow, PublishedBy = User(user) };
                db.FlowVersions.Add(version);
                try { await db.SaveChangesAsync(ct); return Results.Created($"/api/flows/{name}/versions/{next}", new { version = next, report }); }
                catch (DbUpdateException) when (attempt < 2) { db.ChangeTracker.Clear(); }
            }
        }).RequireAuthorization("Operate").RequireRateLimiting("mutations");
        flows.MapGet("/{name}/export", async (string name, int? version, HubDb db, CancellationToken ct) =>
        {
            var d = await db.FlowDesigns.AsNoTracking().SingleOrDefaultAsync(x => x.Name == name, ct);
            if (d is null) return Results.NotFound();
            string json; int? exported = null;
            if (version is int v)
            {
                var row = await db.FlowVersions.AsNoTracking().SingleOrDefaultAsync(x => x.FlowName == name && x.Version == v, ct);
                if (row is null) return Results.NotFound();
                json = row.DefinitionJson; exported = v;
            }
            else json = d.DraftJson;
            var document = new { format = Format, formatVersion = 1, name = d.Name, title = d.Title, description = d.Description,
                source = exported is null ? "draft" : $"version {exported}", exportedAt = DateTime.UtcNow,
                definition = JsonSerializer.Deserialize<FlowDefinition>(json, Json) };
            return Results.File(JsonSerializer.SerializeToUtf8Bytes(document, new JsonSerializerOptions(Json) { WriteIndented = true }),
                "application/json", $"{name}{(exported is null ? "-draft" : "-v" + exported)}.eih-flow.json");
        });
        flows.MapPost("/import", async (ImportRequest input, ClaimsPrincipal user, HubDb db, CancellationToken ct) =>
        {
            var doc = input.Document;
            if (doc.ValueKind != JsonValueKind.Object || !doc.TryGetProperty("format", out var format) || format.GetString() != Format)
                return Invalid("document", $"Not an {Format} document.");
            if (!doc.TryGetProperty("formatVersion", out var fv) || fv.ValueKind != JsonValueKind.Number || fv.GetInt32() != 1)
                return Invalid("document", "Unsupported formatVersion (expected 1).");
            if (Encoding.UTF8.GetByteCount(doc.GetRawText()) > FlowValidator.MaxDefinitionBytes) return Invalid("document", "The document is too large.");
            FlowDefinition? definition;
            try { definition = doc.TryGetProperty("definition", out var def) ? def.Deserialize<FlowDefinition>(Json) : null; }
            catch (JsonException) { return Invalid("document", "The flow definition is malformed."); }
            if (definition is null) return Invalid("document", "The document has no definition.");
            var name = input.Name ?? (doc.TryGetProperty("name", out var n) ? n.GetString() : null);
            if (!FlowName().IsMatch(name ?? "")) return Invalid("name", "Choose a valid flow name for the import.");
            var title = doc.TryGetProperty("title", out var tt) && tt.GetString() is { Length: > 0 and <= 80 } s ? s : name!;
            var description = doc.TryGetProperty("description", out var dd) && dd.ValueKind == JsonValueKind.String && dd.GetString()!.Length <= 300 ? dd.GetString() : null;
            // Imports always become a new draft; they never overwrite an existing flow or a published version.
            return await Create(db, name!, title, description, definition, User(user), ct, imported: true);
        }).RequireAuthorization("Operate").RequireRateLimiting("mutations");
    }

    private static async Task<IResult> Create(HubDb db, string name, string title, string? description, FlowDefinition definition, string user, CancellationToken ct, bool imported = false)
    {
        if (await db.FlowDesigns.AnyAsync(x => x.Name == name, ct)) return Results.Conflict(new { code = "FlowExists", error = $"A flow named '{name}' already exists." });
        var now = DateTime.UtcNow;
        db.FlowDesigns.Add(new FlowDesign { Name = name, Title = title, Description = description, DraftJson = JsonSerializer.Serialize(definition, Json),
            DraftRevision = 1, DraftUpdatedAt = now, DraftUpdatedBy = user, CreatedAt = now, CreatedBy = user });
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException) { return Results.Conflict(new { code = "FlowExists", error = $"A flow named '{name}' already exists." }); }
        return Results.Created($"/api/flows/{name}", new { name, revision = 1, imported });
    }
    private static IResult Invalid(string field, string message) => Results.ValidationProblem(new Dictionary<string, string[]> { [field] = [message] });
    private static IResult DraftChanged(FlowDesign d) => Results.Conflict(new { code = "DraftChanged", revision = d.DraftRevision,
        error = $"The draft was changed by {d.DraftUpdatedBy} at {d.DraftUpdatedAt:HH:mm:ss} UTC. Reload it before saving." });
    private static string User(ClaimsPrincipal user) => user.Identity?.Name ?? "unknown";
    private static bool TooLarge(FlowDefinition? d) => d is not null && JsonSerializer.SerializeToUtf8Bytes(d, Json).Length > FlowValidator.MaxDefinitionBytes;

    /// <summary>Snapshot of both catalogs for one validation. An unreachable system yields "unverified" warnings, not false errors.</summary>
    private static async Task<TableResolver> Catalogs(IHttpClientFactory f, CancellationToken ct)
    {
        async Task<List<TableView>?> Load(string client)
        {
            try
            {
                using var response = await f.CreateClient(client).GetAsync("api/catalog/tables", ct);
                return response.IsSuccessStatusCode ? await response.Content.ReadFromJsonAsync<List<TableView>>(Json, ct) : null;
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested) { return null; }
        }
        var crm = await Load("CRM"); var erp = await Load("ERP");
        return (system, table) =>
        {
            var tables = system == "crm" ? crm : system == "erp" ? erp : null;
            return tables is null ? new TableLookup(null, Unavailable: system is "crm" or "erp") : new TableLookup(tables.FirstOrDefault(t => t.Name == table));
        };
    }
}
