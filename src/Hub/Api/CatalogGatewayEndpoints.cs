using System.Net.Http.Json;
using System.Security.Claims;
using System.Text.Json;
using System.Text.Json.Nodes;
using Hub.Application;
using Hub.Domain;
using Hub.Infrastructure;
using Integration.Shared;
using Microsoft.EntityFrameworkCore;

namespace Hub.Api;
/// <summary>
/// Browser-facing Data Catalog gateway and mapping designer. The browser chooses a system from a fixed allowlist
/// (crm, erp); the middleware forwards to that system's fixed catalog routes with the service key.
/// Mapping definitions are validated configuration: nothing here executes a mapping against a target system.
/// </summary>
public static class CatalogGatewayEndpoints
{
    private static readonly JsonSerializerOptions Json = JsonSerializerOptions.Web;
    private static string? Client(string system) => system switch { "crm" => "CRM", "erp" => "ERP", _ => null };
    private static IResult UnknownSystem() => Results.NotFound(new { error = "Unknown system. Use 'crm' or 'erp'." });
    private static bool Valid(string system, string? table = null, string? key = null) =>
        Client(system) is not null && (table is null || CatalogRules.ValidTableName(table)) && (key is null || CatalogRules.ValidKey(key));

    public static void MapDataCatalog(this RouteGroupBuilder api)
    {
        // ----- Gateway: discovery and CRUD for logical tables -----
        var catalog = api.MapGroup("/catalog/{system}");
        Task<IResult> Get(IHttpClientFactory f, string system, string path, CancellationToken ct) =>
            PortfolioEndpoints.Forward(f, Client(system)!, HttpMethod.Get, "api/catalog/" + path, null, ct);
        Task<IResult> Send(IHttpClientFactory f, string system, HttpMethod method, string path, object? body, CancellationToken ct) =>
            PortfolioEndpoints.Forward(f, Client(system)!, method, "api/catalog/" + path, body, ct);

        catalog.MapGet("/tables", (string system, IHttpClientFactory f, CancellationToken ct) =>
            Valid(system) ? Get(f, system, "tables", ct) : Task.FromResult(UnknownSystem()));
        catalog.MapGet("/tables/{name}", (string system, string name, IHttpClientFactory f, CancellationToken ct) =>
            Valid(system, name) ? Get(f, system, $"tables/{name}", ct) : Task.FromResult(UnknownSystem()));
        catalog.MapGet("/tables/{name}/contract", (string system, string name, IHttpClientFactory f, CancellationToken ct) =>
            Valid(system, name) ? Get(f, system, $"tables/{name}/contract", ct) : Task.FromResult(UnknownSystem()));
        catalog.MapGet("/tables/{name}/records", (string system, string name, int? page, int? pageSize, string? search, IHttpClientFactory f, CancellationToken ct) =>
        {
            if (!Valid(system, name)) return Task.FromResult(UnknownSystem());
            var query = $"page={Math.Max(page ?? 1, 1)}&pageSize={Math.Clamp(pageSize ?? CatalogRules.DefaultPageSize, 1, CatalogRules.MaxPageSize)}";
            if (!string.IsNullOrWhiteSpace(search)) query += "&search=" + Uri.EscapeDataString(search.Length > 60 ? search[..60] : search);
            return Get(f, system, $"tables/{name}/records?{query}", ct);
        });
        catalog.MapGet("/tables/{name}/records/{key}", (string system, string name, string key, IHttpClientFactory f, CancellationToken ct) =>
            Valid(system, name, key) ? Get(f, system, $"tables/{name}/records/{Uri.EscapeDataString(key)}", ct) : Task.FromResult(UnknownSystem()));

        catalog.MapPost("/tables", (string system, TableInput input, IHttpClientFactory f, CancellationToken ct) =>
            Valid(system) ? Send(f, system, HttpMethod.Post, "tables", input, ct) : Task.FromResult(UnknownSystem()))
            .RequireAuthorization("Operate").RequireRateLimiting("mutations");
        catalog.MapPost("/tables/{name}/schema", (string system, string name, SchemaChange change, IHttpClientFactory f, CancellationToken ct) =>
            Valid(system, name) ? Send(f, system, HttpMethod.Post, $"tables/{name}/schema", change, ct) : Task.FromResult(UnknownSystem()))
            .RequireAuthorization("Operate").RequireRateLimiting("mutations");
        catalog.MapDelete("/tables/{name}", (string system, string name, IHttpClientFactory f, CancellationToken ct) =>
            Valid(system, name) ? Send(f, system, HttpMethod.Delete, $"tables/{name}", null, ct) : Task.FromResult(UnknownSystem()))
            .RequireAuthorization("Operate").RequireRateLimiting("mutations");
        catalog.MapPost("/tables/{name}/records", (string system, string name, JsonElement record, IHttpClientFactory f, CancellationToken ct) =>
            Valid(system, name) ? Send(f, system, HttpMethod.Post, $"tables/{name}/records", record, ct) : Task.FromResult(UnknownSystem()))
            .RequireAuthorization("Operate").RequireRateLimiting("mutations");
        catalog.MapPut("/tables/{name}/records/{key}", (string system, string name, string key, JsonElement record, IHttpClientFactory f, CancellationToken ct) =>
            Valid(system, name, key) ? Send(f, system, HttpMethod.Put, $"tables/{name}/records/{Uri.EscapeDataString(key)}", record, ct) : Task.FromResult(UnknownSystem()))
            .RequireAuthorization("Operate").RequireRateLimiting("mutations");
        catalog.MapDelete("/tables/{name}/records/{key}", (string system, string name, string key, IHttpClientFactory f, CancellationToken ct) =>
            Valid(system, name, key) ? Send(f, system, HttpMethod.Delete, $"tables/{name}/records/{Uri.EscapeDataString(key)}", null, ct) : Task.FromResult(UnknownSystem()))
            .RequireAuthorization("Operate").RequireRateLimiting("mutations");

        // ----- Mapping designer: suggestions, validation and preview are read-only -----
        var designer = api.MapGroup("/mapping-designer");
        designer.MapPost("/suggest", async (SuggestRequest request, IHttpClientFactory f, CancellationToken ct) =>
        {
            var (source, target, error) = await LoadPair(f, request.Source, request.Target, ct);
            return error ?? Results.Ok(new { source, target, suggestions = SchemaMapping.Suggest(source!, target!) });
        }).RequireRateLimiting("mutations");
        designer.MapPost("/validate", async (MappingDraft draft, IHttpClientFactory f, CancellationToken ct) =>
        {
            var (source, target, error) = await LoadPair(f, draft.Source, draft.Target, ct);
            return error ?? Results.Ok(SchemaMapping.Validate(draft, source!, target!));
        }).RequireRateLimiting("mutations");
        designer.MapPost("/preview", async (PreviewRequest request, IHttpClientFactory f, CancellationToken ct) =>
        {
            if (request.Draft is null || request.Sample is null) return Results.BadRequest(new { error = "Provide a draft mapping and a sample source record." });
            if (System.Text.Encoding.UTF8.GetByteCount(request.Sample.ToJsonString()) > CatalogRules.MaxRecordBytes)
                return Results.BadRequest(new { error = $"The sample record is limited to {CatalogRules.MaxRecordBytes} bytes." });
            var (source, target, error) = await LoadPair(f, request.Draft.Source, request.Draft.Target, ct);
            if (error is not null) return error;
            var report = SchemaMapping.Validate(request.Draft, source!, target!);
            var rules = request.Draft.Fields?.Where(r => SchemaMapping.Transforms.Contains(r.Transform)).ToList() ?? [];
            var (output, errors) = SchemaMapping.Apply(rules, target!.Columns, request.Sample);
            return Results.Ok(new { input = request.Sample, output, errors, report,
                note = "Preview only: nothing was written and no target system was called." });
        }).RequireRateLimiting("mutations");

        // ----- Versioned mapping definitions (configuration only) -----
        var definitions = api.MapGroup("/mapping-definitions");
        definitions.MapGet("", async (HubDb db) =>
        {
            var all = await db.MappingDefinitions.AsNoTracking().OrderBy(d => d.Name).ThenByDescending(d => d.Version).ToListAsync();
            return all.GroupBy(d => d.Name).Select(g => Summary(g.First(), g.Count()));
        });
        definitions.MapGet("/{name}", async (string name, HubDb db) =>
        {
            var versions = await db.MappingDefinitions.AsNoTracking().Where(d => d.Name == name).OrderByDescending(d => d.Version).ToListAsync();
            return versions.Count == 0 ? Results.NotFound() : Results.Ok(versions.Select(Detail));
        });
        definitions.MapPost("", async (MappingDraft draft, ClaimsPrincipal user, HubDb db, IHttpClientFactory f, CancellationToken ct) =>
        {
            var (source, target, error) = await LoadPair(f, draft.Source, draft.Target, ct);
            if (error is not null) return error;
            var report = SchemaMapping.Validate(draft, source!, target!);
            if (!report.Valid) return Results.BadRequest(new { error = "The mapping is not valid. Fix the errors and save again.", report });
            var name = draft.Name.Trim();
            for (var attempt = 0; ; attempt++)
            {
                var next = (await db.MappingDefinitions.Where(d => d.Name == name).MaxAsync(d => (int?)d.Version, ct) ?? 0) + 1;
                var saved = new MappingDefinition
                {
                    Name = name, Version = next, Description = draft.Description?.Trim() is { Length: > 0 } d ? d : null, // length validated above
                    SourceSystem = draft.Source.System, SourceTable = draft.Source.Table, SourceSchemaVersion = source!.Version,
                    TargetSystem = draft.Target.System, TargetTable = draft.Target.Table, TargetSchemaVersion = target!.Version,
                    FieldsJson = JsonSerializer.Serialize(draft.Fields, Json), CreatedBy = user.Identity?.Name ?? "unknown", CreatedAt = DateTime.UtcNow
                };
                db.MappingDefinitions.Add(saved);
                try { await db.SaveChangesAsync(ct); return Results.Created($"/api/mapping-definitions/{Uri.EscapeDataString(name)}", new { definition = Detail(saved), report }); }
                catch (DbUpdateException) when (attempt < 2) { db.ChangeTracker.Clear(); } // concurrent save took this version number
            }
        }).RequireAuthorization("Operate").RequireRateLimiting("mutations");
    }

    public record SuggestRequest(TableRef Source, TableRef Target);
    public record PreviewRequest(MappingDraft? Draft, JsonObject? Sample);
    private static object Summary(MappingDefinition d, int versions) => new
    {
        d.Name, latestVersion = d.Version, versions, d.Description, source = new TableRef(d.SourceSystem, d.SourceTable),
        target = new TableRef(d.TargetSystem, d.TargetTable), d.CreatedBy, d.CreatedAt, status = "Saved · not executed"
    };
    private static object Detail(MappingDefinition d) => new
    {
        d.Name, d.Version, d.Description, source = new TableRef(d.SourceSystem, d.SourceTable), d.SourceSchemaVersion,
        target = new TableRef(d.TargetSystem, d.TargetTable), d.TargetSchemaVersion,
        fields = JsonSerializer.Deserialize<List<FieldRule>>(d.FieldsJson, Json), d.CreatedBy, d.CreatedAt
    };

    /// <summary>Loads both table definitions from the catalog of their systems.</summary>
    private static async Task<(TableView? Source, TableView? Target, IResult? Error)> LoadPair(IHttpClientFactory f, TableRef? source, TableRef? target, CancellationToken ct)
    {
        if (source is null || target is null) return (null, null, Results.BadRequest(new { error = "Choose a source and a target table." }));
        var (s, e1) = await LoadTable(f, source, ct);
        if (e1 is not null) return (null, null, e1);
        var (t, e2) = await LoadTable(f, target, ct);
        return e2 is not null ? (null, null, e2) : (s, t, null);
    }
    private static async Task<(TableView? Table, IResult? Error)> LoadTable(IHttpClientFactory f, TableRef reference, CancellationToken ct)
    {
        if (!Valid(reference.System ?? "", reference.Table)) return (null, Results.BadRequest(new { error = $"Unknown system or invalid table name '{reference.Table}'." }));
        try
        {
            using var response = await f.CreateClient(Client(reference.System!)!).GetAsync($"api/catalog/tables/{reference.Table}", ct);
            if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
                return (null, Results.NotFound(new { error = $"Table '{reference.Table}' does not exist in {reference.System!.ToUpperInvariant()}." }));
            if (!response.IsSuccessStatusCode) return (null, Results.Problem(statusCode: 502, title: $"{reference.System!.ToUpperInvariant()} catalog unavailable"));
            var body = await response.Content.ReadFromJsonAsync<JsonElement>(Json, ct);
            return (body.GetProperty("table").Deserialize<TableView>(Json), null);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        { return (null, Results.Problem(statusCode: 502, title: $"{reference.System!.ToUpperInvariant()} catalog unavailable")); }
    }
}
