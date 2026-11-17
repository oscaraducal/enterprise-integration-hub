using System.ComponentModel.DataAnnotations;
using System.Net.Http.Json;
using System.Text.Json;
using Hub.Domain;
using Hub.Infrastructure;
using Integration.Shared;
using Microsoft.EntityFrameworkCore;

namespace Hub.Application;
public class IntegrationRunner(HubDb db, IHttpClientFactory clients, ILogger<IntegrationRunner> logger)
{
    public const int MaxAttempts = 3;
    public async Task ProcessAsync(Execution execution, CancellationToken ct)
    {
        execution.Attempts++;
        execution.StartedAt ??= DateTime.UtcNow;
        execution.Status = "Running";
        await Log(execution, "Started", "Integration attempt started.", ct);
        try
        {
            using var crm = new HttpRequestMessage(HttpMethod.Get, $"api/orders/{Uri.EscapeDataString(execution.OrderId)}");
            AddSimulation(crm, execution, "CRM");
            using var source = await clients.CreateClient("CRM").SendAsync(crm, ct);
            Check(source);
            var order = await source.Content.ReadFromJsonAsync<CrmOrder>(ct)
                ?? throw new ValidationException("CRM returned an empty order.");
            if (order.Id != execution.OrderId) throw new ValidationException("CRM returned a different order ID.");
            await Log(execution, "Retrieved", "Source order retrieved from mock CRM.", ct);
            // Freeze the first valid mapping, so manual retries cannot change a transaction after an ambiguous timeout.
            var mapped = execution.MappedPayload is null ? Mapping.Transform(order)
                : JsonSerializer.Deserialize<ErpOrder>(execution.MappedPayload)!;
            execution.MappedPayload ??= JsonSerializer.Serialize(mapped);
            await Log(execution, "Mapped", "Validated and mapped to ERP minor-unit amount.", ct);
            using var erp = new HttpRequestMessage(HttpMethod.Post, "api/orders") { Content = JsonContent.Create(mapped) };
            erp.Headers.Add("X-Execution-Id", execution.Id);
            AddSimulation(erp, execution, "ERP");
            using var target = await clients.CreateClient("ERP").SendAsync(erp, ct);
            Check(target);
            var receipt = await target.Content.ReadFromJsonAsync<Receipt>(ct)
                ?? throw new ValidationException("ERP returned an empty receipt.");
            if (receipt.ExternalOrderId != execution.OrderId || string.IsNullOrWhiteSpace(receipt.ReceiptId))
                throw new ValidationException("ERP receipt does not match the source order.");
            execution.ReceiptId = receipt.ReceiptId;
            execution.Status = "Completed";
            execution.ErrorClass = null;
            execution.Troubleshooting = null;
            Finish(execution);
            await Log(execution, "Completed", receipt.Duplicate
                ? "ERP confirmed an existing matching transaction; no duplicate created."
                : "Mock ERP accepted the order.", ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex) when (ex is UpstreamException or HttpRequestException
            or OperationCanceledException or ValidationException or JsonException)
        {
            var failure = ex switch
            {
                UpstreamException upstream => FailurePolicy.Classify(upstream.Status),
                OperationCanceledException => FailurePolicy.Classify(408),
                HttpRequestException => new Failure("Connection", true, "Check the mock API base URL and process health."),
                _ => new Failure("Validation", false, "Inspect the CRM JSON contract and supported currencies; correct the source data.")
            };
            execution.ErrorClass = failure.Classification;
            execution.Troubleshooting = failure.Guidance;
            // Attempts is reset only by an explicit operator retry; each cycle has a strict maximum.
            if (failure.Transient && execution.Attempts < MaxAttempts)
            {
                execution.Status = "Retrying";
                var delay = FailurePolicy.Backoff(execution.Attempts, (ex as UpstreamException)?.RetryAfter);
                execution.AvailableAt = DateTime.UtcNow.Add(delay);
                await Log(execution, "RetryScheduled", $"{failure.Classification}; retry in {delay.TotalSeconds:0} seconds.", ct, "Warning");
            }
            else
            {
                execution.Status = "Failed";
                Finish(execution);
                await Log(execution, "Failed", $"{failure.Classification}: {failure.Guidance}", ct, "Error");
            }
        }
    }
    private static void Check(HttpResponseMessage response)
    {
        if (!response.IsSuccessStatusCode)
        {
            var retryAfter = response.Headers.RetryAfter?.Delta;
            if (retryAfter is null && response.Headers.RetryAfter?.Date is { } date)
                retryAfter = date - DateTimeOffset.UtcNow;
            throw new UpstreamException((int)response.StatusCode, retryAfter);
        }
    }
    private static void AddSimulation(HttpRequestMessage request, Execution e, string target)
    {
        if (e.Target == target && e.Attempts <= e.FailuresBeforeSuccess)
            request.Headers.Add("X-Demo-Scenario", e.Scenario);
    }
    private static void Finish(Execution e)
    {
        e.EndedAt = DateTime.UtcNow;
        e.DurationMs = (e.EndedAt.Value - e.StartedAt!.Value).TotalMilliseconds;
    }
    private async Task Log(Execution e, string stage, string message, CancellationToken ct, string level = "Information")
    {
        db.Logs.Add(new ExecutionLog { ExecutionId = e.Id, Stage = stage, Message = message,
            Level = level, Attempt = e.Attempts });
        // Never log raw bodies, headers, credentials or exception messages.
        logger.LogInformation("Execution {ExecutionId} Stage {Stage} Attempt {Attempt} Status {Status}",
            e.Id, stage, e.Attempts, e.Status);
        await db.SaveChangesAsync(ct);
    }
}
