# API documentation

Base URLs: middleware :5100, mock CRM :5101, mock ERP :5102. JSON field names use camelCase. Import each service's `/openapi/v1.json` for the generated contract.

## Authentication

```http
POST http://localhost:5100/api/auth/login
Content-Type: application/json

{"username":"operator","password":"<DEMO_PASSWORD from local .env>"}
```

Response: `{"token":"<JWT>","role":"Operator","expiresAt":"<UTC>"}`. Tokens expire after 30 minutes. Use `Authorization: Bearer <token>` on middleware business endpoints. The viewer account receives role Viewer. Both accounts use the generated local password. Login is rate limited to ten requests per minute per remote address.

## Middleware

| Method | Route | Permission | Purpose |
|---|---|---|---|
| POST | /api/auth/login | Anonymous | Issue demo token |
| GET | /api/scenarios | Viewer/Operator | Allowed simulations |
| GET | /api/orders | Viewer/Operator | Proxy fictional CRM orders |
| POST | /api/executions | Operator | Queue one source order |
| GET | /api/executions | Viewer/Operator | Paginated history |
| GET | /api/executions/{id} | Viewer/Operator | Full timeline and delivery details |
| POST | /api/executions/{id}/retry | Operator | Safely requeue Failed only |
| GET | /api/metrics | Viewer/Operator | Global execution metrics |
| GET | /api/jobs | Viewer/Operator | Last 100 synthetic workload records |
| GET | /api/jobs/{id} | Viewer/Operator | Investigate one job |
| POST | /api/jobs/simulate | Operator | Add immediate synthetic job outcome |

Queue example:

```json
{
  "orderId": "ORD-002",
  "environment": "TEST",
  "scenario": "Unavailable",
  "target": "ERP",
  "failuresBeforeSuccess": 1
}
```

Returns 202, a Location header and `{"id":"<execution-id>"}`. An already tracked source order returns 409 with its executionId. Simulation target is CRM or ERP; Validation requires CRM and Duplicate requires ERP. Environments are DEV or TEST only. failuresBeforeSuccess accepts 0–3: 0 disables the scenario, 1/2 demonstrate recovery for transient failures, and 3 exhausts the automatic budget.

History query:
`GET /api/executions?search=<execution-id-substring>&status=Failed&environment=TEST&page=1`

Response: `{"items":[],"total":0,"page":1,"pageSize":20}`. Search is a maximum 64 characters. Statuses are Pending, Running, Completed, Failed, Retrying. Omit status/environment rather than sending invalid values.

Retry request: `POST /api/executions/<id>/retry` with `{}`. Returns 202, 404 for an unknown ID or 409 unless Failed. Simulation is cleared; mapping, idempotency identity and old logs are retained. Attempts reset to 0 for a new 3-attempt cycle, and a `ManualRetry` log names the operator, the previous error class and the attempt number.

Execution detail `logs[]` is the audit trail: `{id, executionId, timestamp (UTC), stage, level, message, attempt}`. Stages: Queued, Started, Retrieved, Mapped, Completed, RetryScheduled, RetryExhausted, Failed, ManualRetry, RecoveryScheduled, RecoveryExhausted (see [ARCHITECTURE.md](ARCHITECTURE.md#audit-trail)). Additional error classes: `Interrupted` (worker restarted during the final attempt), `RetryBudgetExhausted` (attempt refused beyond budget), `Internal` (unexpected worker error).

`GET /api/orders` returns **502** `{"title":"Mock CRM unavailable"}` when the CRM is unreachable, returns an error, or exceeds the 2-second timeout. Metrics, history and job endpoints do not depend on the CRM and keep returning 200 during a CRM outage.

Job simulation: `{"environment":"DEV","fail":true}`. Returns 201 and the synthetic job. It writes a history record immediately; it does not execute a real workload or create a schedule.

## Mock CRM

All `/api` routes require `X-Service-Key: <SERVICE_KEY from .env>`.

| Method | Route | Description |
|---|---|---|
| GET | /api/customers | List fictional customers |
| POST | /api/customers | Add synthetic customer with unique ID |
| GET | /api/orders | List source orders |
| GET | /api/orders/{id} | Retrieve source order, optionally simulate a fault |
| POST | /api/orders | Add synthetic order referencing an existing customer |
| PUT | /api/orders/{id} | Update a source order; route/body IDs must match |

Customer: `{"id":"C-300","name":"Fictional Cedar Research"}`

Order:
```json
{"id":"ORD-013","customerId":"C-100","currency":"USD","amount":250.75}
```

Missing resources return 404, duplicate IDs 409, invalid fields or unknown customers 400. The initial seed has 2 customers and 12 orders. CRM accepts three-letter currency strings; middleware/ERP further restrict supported currencies.

For GET order fault simulation, set `X-Demo-Scenario` to an allowed scenario. Validation returns a deliberately invalid amount. Timeout delays for ten seconds; the middleware's two-second HTTP timeout triggers first.

## Mock ERP

All business endpoints require the service key.

`POST /api/orders` accepts:
```json
{"externalOrderId":"ORD-013","accountCode":"C-100","currencyCode":"USD","totalMinorUnits":25075}
```

First acceptance: 201 and `{"externalOrderId":"ORD-013","receiptId":"<receipt>","duplicate":false}`.
Identical replay: 200, same receipt, duplicate=true.
Changed payload for an accepted ID: 409 DuplicateConflict.

`GET /api/orders` lists accepted IDs, receipt IDs, fingerprints and acceptance timestamps for reconciliation.

X-Demo-Scenario can force HTTP failures, timeout or DuplicateConflict before first acceptance. Existing matching records are reconciled before simulation, preserving duplicate protection.

## Failure scenarios

| Scenario | HTTP / behavior | Classification | Automatic retry |
|---|---|---|---|
| None | Normal flow | — | — |
| BadRequest | 400 | InvalidRequest | No |
| Unauthorized | 401 | Authentication | No |
| NotFound | 404 | MissingResource | No |
| RateLimit | 429, ERP Retry-After: 1 | RateLimited | Yes |
| ServerError | 500 | UpstreamUnavailable | Yes |
| Unavailable | 503 | UpstreamUnavailable | Yes |
| Timeout | 10-second delay; 2-second client timeout | Timeout | Yes |
| Validation | CRM returns negative amount | Validation | No |
| Duplicate | ERP returns 409 | DuplicateConflict | No |

Connection failures are also classified as Connection and retried. Simulation is per execution, not a global mutable fault switch.

## Error security

Unexpected server errors return a generic Problem Details response and traceId. They do not return stack traces or raw upstream bodies. No credentials belong in sample JSON, screenshots, test reports or logs.

See [requests.http](docs/requests.http) for an importable request sequence using local variables.

## Portfolio lab endpoints

The dashboard calls only the middleware. The middleware forwards to **fixed** CRM/ERP routes with the service key, so browsers never receive service keys and cannot choose upstream URLs. IDs are limited to letters, digits, `-` and `_` (≤ 60 characters).

### Middleware (JWT)
| Method | Route | Role | Purpose |
|---|---|---|---|
| GET | /api/source/customers | Viewer/Operator | Legacy CRM customers |
| GET | /api/source/customers/{id} | Viewer/Operator | `{ customer, revisions }` (revisions newest first) |
| POST / PUT | /api/source/customers · /api/source/customers/{id} | Operator | Create / edit (`CustomerInput`); CRM validation errors are relayed as 400 problem details |
| GET / POST / PUT | /api/source/orders · /api/source/orders/{id} | read Viewer · write Operator | Legacy CRM sales orders |
| GET | /api/target/customers · /api/target/customers/{code} | Viewer/Operator | Modern ERP customer master; detail includes `history` |
| PUT | /api/target/fixtures/customers/{code} | Operator | Manual edit of **fixture** records only (409 `NotAFixture` otherwise); audited as `FixtureEdit` with the operator name |
| GET | /api/target/orders · /api/target/orders/{id} | Viewer/Operator | Imported orders with stored mapped fields |
| GET | /api/target/history?take= | Viewer/Operator | Import history across all ERP accounts, newest first (`take` 1–200, default 100) |
| GET | /api/mappings | Viewer/Operator | Field-mapping catalog rendered by the Mapping Studio |
| POST | /api/mappings/{customer\|sales-order}/preview | Viewer/Operator | `{ "sourceId": "C-300" }` (reads the CRM) or `{ "source": { … } }` (inline). Returns `{ input, output, errors[{field,message}], valid, notes }`. **No execution, no writes, no ERP call** |

Upstream 5xx/connection failures return 502 `Mock CRM unavailable` / `Modern ERP unavailable`. Upstream 401/403 is never relayed as the user's own authentication failure.

### Queueing a scenario
```json
POST /api/executions
{ "kind": "CustomerSync", "sourceId": "C-300", "environment": "DEV", "scenario": "None" }
```
`kind` is `SalesOrder` (default; `orderId` from v1 still accepted) or `CustomerSync`. Customer syncs return **409** with `executionId` while another sync of the same customer is Pending/Running/Retrying. `Duplicate` simulation is orders-only. `GET /api/executions` accepts `kind`, and `search` matches the execution ID **or** the source ID (e.g. `ORD-013`, `C-300`). Execution detail adds `kind`, `sourceId`, `sourceVersion` and `sourcePayload` (source snapshot).

### Legacy CRM additions (service key)
| Method | Route | Notes |
|---|---|---|
| GET | /api/customers/{id} | `X-Demo-Scenario` supported; `Validation` returns the customer without email |
| GET | /api/customers/{id}/revisions | Full snapshots per version |
| POST / PUT | /api/customers · /api/customers/{id} | Body `{ customerId, customerName, email?, phone?, status }`; status `Active`/`Inactive`/`OnHold`; version increments only when a field changes; concurrent edits → 409 |

Customer JSON: `{ "customerId", "customerName", "email", "phone", "status", "version", "updatedAt" }`.

### Modern ERP additions (service key)
| Method | Route | Notes |
|---|---|---|
| POST | /api/orders | Now also stores `accountCode`, `currencyCode`, `totalMinorUnits`, `executionId` (`X-Execution-Id`). 422 `{ code: "UnknownAccount" \| "AccountBlocked", accountCode }` when the account is missing or not ACTIVE |
| GET | /api/orders/{id} | Imported order |
| GET | /api/customers · /api/customers/{code} | Customer master; detail `{ customer, history }` |
| PUT | /api/customers/{code} | Integration upsert. Headers `X-Execution-Id`, `X-Source-Version`. Response `{ accountCode, outcome: Created\|Updated\|Unchanged\|SkippedStale, changedFields, appliedVersion, receiptId }` |
| PUT | /api/fixtures/customers/{code} | Fixture-only manual edit; `X-Actor` recorded |
| GET | /api/history?take= | Customer-master history across all accounts, newest first (`take` clamped to 1–200, default 100) |

New error classes: `MissingCustomer` (422 UnknownAccount), `TargetRejected` (other 422). Both are permanent; see the [scenario docs](docs/scenarios/README.md).

## Dynamic Data Catalog and schema mapper (Milestone B)

Every route below is behind the Integration Hub's JWT authentication. `{system}` is the fixed allowlist `crm` | `erp`; the Hub forwards to that application's `/api/catalog` routes with the service key, which never reaches the browser.

| Method | Hub route | Role | Notes |
|---|---|---|---|
| GET | /api/catalog/{system}/tables | Viewer/Operator | Built-in tables (read-only, `builtIn: true`) and logical tables, with columns, types, required flags, primary key, schema version and row count |
| GET | /api/catalog/{system}/tables/{name} | Viewer/Operator | `{ table, versions[] }`: metadata plus the schema version history |
| GET | /api/catalog/{system}/tables/{name}/contract | Viewer/Operator | Generated REST contract: routes and a JSON-schema description of a record |
| POST | /api/catalog/{system}/tables | Operator | Create a logical table `{ name, title, description?, primaryKey, columns[{ name, type, required?, values? }] }`. Types: string, integer, decimal, boolean, date, datetime, enum. Names are validated (`^[a-z][a-z0-9_]{1,39}$`); built-in names are reserved |
| POST | /api/catalog/{system}/tables/{name}/schema | Operator | Approved operations only: `AddColumn` (optional when rows exist), `RemoveColumn` (409 `ColumnInUse` while any row has a value), `SetRequired` (409 `RequiresBackfill` while rows lack a value), `AddEnumValues`, `UpdateDetails`. Each change adds a schema version. No type changes or renames |
| DELETE | /api/catalog/{system}/tables/{name} | Operator | Only empty tables (409 `TableNotEmpty` otherwise) |
| GET | /api/catalog/{system}/tables/{name}/records?page=&pageSize=&search= | Viewer/Operator | Paginated (max 100 per page), text search up to 60 characters |
| GET / PUT / DELETE | /api/catalog/{system}/tables/{name}/records/{key} | read Viewer · write Operator | The key cannot change on PUT |
| POST | /api/catalog/{system}/tables/{name}/records | Operator | Validated against the schema: unknown fields, missing required values and wrong types are 400 per field; duplicate key 409; at most 500 rows per table and 8 KB per row |
| POST | /api/mapping-designer/suggest | Viewer/Operator | `{ source: { system, table }, target: { system, table } }` → both table definitions plus a suggested rule per mappable target field (name, synonym, type and primary-key matching) with confidence and reasons |
| POST | /api/mapping-designer/validate | Viewer/Operator | Validates a draft `{ name, source, target, fields[{ target, transform, source?, sources?, value?, separator?, factor?, format?, lookup? }] }` |
| POST | /api/mapping-designer/preview | Viewer/Operator | `{ draft, sample }` → mapped output for one sample record. Pure: no writes and no target call |
| GET | /api/mapping-definitions · /api/mapping-definitions/{name} | Viewer/Operator | Latest version per name, or every version of one mapping |
| POST | /api/mapping-definitions | Operator | Re-validates on the server, then stores a new immutable version (400 with the report when invalid). Saved definitions are configuration only and are **not executed** in Milestone B |

Allowlisted transformations: Copy, Trim, Uppercase, Lowercase, Concatenate, Default, ToNumber, Multiply, Divide, FormatDate (fixed format list), Lookup. Nothing is evaluated as code or SQL.

## Integration Designer (Milestone C)

Designs are configuration: no route below executes a flow or calls a target system. Validation reads catalog metadata only.

| Method | Hub route | Role | Notes |
|---|---|---|---|
| GET | /api/flows/actions | Viewer/Operator | Action catalog with status (Designable or Planned), expression functions, date formats, templates and limits |
| POST | /api/flows/expressions/check | Viewer/Operator | `{ expression }` → `{ valid, errors[{position,message}], variables }`. Parsed, never evaluated |
| POST | /api/flows/validate | Viewer/Operator | `{ definition }` → `{ valid, issues[{nodeId,severity,message,field}], nodeCount, variables }` |
| GET | /api/flows | Viewer/Operator | Flows with draft revision, latest published version and date, and the draft's validation status (`valid`, `errors`, `warnings`, `actions`) for the Integrations page |
| GET | /api/flows/{name} | Viewer/Operator | Draft definition, revision, versions and a fresh validation report |
| GET | /api/flows/{name}/versions/{version} | Viewer/Operator | An immutable published version |
| POST | /api/flows | Operator | `{ name, title, description?, template? }` (`blank`, `customer-sync`, `order-xml`, `order-review`). Names: `^[a-z][a-z0-9-]{2,59}$`; 409 if taken |
| PUT | /api/flows/{name}/draft | Operator | `{ definition, revision, title?, description? }`. A stale revision returns 409 `DraftChanged`; incomplete drafts are allowed and the report is returned |
| POST | /api/flows/{name}/publish | Operator | `{ revision }`. Only a valid saved draft becomes version n+1 (400 with report otherwise, 503 if a catalog was unreachable) |
| GET | /api/flows/{name}/export?version= | Viewer/Operator | `eih-flow` document of the draft or a version |
| POST | /api/flows/import | Operator | `{ document, name? }`. Always creates a new draft; 409 if the name exists |
| POST | /api/flows/{name}/duplicate | Operator | `{ identifier, title? }` (Milestone C.2). Copies the **saved** draft into a new unpublished integration named after the identifier (`ACCOUNT_SYNC_COPY` → `account-sync-copy`). The original and its versions are unchanged; 409 if the name exists, 404 for an unknown source |

Limits: 150 actions, 6 nesting levels, 256 KB per definition, 500-character expressions. See [docs/designer](docs/designer/README.md).

## Connections and integration styles (Milestone C.1)

| Method | Hub route | Role | Notes |
|---|---|---|---|
| GET | /api/connections/applications | Viewer/Operator | The approved internal applications with their adapter, supported roles, security summary and reasons for unsupported roles. No URLs or keys |
| GET | /api/connections/applications/{app}/operations | Viewer/Operator | Discovered operations with method, path, request/response schema and parameters (503 if a catalog is unreachable) |
| POST | /api/connections/applications/{app}/test | Operator | Safe test before saving (health and catalog metadata reads only) |
| GET | /api/connections · /api/connections/{id} | Viewer/Operator | Connections; detail includes the integrations that use it |
| GET | /api/connections/{id}/operations | Viewer/Operator | Operations of a saved connection |
| POST | /api/connections | Operator | `{ identifier, name, description?, adapter: "REST", role: "Trigger"\|"Invoke"\|"TriggerAndInvoke", application }`. The role must be supported by the application |
| PUT | /api/connections/{id} | Operator | `{ name, description?, role?, revision }`. A role change is refused (409) while the connection is used |
| DELETE | /api/connections/{id} | Operator | Refused (409, with usage) while any draft or published version references it |
| POST | /api/connections/{id}/test | Operator | Safe test; stores the status (Configured or Failed) |

`POST /api/flows` also accepts `{ title, identifier, versionLabel, style: "application"|"schedule"|"manual", description?, tags?, template? }`. New integrations are blank (only the Start trigger) unless a starter template is chosen, and templates require `manual`. The earlier `{ name, title, template }` shape still works. Flow list, detail and export include `style`, `identifier`, `versionLabel` and `tags`. See [docs/designer/WORKBENCH.md](docs/designer/WORKBENCH.md).
