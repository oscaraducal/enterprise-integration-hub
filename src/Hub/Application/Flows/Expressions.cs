using System.Globalization;
using System.Text;

namespace Hub.Application.Flows;

/// <summary>
/// The designer's safe expression language. It is parsed into an AST and never evaluated as code: only literals,
/// <c>$variable.field</c> references, arithmetic/comparison/boolean operators and an allowlist of functions exist.
/// Milestone C validates expressions; Milestone D evaluates the same AST.
/// </summary>
public abstract record Expr(int Position);
public sealed record Literal(object? Value, string Kind, int Position) : Expr(Position);
public sealed record VariableRef(string Name, string[] Path, int Position) : Expr(Position)
{
    public override string ToString() => "$" + string.Join('.', Path.Prepend(Name));
}
public sealed record Unary(string Op, Expr Operand, int Position) : Expr(Position);
public sealed record Binary(string Op, Expr Left, Expr Right, int Position) : Expr(Position);
public sealed record Call(string Function, IReadOnlyList<Expr> Args, int Position) : Expr(Position);

public sealed record FunctionDef(string Name, string Category, int MinArgs, int MaxArgs, string Signature, string Description);
public sealed record ExpressionIssue(int Position, string Message);
public sealed record ParseResult(Expr? Ast, List<ExpressionIssue> Errors, List<VariableRef> Variables);

public static class Expressions
{
    public const int MaxLength = 500, MaxDepth = 20;
    public static readonly FunctionDef[] Functions =
    [
        new("concat", "String", 2, 10, "concat(a, b, ...)", "Joins values as text."),
        new("upper", "String", 1, 1, "upper(text)", "Upper-cases text."),
        new("lower", "String", 1, 1, "lower(text)", "Lower-cases text."),
        new("trim", "String", 1, 1, "trim(text)", "Removes surrounding spaces."),
        new("length", "String", 1, 1, "length(text)", "Number of characters."),
        new("substring", "String", 2, 3, "substring(text, start, length?)", "Part of a text (0-based)."),
        new("contains", "String", 2, 2, "contains(text, part)", "True when text contains part (case-insensitive)."),
        new("startsWith", "String", 2, 2, "startsWith(text, prefix)", "True when text starts with prefix."),
        new("endsWith", "String", 2, 2, "endsWith(text, suffix)", "True when text ends with suffix."),
        new("replace", "String", 3, 3, "replace(text, find, with)", "Replaces every occurrence (plain text, no patterns)."),
        new("round", "Math", 1, 2, "round(number, decimals?)", "Rounds half away from zero."),
        new("floor", "Math", 1, 1, "floor(number)", "Rounds down."),
        new("ceil", "Math", 1, 1, "ceil(number)", "Rounds up."),
        new("abs", "Math", 1, 1, "abs(number)", "Absolute value."),
        new("min", "Math", 2, 10, "min(a, b, ...)", "Smallest number."),
        new("max", "Math", 2, 10, "max(a, b, ...)", "Largest number."),
        new("toNumber", "Conversion", 1, 1, "toNumber(value)", "Converts text to a number."),
        new("toString", "Conversion", 1, 1, "toString(value)", "Converts a value to text."),
        new("toBoolean", "Conversion", 1, 1, "toBoolean(value)", "Converts 'true'/'false' to a Boolean."),
        new("now", "Date", 0, 0, "now()", "Current UTC date and time."),
        new("today", "Date", 0, 0, "today()", "Current UTC date."),
        new("formatDate", "Date", 2, 2, "formatDate(date, 'yyyy-MM-dd')", "Formats a date with an allowlisted pattern."),
        new("addDays", "Date", 2, 2, "addDays(date, days)", "Adds days to a date."),
        new("if", "Boolean", 3, 3, "if(condition, then, else)", "Chooses a value."),
        new("coalesce", "Boolean", 2, 10, "coalesce(a, b, ...)", "First value that is not empty."),
        new("isEmpty", "Boolean", 1, 1, "isEmpty(value)", "True for null, empty text or an empty collection."),
        new("count", "Collection", 1, 1, "count(collection)", "Number of items."),
        new("sum", "Collection", 2, 2, "sum(collection, 'field')", "Sum of a numeric field across items."),
        new("first", "Collection", 1, 1, "first(collection)", "First item, or null."),
        new("lookup", "Lookup", 2, 3, "lookup('table', key, default?)", "Value from a named lookup (lookup tables arrive in Milestone E)."),
    ];
    public static readonly string[] DateFormats = ["yyyy-MM-dd", "yyyy-MM-dd'T'HH:mm:ss'Z'", "MM/dd/yyyy", "dd/MM/yyyy", "yyyyMMdd"];
    private static readonly Dictionary<string, FunctionDef> ByName = Functions.ToDictionary(f => f.Name);

    public static ParseResult Parse(string? text)
    {
        var errors = new List<ExpressionIssue>(); var vars = new List<VariableRef>();
        if (string.IsNullOrWhiteSpace(text)) return new(null, [new(0, "Expression is empty.")], vars);
        if (text.Length > MaxLength) return new(null, [new(MaxLength, $"Expressions are limited to {MaxLength} characters.")], vars);
        List<Token> tokens;
        try { tokens = Lex(text); }
        catch (ExpressionException ex) { return new(null, [new(ex.Position, ex.Message)], vars); }
        var parser = new Parser(tokens, errors, vars);
        Expr? ast = null;
        try
        {
            ast = parser.ParseExpression(0);
            if (parser.Current.Kind != TokenKind.End) errors.Add(new(parser.Current.Position, $"Unexpected '{parser.Current.Text}'."));
        }
        catch (ExpressionException ex) { errors.Add(new(ex.Position, ex.Message)); }
        return new(errors.Count == 0 ? ast : null, errors, vars);
    }

    // ------------------------------------------------------------------ lexer
    private enum TokenKind { Number, String, Variable, Ident, Op, LParen, RParen, Comma, End }
    private sealed record Token(TokenKind Kind, string Text, int Position, object? Value = null);
    private sealed class ExpressionException(int position, string message) : Exception(message) { public int Position { get; } = position; }

    private static List<Token> Lex(string s)
    {
        var tokens = new List<Token>(); var i = 0;
        while (i < s.Length)
        {
            var c = s[i];
            if (char.IsWhiteSpace(c)) { i++; continue; }
            var start = i;
            if (char.IsDigit(c) || (c == '.' && i + 1 < s.Length && char.IsDigit(s[i + 1])))
            {
                while (i < s.Length && (char.IsDigit(s[i]) || s[i] == '.')) i++;
                if (!decimal.TryParse(s[start..i], NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out var number))
                    throw new ExpressionException(start, $"'{s[start..i]}' is not a number.");
                tokens.Add(new(TokenKind.Number, s[start..i], start, number));
            }
            else if (c is '\'' or '"')
            {
                var quote = c; var sb = new StringBuilder(); i++;
                while (true)
                {
                    if (i >= s.Length) throw new ExpressionException(start, "Text is missing its closing quote.");
                    if (s[i] == quote) { if (i + 1 < s.Length && s[i + 1] == quote) { sb.Append(quote); i += 2; continue; } i++; break; }
                    sb.Append(s[i++]);
                }
                tokens.Add(new(TokenKind.String, s[start..i], start, sb.ToString()));
            }
            else if (c == '$')
            {
                i++;
                if (i >= s.Length || !char.IsLetter(s[i])) throw new ExpressionException(start, "A variable name must follow '$'.");
                while (i < s.Length && (char.IsLetterOrDigit(s[i]) || s[i] is '_' or '.')) i++;
                var path = s[(start + 1)..i];
                if (path.EndsWith('.') || path.Contains("..")) throw new ExpressionException(start, $"'{s[start..i]}' is not a valid variable reference.");
                tokens.Add(new(TokenKind.Variable, s[start..i], start, path.Split('.')));
            }
            else if (char.IsLetter(c))
            {
                while (i < s.Length && (char.IsLetterOrDigit(s[i]) || s[i] == '_')) i++;
                tokens.Add(new(TokenKind.Ident, s[start..i], start));
            }
            else if (c == '(') { tokens.Add(new(TokenKind.LParen, "(", i++)); }
            else if (c == ')') { tokens.Add(new(TokenKind.RParen, ")", i++)); }
            else if (c == ',') { tokens.Add(new(TokenKind.Comma, ",", i++)); }
            else
            {
                var two = i + 1 < s.Length ? s.Substring(i, 2) : "";
                if (two is "==" or "!=" or "<=" or ">=") { tokens.Add(new(TokenKind.Op, two, i)); i += 2; }
                else if (c is '+' or '-' or '*' or '/' or '<' or '>') { tokens.Add(new(TokenKind.Op, c.ToString(), i++)); }
                else throw new ExpressionException(i, $"'{c}' is not allowed in an expression.");
            }
        }
        tokens.Add(new(TokenKind.End, "end of expression", s.Length));
        return tokens;
    }

    // ------------------------------------------------------------------ Pratt parser
    private sealed class Parser(List<Token> tokens, List<ExpressionIssue> errors, List<VariableRef> vars)
    {
        private int index, depth;
        public Token Current => tokens[index];
        private Token Next() => tokens[index++];
        private static int Precedence(Token t) => (t.Kind, t.Text) switch
        {
            (TokenKind.Ident, "or") => 1, (TokenKind.Ident, "and") => 2,
            (TokenKind.Op, "==" or "!=" or "<" or "<=" or ">" or ">=") => 3,
            (TokenKind.Op, "+" or "-") => 4, (TokenKind.Op, "*" or "/") => 5,
            _ => 0
        };
        public Expr ParseExpression(int minPrecedence)
        {
            if (++depth > MaxDepth) throw new ExpressionException(Current.Position, $"Expressions may nest at most {MaxDepth} levels.");
            var left = ParsePrefix();
            while (Precedence(Current) is var p && p > minPrecedence)
            {
                var op = Next();
                // Comparisons do not chain: a < b < c is rejected.
                var right = ParseExpression(p == 3 ? p : p);
                if (p == 3 && Precedence(Current) == 3) throw new ExpressionException(Current.Position, "Comparisons cannot be chained; combine them with 'and'.");
                left = new Binary(op.Text, left, right, op.Position);
            }
            depth--;
            return left;
        }
        private Expr ParsePrefix()
        {
            var t = Next();
            switch (t.Kind)
            {
                case TokenKind.Number: return new Literal(t.Value, "number", t.Position);
                case TokenKind.String: return new Literal(t.Value, "string", t.Position);
                case TokenKind.Variable:
                    var parts = (string[])t.Value!;
                    var v = new VariableRef(parts[0], parts[1..], t.Position); vars.Add(v); return v;
                case TokenKind.LParen:
                    var inner = ParseExpression(0);
                    Expect(TokenKind.RParen, "')'");
                    return inner;
                case TokenKind.Op when t.Text == "-": return new Unary("-", ParseExpression(5), t.Position);
                case TokenKind.Ident when t.Text == "not": return new Unary("not", ParseExpression(2), t.Position);
                case TokenKind.Ident when t.Text is "true" or "false": return new Literal(t.Text == "true", "boolean", t.Position);
                case TokenKind.Ident when t.Text == "null": return new Literal(null, "null", t.Position);
                case TokenKind.Ident:
                    if (Current.Kind != TokenKind.LParen) throw new ExpressionException(t.Position, $"Unknown word '{t.Text}'. Variables start with '$'; text needs quotes.");
                    Next();
                    var args = new List<Expr>();
                    if (Current.Kind != TokenKind.RParen)
                        do { args.Add(ParseExpression(0)); } while (Current.Kind == TokenKind.Comma && Next() is not null);
                    Expect(TokenKind.RParen, "')'");
                    if (!ByName.TryGetValue(t.Text, out var fn)) errors.Add(new(t.Position, $"Unknown function '{t.Text}'. Allowed: {string.Join(", ", Functions.Select(f => f.Name))}."));
                    else if (args.Count < fn.MinArgs || args.Count > fn.MaxArgs)
                        errors.Add(new(t.Position, $"{fn.Name} takes {(fn.MinArgs == fn.MaxArgs ? fn.MinArgs.ToString() : $"{fn.MinArgs} to {fn.MaxArgs}")} argument(s): {fn.Signature}."));
                    else if (fn.Name == "formatDate" && args[1] is Literal { Value: string f } && !DateFormats.Contains(f))
                        errors.Add(new(args[1].Position, $"Date format must be one of {string.Join(", ", DateFormats)}."));
                    return new Call(t.Text, args, t.Position);
                case TokenKind.End: throw new ExpressionException(t.Position, "The expression ends too early.");
                default: throw new ExpressionException(t.Position, $"Unexpected '{t.Text}'.");
            }
        }
        private void Expect(TokenKind kind, string what)
        {
            if (Current.Kind != kind) throw new ExpressionException(Current.Position, $"Expected {what} but found '{Current.Text}'.");
            Next();
        }
    }
}
