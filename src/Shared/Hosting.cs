using System.ComponentModel.DataAnnotations;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Integration.Shared;

public static class Hosting
{
    public static void AddDemoDefaults(this WebApplicationBuilder builder)
    {
        // This portfolio deliberately refuses to impersonate a production deployment.
        if (!builder.Environment.IsDevelopment() && !builder.Environment.IsEnvironment("Testing"))
            throw new InvalidOperationException("This simulator runs only in Development or Testing.");
        builder.Logging.ClearProviders();
        builder.Logging.AddJsonConsole();
        builder.Services.AddOpenApi();
        builder.Services.AddProblemDetails();
        builder.Services.AddExceptionHandler<SecureExceptionHandler>();
    }
    public static string RequiredSetting(this IConfiguration config, string key)
        => !string.IsNullOrWhiteSpace(config[key]) ? config[key]!
            : throw new InvalidOperationException($"Set configuration '{key}' before startup.");
    public static void UseDemoDefaults(this WebApplication app, bool serviceKey = true)
    {
        app.UseExceptionHandler();
        app.MapGet("/health", () => Results.Ok(new { status = "healthy", mode = "synthetic-demo" }));
        if (serviceKey)
        {
            var expected = app.Configuration.RequiredSetting("Services:ApiKey");
            app.Use(async (context, next) =>
            {
                if (context.Request.Path.StartsWithSegments("/api") &&
                    !EqualSecret(context.Request.Headers["X-Service-Key"].ToString(), expected))
                {
                    context.Response.StatusCode = 401;
                    return;
                }
                await next(context);
            });
        }
        app.MapOpenApi();
    }
    public static bool EqualSecret(string input, string expected)
        => CryptographicOperations.FixedTimeEquals(
            SHA256.HashData(Encoding.UTF8.GetBytes(input)),
            SHA256.HashData(Encoding.UTF8.GetBytes(expected)));
    public static Dictionary<string, string[]> Validate(object value)
    {
        var errors = new List<ValidationResult>();
        Validator.TryValidateObject(value, new ValidationContext(value), errors, true);
        return errors.GroupBy(e => e.MemberNames.FirstOrDefault() ?? "request")
            .ToDictionary(g => g.Key, g => g.Select(e => e.ErrorMessage ?? "Invalid value").ToArray());
    }
}
public sealed class SecureExceptionHandler(ILogger<SecureExceptionHandler> logger)
    : Microsoft.AspNetCore.Diagnostics.IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(HttpContext context, Exception exception, CancellationToken ct)
    {
        logger.LogError("Unhandled {ErrorType}. Trace {TraceId}", exception.GetType().Name, context.TraceIdentifier);
        await Results.Problem(statusCode: 500, title: "Unexpected simulator error",
            extensions: new Dictionary<string, object?> { ["traceId"] = context.TraceIdentifier })
            .ExecuteAsync(context);
        return true;
    }
}
