namespace Hub.Domain;

/// <summary>
/// An immutable, versioned mapping definition saved from the Mapping Studio. Saving never overwrites: each save of
/// the same name adds version n+1. Definitions are configuration only; Milestone B never executes them.
/// </summary>
public class MappingDefinition
{
    public long Id { get; set; }
    public string Name { get; set; } = "";
    public int Version { get; set; }
    public string? Description { get; set; }
    public string SourceSystem { get; set; } = "";
    public string SourceTable { get; set; } = "";
    public int SourceSchemaVersion { get; set; }
    public string TargetSystem { get; set; } = "";
    public string TargetTable { get; set; } = "";
    public int TargetSchemaVersion { get; set; }
    public string FieldsJson { get; set; } = "[]";
    public string CreatedBy { get; set; } = "";
    public DateTime CreatedAt { get; set; }
}
