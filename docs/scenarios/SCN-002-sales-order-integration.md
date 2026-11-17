# SCN-002: Sales Order Integration

**Status:** Implemented · **Source:** Legacy CRM · **Target:** Modern ERP · **Execution kind:** `SalesOrder`

## Business context
Sales orders are captured in the Legacy CRM and must be imported into the Modern ERP **exactly once**. An ambiguous timeout or a lost response must never create a second order, and a retry must never deliver different data under the same order ID.

## Objective
Retrieve a CRM order, validate it, convert its decimal amount to integer minor units and deliver it idempotently. The ERP **stores the mapped order**, not only a receipt.

## Systems involved
| System | Responsibility |
|---|---|
| Legacy CRM | Owns sales orders |
| Integration Middleware | One execution per order, frozen mapping, classification, bounded retries |
| Modern ERP | Validates account rules, stores the order with its receipt, fingerprint and execution ID, and replays duplicates |

## Prerequisites
- The order's customer must exist in the ERP and be `ACTIVE`.
  - C-100 and C-200 are seeded as migrated fixtures, so ORD-001 to ORD-012 work immediately.
  - For a new customer (e.g. C-300 / ORD-013), run [SCN-001](SCN-001-customer-master-sync.md) first. Otherwise delivery fails with `MissingCustomer`, and the execution explains this prerequisite.

## Source schema (Legacy CRM order)
| Field | Type | Required |
|---|---|---|
| id | string | yes |
| customerId | string | yes |
| currency | string, 3 upper-case letters | yes |
| amount | decimal 0.01–1,000,000 | yes |

## Target schema (Modern ERP imported order)
| Field | Type | Required |
|---|---|---|
| externalOrderId | string | yes (idempotency key) |
| accountCode | string | yes (must exist and be ACTIVE) |
| currencyCode | `USD` / `PHP` / `EUR` | yes |
| totalMinorUnits | integer ≥ 1 | yes |

ERP-managed fields: `receiptId`, `fingerprint` (SHA-256 of the typed payload), `acceptedAt` (import time), `executionId`, `sourceSystem`.

## Field mapping
| Source | Rule | Target |
|---|---|---|
| id | copy | externalOrderId |
| customerId | copy | accountCode |
| currency | validate (USD, PHP, EUR) | currencyCode |
| amount | × 100, round half away from zero | totalMinorUnits |

## Transformation and validation rules
- `Mapping.TryTransform(CrmOrder)` reports errors per field (e.g. `currency: Unsupported currency JPY…`).
- 125.50 → 12550; 12.345 → 1235; 0.01 → 1.
- The first valid mapping is **frozen**. Retries, including manual retries after CRM data changed, deliver the original payload.

## Sample source JSON (ORD-013)
```json
{ "id": "ORD-013", "customerId": "C-300", "currency": "USD", "amount": 410.25 }
```

## Expected target JSON
```json
{ "externalOrderId": "ORD-013", "accountCode": "C-300", "currencyCode": "USD", "totalMinorUnits": 41025 }
```

## REST endpoints
Browser → middleware:
| Method | Route | Role |
|---|---|---|
| GET/POST/PUT | `/api/source/orders` · `/api/source/orders/{id}` | read: Viewer · write: Operator |
| POST | `/api/mappings/sales-order/preview` | Viewer/Operator |
| POST | `/api/executions` `{ "kind": "SalesOrder", "sourceId": "ORD-013" }` (v1 form `{ "orderId": … }` still accepted) | Operator |
| POST | `/api/executions/{id}/retry` | Operator |
| GET | `/api/target/orders` · `/api/target/orders/{id}` | Viewer/Operator |

Middleware → systems:
| Call | Result |
|---|---|
| `GET {crm}/api/orders/{id}` | Source order |
| `POST {erp}/api/orders` + `X-Execution-Id` | 201 receipt · 200 duplicate replay · 409 conflicting payload · 422 `UnknownAccount` / `AccountBlocked` |

## End-to-end process
1. Queue the order: `Queued`.
2. `Started` (attempt n of 3) → `Retrieved` → `Mapped` (payload frozen).
3. The ERP validates the account, stores the order and returns a receipt → `Completed`: "Mock ERP accepted the order."
4. Modern ERP → Imported orders shows the stored mapped values, the receipt, the import time and the execution ID.

## Expected database changes
| Database | Change |
|---|---|
| hub.db `Executions` | `Kind=SalesOrder`, `OrderId=SourceId=ORD-013`, `SourcePayload`, frozen `MappedPayload`, `ReceiptId` |
| erp.db `Accepted` | 1 row: `ExternalOrderId`, `AccountCode`, `CurrencyCode`, `TotalMinorUnits`, `ExecutionId`, `Fingerprint`, `ReceiptId`, `AcceptedAt` |
| crm.db | none |

## Error scenarios
| Case | Reproduce | Result |
|---|---|---|
| Missing customer in ERP | Run ORD-013 before syncing C-300 | `MissingCustomer`, **failed at: Target delivery**, guidance to run SCN-001, no automatic retry |
| ERP business rejection | Sync C-500 (BLOCKED), then run ORD-015 | `TargetRejected` (`AccountBlocked`) |
| Unsupported currency | Run ORD-014 (JPY) | `Validation` at the Validation stage; ERP never called |
| Invalid source on demand | Simulation `Validation` | CRM returns amount −1 → `Validation` |
| Source/target unavailable | `Unavailable`/`ServerError`/`Timeout` simulations or stopped containers | Transient; up to 3 attempts, then `RetryExhausted` |
| HTTP 429 | `RateLimit` on ERP | Retried after the bounded `Retry-After` |
| Duplicate transaction | Run the same order again | Middleware 409 *already tracked* |
| Conflicting payload | Simulation `Duplicate` | `DuplicateConflict`; do not change the ID to bypass it |

## Retry and idempotency
- One execution per order ID, ever (unique index on `OrderId`). Concurrent submissions create exactly one execution.
- The ERP keys orders by `externalOrderId`. An identical payload returns the original receipt (`duplicate: true`), and a different payload under the same ID returns 409.
- A crash after ERP acceptance is recovered with the frozen payload, and the ERP replays the original receipt. Exactly one ERP order exists.

## Verification and reconciliation
1. Modern ERP → Imported orders → ORD-013 → **Compare with source**: all four fields ✓.
2. If the CRM order was edited after import, the comparison shows ✗ and explains that imported orders are immutable.
3. The execution's **Open imported record** and the ERP's **Open execution** link each other.

## Troubleshooting
| Symptom | Action |
|---|---|
| `MissingCustomer` | Run SCN-001 for the account, then **Safely retry** the same execution |
| `TargetRejected` (BLOCKED) | Change the CRM status to Active, sync (SCN-003), then retry |
| `Validation: Unsupported currency` | Correct the CRM order (USD/PHP/EUR), then retry. The frozen payload only exists after a valid mapping |
| *Source order already tracked* | Open the existing execution; retry only if Failed |
| Pre-upgrade orders show "Imported before payload storage" | Expected for orders imported by v1; only their receipt was stored |

## Test cases
| Test | Expected |
|---|---|
| `MappingTests.*`, `CustomerMappingTests.Order_errors_name_the_field` | Minor units; currency errors name the field |
| `CustomerSyncRunnerTests.Order_for_unknown_ERP_account_fails_as_MissingCustomer_with_prerequisite_guidance` | Permanent; guidance mentions SCN-001 |
| `CustomerSyncRunnerTests.Frozen_v1_PascalCase_order_payload_is_still_reused_on_retry` | v1 frozen payloads still deliver |
| `LabMockApiTests.ERP_stores_mapped_orders_and_enforces_account_rules` | Stored fields; 422 UnknownAccount / AccountBlocked |
| `RecoveryTests.Crash_after_ERP_acceptance_recovers_idempotently_with_one_ERP_order` | Exactly one ERP order |
| `ApiTests.Concurrent_submissions_create_exactly_one_execution` | One execution |
| e2e `lab.spec.ts` "SCN-002…" | Create customer and order in the UI → MissingCustomer → sync → safe retry → reconciliation ✓ |
