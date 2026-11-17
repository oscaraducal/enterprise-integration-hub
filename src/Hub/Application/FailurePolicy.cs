namespace Hub.Application;
public record Failure(string Classification, bool Transient, string Guidance);
public static class FailurePolicy
{
    public static Failure Classify(int status) => status switch
    {
        400 => new("InvalidRequest", false, "Inspect the mapped order and required fields; correct the CRM record before retrying."),
        401 or 403 => new("Authentication", false, "Check the local service-key configuration. Never paste credentials into logs."),
        404 => new("MissingResource", false, "Check the source order ID and configured mock service route."),
        409 => new("DuplicateConflict", false, "Reconcile the existing ERP order; do not bypass the idempotency key."),
        429 => new("RateLimited", true, "Wait for the rate-limit window; automatic retry respects the bounded Retry-After delay."),
        408 or 504 => new("Timeout", true, "Inspect service availability. Retrying uses the same source order ID."),
        >= 500 => new("UpstreamUnavailable", true, "Check mock API health and the simulation configuration."),
        _ => new("UnexpectedResponse", false, "Inspect the execution stages and upstream contract.")
    };
    public static TimeSpan Backoff(int attempt, TimeSpan? retryAfter = null)
    {
        var seconds = Math.Min(30, Math.Pow(2, Math.Clamp(attempt - 1, 0, 5)));
        if (retryAfter is not null) seconds = Math.Max(seconds, Math.Clamp(retryAfter.Value.TotalSeconds, 0, 30));
        return TimeSpan.FromSeconds(seconds);
    }
}
public class UpstreamException(int status, TimeSpan? retryAfter = null) : Exception("Upstream request failed.")
{
    public int Status { get; } = status;
    public TimeSpan? RetryAfter { get; } = retryAfter;
}
