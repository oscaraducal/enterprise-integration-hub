namespace Hub.Application;
public record Failure(string Classification, bool Transient, string Guidance);
public static class FailurePolicy
{
    public static Failure Classify(int status) => Classify(status, null, null);
    /// <param name="code">Machine-readable reason returned by the target (e.g. UnknownAccount).</param>
    /// <param name="reference">Business reference from the target's response (e.g. the account code); never a secret.</param>
    public static Failure Classify(int status, string? code, string? reference) => (status, code) switch
    {
        (422, "UnknownAccount") => new("MissingCustomer", false,
            $"Account {reference ?? "for this order"} does not exist in Modern ERP yet. Run SCN-001 Customer Master Synchronization for it, then use Safely retry."),
        (422, "AccountBlocked") => new("TargetRejected", false,
            $"Modern ERP rejected the order because account {reference ?? "for this order"} is not ACTIVE. Fix the customer status in the Legacy CRM, synchronize it (SCN-003), then retry."),
        (422, _) => new("TargetRejected", false, "Modern ERP rejected the payload under its business rules. Inspect the mapped payload and target record."),
        (400, _) => new("InvalidRequest", false, "Inspect the mapped order and required fields; correct the CRM record before retrying."),
        (401 or 403, _) => new("Authentication", false, "Check the local service-key configuration. Never paste credentials into logs."),
        (404, _) => new("MissingResource", false, "Check the source record ID and configured mock service route."),
        (409, _) => new("DuplicateConflict", false, "Reconcile the existing ERP record; do not bypass the idempotency key."),
        (429, _) => new("RateLimited", true, "Wait for the rate-limit window; automatic retry respects the bounded Retry-After delay."),
        (408 or 504, _) => new("Timeout", true, "Inspect service availability. Retrying uses the same source record ID."),
        ( >= 500, _) => new("UpstreamUnavailable", true, "Check mock API health and the simulation configuration."),
        _ => new("UnexpectedResponse", false, "Inspect the execution stages and upstream contract.")
    };
    public static TimeSpan Backoff(int attempt, TimeSpan? retryAfter = null)
    {
        var seconds = Math.Min(30, Math.Pow(2, Math.Clamp(attempt - 1, 0, 5)));
        if (retryAfter is not null) seconds = Math.Max(seconds, Math.Clamp(retryAfter.Value.TotalSeconds, 0, 30));
        return TimeSpan.FromSeconds(seconds);
    }
}
public class UpstreamException(int status, TimeSpan? retryAfter = null, string? code = null, string? reference = null)
    : Exception("Upstream request failed.")
{
    public int Status { get; } = status;
    public TimeSpan? RetryAfter { get; } = retryAfter;
    public string? Code { get; } = code;
    public string? Reference { get; } = reference;
}
