using Microsoft.EntityFrameworkCore;
using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
namespace Integration.Shared;

// ---------- Legacy CRM (source system) ----------
public static class CustomerStatuses
{
    public static readonly string[] All = ["Active", "Inactive", "OnHold"];
}
/// <summary>Legacy CRM customer. Email/phone are optional in the legacy system; the ERP mapping requires email.</summary>
public record Customer([property: Required, StringLength(60), JsonPropertyName("customerId")] string Id,
    [property: Required, StringLength(100), JsonPropertyName("customerName")] string Name)
{
    [EmailAddress, StringLength(120)] public string? Email { get; init; }
    [StringLength(30)] public string? Phone { get; init; }
    [Required, StringLength(20)] public string Status { get; init; } = "Active";
    /// <summary>Incremented by the CRM on every update; drives the ERP's stale-update protection.</summary>
    public int Version { get; init; } = 1;
    public DateTime? UpdatedAt { get; init; }
}
/// <summary>Editable CRM customer fields. Id is taken from the route on update.</summary>
public record CustomerInput(
    [property: Required, StringLength(60), RegularExpression("^[A-Z]-[0-9]{3,6}$", ErrorMessage = "Use the format C-123."), JsonPropertyName("customerId")] string Id,
    [property: Required, StringLength(100, MinimumLength = 2), JsonPropertyName("customerName")] string Name,
    [property: EmailAddress, StringLength(120)] string? Email,
    [property: StringLength(30), RegularExpression(@"^\+?[0-9 ()-]{7,30}$", ErrorMessage = "Use digits, spaces, +, - or parentheses.")] string? Phone,
    [property: Required] string Status);
public class CustomerRevision
{
    public long Id { get; set; }
    public string CustomerId { get; set; } = "";
    public int Version { get; set; }
    public string Snapshot { get; set; } = "";
    public DateTime ChangedAt { get; set; }
}
public record CrmOrder([property: Required, StringLength(60)] string Id,
    [property: Required, StringLength(60)] string CustomerId,
    [property: Required, RegularExpression("^[A-Z]{3}$")] string Currency,
    [property: Range(0.01, 1000000)] decimal Amount);

// ---------- Modern ERP (target system) ----------
public record ErpOrder([property: Required, StringLength(60)] string ExternalOrderId,
    [property: Required, StringLength(60)] string AccountCode,
    [property: Required, RegularExpression("^[A-Z]{3}$")] string CurrencyCode,
    [property: Range(1, 100000000)] long TotalMinorUnits);
public record Receipt(string ExternalOrderId, string ReceiptId, bool Duplicate);
public static class AccountStatuses
{
    public static readonly string[] All = ["ACTIVE", "INACTIVE", "BLOCKED"];
}
/// <summary>Modern ERP customer master payload produced by the customer mapping.</summary>
public record ErpCustomer(
    [property: Required, StringLength(60)] string AccountCode,
    [property: Required, StringLength(100)] string DisplayName,
    [property: Required, EmailAddress, StringLength(120)] string EmailAddress,
    [property: StringLength(30)] string? ContactNumber,
    [property: Required] string AccountStatus);
/// <summary>ERP result of a customer upsert: Created, Updated, Unchanged or SkippedStale.</summary>
public record CustomerSyncResult(string AccountCode, string Outcome, string[] ChangedFields, int? AppliedVersion, string ReceiptId);

// ---------- Mapping (single source of truth for executions and previews) ----------
public record MappingError(string Field, string Message);
public record FieldMapping(string SourceField, string SourceType, bool SourceRequired, string Rule,
    string Description, string TargetField, string TargetType, bool TargetRequired);
public static class MappingCatalog
{
    public static readonly FieldMapping[] SalesOrder =
    [
        new("id", "string", true, "copy", "Source order ID becomes the ERP external reference and idempotency key.", "externalOrderId", "string", true),
        new("customerId", "string", true, "copy", "Customer reference. The ERP account must already exist (SCN-001).", "accountCode", "string", true),
        new("currency", "string(3)", true, "validate", "Must be USD, PHP or EUR.", "currencyCode", "string(3)", true),
        new("amount", "decimal", true, "× 100, round half away from zero", "Decimal major units become integer minor units (125.50 → 12550).", "totalMinorUnits", "integer", true),
    ];
    public static readonly FieldMapping[] Customer =
    [
        new("customerId", "string", true, "trim, upper-case", "Becomes the ERP account code and upsert key.", "accountCode", "string", true),
        new("customerName", "string", true, "trim, collapse spaces", "Legacy names often contain stray whitespace.", "displayName", "string", true),
        new("email", "string", false, "required, trim, lower-case", "Optional in the legacy CRM but mandatory in the ERP.", "emailAddress", "string (email)", true),
        new("phone", "string", false, "keep digits and leading +", "Formatting characters are removed; empty becomes null.", "contactNumber", "string", false),
        new("status", "enum", true, "lookup", "Active → ACTIVE, Inactive → INACTIVE, OnHold → BLOCKED.", "accountStatus", "enum", true),
    ];
}
public static partial class Mapping
{
    public static readonly string[] SupportedCurrencies = ["USD", "PHP", "EUR"];

    public static ErpOrder Transform(CrmOrder order)
    {
        var (mapped, errors) = TryTransform(order);
        return mapped ?? throw new ValidationException(string.Join(" ", errors.Select(e => e.Message)));
    }
    public static (ErpOrder? Mapped, List<MappingError> Errors) TryTransform(CrmOrder order)
    {
        var errors = new List<MappingError>();
        if (string.IsNullOrWhiteSpace(order.Id)) errors.Add(new("id", "Order ID is required."));
        if (string.IsNullOrWhiteSpace(order.CustomerId)) errors.Add(new("customerId", "Customer reference is required."));
        if (string.IsNullOrWhiteSpace(order.Currency) || !Regex.IsMatch(order.Currency, "^[A-Z]{3}$"))
            errors.Add(new("currency", "Currency must be a three-letter ISO-style code."));
        else if (!SupportedCurrencies.Contains(order.Currency))
            errors.Add(new("currency", $"Unsupported currency {order.Currency}. Demo supports USD, PHP and EUR only."));
        if (order.Amount is < 0.01m or > 1000000m) errors.Add(new("amount", "Amount must be between 0.01 and 1,000,000."));
        if (errors.Count > 0) return (null, errors);
        return (new(order.Id, order.CustomerId, order.Currency,
            checked((long)decimal.Round(order.Amount * 100, 0, MidpointRounding.AwayFromZero))), errors);
    }

    public static ErpCustomer Transform(Customer customer)
    {
        var (mapped, errors) = TryTransform(customer);
        return mapped ?? throw new ValidationException(string.Join(" ", errors.Select(e => e.Message)));
    }
    public static (ErpCustomer? Mapped, List<MappingError> Errors) TryTransform(Customer customer)
    {
        var errors = new List<MappingError>();
        var code = customer.Id?.Trim().ToUpperInvariant() ?? "";
        if (code.Length == 0) errors.Add(new("customerId", "Customer ID is required."));
        var name = Whitespace().Replace(customer.Name ?? "", " ").Trim();
        if (name.Length == 0) errors.Add(new("customerName", "Customer name is required."));
        var email = customer.Email?.Trim().ToLowerInvariant();
        if (string.IsNullOrEmpty(email)) errors.Add(new("email", "Email is required by the ERP customer master but is empty in the CRM record."));
        else if (!new EmailAddressAttribute().IsValid(email)) errors.Add(new("email", "Email is not a valid address."));
        string? phone = null;
        if (!string.IsNullOrWhiteSpace(customer.Phone))
        {
            var digits = new string(customer.Phone.Where(char.IsDigit).ToArray());
            phone = (customer.Phone.TrimStart().StartsWith('+') ? "+" : "") + digits;
            if (digits.Length is < 7 or > 15) errors.Add(new("phone", "Phone must contain 7 to 15 digits."));
        }
        var status = customer.Status switch { "Active" => "ACTIVE", "Inactive" => "INACTIVE", "OnHold" => "BLOCKED", _ => null };
        if (status is null) errors.Add(new("status", "Unknown CRM status. Expected Active, Inactive or OnHold."));
        if (errors.Count > 0) return (null, errors);
        return (new(code, name, email!, phone, status!), errors);
    }
    [GeneratedRegex(@"\s+")] private static partial Regex Whitespace();
}

// ---------- Failure simulation ----------
public static class Scenarios
{
    public static readonly string[] All =
        ["None", "BadRequest", "Unauthorized", "NotFound", "RateLimit", "ServerError",
         "Unavailable", "Timeout", "Validation", "Duplicate"];
    public static int? Status(string scenario) => scenario switch {
        "BadRequest" => 400, "Unauthorized" => 401, "NotFound" => 404,
        "RateLimit" => 429, "ServerError" => 500, "Unavailable" => 503, _ => null
    };
}

// ---------- Additive schema upgrades for EnsureCreated databases ----------
/// <summary>
/// The demo uses EnsureCreated, which never alters an existing database. These helpers apply additive,
/// idempotent changes (new columns with defaults, new tables, new indexes) so older local demo data is kept.
/// </summary>
public static class SchemaUpgrade
{
    public static async Task AddColumnsAsync(Microsoft.EntityFrameworkCore.DbContext db, string table,
        params (string Column, string Definition)[] columns)
    {
        var existing = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var connection = db.Database.GetDbConnection();
        if (connection.State != System.Data.ConnectionState.Open) await db.Database.OpenConnectionAsync();
        using (var command = connection.CreateCommand())
        {
            command.CommandText = $"PRAGMA table_info(\"{table}\")";
            using var reader = await command.ExecuteReaderAsync();
            while (await reader.ReadAsync()) existing.Add(reader.GetString(1));
        }
        foreach (var (column, definition) in columns)
            if (!existing.Contains(column))
#pragma warning disable EF1002 // identifiers are compile-time constants from this codebase, never user input
                await Microsoft.EntityFrameworkCore.RelationalDatabaseFacadeExtensions.ExecuteSqlRawAsync(
                    db.Database, $"ALTER TABLE \"{table}\" ADD COLUMN \"{column}\" {definition}");
#pragma warning restore EF1002
    }
    public static Task ExecuteAsync(Microsoft.EntityFrameworkCore.DbContext db, string idempotentSql) =>
        Microsoft.EntityFrameworkCore.RelationalDatabaseFacadeExtensions.ExecuteSqlRawAsync(db.Database, idempotentSql);
}

public sealed class UtcDateTimeConverter() : Microsoft.EntityFrameworkCore.Storage.ValueConversion.ValueConverter<DateTime, DateTime>(
    value => value.ToUniversalTime(), value => DateTime.SpecifyKind(value, DateTimeKind.Utc));
