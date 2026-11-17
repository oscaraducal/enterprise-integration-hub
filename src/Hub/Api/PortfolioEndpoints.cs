using System.Net.Http.Json;
using System.Security.Claims;
using System.Text.Json;
using Integration.Shared;

namespace Hub.Api;
/// <summary>
/// Browser-facing endpoints for the portfolio lab. The dashboard never calls the Legacy CRM or Modern ERP directly:
/// the middleware forwards to fixed internal routes with the service key, so keys never reach the browser and
/// users cannot choose arbitrary upstream URLs.
/// </summary>
public static class PortfolioEndpoints
{
    public static void MapPortfolioLab(this RouteGroupBuilder api)
    {
        // ----- Legacy CRM (source system) -----
        var source = api.MapGroup("/source");
        source.MapGet("/customers", (IHttpClientFactory f, CancellationToken ct) => Forward(f, "CRM", HttpMethod.Get, "api/customers", null, ct));
        source.MapGet("/customers/{id}", async (string id, IHttpClientFactory f, CancellationToken ct) =>
        {
            if (!ValidId(id)) return Results.BadRequest();
            var crm = f.CreateClient("CRM");
            try
            {
                using var customer = await crm.GetAsync($"api/customers/{Uri.EscapeDataString(id)}", ct);
                if (!customer.IsSuccessStatusCode) return Results.StatusCode((int)customer.StatusCode is 404 ? 404 : 502);
                using var revisions = await crm.GetAsync($"api/customers/{Uri.EscapeDataString(id)}/revisions", ct);
                return Results.Ok(new
                {
                    customer = await customer.Content.ReadFromJsonAsync<JsonElement>(ct),
                    revisions = revisions.IsSuccessStatusCode ? await revisions.Content.ReadFromJsonAsync<JsonElement>(ct) : (JsonElement?)null
                });
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
            { return Unavailable("CRM"); }
        });
        source.MapPost("/customers", (CustomerInput input, IHttpClientFactory f, CancellationToken ct) =>
            Forward(f, "CRM", HttpMethod.Post, "api/customers", input, ct)).RequireAuthorization("Operate").RequireRateLimiting("mutations");
        source.MapPut("/customers/{id}", (string id, CustomerInput input, IHttpClientFactory f, CancellationToken ct) =>
            ValidId(id) ? Forward(f, "CRM", HttpMethod.Put, $"api/customers/{Uri.EscapeDataString(id)}", input, ct) : Task.FromResult(Results.BadRequest()))
            .RequireAuthorization("Operate").RequireRateLimiting("mutations");
        source.MapGet("/orders", (IHttpClientFactory f, CancellationToken ct) => Forward(f, "CRM", HttpMethod.Get, "api/orders", null, ct));
        source.MapGet("/orders/{id}", (string id, IHttpClientFactory f, CancellationToken ct) =>
            ValidId(id) ? Forward(f, "CRM", HttpMethod.Get, $"api/orders/{Uri.EscapeDataString(id)}", null, ct) : Task.FromResult(Results.BadRequest()));
        source.MapPost("/orders", (CrmOrder input, IHttpClientFactory f, CancellationToken ct) =>
            Forward(f, "CRM", HttpMethod.Post, "api/orders", input, ct)).RequireAuthorization("Operate").RequireRateLimiting("mutations");
        source.MapPut("/orders/{id}", (string id, CrmOrder input, IHttpClientFactory f, CancellationToken ct) =>
            ValidId(id) ? Forward(f, "CRM", HttpMethod.Put, $"api/orders/{Uri.EscapeDataString(id)}", input, ct) : Task.FromResult(Results.BadRequest()))
            .RequireAuthorization("Operate").RequireRateLimiting("mutations");

        // ----- Modern ERP (target system) -----
        var target = api.MapGroup("/target");
        target.MapGet("/customers", (IHttpClientFactory f, CancellationToken ct) => Forward(f, "ERP", HttpMethod.Get, "api/customers", null, ct));
        target.MapGet("/customers/{code}", (string code, IHttpClientFactory f, CancellationToken ct) =>
            ValidId(code) ? Forward(f, "ERP", HttpMethod.Get, $"api/customers/{Uri.EscapeDataString(code)}", null, ct) : Task.FromResult(Results.BadRequest()));
        target.MapPut("/fixtures/customers/{code}", (string code, ErpCustomer input, ClaimsPrincipal user, IHttpClientFactory f, CancellationToken ct) =>
            ValidId(code) ? Forward(f, "ERP", HttpMethod.Put, $"api/fixtures/customers/{Uri.EscapeDataString(code)}", input, ct,
                user.Identity?.Name) : Task.FromResult(Results.BadRequest()))
            .RequireAuthorization("Operate").RequireRateLimiting("mutations");
        target.MapGet("/orders", (IHttpClientFactory f, CancellationToken ct) => Forward(f, "ERP", HttpMethod.Get, "api/orders", null, ct));
        target.MapGet("/orders/{id}", (string id, IHttpClientFactory f, CancellationToken ct) =>
            ValidId(id) ? Forward(f, "ERP", HttpMethod.Get, $"api/orders/{Uri.EscapeDataString(id)}", null, ct) : Task.FromResult(Results.BadRequest()));

        // Read-only, bounded import audit across all ERP accounts (the ERP Import History screen).
        target.MapGet("/history", (int? take, IHttpClientFactory f, CancellationToken ct) =>
            Forward(f, "ERP", HttpMethod.Get, $"api/history?take={Math.Clamp(take ?? 100, 1, 200)}", null, ct));

        // ----- Mapping Studio -----
        api.MapGet("/mappings", () => new
        {
            salesOrder = new { scenario = "SCN-002", source = "Legacy CRM sales order", target = "Modern ERP imported order", fields = MappingCatalog.SalesOrder },
            customer = new { scenario = "SCN-001 / SCN-003", source = "Legacy CRM customer", target = "Modern ERP customer master", fields = MappingCatalog.Customer }
        });
        // Preview is read-only by design: it may read the source record, but it never creates an execution,
        // writes to any database or calls the target system.
        api.MapPost("/mappings/{kind}/preview", async (string kind, PreviewRequest request, IHttpClientFactory f, CancellationToken ct) =>
        {
            if (kind is not ("customer" or "sales-order")) return Results.NotFound();
            JsonElement input;
            if (request.Source is { ValueKind: JsonValueKind.Object } inline) input = inline;
            else if (!string.IsNullOrWhiteSpace(request.SourceId) && ValidId(request.SourceId))
            {
                try
                {
                    var path = kind == "customer" ? "api/customers/" : "api/orders/";
                    using var response = await f.CreateClient("CRM").GetAsync(path + Uri.EscapeDataString(request.SourceId), ct);
                    if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
                        return Results.NotFound(new { error = $"Source record {request.SourceId} was not found in the Legacy CRM." });
                    if (!response.IsSuccessStatusCode) return Unavailable("CRM");
                    input = await response.Content.ReadFromJsonAsync<JsonElement>(ct);
                }
                catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
                { return Unavailable("CRM"); }
            }
            else return Results.BadRequest(new { error = "Provide a sourceId or an inline source JSON object." });
            try
            {
                if (kind == "customer")
                {
                    var customer = input.Deserialize<Customer>(JsonSerializerOptions.Web)
                        ?? throw new JsonException("Empty customer.");
                    var (mapped, errors) = Mapping.TryTransform(customer);
                    return Results.Ok(new PreviewResult("customer", input, mapped, errors, errors.Count == 0,
                        ["Delivery is an upsert keyed by accountCode. The ERP ignores a source version older than the one it holds."]));
                }
                var order = input.Deserialize<CrmOrder>(JsonSerializerOptions.Web) ?? throw new JsonException("Empty order.");
                var (mappedOrder, orderErrors) = Mapping.TryTransform(order);
                return Results.Ok(new PreviewResult("sales-order", input, mappedOrder, orderErrors, orderErrors.Count == 0,
                    ["At delivery the ERP also requires accountCode to exist and be ACTIVE (run SCN-001 first for new customers)."]));
            }
            catch (JsonException)
            {
                return Results.Ok(new PreviewResult(kind, input, null, [new("request", "The source JSON does not match the source contract (check field names and types).")], false, []));
            }
        }).RequireRateLimiting("mutations");
    }

    public record PreviewRequest(string? SourceId, JsonElement? Source);
    public record PreviewResult(string Kind, JsonElement Input, object? Output, List<MappingError> Errors, bool Valid, string[] Notes);

    private static bool ValidId(string id) => id.Length is > 0 and <= 60 && id.All(c => char.IsLetterOrDigit(c) || c is '-' or '_');
    private static IResult Unavailable(string system) =>
        Results.Problem(statusCode: 502, title: system == "CRM" ? "Mock CRM unavailable" : "Modern ERP unavailable");

    /// <summary>Forwards to a fixed upstream route and relays its status and JSON body (validation errors included).</summary>
    internal static async Task<IResult> Forward(IHttpClientFactory factory, string system, HttpMethod method, string path,
        object? body, CancellationToken ct, string? actor = null)
    {
        try
        {
            using var request = new HttpRequestMessage(method, path) { Content = body is null ? null : JsonContent.Create(body, body.GetType()) };
            if (actor is not null) request.Headers.Add("X-Actor", actor);
            using var response = await factory.CreateClient(system).SendAsync(request, ct);
            var status = (int)response.StatusCode;
            // Never relay upstream authentication failures as if they were the user's.
            if (status is 401 or 403) return Results.Problem(statusCode: 502, title: "Upstream service authentication failed");
            if (status >= 500) return Unavailable(system);
            if (status == 204) return Results.NoContent();
            var text = await response.Content.ReadAsStringAsync(ct);
            return Results.Content(text.Length == 0 ? "{}" : text,
                response.Content.Headers.ContentType?.MediaType ?? "application/json", statusCode: status);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        { return Unavailable(system); }
    }
}
