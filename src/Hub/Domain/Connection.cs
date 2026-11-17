namespace Hub.Domain;

/// <summary>
/// A reusable connection to an approved internal application. It stores only references and metadata: base URLs and
/// credentials are resolved by the Hub at call time and are never stored here or sent to the browser.
/// </summary>
public class Connection
{
    public string Identifier { get; set; } = "";
    public string Name { get; set; } = "";
    public string? Description { get; set; }
    public string Adapter { get; set; } = "REST";
    public string Role { get; set; } = "Invoke";
    public string Application { get; set; } = "";
    /// <summary>Draft (saved, not yet tested), Configured (last test passed) or Failed (last test failed).</summary>
    public string Status { get; set; } = "Draft";
    public DateTime? LastTestedAt { get; set; }
    public string? LastTestSummary { get; set; }
    public int Revision { get; set; } = 1;
    public DateTime CreatedAt { get; set; }
    public string CreatedBy { get; set; } = "";
    public DateTime UpdatedAt { get; set; }
    public string UpdatedBy { get; set; } = "";
}
