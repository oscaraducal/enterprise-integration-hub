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
