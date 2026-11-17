using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;

namespace Integration.Shared;

// =====================================================================================================================
// Dynamic Data Catalog: metadata-driven logical tables for the fictional applications.
// Table definitions live in a metadata registry; rows are validated JSON documents. User input never becomes SQL:
// identifiers are validated against an allowlist pattern and only approved schema operations exist.
// =====================================================================================================================

/// <summary>A column of a logical table. <see cref="ReadOnly"/> columns are set by the application, never mapped into.</summary>
public sealed record ColumnDef(string Name, string Type, bool Required = false, string[]? Values = null,
    string? Description = null, bool ReadOnly = false);
public sealed record TableInput(string Name, string Title, string? Description, string PrimaryKey, List<ColumnDef> Columns);
/// <summary>An approved schema operation (see <see cref="CatalogRules.Operations"/>).</summary>
public sealed record SchemaChange(string Operation, ColumnDef? Column = null, string? ColumnName = null, bool? Required = null,
    string[]? Values = null, string? Title = null, string? Description = null);
public sealed record TableView(string Name, string Title, string? Description, string PrimaryKey, IReadOnlyList<ColumnDef> Columns,
    int Version, bool BuiltIn, int? RecordCount, DateTime? UpdatedAt);
public sealed record TableVersionView(int Version, string Change, DateTime ChangedAt, IReadOnlyList<ColumnDef> Columns);
public sealed record RecordView(string Key, JsonElement Data, int SchemaVersion, DateTime CreatedAt, DateTime UpdatedAt);
public sealed record RecordPage(IReadOnlyList<RecordView> Items, int Total, int Page, int PageSize);
/// <summary>A built-in (code-defined) table exposed for discovery only. Its rows are served by the application's own API.</summary>
public sealed record BuiltInTable<TDb>(TableView Definition, string RecordsPath, Func<TDb, CancellationToken, Task<int>> Count);

public class CatalogTable
{
    public string Name { get; set; } = "";
    public string Title { get; set; } = "";
    public string? Description { get; set; }
    public string PrimaryKey { get; set; } = "";
    public string ColumnsJson { get; set; } = "[]";
    public int Version { get; set; } = 1;
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}
public class CatalogTableVersion
{
    public long Id { get; set; }
    public string TableName { get; set; } = "";
    public int Version { get; set; }
    public string ColumnsJson { get; set; } = "[]";
    public string Change { get; set; } = "";
    public DateTime ChangedAt { get; set; }
}
public class CatalogRecord
{
    public long Id { get; set; }
    public string TableName { get; set; } = "";
    public string RecordKey { get; set; } = "";
    public string DataJson { get; set; } = "{}";
    public int SchemaVersion { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}
public interface ICatalogDb
{
    DbSet<CatalogTable> CatalogTables { get; }
    DbSet<CatalogTableVersion> CatalogTableVersions { get; }
    DbSet<CatalogRecord> CatalogRecords { get; }
}

public static class CatalogModel
{
    public static void Configure(ModelBuilder model)
    {
        model.Entity<CatalogTable>().ToTable("CatalogTables").HasKey(x => x.Name);
        model.Entity<CatalogTableVersion>().ToTable("CatalogTableVersions").HasIndex(x => new { x.TableName, x.Version }).IsUnique();
        model.Entity<CatalogRecord>().ToTable("CatalogRecords").HasIndex(x => new { x.TableName, x.RecordKey }).IsUnique();
    }
    /// <summary>Additive and idempotent: creates the registry tables in an existing database without touching other data.</summary>
    public static async Task EnsureSchemaAsync(DbContext db)
    {
        await SchemaUpgrade.ExecuteAsync(db, """
            CREATE TABLE IF NOT EXISTS "CatalogTables" (
                "Name" TEXT NOT NULL CONSTRAINT "PK_CatalogTables" PRIMARY KEY, "Title" TEXT NOT NULL, "Description" TEXT NULL,
                "PrimaryKey" TEXT NOT NULL, "ColumnsJson" TEXT NOT NULL, "Version" INTEGER NOT NULL,
                "CreatedAt" TEXT NOT NULL, "UpdatedAt" TEXT NOT NULL)
            """);
        await SchemaUpgrade.ExecuteAsync(db, """
            CREATE TABLE IF NOT EXISTS "CatalogTableVersions" (
                "Id" INTEGER NOT NULL CONSTRAINT "PK_CatalogTableVersions" PRIMARY KEY AUTOINCREMENT, "TableName" TEXT NOT NULL,
                "Version" INTEGER NOT NULL, "ColumnsJson" TEXT NOT NULL, "Change" TEXT NOT NULL, "ChangedAt" TEXT NOT NULL)
            """);
        await SchemaUpgrade.ExecuteAsync(db, """CREATE UNIQUE INDEX IF NOT EXISTS "IX_CatalogTableVersions_TableName_Version" ON "CatalogTableVersions" ("TableName", "Version")""");
        await SchemaUpgrade.ExecuteAsync(db, """
            CREATE TABLE IF NOT EXISTS "CatalogRecords" (
                "Id" INTEGER NOT NULL CONSTRAINT "PK_CatalogRecords" PRIMARY KEY AUTOINCREMENT, "TableName" TEXT NOT NULL,
                "RecordKey" TEXT NOT NULL, "DataJson" TEXT NOT NULL, "SchemaVersion" INTEGER NOT NULL,
                "CreatedAt" TEXT NOT NULL, "UpdatedAt" TEXT NOT NULL)
            """);
        await SchemaUpgrade.ExecuteAsync(db, """CREATE UNIQUE INDEX IF NOT EXISTS "IX_CatalogRecords_TableName_RecordKey" ON "CatalogRecords" ("TableName", "RecordKey")""");
    }
}

/// <summary>Identifier, type, limit and record validation for the catalog. Pure functions, unit tested.</summary>
public static partial class CatalogRules
{
    public static readonly string[] Types = ["string", "integer", "decimal", "boolean", "date", "datetime", "enum"];
    public static readonly string[] Operations = ["AddColumn", "RemoveColumn", "SetRequired", "AddEnumValues", "UpdateDetails"];
    public const int MaxTables = 20, MaxColumns = 40, MaxRecords = 500, MaxRecordBytes = 8192, MaxString = 500, MaxEnumValues = 30;
    public const int DefaultPageSize = 25, MaxPageSize = 100;

    [GeneratedRegex("^[a-z][a-z0-9_]{1,39}$")] private static partial Regex TableName();
    [GeneratedRegex("^[A-Za-z][A-Za-z0-9_]{0,39}$")] private static partial Regex ColumnName();
    [GeneratedRegex("^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$")] private static partial Regex EnumValue();
    [GeneratedRegex("^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$")] private static partial Regex KeyValue();

    public static bool ValidTableName(string? name) => name is not null && TableName().IsMatch(name);
    public static bool ValidKey(string? key) => key is not null && KeyValue().IsMatch(key);

    public static Dictionary<string, string[]> ValidateTable(TableInput input, IEnumerable<string> reserved)
    {
        var errors = new Dictionary<string, List<string>>();
        void Add(string field, string message) { if (!errors.TryGetValue(field, out var l)) errors[field] = l = []; l.Add(message); }
        if (!ValidTableName(input.Name)) Add("name", "Use 2-40 lowercase letters, digits or underscores, starting with a letter.");
        else if (reserved.Contains(input.Name, StringComparer.OrdinalIgnoreCase)) Add("name", $"'{input.Name}' is a built-in table name.");
        if (string.IsNullOrWhiteSpace(input.Title) || input.Title.Length > 80) Add("title", "Title is required (max 80 characters).");
        if (input.Description?.Length > 300) Add("description", "Description is limited to 300 characters.");
        var columns = input.Columns ?? [];
        if (columns.Count is 0 or > MaxColumns) Add("columns", $"Define 1 to {MaxColumns} columns.");
        foreach (var (column, i) in columns.Select((c, i) => (c, i)))
            foreach (var message in ValidateColumn(column)) Add($"columns[{i}]", message);
        foreach (var dup in columns.GroupBy(c => c.Name, StringComparer.OrdinalIgnoreCase).Where(g => g.Count() > 1))
            Add("columns", $"Column '{dup.Key}' is defined more than once.");
        var pk = columns.FirstOrDefault(c => c.Name == input.PrimaryKey);
        if (pk is null) Add("primaryKey", "The primary key must be one of the columns.");
        else if (pk.Type is not ("string" or "integer")) Add("primaryKey", "The primary key must be a string or integer column.");
        else if (!pk.Required) Add("primaryKey", "The primary key column must be required.");
        return errors.ToDictionary(e => e.Key, e => e.Value.ToArray());
    }
    public static IEnumerable<string> ValidateColumn(ColumnDef c)
    {
        if (c is null) { yield return "Column is missing."; yield break; }
        if (!ColumnName().IsMatch(c.Name ?? "")) yield return $"Column name '{c.Name}' must be 1-40 letters, digits or underscores, starting with a letter.";
        if (!Types.Contains(c.Type)) yield return $"Type '{c.Type}' is not supported. Use {string.Join(", ", Types)}.";
        if (c.Description?.Length > 200) yield return "Column description is limited to 200 characters.";
        if (c.ReadOnly) yield return "Read-only (system-managed) columns are reserved for built-in tables.";
        if (c.Type == "enum")
        {
            var values = c.Values ?? [];
            if (values.Length is 0 or > MaxEnumValues) yield return $"Enum columns need 1 to {MaxEnumValues} values.";
            if (values.Any(v => !EnumValue().IsMatch(v ?? ""))) yield return "Enum values must be 1-40 letters, digits, spaces, '_' or '-'.";
            if (values.Distinct(StringComparer.Ordinal).Count() != values.Length) yield return "Enum values must be unique.";
        }
        else if (c.Values is { Length: > 0 }) yield return "Only enum columns have values.";
    }

    /// <summary>Validates a record against the table, returning canonical JSON (known columns only) and its key.</summary>
    public static (JsonObject? Data, string? Key, Dictionary<string, string[]> Errors) ValidateRecord(
        IReadOnlyList<ColumnDef> columns, string primaryKey, JsonElement input)
    {
        var errors = new Dictionary<string, string[]>();
        if (input.ValueKind != JsonValueKind.Object) return (null, null, new() { ["record"] = ["The record must be a JSON object."] });
        var known = columns.ToDictionary(c => c.Name, StringComparer.Ordinal);
        foreach (var p in input.EnumerateObject().Where(p => !known.ContainsKey(p.Name)))
            errors[p.Name] = ["Unknown field. It is not a column of this table."];
        var output = new JsonObject();
        foreach (var column in columns)
        {
            var present = input.TryGetProperty(column.Name, out var value) && value.ValueKind is not (JsonValueKind.Null or JsonValueKind.Undefined)
                && !(value.ValueKind == JsonValueKind.String && value.GetString()!.Trim().Length == 0);
            if (!present)
            {
                if (column.Required) errors[column.Name] = ["This field is required."];
                continue;
            }
            var (node, error) = Coerce(column, value);
            if (error is not null) errors[column.Name] = [error];
            else output[column.Name] = node;
        }
        var key = output[primaryKey]?.ToString();
        if (key is not null && !ValidKey(key)) errors[primaryKey] = ["Key values may contain letters, digits, '.', '_' or '-' (max 60)."];
        if (errors.Count > 0) return (null, null, errors);
        if (System.Text.Encoding.UTF8.GetByteCount(output.ToJsonString()) > MaxRecordBytes)
            return (null, null, new() { ["record"] = [$"Records are limited to {MaxRecordBytes} bytes."] });
        return (output, key, errors);
    }
    private static (JsonNode? Node, string? Error) Coerce(ColumnDef column, JsonElement v)
    {
        switch (column.Type)
        {
            case "string":
                if (v.ValueKind != JsonValueKind.String) return (null, "Expected text.");
                var s = v.GetString()!;
                return s.Length > MaxString ? (null, $"Text is limited to {MaxString} characters.") : (JsonValue.Create(s), null);
            case "integer":
                return v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var l) ? (JsonValue.Create(l), null) : (null, "Expected a whole number.");
            case "decimal":
                return v.ValueKind == JsonValueKind.Number && v.TryGetDecimal(out var d) ? (JsonValue.Create(d), null) : (null, "Expected a number.");
            case "boolean":
                return v.ValueKind is JsonValueKind.True or JsonValueKind.False ? (JsonValue.Create(v.GetBoolean()), null) : (null, "Expected true or false.");
            case "date":
                return v.ValueKind == JsonValueKind.String && DateOnly.TryParseExact(v.GetString(), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date)
                    ? (JsonValue.Create(date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)), null) : (null, "Expected a date as YYYY-MM-DD.");
            case "datetime":
                return v.ValueKind == JsonValueKind.String && DateTimeOffset.TryParse(v.GetString(), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var dt)
                    ? (JsonValue.Create(dt.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture)), null) : (null, "Expected an ISO 8601 date and time.");
            case "enum":
                return v.ValueKind == JsonValueKind.String && (column.Values ?? []).Contains(v.GetString())
                    ? (JsonValue.Create(v.GetString()), null) : (null, $"Expected one of: {string.Join(", ", column.Values ?? [])}.");
            default: return (null, "Unsupported column type.");
        }
    }

    /// <summary>Generated REST contract for a logical table: routes plus a JSON-schema description of a record.</summary>
    public static object Contract(TableView table, string basePath)
    {
        string Format(ColumnDef c) => c.Type switch { "date" => "date", "datetime" => "date-time", _ => "" };
        string JsonType(ColumnDef c) => c.Type switch { "integer" => "integer", "decimal" => "number", "boolean" => "boolean", _ => "string" };
        var records = $"{basePath}/tables/{table.Name}/records";
        return new
        {
            table = table.Name, version = table.Version, builtIn = table.BuiltIn, primaryKey = table.PrimaryKey,
            endpoints = table.BuiltIn
                ? new[] { new { method = "GET", path = $"{basePath}/tables/{table.Name}", description = "Table metadata (rows are served by the application's own API)." } }
                : new[]
                {
                    new { method = "GET", path = records + "?page=1&pageSize=25&search=", description = "List records (paginated, max 100 per page)." },
                    new { method = "GET", path = records + "/{key}", description = $"Get one record by {table.PrimaryKey}." },
                    new { method = "POST", path = records, description = "Create a record (validated against the schema)." },
                    new { method = "PUT", path = records + "/{key}", description = $"Replace a record; {table.PrimaryKey} cannot change." },
                    new { method = "DELETE", path = records + "/{key}", description = "Delete a synthetic record." },
                },
            schema = new
            {
                type = "object", additionalProperties = false,
                required = table.Columns.Where(c => c.Required).Select(c => c.Name).ToArray(),
                properties = table.Columns.ToDictionary(c => c.Name, c => (object)new
                {
                    type = JsonType(c), format = Format(c) is { Length: > 0 } f ? f : null, @enum = c.Values,
                    maxLength = c.Type == "string" ? MaxString : (int?)null, readOnly = c.ReadOnly ? true : (bool?)null, description = c.Description
                })
            }
        };
    }
}

/// <summary>Maps the catalog API (service-key protected like every /api route of the fictional applications).</summary>
public static class CatalogEndpoints
{
    private static readonly JsonSerializerOptions Json = JsonSerializerOptions.Web;
    internal static List<ColumnDef> Columns(string json) => JsonSerializer.Deserialize<List<ColumnDef>>(json, Json) ?? [];
    private static TableView View(CatalogTable t, int? count) =>
        new(t.Name, t.Title, t.Description, t.PrimaryKey, Columns(t.ColumnsJson), t.Version, false, count, t.UpdatedAt);

    public static void MapCatalog<TDb>(this WebApplication app, IReadOnlyList<BuiltInTable<TDb>> builtIns) where TDb : DbContext, ICatalogDb
    {
        var group = app.MapGroup("/api/catalog");
        var reserved = builtIns.Select(b => b.Definition.Name).Append("tables").ToArray();
        BuiltInTable<TDb>? BuiltIn(string name) => builtIns.FirstOrDefault(b => b.Definition.Name == name);
        IResult BuiltInRefusal(string name) => Results.Conflict(new { code = "BuiltInTable",
            error = $"'{name}' is a built-in table. Its schema is fixed and its rows are managed by the application's own API." });

        group.MapGet("/tables", async (TDb db, CancellationToken ct) =>
        {
            var counts = await db.CatalogRecords.GroupBy(r => r.TableName).Select(g => new { g.Key, Count = g.Count() }).ToDictionaryAsync(x => x.Key, x => x.Count, ct);
            var custom = await db.CatalogTables.AsNoTracking().OrderBy(t => t.Name).ToListAsync(ct);
            var result = new List<TableView>();
            foreach (var b in builtIns) result.Add(b.Definition with { RecordCount = await b.Count(db, ct) });
            result.AddRange(custom.Select(t => View(t, counts.GetValueOrDefault(t.Name))));
            return Results.Ok(result);
        });
        group.MapGet("/tables/{name}", async (string name, TDb db, CancellationToken ct) =>
        {
            if (BuiltIn(name) is { } b) return Results.Ok(new { table = b.Definition with { RecordCount = await b.Count(db, ct) }, versions = Array.Empty<TableVersionView>(), recordsPath = b.RecordsPath });
            var t = await db.CatalogTables.AsNoTracking().SingleOrDefaultAsync(x => x.Name == name, ct);
            if (t is null) return Results.NotFound();
            var count = await db.CatalogRecords.CountAsync(r => r.TableName == name, ct);
            var versions = (await db.CatalogTableVersions.AsNoTracking().Where(v => v.TableName == name).OrderByDescending(v => v.Version).ToListAsync(ct))
                .Select(v => new TableVersionView(v.Version, v.Change, v.ChangedAt, Columns(v.ColumnsJson)));
            return Results.Ok(new { table = View(t, count), versions, recordsPath = $"/api/catalog/tables/{name}/records" });
        });
        group.MapGet("/tables/{name}/contract", async (string name, TDb db, CancellationToken ct) =>
        {
            if (BuiltIn(name) is { } b) return Results.Ok(CatalogRules.Contract(b.Definition, "/api/catalog"));
            var t = await db.CatalogTables.AsNoTracking().SingleOrDefaultAsync(x => x.Name == name, ct);
            return t is null ? Results.NotFound() : Results.Ok(CatalogRules.Contract(View(t, null), "/api/catalog"));
        });
        group.MapPost("/tables", async (TableInput input, TDb db, CancellationToken ct) =>
        {
            var errors = CatalogRules.ValidateTable(input, reserved);
            if (errors.Count > 0) return Results.ValidationProblem(errors);
            if (await db.CatalogTables.CountAsync(ct) >= CatalogRules.MaxTables)
                return Results.Conflict(new { code = "TableLimit", error = $"At most {CatalogRules.MaxTables} logical tables per application." });
            if (await db.CatalogTables.AnyAsync(t => t.Name == input.Name, ct))
                return Results.Conflict(new { code = "TableExists", error = $"Table '{input.Name}' already exists." });
            var now = DateTime.UtcNow;
            var columns = JsonSerializer.Serialize(input.Columns.Select(c => c with { Values = c.Type == "enum" ? c.Values : null }), Json);
            var table = new CatalogTable { Name = input.Name, Title = input.Title.Trim(), Description = input.Description?.Trim(), PrimaryKey = input.PrimaryKey,
                ColumnsJson = columns, Version = 1, CreatedAt = now, UpdatedAt = now };
            db.CatalogTables.Add(table);
            db.CatalogTableVersions.Add(new() { TableName = input.Name, Version = 1, ColumnsJson = columns, Change = "Created table", ChangedAt = now });
            try { await db.SaveChangesAsync(ct); }
            catch (DbUpdateException) { return Results.Conflict(new { code = "TableExists", error = $"Table '{input.Name}' already exists." }); }
            return Results.Created($"/api/catalog/tables/{input.Name}", View(table, 0));
        });
        group.MapPost("/tables/{name}/schema", async (string name, SchemaChange change, TDb db, CancellationToken ct) =>
        {
            if (BuiltIn(name) is not null) return BuiltInRefusal(name);
            var t = await db.CatalogTables.SingleOrDefaultAsync(x => x.Name == name, ct);
            if (t is null) return Results.NotFound();
            var columns = Columns(t.ColumnsJson);
            var records = await db.CatalogRecords.AsNoTracking().Where(r => r.TableName == name).Select(r => r.DataJson).ToListAsync(ct);
            int WithValue(string column) => records.Count(r => JsonNode.Parse(r)?[column] is not null);
            IResult Invalid(string field, string message) => Results.ValidationProblem(new Dictionary<string, string[]> { [field] = [message] });
            ColumnDef? Find() => columns.FirstOrDefault(c => c.Name == change.ColumnName);
            string summary;
            switch (change.Operation)
            {
                case "AddColumn":
                    if (change.Column is not { } add) return Invalid("column", "Provide the column to add.");
                    if (CatalogRules.ValidateColumn(add).FirstOrDefault() is { } bad) return Invalid("column", bad);
                    if (columns.Any(c => c.Name.Equals(add.Name, StringComparison.OrdinalIgnoreCase))) return Invalid("column", $"Column '{add.Name}' already exists.");
                    if (columns.Count >= CatalogRules.MaxColumns) return Invalid("column", $"Tables are limited to {CatalogRules.MaxColumns} columns.");
                    if (add.Required && records.Count > 0)
                        return Results.Conflict(new { code = "RequiresBackfill", error = $"The table has {records.Count} records without a value for '{add.Name}'. Add it as optional, fill the values, then mark it required." });
                    columns.Add(add with { Values = add.Type == "enum" ? add.Values : null });
                    summary = $"Added column {add.Name} ({add.Type}{(add.Required ? ", required" : "")})";
                    break;
                case "RemoveColumn":
                    if (Find() is not { } remove) return Invalid("columnName", "Unknown column.");
                    if (remove.Name == t.PrimaryKey) return Invalid("columnName", "The primary key cannot be removed.");
                    if (WithValue(remove.Name) is var used and > 0)
                        return Results.Conflict(new { code = "ColumnInUse", records = used,
                            error = $"{used} record(s) have a value for '{remove.Name}'. Clear those values first; the catalog never deletes data silently." });
                    columns.Remove(remove);
                    summary = $"Removed unused column {remove.Name}";
                    break;
                case "SetRequired":
                    if (Find() is not { } target || change.Required is not bool required) return Invalid("columnName", "Provide a column and required=true|false.");
                    if (target.Name == t.PrimaryKey && !required) return Invalid("columnName", "The primary key must stay required.");
                    if (required && WithValue(target.Name) is var filled && filled < records.Count)
                        return Results.Conflict(new { code = "RequiresBackfill", error = $"{records.Count - filled} record(s) have no value for '{target.Name}'. Fill them before making it required." });
                    columns[columns.IndexOf(target)] = target with { Required = required };
                    summary = $"{(required ? "Required" : "Optional")}: {target.Name}";
                    break;
                case "AddEnumValues":
                    if (Find() is not { Type: "enum" } en) return Invalid("columnName", "Provide an enum column.");
                    var merged = (en.Values ?? []).Concat(change.Values ?? []).Distinct(StringComparer.Ordinal).ToArray();
                    var updated = en with { Values = merged };
                    if (CatalogRules.ValidateColumn(updated).FirstOrDefault() is { } enumError) return Invalid("values", enumError);
                    if (merged.Length == en.Values?.Length) return Invalid("values", "No new values to add.");
                    columns[columns.IndexOf(en)] = updated;
                    summary = $"Added values to {en.Name}: {string.Join(", ", merged.Except(en.Values ?? []))}";
                    break;
                case "UpdateDetails":
                    if (change.Title is { } title) { if (string.IsNullOrWhiteSpace(title) || title.Length > 80) return Invalid("title", "Title is required (max 80 characters)."); t.Title = title.Trim(); }
                    if (change.Description is { } description) { if (description.Length > 300) return Invalid("description", "Max 300 characters."); t.Description = description.Trim(); }
                    summary = "Updated table details";
                    break;
                default:
                    return Invalid("operation", $"Unsupported operation. Approved operations: {string.Join(", ", CatalogRules.Operations)}. Type changes and renames are not supported.");
            }
            t.ColumnsJson = JsonSerializer.Serialize(columns, Json);
            t.Version++;
            t.UpdatedAt = DateTime.UtcNow;
            db.CatalogTableVersions.Add(new() { TableName = name, Version = t.Version, ColumnsJson = t.ColumnsJson, Change = summary, ChangedAt = t.UpdatedAt });
            await db.SaveChangesAsync(ct);
            return Results.Ok(View(t, records.Count));
        });
        group.MapDelete("/tables/{name}", async (string name, TDb db, CancellationToken ct) =>
        {
            if (BuiltIn(name) is not null) return BuiltInRefusal(name);
            var t = await db.CatalogTables.SingleOrDefaultAsync(x => x.Name == name, ct);
            if (t is null) return Results.NotFound();
            var count = await db.CatalogRecords.CountAsync(r => r.TableName == name, ct);
            if (count > 0) return Results.Conflict(new { code = "TableNotEmpty", records = count, error = $"Table '{name}' still has {count} record(s). Delete them first; tables with data are never dropped." });
            db.CatalogTables.Remove(t);
            db.CatalogTableVersions.RemoveRange(db.CatalogTableVersions.Where(v => v.TableName == name));
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });

        // ----- Records (validated JSON rows) -----
        group.MapGet("/tables/{name}/records", async (string name, int? page, int? pageSize, string? search, TDb db, CancellationToken ct) =>
        {
            if (BuiltIn(name) is not null) return BuiltInRefusal(name);
            if (!await db.CatalogTables.AnyAsync(t => t.Name == name, ct)) return Results.NotFound();
            var size = Math.Clamp(pageSize ?? CatalogRules.DefaultPageSize, 1, CatalogRules.MaxPageSize);
            var query = db.CatalogRecords.AsNoTracking().Where(r => r.TableName == name);
            if (!string.IsNullOrWhiteSpace(search))
            {
                var term = search.Trim();
                if (term.Length > 60) return Results.BadRequest(new { error = "Search is limited to 60 characters." });
                var pattern = "%" + term.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%";
                query = query.Where(r => EF.Functions.Like(r.DataJson, pattern, "\\"));
            }
            var total = await query.CountAsync(ct);
            var current = Math.Clamp(page ?? 1, 1, Math.Max(1, (int)Math.Ceiling(total / (double)size)));
            var rows = await query.OrderBy(r => r.RecordKey).Skip((current - 1) * size).Take(size).ToListAsync(ct);
            return Results.Ok(new RecordPage(rows.Select(ToView).ToList(), total, current, size));
        });
        group.MapGet("/tables/{name}/records/{key}", async (string name, string key, TDb db, CancellationToken ct) =>
        {
            if (BuiltIn(name) is not null) return BuiltInRefusal(name);
            var row = await db.CatalogRecords.AsNoTracking().SingleOrDefaultAsync(r => r.TableName == name && r.RecordKey == key, ct);
            return row is null ? Results.NotFound() : Results.Ok(ToView(row));
        });
        group.MapPost("/tables/{name}/records", async (string name, JsonElement body, TDb db, CancellationToken ct) =>
        {
            if (BuiltIn(name) is not null) return BuiltInRefusal(name);
            var t = await db.CatalogTables.AsNoTracking().SingleOrDefaultAsync(x => x.Name == name, ct);
            if (t is null) return Results.NotFound();
            var (data, key, errors) = CatalogRules.ValidateRecord(Columns(t.ColumnsJson), t.PrimaryKey, body);
            if (errors.Count > 0) return Results.ValidationProblem(errors);
            if (await db.CatalogRecords.CountAsync(r => r.TableName == name, ct) >= CatalogRules.MaxRecords)
                return Results.Conflict(new { code = "RecordLimit", error = $"Logical tables are limited to {CatalogRules.MaxRecords} synthetic records." });
            if (await db.CatalogRecords.AnyAsync(r => r.TableName == name && r.RecordKey == key, ct))
                return Results.Conflict(new { code = "DuplicateKey", error = $"A record with {t.PrimaryKey} '{key}' already exists." });
            var now = DateTime.UtcNow;
            var row = new CatalogRecord { TableName = name, RecordKey = key!, DataJson = data!.ToJsonString(), SchemaVersion = t.Version, CreatedAt = now, UpdatedAt = now };
            db.CatalogRecords.Add(row);
            try { await db.SaveChangesAsync(ct); }
            catch (DbUpdateException) { return Results.Conflict(new { code = "DuplicateKey", error = $"A record with {t.PrimaryKey} '{key}' already exists." }); }
            return Results.Created($"/api/catalog/tables/{name}/records/{key}", ToView(row));
        });
        group.MapPut("/tables/{name}/records/{key}", async (string name, string key, JsonElement body, TDb db, CancellationToken ct) =>
        {
            if (BuiltIn(name) is not null) return BuiltInRefusal(name);
            var t = await db.CatalogTables.AsNoTracking().SingleOrDefaultAsync(x => x.Name == name, ct);
            if (t is null) return Results.NotFound();
            var row = await db.CatalogRecords.SingleOrDefaultAsync(r => r.TableName == name && r.RecordKey == key, ct);
            if (row is null) return Results.NotFound();
            var (data, newKey, errors) = CatalogRules.ValidateRecord(Columns(t.ColumnsJson), t.PrimaryKey, body);
            if (errors.Count > 0) return Results.ValidationProblem(errors);
            if (newKey != key) return Results.BadRequest(new { error = $"{t.PrimaryKey} cannot be changed (route '{key}', body '{newKey}')." });
            row.DataJson = data!.ToJsonString(); row.SchemaVersion = t.Version; row.UpdatedAt = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
            return Results.Ok(ToView(row));
        });
        group.MapDelete("/tables/{name}/records/{key}", async (string name, string key, TDb db, CancellationToken ct) =>
        {
            if (BuiltIn(name) is not null) return BuiltInRefusal(name);
            var row = await db.CatalogRecords.SingleOrDefaultAsync(r => r.TableName == name && r.RecordKey == key, ct);
            if (row is null) return Results.NotFound();
            db.CatalogRecords.Remove(row);
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });
    }
    private static RecordView ToView(CatalogRecord r) =>
        new(r.RecordKey, JsonDocument.Parse(r.DataJson).RootElement.Clone(), r.SchemaVersion, r.CreatedAt, r.UpdatedAt);
}
