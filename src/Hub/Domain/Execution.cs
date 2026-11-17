namespace Hub.Domain;

public static class Statuses
{
    public static readonly string[] All = ["Pending", "Running", "Completed", "Failed", "Retrying"];
}
public class Execution
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string OrderId { get; set; } = "";
    public string Status { get; set; } = "Pending";
    public string Environment { get; set; } = "DEV";
    public string Scenario { get; set; } = "None";
    public string Target { get; set; } = "ERP";
    public int FailuresBeforeSuccess { get; set; } = 1;
    public int Attempts { get; set; }
    public int RetryCount { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? StartedAt { get; set; }
    public DateTime? EndedAt { get; set; }
    public DateTime AvailableAt { get; set; } = DateTime.UtcNow;
    public double? DurationMs { get; set; }
    public string? ErrorClass { get; set; }
    public string? Troubleshooting { get; set; }
    public string? ReceiptId { get; set; }
    public string? MappedPayload { get; set; }
    public List<ExecutionLog> Logs { get; set; } = [];
}
public class ExecutionLog
{
    public long Id { get; set; }
    public string ExecutionId { get; set; } = "";
    public DateTime Timestamp { get; set; } = DateTime.UtcNow;
    public string Stage { get; set; } = "";
    public string Level { get; set; } = "Information";
    public string Message { get; set; } = "";
    public int Attempt { get; set; }
}
public class JobRun
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = "";
    public string Environment { get; set; } = "DEV";
    public string Status { get; set; } = "Completed";
    public DateTime StartedAt { get; set; }
    public DateTime EndedAt { get; set; }
    public string Details { get; set; } = "";
}
