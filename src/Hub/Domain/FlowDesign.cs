namespace Hub.Domain;

/// <summary>An integration flow under design: one editable draft (with an optimistic-concurrency revision).</summary>
public class FlowDesign
{
    public string Name { get; set; } = "";
    public string Title { get; set; } = "";
    public string? Description { get; set; }
    public string DraftJson { get; set; } = "{}";
    public int DraftRevision { get; set; } = 1;
    public DateTime DraftUpdatedAt { get; set; }
    public string DraftUpdatedBy { get; set; } = "";
    public DateTime CreatedAt { get; set; }
    public string CreatedBy { get; set; } = "";
}
/// <summary>An immutable published version. Publishing requires a valid graph; versions are never edited.</summary>
public class FlowVersion
{
    public long Id { get; set; }
    public string FlowName { get; set; } = "";
    public int Version { get; set; }
    public string Title { get; set; } = "";
    public string? Description { get; set; }
    public string DefinitionJson { get; set; } = "{}";
    public int NodeCount { get; set; }
    public DateTime PublishedAt { get; set; }
    public string PublishedBy { get; set; } = "";
}
