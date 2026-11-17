using System.ComponentModel.DataAnnotations;
using Hub.Application;
using Integration.Shared;

namespace Hub.Tests;
public class MappingTests
{
    [Theory]
    [InlineData("USD", 12.345, 1235)]
    [InlineData("PHP", 100.50, 10050)]
    [InlineData("EUR", 0.01, 1)]
    public void Mapping_preserves_identity_and_rounds_minor_units(string currency, double amount, long expected)
    {
        var mapped = Mapping.Transform(new CrmOrder("ORD-001", "C-100", currency, (decimal)amount));
        Assert.Equal("ORD-001", mapped.ExternalOrderId);
        Assert.Equal("C-100", mapped.AccountCode);
        Assert.Equal(currency, mapped.CurrencyCode);
        Assert.Equal(expected, mapped.TotalMinorUnits);
    }
    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(1000001)]
    public void Invalid_amount_is_rejected(int amount) =>
        Assert.Throws<ValidationException>(() => Mapping.Transform(new CrmOrder("O", "C", "USD", amount)));
    [Fact]
    public void Unsupported_currency_is_rejected() =>
        Assert.Throws<ValidationException>(() => Mapping.Transform(new CrmOrder("O", "C", "JPY", 10)));
    [Theory]
    [InlineData(400, false, "InvalidRequest")]
    [InlineData(401, false, "Authentication")]
    [InlineData(404, false, "MissingResource")]
    [InlineData(409, false, "DuplicateConflict")]
    [InlineData(429, true, "RateLimited")]
    [InlineData(500, true, "UpstreamUnavailable")]
    [InlineData(503, true, "UpstreamUnavailable")]
    [InlineData(408, true, "Timeout")]
    public void Classifies_failures(int status, bool transient, string classification)
    {
        var failure = FailurePolicy.Classify(status);
        Assert.Equal(transient, failure.Transient);
        Assert.Equal(classification, failure.Classification);
        Assert.NotEmpty(failure.Guidance);
    }
    [Fact]
    public void Backoff_doubles_and_bounds_retry_after()
    {
        Assert.Equal(TimeSpan.FromSeconds(1), FailurePolicy.Backoff(1));
        Assert.Equal(TimeSpan.FromSeconds(2), FailurePolicy.Backoff(2));
        Assert.Equal(TimeSpan.FromSeconds(4), FailurePolicy.Backoff(3));
        Assert.Equal(TimeSpan.FromSeconds(30), FailurePolicy.Backoff(2, TimeSpan.FromHours(1)));
        Assert.Equal(TimeSpan.FromSeconds(5), FailurePolicy.Backoff(1, TimeSpan.FromSeconds(5)));
    }
}
