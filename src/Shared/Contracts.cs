using System.ComponentModel.DataAnnotations;
namespace Integration.Shared;

public record Customer([property: Required, StringLength(60)] string Id,
    [property: Required, StringLength(100)] string Name);
public record CrmOrder([property: Required, StringLength(60)] string Id,
    [property: Required, StringLength(60)] string CustomerId,
    [property: Required, RegularExpression("^[A-Z]{3}$")] string Currency,
    [property: Range(0.01, 1000000)] decimal Amount);
public record ErpOrder([property: Required, StringLength(60)] string ExternalOrderId,
    [property: Required, StringLength(60)] string AccountCode,
    [property: Required, RegularExpression("^[A-Z]{3}$")] string CurrencyCode,
    [property: Range(1, 100000000)] long TotalMinorUnits);
public record Receipt(string ExternalOrderId, string ReceiptId, bool Duplicate);
public static class Mapping
{
    public static ErpOrder Transform(CrmOrder order)
    {
        var errors = new List<ValidationResult>();
        if (!Validator.TryValidateObject(order, new ValidationContext(order), errors, true))
            throw new ValidationException("Order requires an ID, customer, ISO-style currency and positive amount.");
        if (order.Currency is not ("USD" or "PHP" or "EUR"))
            throw new ValidationException("Demo supports USD, PHP and EUR only.");
        return new(order.Id, order.CustomerId, order.Currency,
            checked((long)decimal.Round(order.Amount * 100, 0, MidpointRounding.AwayFromZero)));
    }
}
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

public sealed class UtcDateTimeConverter() : Microsoft.EntityFrameworkCore.Storage.ValueConversion.ValueConverter<DateTime, DateTime>(
    value => value.ToUniversalTime(), value => DateTime.SpecifyKind(value, DateTimeKind.Utc));
