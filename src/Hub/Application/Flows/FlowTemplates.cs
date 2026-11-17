using System.Text.Json;

namespace Hub.Application.Flows;

public sealed record FlowTemplate(string Id, string Title, string Description, string Scenario, FlowDefinition Definition);

/// <summary>Starter flows an Operator can create in one step. They are created only on request, never seeded.</summary>
public static class FlowTemplates
{
    private static FlowDefinition Parse(string json) => JsonSerializer.Deserialize<FlowDefinition>(json, JsonSerializerOptions.Web)!;

    public static readonly FlowTemplate[] All =
    [
        new("blank", "Blank integration", "Only the Start trigger. Add every action yourself with + or drag-and-drop.", "Practice",
            Parse("""
            { "schemaVersion": 1,
              "trigger": { "id": "t1", "type": "trigger", "name": "start", "config": { "mode": "manual", "parameters": [] } },
              "steps": [], "globalFaultHandler": [] }
            """)),
        new("customer-sync", "Legacy CRM customer → Modern ERP customer", "Read a CRM customer, guard the email, map it and upsert the ERP customer master.", "SCN-001 / SCN-003",
            Parse("""
            { "schemaVersion": 1,
              "trigger": { "id": "t1", "type": "trigger", "name": "start", "description": "Run for one customer.",
                "config": { "mode": "manual", "parameters": [ { "name": "customerId", "type": "string", "required": true, "sample": "C-300" } ] } },
              "steps": [
                { "id": "n1", "type": "invoke", "name": "readCustomer", "description": "GET the source customer from the Legacy CRM.",
                  "config": { "system": "crm", "table": "customers", "operation": "get", "key": "$trigger.customerId" } },
                { "id": "n2", "type": "switch", "name": "checkEmail", "config": {}, "branches": [
                  { "id": "b1", "kind": "case", "label": "Email missing", "condition": "isEmpty($readCustomer.email)", "steps": [
                    { "id": "n3", "type": "throwFault", "name": "missingEmail",
                      "config": { "code": "MissingEmail", "message": "concat('Customer ', $readCustomer.customerId, ' has no email; the ERP requires one.')" } } ] },
                  { "id": "b2", "kind": "otherwise", "label": "Otherwise", "steps": [] } ] },
                { "id": "n4", "type": "assign", "name": "prepare",
                  "config": { "assignments": [ { "variable": "syncLabel", "expression": "concat('SYNC-', upper($readCustomer.customerId))" } ] } },
                { "id": "n5", "type": "map", "name": "mapCustomer", "description": "Same rules as SCN-001.",
                  "config": { "input": "readCustomer", "targetSystem": "erp", "targetTable": "customer_master", "rules": [
                    { "target": "accountCode", "transform": "Uppercase", "source": "customerId" },
                    { "target": "displayName", "transform": "Trim", "source": "customerName" },
                    { "target": "emailAddress", "transform": "Lowercase", "source": "email" },
                    { "target": "contactNumber", "transform": "Trim", "source": "phone" },
                    { "target": "accountStatus", "transform": "Lookup", "source": "status", "lookup": { "Active": "ACTIVE", "Inactive": "INACTIVE", "OnHold": "BLOCKED" } } ] } },
                { "id": "n6", "type": "invoke", "name": "upsertCustomer", "description": "Create or update the ERP account.",
                  "config": { "system": "erp", "table": "customer_master", "operation": "upsert", "input": "mapCustomer" } },
                { "id": "n7", "type": "logger", "name": "logResult", "config": { "level": "info", "message": "concat($syncLabel, ' delivered to the Modern ERP')" } },
                { "id": "n8", "type": "return", "name": "done", "config": { "output": "$mapCustomer.accountCode" } } ],
              "globalFaultHandler": [
                { "id": "f1", "type": "logger", "name": "logFault", "config": { "level": "error", "message": "concat($fault.code, ': ', $fault.message)" } },
                { "id": "f2", "type": "faultReturn", "name": "failed", "config": { "code": "CustomerSyncFailed", "message": "$fault.message" } } ] }
            """)),
        new("order-xml", "Legacy CRM order → staged XML file", "Read a CRM order, map it to the ERP order schema and write a synthetic XML file to the stage area.", "Stage File",
            Parse("""
            { "schemaVersion": 1,
              "trigger": { "id": "t1", "type": "trigger", "name": "start", "config": { "mode": "manual", "parameters": [ { "name": "orderId", "type": "string", "required": true, "sample": "ORD-013" } ] } },
              "steps": [
                { "id": "n1", "type": "invoke", "name": "readOrder", "config": { "system": "crm", "table": "sales_orders", "operation": "get", "key": "$trigger.orderId" } },
                { "id": "n2", "type": "assign", "name": "prepare", "config": { "assignments": [ { "variable": "exportLabel", "expression": "concat('Order ', $readOrder.id, ' for ', $readOrder.customerId)" } ] } },
                { "id": "n3", "type": "map", "name": "mapOrder", "config": { "input": "readOrder", "targetSystem": "erp", "targetTable": "imported_orders", "rules": [
                    { "target": "externalOrderId", "transform": "Copy", "source": "id" },
                    { "target": "accountCode", "transform": "Uppercase", "source": "customerId" },
                    { "target": "currencyCode", "transform": "Uppercase", "source": "currency" },
                    { "target": "totalMinorUnits", "transform": "Multiply", "source": "amount", "factor": 100 } ] } },
                { "id": "n4", "type": "stageFile", "name": "writeOrderXml", "description": "XML is staged only; it is not sent to the ERP.",
                  "config": { "operation": "writeFile", "fileName": "order-export.xml", "format": "xml", "rootElement": "SalesOrders", "recordElement": "SalesOrder", "input": "mapOrder" } },
                { "id": "n5", "type": "logger", "name": "logFile", "config": { "level": "info", "message": "concat($exportLabel, ' staged as ', $writeOrderXml.fileName)" } },
                { "id": "n6", "type": "return", "name": "done", "config": { "output": "$writeOrderXml.fileName" } } ],
              "globalFaultHandler": [] }
            """)),
        new("order-review", "Review CRM orders (loop and branch)", "List CRM orders, check each currency in a For Each with a Switch, and summarize with collection functions.", "Logic practice",
            Parse("""
            { "schemaVersion": 1,
              "trigger": { "id": "t1", "type": "trigger", "name": "start", "config": { "mode": "manual", "parameters": [] } },
              "steps": [
                { "id": "n1", "type": "invoke", "name": "listOrders", "config": { "system": "crm", "table": "sales_orders", "operation": "list", "limit": 50 } },
                { "id": "n2", "type": "forEach", "name": "eachOrder", "config": { "collection": "listOrders", "itemVariable": "order", "maxItems": 50 }, "branches": [
                  { "id": "b1", "kind": "body", "label": "For each order", "steps": [
                    { "id": "n3", "type": "switch", "name": "byCurrency", "config": {}, "branches": [
                      { "id": "b2", "kind": "case", "label": "Supported currency", "condition": "$order.currency == 'USD' or $order.currency == 'PHP' or $order.currency == 'EUR'", "steps": [
                        { "id": "n4", "type": "logger", "name": "logReady", "config": { "level": "info", "message": "concat($order.id, ' is ready for import')" } } ] },
                      { "id": "b3", "kind": "otherwise", "label": "Otherwise", "steps": [
                        { "id": "n5", "type": "logger", "name": "logUnsupported", "config": { "level": "warning", "message": "concat($order.id, ' uses unsupported currency ', $order.currency)" } } ] } ] } ] } ] },
                { "id": "n6", "type": "assign", "name": "summary", "config": { "assignments": [
                    { "variable": "orderCount", "expression": "count($listOrders)" },
                    { "variable": "orderTotal", "expression": "round(sum($listOrders, 'amount'), 2)" } ] } },
                { "id": "n7", "type": "logger", "name": "logSummary", "config": { "level": "info", "message": "concat('Reviewed ', toString($orderCount), ' orders worth ', toString($orderTotal))" } },
                { "id": "n8", "type": "return", "name": "done", "config": {} } ],
              "globalFaultHandler": [] }
            """)),
    ];
    public static readonly Dictionary<string, FlowTemplate> ById = All.ToDictionary(t => t.Id);

    /// <summary>A genuinely empty integration: only the Start trigger for its style, no business actions.</summary>
    public static FlowDefinition Blank(string style) => new()
    {
        Trigger = new FlowNode { Id = "t1", Type = "trigger", Name = "start", Config = style switch
        {
            // Application: an unconfigured placeholder until a Trigger connection and REST endpoint are chosen.
            "application" => new() { ["mode"] = "rest" },
            "schedule" => new() { ["mode"] = "schedule", ["frequency"] = "manual", ["timezone"] = "UTC", ["parameters"] = new System.Text.Json.Nodes.JsonArray() },
            _ => new() { ["mode"] = "manual", ["parameters"] = new System.Text.Json.Nodes.JsonArray() },
        } },
    };
}
