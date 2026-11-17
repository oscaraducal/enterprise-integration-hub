using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using System.Threading.RateLimiting;
using Hub.Api;
using Hub.Application;
using Hub.Domain;
using Hub.Infrastructure;
using Integration.Shared;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;

namespace Hub;
public partial class Program
{
    public static async Task Main(string[] args)
    {
        var builder = WebApplication.CreateBuilder(args);
        builder.AddDemoDefaults();
        var signingKey = builder.Configuration.RequiredSetting("Jwt:Key");
        if (Encoding.UTF8.GetByteCount(signingKey) < 32)
            throw new InvalidOperationException("Jwt:Key must be at least 32 bytes.");
        var demoPassword = builder.Configuration.RequiredSetting("Demo:Password");
        if (demoPassword.Length < 12) throw new InvalidOperationException("Demo:Password must have at least 12 characters.");
        var serviceKey = builder.Configuration.RequiredSetting("Services:ApiKey");
        builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer(options =>
        {
            options.TokenValidationParameters = new TokenValidationParameters
            {
                ValidateIssuer = true, ValidIssuer = "integration-hub-demo",
                ValidateAudience = true, ValidAudience = "integration-dashboard",
                ValidateLifetime = true, ValidateIssuerSigningKey = true,
                IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(signingKey)),
                ClockSkew = TimeSpan.FromSeconds(10)
            };
        });
        builder.Services.AddAuthorizationBuilder().AddPolicy("Operate", p => p.RequireRole("Operator"));
        // Demo default: 10 logins/minute per address. CI browser tests raise it because every test signs in.
        var loginLimit = Math.Clamp(builder.Configuration.GetValue("RateLimits:LoginPerMinute", 10), 1, 1000);
        builder.Services.AddRateLimiter(options =>
        {
            options.RejectionStatusCode = 429;
            options.AddPolicy("login", context => RateLimitPartition.GetFixedWindowLimiter(
                context.Connection.RemoteIpAddress?.ToString() ?? "local",
                _ => new FixedWindowRateLimiterOptions { PermitLimit = loginLimit, Window = TimeSpan.FromMinutes(1) }));
            options.AddFixedWindowLimiter("mutations", o => { o.PermitLimit = 60; o.Window = TimeSpan.FromMinutes(1); });
        });
        builder.Services.AddCors(o => o.AddDefaultPolicy(p => p
            .WithOrigins(builder.Configuration["Frontend:Origin"] ?? "http://localhost:4200").AllowAnyHeader().AllowAnyMethod()));
        builder.Services.AddDbContext<HubDb>(o => o.UseSqlite(
            builder.Configuration.GetConnectionString("Database") ?? "Data Source=hub.db"));
        foreach (var name in new[] { "CRM", "ERP" })
            builder.Services.AddHttpClient(name, client =>
            {
                client.BaseAddress = new Uri(builder.Configuration.RequiredSetting($"Services:{name}"));
                client.Timeout = TimeSpan.FromSeconds(2);
                client.DefaultRequestHeaders.Add("X-Service-Key", serviceKey);
            });
        builder.Services.AddScoped<IntegrationRunner>();
        if (builder.Configuration["Worker:Enabled"] != "false")
            builder.Services.AddHostedService<ExecutionWorker>();
        var app = builder.Build();
        app.UseDemoDefaults(false);
        app.UseCors();
        app.UseAuthentication();
        app.UseAuthorization();
        app.UseRateLimiter();
        using (var scope = app.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<HubDb>();
            await HubDb.InitializeAsync(db);
            if (!await db.Jobs.AnyAsync())
            {
                db.Jobs.AddRange(Enumerable.Range(1, 8).Select(i => new JobRun
                {
                    Name = i % 2 == 0 ? "Demo order reconciliation" : "Demo inventory validation",
                    Environment = i % 2 == 0 ? "DEV" : "TEST",
                    Status = i % 3 == 0 ? "Failed" : "Completed",
                    StartedAt = DateTime.UtcNow.AddMinutes(-i * 30),
                    EndedAt = DateTime.UtcNow.AddMinutes(-i * 30).AddSeconds(18 + i),
                    Details = i % 3 == 0 ? "Synthetic validation failure: inspect fictional input file schema."
                        : "Synthetic workload completed. No external scheduler was contacted."
                }));
                await db.SaveChangesAsync();
            }
        }
        app.MapPost("/api/auth/login", (Login input) =>
        {
            if (input.Username is not ("operator" or "viewer") || input.Password is null ||
                !Hosting.EqualSecret(input.Password, demoPassword)) return Results.Unauthorized();
            var role = input.Username == "operator" ? "Operator" : "Viewer";
            var expires = DateTime.UtcNow.AddMinutes(30);
            var token = new JwtSecurityToken("integration-hub-demo", "integration-dashboard",
                [new Claim(ClaimTypes.Name, input.Username), new Claim(ClaimTypes.Role, role)],
                expires: expires,
                signingCredentials: new SigningCredentials(new SymmetricSecurityKey(Encoding.UTF8.GetBytes(signingKey)),
                    SecurityAlgorithms.HmacSha256));
            return Results.Ok(new { token = new JwtSecurityTokenHandler().WriteToken(token), role, expiresAt = expires });
        }).RequireRateLimiting("login");
        var api = app.MapGroup("/api").RequireAuthorization();
        api.MapGet("/scenarios", () => Scenarios.All);
        api.MapGet("/orders", async (IHttpClientFactory factory, CancellationToken ct) =>
        {
            try
            {
                using var response = await factory.CreateClient("CRM").GetAsync("api/orders", ct);
                if (!response.IsSuccessStatusCode) return Results.Problem(statusCode: 502, title: "Mock CRM unavailable");
                return Results.Ok(await response.Content.ReadFromJsonAsync<CrmOrder[]>(ct));
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
            { return Results.Problem(statusCode: 502, title: "Mock CRM unavailable"); }
        });
        api.MapGet("/metrics", async (HubDb db) =>
        {
            var total = await db.Executions.CountAsync();
            var completed = await db.Executions.CountAsync(x => x.Status == "Completed");
            var failed = await db.Executions.CountAsync(x => x.Status == "Failed");
            var durations = await db.Executions.Where(x => x.DurationMs != null).Select(x => x.DurationMs!.Value).ToListAsync();
            var statuses = await db.Executions.GroupBy(x => x.Status).Select(g => new { status = g.Key, count = g.Count() }).ToListAsync();
            return Results.Ok(new { total, completed, failed, successRate = total == 0 ? 0 : Math.Round(100.0 * completed / total, 1),
                averageDurationMs = durations.Count == 0 ? 0 : durations.Average(), statuses });
        });
        api.MapGet("/executions", async (string? search, string? status, string? environment, string? kind, int? page, HubDb db) =>
        {
            if (search?.Length > 64 || (status is not null && !Statuses.All.Contains(status)) ||
                (environment is not null && environment is not ("DEV" or "TEST")) ||
                (kind is not null && !Kinds.All.Contains(kind))) return Results.BadRequest();
            var query = db.Executions.AsNoTracking().AsQueryable();
            // Search matches the execution ID or the source record ID (e.g. ORD-013, C-300).
            if (!string.IsNullOrWhiteSpace(search)) query = query.Where(x => x.Id.Contains(search) || (x.SourceId != null && x.SourceId.Contains(search)));
            if (kind is not null) query = query.Where(x => x.Kind == kind);
            if (status is not null) query = query.Where(x => x.Status == status);
            if (environment is not null) query = query.Where(x => x.Environment == environment);
            var count = await query.CountAsync();
            var currentPage = Math.Clamp(page ?? 1, 1, 100000);
            var items = await query.OrderByDescending(x => x.CreatedAt).Skip((currentPage - 1) * 20).Take(20)
                .Select(x => new { x.Id, x.OrderId, x.Kind, x.SourceId, x.SourceVersion, x.Status, x.Environment, x.CreatedAt, x.DurationMs, x.Attempts, x.ErrorClass }).ToListAsync();
            return Results.Ok(new { items, total = count, page = currentPage, pageSize = 20 });
        });
        api.MapGet("/executions/{id}", async (string id, HubDb db) =>
        {
            var execution = await db.Executions.AsNoTracking().Include(x => x.Logs.OrderBy(l => l.Id)).SingleOrDefaultAsync(x => x.Id == id);
            return execution is null ? Results.NotFound() : Results.Ok(execution);
        });
        api.MapPost("/executions", async (StartExecution input, ClaimsPrincipal user, HubDb db) =>
        {
            var kind = input.Kind ?? Kinds.SalesOrder;
            var sourceId = (kind == Kinds.SalesOrder ? input.OrderId ?? input.SourceId : input.SourceId)?.Trim();
            if (!Kinds.All.Contains(kind) || string.IsNullOrWhiteSpace(sourceId) || sourceId.Length > 60 ||
                !sourceId.All(c => char.IsLetterOrDigit(c) || c is '-' or '_') ||
                input.Environment is not ("DEV" or "TEST") || !Scenarios.All.Contains(input.Scenario) ||
                input.Target is not ("CRM" or "ERP") || input.FailuresBeforeSuccess is < 0 or > 3 ||
                (input.Scenario == "Validation" && input.Target != "CRM") ||
                (input.Scenario == "Duplicate" && (input.Target != "ERP" || kind != Kinds.SalesOrder))) return Results.BadRequest();
            if (kind == Kinds.SalesOrder)
            {
                var existing = await db.Executions.AsNoTracking().SingleOrDefaultAsync(x => x.OrderId == sourceId);
                if (existing is not null) return Results.Conflict(new { executionId = existing.Id, error = "Source order already tracked. Open its execution." });
            }
            // Orders are immutable: one execution per order, ever. Customers are mutable: every sync is a new
            // execution, but only one may be active per customer (enforced by a partial unique index).
            var execution = new Execution { Kind = kind, SourceId = sourceId,
                OrderId = kind == Kinds.SalesOrder ? sourceId : $"CUSTOMER:{sourceId}:{Guid.NewGuid():N}",
                Environment = input.Environment, Scenario = input.Scenario, Target = input.Target, FailuresBeforeSuccess = input.FailuresBeforeSuccess };
            execution.Logs.Add(new ExecutionLog { Stage = "Queued", Message =
                (kind == Kinds.CustomerSync ? $"Customer sync for {sourceId} queued" : "Queued") + $" by {Actor(user)} in {input.Environment}. " +
                (input.Scenario == "None" ? "No failure simulation." : $"Simulation {input.Scenario} on {execution.Target} for the first {input.FailuresBeforeSuccess} attempt(s).") +
                $" Automatic retry budget: {IntegrationRunner.MaxAttempts} attempts." });
            db.Executions.Add(execution);
            try { await db.SaveChangesAsync(); }
            catch (DbUpdateException)
            {
                db.ChangeTracker.Clear();
                if (kind == Kinds.CustomerSync)
                {
                    var active = await ActiveSync(db, sourceId);
                    if (active is null) throw;
                    return Results.Conflict(new { executionId = active, error = $"A sync for {sourceId} is already queued or running. Open it." });
                }
                var winner = await db.Executions.AsNoTracking().SingleOrDefaultAsync(x => x.OrderId == sourceId);
                if (winner is null) throw;
                return Results.Conflict(new { executionId = winner.Id, error = "Source order already tracked." });
            }
            return Results.Accepted($"/api/executions/{execution.Id}", new { execution.Id });
        }).RequireAuthorization("Operate").RequireRateLimiting("mutations");
        api.MapPost("/executions/{id}/retry", async (string id, ClaimsPrincipal user, HubDb db) =>
        {
            // Atomic state transition prevents double-clicks and concurrent operators from queuing twice.
            await using var tx = await db.Database.BeginTransactionAsync();
            var before = await db.Executions.AsNoTracking().Where(x => x.Id == id)
                .Select(x => new { x.ErrorClass, x.Attempts, x.RetryCount }).SingleOrDefaultAsync();
            int changed;
            try
            {
                changed = await db.Executions.Where(x => x.Id == id && x.Status == "Failed")
                .ExecuteUpdateAsync(s => s.SetProperty(x => x.Status, "Pending")
                    .SetProperty(x => x.Scenario, "None").SetProperty(x => x.Attempts, 0)
                    .SetProperty(x => x.RetryCount, x => x.RetryCount + 1)
                    .SetProperty(x => x.EndedAt, (DateTime?)null).SetProperty(x => x.DurationMs, (double?)null)
                    .SetProperty(x => x.StartedAt, (DateTime?)null)
                    .SetProperty(x => x.ErrorClass, (string?)null).SetProperty(x => x.Troubleshooting, (string?)null)
                    .SetProperty(x => x.AvailableAt, DateTime.UtcNow));
            }
            catch (Exception ex) when (ex is DbUpdateException or Microsoft.Data.Sqlite.SqliteException)
            {
                // Another sync for the same customer is already active (partial unique index).
                return Results.Conflict(new { error = "Another sync for this customer is already queued or running. Wait for it, then retry." });
            }
            if (changed == 0) return await db.Executions.AnyAsync(x => x.Id == id)
                ? Results.Conflict(new { error = "Only failed executions can be retried." }) : Results.NotFound();
            db.Logs.Add(new ExecutionLog { ExecutionId = id, Stage = "ManualRetry",
                Message = $"Manual retry #{before!.RetryCount + 1} requested by {Actor(user)} after {before.ErrorClass ?? "failure"} " +
                    $"on attempt {before.Attempts}. New cycle with a {IntegrationRunner.MaxAttempts}-attempt budget; simulation cleared; " +
                    "original source ID and frozen mapped payload retained." });
            await db.SaveChangesAsync();
            await tx.CommitAsync();
            return Results.Accepted($"/api/executions/{id}", new { id });
        }).RequireAuthorization("Operate").RequireRateLimiting("mutations");
        api.MapGet("/jobs", async (string? environment, HubDb db) =>
        {
            if (environment is not null && environment is not ("DEV" or "TEST")) return Results.BadRequest();
            return Results.Ok(await db.Jobs.AsNoTracking().Where(x => environment == null || x.Environment == environment)
                .OrderByDescending(x => x.StartedAt).Take(100).ToListAsync());
        });
        api.MapGet("/jobs/{id}", async (string id, HubDb db) =>
        {
            var job = await db.Jobs.AsNoTracking().SingleOrDefaultAsync(x => x.Id == id);
            return job is null ? Results.NotFound() : Results.Ok(job);
        });
        api.MapPost("/jobs/simulate", async (SimulateJob input, HubDb db) =>
        {
            if (input.Environment is not ("DEV" or "TEST")) return Results.BadRequest();
            var now = DateTime.UtcNow;
            var job = new JobRun { Name = "Demo reconciliation check", Environment = input.Environment,
                StartedAt = now, EndedAt = now, Status = input.Fail ? "Failed" : "Completed",
                Details = input.Fail ? "Synthetic input schema mismatch. Inspect the mock source contract and rerun the demo."
                    : "Synthetic verification completed; no external workload platform contacted." };
            db.Jobs.Add(job);
            await db.SaveChangesAsync();
            return Results.Created($"/api/jobs/{job.Id}", job);
        }).RequireAuthorization("Operate").RequireRateLimiting("mutations");
        api.MapPortfolioLab();
        api.MapDataCatalog();
        api.MapFlowDesigner();
        api.MapConnections();
        await app.RunAsync();
    }
    private static async Task<string?> ActiveSync(HubDb db, string sourceId) =>
        await db.Executions.AsNoTracking().Where(x => x.Kind == Kinds.CustomerSync && x.SourceId == sourceId &&
            (x.Status == "Pending" || x.Status == "Running" || x.Status == "Retrying")).Select(x => x.Id).FirstOrDefaultAsync();
    // Audit attribution uses only the fixed demo account name and role, never token contents.
    private static string Actor(ClaimsPrincipal user) =>
        $"{user.Identity?.Name ?? "unknown"} ({(user.IsInRole("Operator") ? "Operator" : "Viewer")})";
}
public record Login(string Username, string Password);
/// <summary>Queue request. Sales orders may send orderId (v1 contract) or sourceId; customer syncs send kind + sourceId.</summary>
public record StartExecution(string? OrderId = null, string Environment = "DEV", string Scenario = "None",
    string Target = "ERP", int FailuresBeforeSuccess = 1, string? Kind = null, string? SourceId = null);
public record SimulateJob(string Environment, bool Fail);
