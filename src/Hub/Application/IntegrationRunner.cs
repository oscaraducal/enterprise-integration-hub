using System.ComponentModel.DataAnnotations;
using System.Net.Http.Json;
using System.Text.Json;
using Hub.Domain;
using Hub.Infrastructure;
using Integration.Shared;
using Microsoft.EntityFrameworkCore;

namespace Hub.Application;
/// <summary>
/// Runs one attempt of an execution: retrieve from the Legacy CRM, validate and map, deliver to the Modern ERP.
/// Sales orders (SCN-002) and customer synchronization (SCN-001/SCN-003) share the attempt, retry and audit rules.
/// </summary>
public class IntegrationRunner(HubDb db, IHttpClientFactory clients, ILogger<IntegrationRunner> logger)
{
    public const int MaxAttempts = 3;
    public async Task ProcessAsync(Execution execution, CancellationToken ct)
    {
        // Defence in depth: never start an attempt beyond the budget, whatever path re-queued the execution.
        if (execution.Attempts >= MaxAttempts)
        {
            execution.Status = "Failed";
            execution.ErrorClass ??= "RetryBudgetExhausted";
            execution.Troubleshooting ??= "The automatic retry budget is exhausted. Investigate, then use an explicit operator retry.";
            execution.StartedAt ??= DateTime.UtcNow;
            Finish(execution);
            await Log(execution, "RetryExhausted", $"Refused to start attempt {execution.Attempts + 1}; budget is {MaxAttempts} attempts per cycle.", ct, "Error");
            return;
        }
        execution.Attempts++;
        execution.StartedAt ??= DateTime.UtcNow;
        execution.Status = "Running";
        // Persisting the attempt number before any upstream call is what lets crash recovery count interrupted attempts.
        await Log(execution, "Started", $"Attempt {execution.Attempts} of {MaxAttempts} started.", ct);
        try
        {
            if (execution.Kind == Kinds.CustomerSync) await SyncCustomerAsync(execution, ct);
            else await ImportOrderAsync(execution, ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex) when (ex is UpstreamException or HttpRequestException
            or OperationCanceledException or ValidationException or JsonException)
        {
            var failure = ex switch
            {
                UpstreamException upstream => FailurePolicy.Classify(upstream.Status, upstream.Code, upstream.Reference),
                OperationCanceledException => FailurePolicy.Classify(408),
                HttpRequestException => new Failure("Connection", true, "Check the mock API base URL and process health."),
                // Mapping messages are fixed templates that name fields, never source values.
                ValidationException validation => new Failure("Validation", false,
                    $"Correct the source record in the Legacy CRM, then retry. {validation.Message}"),
                _ => new Failure("Validation", false, "Inspect the CRM JSON contract and supported values; correct the source data.")
            };
            execution.ErrorClass = failure.Classification;
            execution.Troubleshooting = failure.Guidance;
            // Attempts is reset only by an explicit operator retry; each cycle has a strict maximum.
            if (failure.Transient && execution.Attempts < MaxAttempts)
            {
                execution.Status = "Retrying";
                var delay = FailurePolicy.Backoff(execution.Attempts, (ex as UpstreamException)?.RetryAfter);
                execution.AvailableAt = DateTime.UtcNow.Add(delay);
                await Log(execution, "RetryScheduled", $"{failure.Classification} (transient); attempt {execution.Attempts + 1} of {MaxAttempts} in {delay.TotalSeconds:0} seconds.", ct, "Warning");
            }
            else if (failure.Transient)
            {
                execution.Status = "Failed";
                Finish(execution);
                await Log(execution, "RetryExhausted", $"{failure.Classification} (transient) persisted for all {MaxAttempts} attempts. {failure.Guidance}", ct, "Error");
            }
            else
            {
                execution.Status = "Failed";
                Finish(execution);
                await Log(execution, "Failed", $"{failure.Classification} (permanent, not retried automatically): {failure.Guidance}", ct, "Error");
            }
        }
    }

    /// <summary>SCN-002: immutable sales order import. The first valid mapping is frozen for every later attempt and retry.</summary>
    private async Task ImportOrderAsync(Execution execution, CancellationToken ct)
    {
        using var crm = new HttpRequestMessage(HttpMethod.Get, $"api/orders/{Uri.EscapeDataString(execution.OrderId)}");
        AddSimulation(crm, execution, "CRM");
        using var source = await clients.CreateClient("CRM").SendAsync(crm, ct);
        await CheckAsync(source, ct);
        var order = await source.Content.ReadFromJsonAsync<CrmOrder>(ct)
            ?? throw new ValidationException("CRM returned an empty order.");
        if (order.Id != execution.OrderId) throw new ValidationException("CRM returned a different order ID.");
        execution.SourceId ??= order.Id;
        execution.SourcePayload ??= JsonSerializer.Serialize(order, JsonSerializerOptions.Web);
        await Log(execution, "Retrieved", "Source order retrieved from mock CRM.", ct);
        // Freeze the first valid mapping, so manual retries cannot change a transaction after an ambiguous timeout.
        var mapped = execution.MappedPayload is null ? Mapping.Transform(order)
            : JsonSerializer.Deserialize<ErpOrder>(execution.MappedPayload, JsonSerializerOptions.Web)!; // case-insensitive: v1 payloads were PascalCase
        execution.MappedPayload ??= JsonSerializer.Serialize(mapped, JsonSerializerOptions.Web);
        await Log(execution, "Mapped", "Validated and mapped to ERP minor-unit amount.", ct);
        using var erp = new HttpRequestMessage(HttpMethod.Post, "api/orders") { Content = JsonContent.Create(mapped) };
        erp.Headers.Add("X-Execution-Id", execution.Id);
        AddSimulation(erp, execution, "ERP");
        using var target = await clients.CreateClient("ERP").SendAsync(erp, ct);
        await CheckAsync(target, ct);
        var receipt = await target.Content.ReadFromJsonAsync<Receipt>(ct)
            ?? throw new ValidationException("ERP returned an empty receipt.");
        if (receipt.ExternalOrderId != execution.OrderId || string.IsNullOrWhiteSpace(receipt.ReceiptId))
            throw new ValidationException("ERP receipt does not match the source order.");
        Complete(execution, receipt.ReceiptId);
        await Log(execution, "Completed", receipt.Duplicate
            ? "ERP confirmed an existing matching transaction; no duplicate created."
            : "Mock ERP accepted the order.", ct);
    }

    /// <summary>
    /// SCN-001/SCN-003: customer master upsert. The source version and mapped payload are frozen at the first
    /// successful mapping; the ERP applies a version only if it is not older than the one it already holds.
    /// </summary>
    private async Task SyncCustomerAsync(Execution execution, CancellationToken ct)
    {
        var customerId = execution.SourceId ?? throw new ValidationException("Customer sync has no source customer ID.");
        using var crm = new HttpRequestMessage(HttpMethod.Get, $"api/customers/{Uri.EscapeDataString(customerId)}");
        AddSimulation(crm, execution, "CRM");
        using var source = await clients.CreateClient("CRM").SendAsync(crm, ct);
        await CheckAsync(source, ct);
        var customer = await source.Content.ReadFromJsonAsync<Customer>(ct)
            ?? throw new ValidationException("CRM returned an empty customer.");
        if (customer.Id != customerId) throw new ValidationException("CRM returned a different customer ID.");
        await Log(execution, "Retrieved", $"Customer {customerId} version {customer.Version} retrieved from Legacy CRM.", ct);
        ErpCustomer mapped;
        if (execution.MappedPayload is null)
        {
            mapped = Mapping.Transform(customer);
            execution.SourceVersion = customer.Version;
            execution.SourcePayload = JsonSerializer.Serialize(customer, JsonSerializerOptions.Web);
            execution.MappedPayload = JsonSerializer.Serialize(mapped, JsonSerializerOptions.Web);
            await Log(execution, "Mapped", $"Validated and mapped source version {customer.Version} to the ERP customer master schema.", ct);
        }
        else
        {
            mapped = JsonSerializer.Deserialize<ErpCustomer>(execution.MappedPayload, JsonSerializerOptions.Web)!;
            await Log(execution, "Mapped", customer.Version == execution.SourceVersion
                ? $"Reusing the frozen mapping of source version {execution.SourceVersion}."
                : $"Reusing the frozen mapping of source version {execution.SourceVersion}; the CRM is now at version {customer.Version}. Run a new sync to deliver the newer data.", ct);
        }
        using var erp = new HttpRequestMessage(HttpMethod.Put, $"api/customers/{Uri.EscapeDataString(mapped.AccountCode)}")
            { Content = JsonContent.Create(mapped) };
        erp.Headers.Add("X-Execution-Id", execution.Id);
        if (execution.SourceVersion is int version) erp.Headers.Add("X-Source-Version", version.ToString());
        AddSimulation(erp, execution, "ERP");
        using var target = await clients.CreateClient("ERP").SendAsync(erp, ct);
        await CheckAsync(target, ct);
        var result = await target.Content.ReadFromJsonAsync<CustomerSyncResult>(ct)
            ?? throw new ValidationException("ERP returned an empty customer sync result.");
        if (result.AccountCode != mapped.AccountCode || string.IsNullOrWhiteSpace(result.ReceiptId))
            throw new ValidationException("ERP result does not match the mapped customer.");
        Complete(execution, result.ReceiptId);
        var v = execution.SourceVersion;
        await Log(execution, "Completed", result.Outcome switch
        {
            "Created" => $"Modern ERP created customer {result.AccountCode} from source version {v}.",
            "Updated" when result.ChangedFields.Length > 0 => $"Modern ERP updated {result.AccountCode} from source version {v}: {string.Join(", ", result.ChangedFields)}.",
            "Updated" => $"Modern ERP linked fixture {result.AccountCode} to the integration at source version {v}; no field changes.",
            "Unchanged" => $"Modern ERP already held identical data for {result.AccountCode}; nothing changed (idempotent).",
            "SkippedStale" => $"Modern ERP already holds newer source version {result.AppliedVersion}; version {v} was not applied.",
            _ => $"Modern ERP reported outcome {result.Outcome} for {result.AccountCode}."
        }, ct);
    }

    private static void Complete(Execution execution, string receiptId)
    {
        execution.ReceiptId = receiptId;
        execution.Status = "Completed";
        execution.ErrorClass = null;
        execution.Troubleshooting = null;
        Finish(execution);
    }
    /// <summary>Raises a classified failure; reads only the target's small reason code and business reference, never the body.</summary>
    private static async Task CheckAsync(HttpResponseMessage response, CancellationToken ct)
    {
        if (response.IsSuccessStatusCode) return;
        var retryAfter = response.Headers.RetryAfter?.Delta;
        if (retryAfter is null && response.Headers.RetryAfter?.Date is { } date)
            retryAfter = date - DateTimeOffset.UtcNow;
        string? code = null, reference = null;
        if ((int)response.StatusCode is 409 or 422)
        {
            try
            {
                using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
                if (doc.RootElement.ValueKind == JsonValueKind.Object)
                {
                    if (doc.RootElement.TryGetProperty("code", out var c) && c.ValueKind == JsonValueKind.String) code = Short(c.GetString());
                    if (doc.RootElement.TryGetProperty("accountCode", out var a) && a.ValueKind == JsonValueKind.String) reference = Short(a.GetString());
                }
            }
            catch (JsonException) { /* classification falls back to the status code */ }
        }
        throw new UpstreamException((int)response.StatusCode, retryAfter, code, reference);
    }
    private static string? Short(string? value) => value is null ? null : value.Length > 60 ? value[..60] : value;
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
        logger.LogInformation("Execution {ExecutionId} Kind {Kind} Stage {Stage} Attempt {Attempt} Status {Status}",
            e.Id, e.Kind, stage, e.Attempts, e.Status);
        await db.SaveChangesAsync(ct);
    }
}
