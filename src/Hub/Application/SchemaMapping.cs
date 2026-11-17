using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Integration.Shared;

namespace Hub.Application;

/// <summary>One target field's rule in a mapping definition. Only allowlisted transformations exist; nothing is evaluated as code.</summary>
public sealed record FieldRule(string Target, string Transform, string? Source = null, string[]? Sources = null, string? Value = null,
    string? Separator = null, decimal? Factor = null, string? Format = null, Dictionary<string, string>? Lookup = null);
public sealed record TableRef(string System, string Table);
public sealed record MappingDraft(string Name, string? Description, TableRef Source, TableRef Target, List<FieldRule> Fields);
public sealed record Issue(string Field, string Message);
public sealed record ValidationReport(bool Valid, List<Issue> Errors, List<Issue> Warnings);
public sealed record Suggestion(string Source, string Transform, double Confidence, string[] Reasons, decimal? Factor = null,
    string? Format = null, Dictionary<string, string>? Lookup = null);
public sealed record TargetSuggestion(string Target, string TargetType, bool Required, bool PrimaryKey, Suggestion? Suggestion);
public sealed record SuggestionResult(List<TargetSuggestion> Fields, string[] UnmatchedSources, List<Issue> Warnings);

public static partial class SchemaMapping
{
    public static readonly string[] Transforms =
        ["Copy", "Trim", "Uppercase", "Lowercase", "Concatenate", "Default", "ToNumber", "Multiply", "Divide", "FormatDate", "Lookup"];
    public static readonly string[] DateFormats = ["yyyy-MM-dd", "yyyy-MM-dd'T'HH:mm:ss'Z'", "MM/dd/yyyy", "dd/MM/yyyy", "yyyyMMdd"];
    public static readonly string[] Systems = ["crm", "erp"];
    private const int MaxLookup = 50, MaxConcat = 5, MaxText = 500;
    private const double Threshold = 0.5;

    // ---------------------------------------------------------------- suggestions
    /// <summary>Synonym groups for semantic matching (customerName ~ displayName, phone ~ contactNumber, id ~ code …).</summary>
    private static readonly string[][] Synonyms =
    [
        ["id", "code", "key", "number", "no", "ref", "reference", "identifier"],
        ["name", "displayname", "fullname", "title", "label"],
        ["email", "mail", "emailaddress"],
        ["phone", "telephone", "mobile", "tel", "contact", "contactnumber"],
        ["status", "state", "accountstatus"],
        ["currency", "currencycode", "ccy"],
        ["amount", "total", "value", "price", "sum", "totalminorunits"],
        ["customer", "account", "client", "party"],
        ["created", "createdat", "createdon"],
        ["updated", "updatedat", "modified", "modifiedat", "changed"],
        ["description", "desc", "details", "notes"],
        ["quantity", "qty", "count"],
        ["sku", "item", "itemcode", "product"],
        ["postal", "zip", "postcode", "zipcode"],
        ["country", "countrycode", "nation"],
        ["city", "town"],
        ["order", "salesorder", "externalorder"],
    ];
    [GeneratedRegex("(?<=[a-z0-9])(?=[A-Z])|_|-")] private static partial Regex WordBreak();
    private static string Normalize(string s) => new(s.ToLowerInvariant().Where(char.IsLetterOrDigit).ToArray());
    private static string[] Tokens(string s) => WordBreak().Split(s).Where(t => t.Length > 0).Select(t => t.ToLowerInvariant()).ToArray();
    private static int[] Groups(string token) =>
        Synonyms.Select((g, i) => (g, i)).Where(x => x.g.Contains(token)).Select(x => x.i).ToArray();

    /// <summary>Name similarity in [0,1] with human-readable reasons.</summary>
    public static (double Score, string Reason) NameScore(string source, string target)
    {
        var (a, b) = (Normalize(source), Normalize(target));
        if (a == b) return (1.0, "Same column name");
        var wholeGroups = Groups(a).Intersect(Groups(b)).Any();
        if (wholeGroups) return (0.85, "Synonymous names");
        var (ta, tb) = (Tokens(source), Tokens(target));
        // The most specific (last) token carries the meaning: customerName ~ displayName, emailAddress ~ email.
        var headA = ta.LastOrDefault() ?? a; var headB = tb.LastOrDefault() ?? b;
        if (headA == headB) return (0.75, $"Same final word '{headA}'");
        if (Groups(headA).Intersect(Groups(headB)).Any()) return (0.7, $"'{headA}' and '{headB}' are synonyms");
        if (a.Length >= 4 && b.Length >= 4 && (a.Contains(b) || b.Contains(a))) return (0.7, "One name contains the other");
        var shared = ta.Count(t => tb.Contains(t) || tb.Any(u => Groups(t).Intersect(Groups(u)).Any()));
        var overlap = shared / (double)Math.Max(ta.Length, tb.Length);
        return overlap > 0 ? (0.55 * overlap, "Shared words") : (0, "");
    }

    /// <summary>The transformation that makes a source column fit a target column, or null when none in the allowlist does.</summary>
    public static Suggestion? TransformFor(ColumnDef source, ColumnDef target, double confidence, List<string> reasons)
    {
        Suggestion S(string transform, string why, decimal? factor = null, string? format = null, Dictionary<string, string>? lookup = null)
        {
            reasons.Add(why);
            return new(source.Name, transform, Math.Round(Math.Clamp(confidence, 0, 1), 2), reasons.ToArray(), factor, format, lookup);
        }
        var name = Normalize(target.Name);
        switch (source.Type, target.Type)
        {
            case ("string", "string"):
                if (name.Contains("email")) return S("Lowercase", "Email addresses are compared case-insensitively: lower-case them");
                if (name is "code" || name.EndsWith("code") && !name.Contains("currency")) return S("Uppercase", "Codes are normalized to upper case");
                if (name.Contains("currency")) return S("Uppercase", "Currency codes are upper case");
                return S("Trim", "Text to text: trim surrounding spaces");
            case ("decimal", "integer"):
                return name.Contains("minor") || name.Contains("cents")
                    ? S("Multiply", "Decimal major units to integer minor units (× 100, rounded half away from zero)", factor: 100)
                    : S("ToNumber", "Decimal to integer (rounded half away from zero)");
            case ("integer", "decimal"): return S("Copy", "Integers fit decimal columns");
            case ("string", "integer" or "decimal"): return S("ToNumber", "Text to number conversion");
            case ("integer" or "decimal", "string"): return S("Copy", "Numbers are written as text");
            case ("datetime", "date"): return S("FormatDate", "Date-time to date", format: "yyyy-MM-dd");
            case ("date" or "datetime", "string"): return S("Copy", "Dates are written as ISO text");
            case ("enum", "enum"):
            case ("string", "enum"):
                var targetValues = target.Values ?? [];
                var sourceValues = source.Values ?? [];
                if (source.Type == "enum" && sourceValues.All(v => targetValues.Contains(v))) return S("Copy", "Every source value is a valid target value");
                var lookup = new Dictionary<string, string>();
                foreach (var v in sourceValues)
                    if (targetValues.FirstOrDefault(t => Normalize(t) == Normalize(v)) is { } match) lookup[v] = match;
                var unmatched = sourceValues.Where(v => !lookup.ContainsKey(v)).ToArray();
                var why = unmatched.Length == 0 ? "Status lookup: values matched by name"
                    : $"Status lookup: review unmatched value(s) {string.Join(", ", unmatched)}";
                return S("Lookup", why, lookup: lookup);
            case ("enum", "string"): return S("Copy", "Enum values are written as text");
            case var (s, t) when s == t: return S("Copy", "Same type");
            default: return null;
        }
    }

    public static SuggestionResult Suggest(TableView source, TableView target)
    {
        var candidates = new List<(ColumnDef Target, ColumnDef Source, double Score, string Reason)>();
        var mappable = target.Columns.Where(c => !c.ReadOnly).ToList();
        foreach (var t in mappable)
            foreach (var s in source.Columns)
            {
                var (score, reason) = NameScore(s.Name, t.Name);
                var sourceKey = s.Name == source.PrimaryKey; var targetKey = t.Name == target.PrimaryKey;
                if (sourceKey && targetKey) { score = Math.Max(score, 0.6) + 0.2; reason = (reason.Length > 0 ? reason + "; " : "") + "Primary key to primary key"; }
                else if (sourceKey != targetKey && score < 0.85) score -= 0.1;
                if (score >= Threshold) candidates.Add((t, s, score, reason));
            }
        var usedSources = new HashSet<string>(); var assigned = new Dictionary<string, Suggestion>();
        foreach (var c in candidates.OrderByDescending(c => c.Score))
        {
            if (assigned.ContainsKey(c.Target.Name) || usedSources.Contains(c.Source.Name)) continue;
            var suggestion = TransformFor(c.Source, c.Target, c.Score, [c.Reason]);
            if (suggestion is null) continue; // incompatible types and no allowlisted conversion
            assigned[c.Target.Name] = suggestion; usedSources.Add(c.Source.Name);
        }
        var fields = mappable.Select(t => new TargetSuggestion(t.Name, t.Type, t.Required, t.Name == target.PrimaryKey, assigned.GetValueOrDefault(t.Name))).ToList();
        var warnings = fields.Where(f => f.Required && f.Suggestion is null)
            .Select(f => new Issue(f.Target, "Required target field has no suggested source. Map it, or set a Default value.")).ToList();
        return new(fields, source.Columns.Select(c => c.Name).Where(n => !usedSources.Contains(n)).ToArray(), warnings);
    }

    // ---------------------------------------------------------------- validation
    /// <summary>Type produced by a rule, before conversion to the target column.</summary>
    private static string? OutputType(FieldRule rule, ColumnDef? source, ColumnDef target) => rule.Transform switch
    {
        "Copy" => source?.Type,
        "Trim" or "Uppercase" or "Lowercase" or "Concatenate" => "string",
        "Default" => target.Type,
        "ToNumber" or "Multiply" or "Divide" => "decimal",
        "FormatDate" => rule.Format == "yyyy-MM-dd" && target.Type == "date" ? "date" : "string",
        "Lookup" => target.Type == "enum" ? "enum" : "string",
        _ => null
    };
    private static bool Fits(string? produced, ColumnDef source, ColumnDef target, FieldRule rule) => (produced, target.Type) switch
    {
        (null, _) => false,
        var (p, t) when p == t => rule.Transform != "Copy" || p != "enum" || (source.Values ?? []).All(v => (target.Values ?? []).Contains(v)),
        ("integer", "decimal") => true,
        ("decimal", "integer") => rule.Transform is "ToNumber" or "Multiply" or "Divide",
        (_, "string") => true,
        _ => false
    };

    public static ValidationReport Validate(MappingDraft draft, TableView source, TableView target)
    {
        var errors = new List<Issue>(); var warnings = new List<Issue>();
        if (string.IsNullOrWhiteSpace(draft.Name) || draft.Name.Length > 60 || !CatalogRules.ValidKey(draft.Name.Replace(' ', '-')))
            errors.Add(new("name", "Name the mapping (letters, digits, spaces, '.', '_' or '-'; max 60)."));
        if (draft.Description?.Length > 300) errors.Add(new("description", "Description is limited to 300 characters."));
        var fields = draft.Fields ?? [];
        if (fields.Count == 0) errors.Add(new("fields", "Map at least one target field."));
        if (fields.Count > 60) errors.Add(new("fields", "A mapping is limited to 60 rules."));
        foreach (var dup in fields.GroupBy(f => f.Target).Where(g => g.Count() > 1)) errors.Add(new(dup.Key, "Target field is mapped more than once."));
        var sourceCols = source.Columns.ToDictionary(c => c.Name);
        foreach (var rule in fields)
        {
            var t = target.Columns.FirstOrDefault(c => c.Name == rule.Target);
            if (t is null) { errors.Add(new(rule.Target, "Unknown target field.")); continue; }
            if (t.ReadOnly) { errors.Add(new(rule.Target, "This field is set by the target application and cannot be mapped.")); continue; }
            if (!Transforms.Contains(rule.Transform)) { errors.Add(new(rule.Target, $"Transformation '{rule.Transform}' is not allowed. Use {string.Join(", ", Transforms)}.")); continue; }
            ColumnDef? s = null;
            if (rule.Transform is not ("Default" or "Concatenate"))
            {
                if (rule.Source is null || !sourceCols.TryGetValue(rule.Source, out s)) { errors.Add(new(rule.Target, "Choose an existing source field.")); continue; }
            }
            switch (rule.Transform)
            {
                case "Trim" or "Uppercase" or "Lowercase" when s!.Type is not ("string" or "enum"):
                    errors.Add(new(rule.Target, $"{rule.Transform} needs a text source; '{s.Name}' is {s.Type}.")); break;
                case "Concatenate":
                    var parts = rule.Sources ?? [];
                    if (parts.Length is < 2 or > MaxConcat) errors.Add(new(rule.Target, $"Concatenate 2 to {MaxConcat} source fields."));
                    foreach (var p in parts.Where(p => !sourceCols.ContainsKey(p))) errors.Add(new(rule.Target, $"Unknown source field '{p}'."));
                    if ((rule.Separator?.Length ?? 0) > 5) errors.Add(new(rule.Target, "Separator is limited to 5 characters."));
                    break;
                case "Default":
                    if (rule.Value is null || rule.Value.Length > MaxText) errors.Add(new(rule.Target, "Provide a default value (max 500 characters)."));
                    else if (Convert(JsonValue.Create(rule.Value), t).Error is { } bad) errors.Add(new(rule.Target, "Default value: " + bad));
                    break;
                case "ToNumber" when s!.Type is not ("string" or "integer" or "decimal"):
                case "Multiply" or "Divide" when s!.Type is not ("string" or "integer" or "decimal"):
                    errors.Add(new(rule.Target, $"{rule.Transform} needs a numeric or text source; '{s!.Name}' is {s.Type}.")); break;
                case "Multiply" or "Divide" when rule.Factor is not { } f || f == 0 || Math.Abs(f) > 1_000_000:
                    errors.Add(new(rule.Target, "Provide a non-zero factor up to 1,000,000.")); break;
                case "FormatDate" when !DateFormats.Contains(rule.Format):
                    errors.Add(new(rule.Target, $"Choose a date format: {string.Join(", ", DateFormats)}.")); break;
                case "FormatDate" when s!.Type is not ("date" or "datetime" or "string"):
                    errors.Add(new(rule.Target, "FormatDate needs a date, date-time or text source.")); break;
                case "Lookup":
                    var map = rule.Lookup ?? [];
                    if (map.Count is 0 or > MaxLookup) errors.Add(new(rule.Target, $"A lookup needs 1 to {MaxLookup} entries."));
                    if (map.Any(kv => kv.Key.Length > 60 || kv.Value.Length > 60)) errors.Add(new(rule.Target, "Lookup keys and values are limited to 60 characters."));
                    if (t.Type == "enum" && map.Values.FirstOrDefault(v => !(t.Values ?? []).Contains(v)) is { } invalid)
                        errors.Add(new(rule.Target, $"Lookup result '{invalid}' is not a value of {t.Name}."));
                    if (s!.Type == "enum" && (s.Values ?? []).Where(v => !map.ContainsKey(v)).ToArray() is { Length: > 0 } missing)
                        warnings.Add(new(rule.Target, $"Source value(s) {string.Join(", ", missing)} have no lookup entry and will fail."));
                    break;
            }
            if (rule.Transform is not ("Concatenate" or "Default") && s is not null && !Fits(OutputType(rule, s, t), s, t, rule))
                errors.Add(new(rule.Target, $"{rule.Transform} of {s.Type} '{s.Name}' does not produce a valid {t.Type}. " +
                    (t.Type == "enum" ? "Use Lookup." : t.Type is "integer" or "decimal" ? "Use ToNumber, Multiply or Divide." : "Choose a compatible source or transformation.")));
            if (rule.Transform == "Concatenate" && t.Type != "string") errors.Add(new(rule.Target, "Concatenate produces text; the target must be a string."));
            if (s is not null && !s.Required && t.Required && rule.Transform != "Default")
                warnings.Add(new(rule.Target, $"Source '{s.Name}' is optional but the target is required: records without it will fail."));
        }
        foreach (var t in target.Columns.Where(c => c.Required && !c.ReadOnly && fields.All(f => f.Target != c.Name)))
            errors.Add(new(t.Name, t.Name == target.PrimaryKey ? "The target primary key must be mapped." : "Required target field is not mapped."));
        return new(errors.Count == 0, errors, warnings);
    }

    // ---------------------------------------------------------------- preview (side-effect free)
    /// <summary>Applies the rules to one sample record. Pure: no I/O, no code evaluation.</summary>
    public static (JsonObject Output, List<Issue> Errors) Apply(IReadOnlyList<FieldRule> rules, IReadOnlyList<ColumnDef> targetColumns, JsonObject record)
    {
        var output = new JsonObject(); var errors = new List<Issue>();
        foreach (var rule in rules)
        {
            var target = targetColumns.FirstOrDefault(c => c.Name == rule.Target);
            if (target is null) continue;
            var (value, error) = Evaluate(rule, record);
            if (error is null && value is { } produced) (value, error) = Convert(produced, target);
            if (error is not null) { errors.Add(new(rule.Target, error)); continue; }
            if (value is null) { if (target.Required) errors.Add(new(rule.Target, "Required value is empty.")); continue; }
            output[rule.Target] = value;
        }
        return (output, errors);
    }
    private static string? Text(JsonNode? node) => node is null ? null : node.GetValueKind() == JsonValueKind.String ? node.GetValue<string>() : node.ToJsonString();
    private static (JsonNode? Value, string? Error) Evaluate(FieldRule rule, JsonObject record)
    {
        var src = rule.Source is null ? null : record[rule.Source]?.DeepClone();
        switch (rule.Transform)
        {
            case "Copy": return (src, null);
            case "Trim": return (src is null ? null : JsonValue.Create(Text(src)!.Trim()), null);
            case "Uppercase": return (src is null ? null : JsonValue.Create(Text(src)!.Trim().ToUpperInvariant()), null);
            case "Lowercase": return (src is null ? null : JsonValue.Create(Text(src)!.Trim().ToLowerInvariant()), null);
            case "Default": return (src ?? JsonValue.Create(rule.Value), null);
            case "Concatenate":
                var parts = (rule.Sources ?? []).Select(p => Text(record[p])?.Trim()).Where(p => !string.IsNullOrEmpty(p)).ToArray();
                return (parts.Length == 0 ? null : JsonValue.Create(string.Join(rule.Separator ?? " ", parts)), null);
            case "ToNumber" or "Multiply" or "Divide":
                if (src is null) return (null, null);
                if (!decimal.TryParse(Text(src), NumberStyles.Number, CultureInfo.InvariantCulture, out var n)) return (null, $"'{Text(src)}' is not a number.");
                var factor = rule.Factor ?? 1;
                return (JsonValue.Create(rule.Transform == "Multiply" ? n * factor : rule.Transform == "Divide" ? n / factor : n), null);
            case "FormatDate":
                if (src is null) return (null, null);
                if (!DateTimeOffset.TryParse(Text(src), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var date)) return (null, $"'{Text(src)}' is not a date.");
                return (JsonValue.Create(date.UtcDateTime.ToString(rule.Format ?? "yyyy-MM-dd", CultureInfo.InvariantCulture)), null);
            case "Lookup":
                if (src is null) return (null, null);
                return (rule.Lookup ?? []).TryGetValue(Text(src)!, out var mapped) ? (JsonValue.Create(mapped), null) : (null, $"No lookup entry for '{Text(src)}'.");
            default: return (null, $"Transformation '{rule.Transform}' is not allowed.");
        }
    }
    /// <summary>Converts a produced value to the target column type (integers round half away from zero).</summary>
    public static (JsonNode? Value, string? Error) Convert(JsonNode value, ColumnDef target)
    {
        var text = Text(value) ?? "";
        switch (target.Type)
        {
            case "string": return text.Length > MaxText ? (null, "Text exceeds 500 characters.") : (JsonValue.Create(text), null);
            case "integer":
                return decimal.TryParse(text, NumberStyles.Number, CultureInfo.InvariantCulture, out var i)
                    ? (JsonValue.Create((long)decimal.Round(i, 0, MidpointRounding.AwayFromZero)), null) : (null, $"'{text}' is not a whole number.");
            case "decimal":
                return decimal.TryParse(text, NumberStyles.Number, CultureInfo.InvariantCulture, out var d) ? (JsonValue.Create(d), null) : (null, $"'{text}' is not a number.");
            case "boolean": return bool.TryParse(text, out var b) ? (JsonValue.Create(b), null) : (null, $"'{text}' is not true or false.");
            case "date":
                return DateOnly.TryParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day)
                    ? (JsonValue.Create(day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)), null) : (null, $"'{text}' is not a YYYY-MM-DD date.");
            case "datetime":
                return DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var dt)
                    ? (JsonValue.Create(dt.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture)), null) : (null, $"'{text}' is not a date and time.");
            case "enum":
                return (target.Values ?? []).Contains(text) ? (JsonValue.Create(text), null) : (null, $"'{text}' is not one of {string.Join(", ", target.Values ?? [])}.");
            default: return (null, "Unsupported target type.");
        }
    }
}
