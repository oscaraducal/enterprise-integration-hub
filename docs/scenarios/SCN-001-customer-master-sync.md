# SCN-001: Customer Master Synchronization

**Status:** Implemented · **Source:** Legacy CRM · **Target:** Modern ERP · **Execution kind:** `CustomerSync`

## Business context
Customer master data is maintained in the Legacy CRM. The Modern ERP needs a matching customer account before it can accept sales orders for that customer (see [SCN-002](SCN-002-sales-order-integration.md)).

## Objective
Retrieve a CRM customer and validate the fields the ERP requires. Transform the record into the ERP customer-master schema, then **create** the account if it is missing or **update** it under a controlled policy, without ever creating a duplicate.

## Systems involved
| System | Responsibility |
|---|---|
| Legacy CRM | Owns the customer; increments `version` on every change and keeps revisions |
| Integration Middleware | Retrieval, validation, mapping, delivery, execution tracking, retries, audit |
| Modern ERP | Upserts the account by `accountCode`; records source reference, version, execution and history |

## Prerequisites
- Stack running (`docker compose up --build`) and signed in as **operator** (viewers can inspect but not run).
- The customer exists in the Legacy CRM. Seeded example: **C-300**.

## Source schema (Legacy CRM customer)
| Field | Type | Required in CRM | Notes |
|---|---|---|---|
| customerId | string (`C-123`) | yes | Immutable key |
| customerName | string ≤ 100 | yes | Legacy data may contain extra spaces |
| email | string (email) | **no** | Optional in the legacy system |
| phone | string ≤ 30 | no | Free format |
| status | enum `Active` / `Inactive` / `OnHold` | yes | |
| version | integer | system | +1 on every change |
| updatedAt | UTC timestamp | system | |

## Target schema (Modern ERP customer master)
| Field | Type | Required |
|---|---|---|
| accountCode | string | yes (upsert key) |
| displayName | string ≤ 100 | yes |
| emailAddress | string (email) | **yes** |
| contactNumber | string | no |
| accountStatus | enum `ACTIVE` / `INACTIVE` / `BLOCKED` | yes |

Plus ERP-managed fields: `origin` (`Import` or `Fixture`), `sourceSystem`, `sourceReference`, `sourceVersion`, `lastExecutionId`, `lastSyncedAt`, `createdAt`, `updatedAt`.

## Field mapping
| Source | Rule | Target |
|---|---|---|
| customerId | trim, upper-case | accountCode |
| customerName | trim, collapse repeated spaces | displayName |
| email | **required**, trim, lower-case, must be a valid address | emailAddress |
| phone | keep digits and a leading `+`; 7–15 digits; empty → `null` | contactNumber |
| status | lookup: Active → ACTIVE, Inactive → INACTIVE, OnHold → BLOCKED | accountStatus |

## Transformation and validation rules
- Rules are implemented once in `Mapping.TryTransform(Customer)` and shared by executions and the Mapping Studio preview.
- All field errors are reported together, each naming its field. Messages never echo source values.
- The first successful mapping is **frozen** on the execution together with the source `version`. Automatic and manual retries deliver exactly that payload.

## Sample source JSON (seeded C-300)
```json
{ "customerId": "C-300", "customerName": "Bluefin  Fictional Outfitters",
  "email": " Buyer@Bluefin-Outfitters.example ", "phone": "555-0300", "status": "Active", "version": 1 }
```

## Expected target JSON
```json
{ "accountCode": "C-300", "displayName": "Bluefin Fictional Outfitters",
  "emailAddress": "buyer@bluefin-outfitters.example", "contactNumber": "5550300", "accountStatus": "ACTIVE" }
```

## REST endpoints
Browser → middleware (JWT):
| Method | Route | Role | Purpose |
|---|---|---|---|
| GET | `/api/source/customers` · `/api/source/customers/{id}` | Viewer/Operator | CRM list; detail with revisions |
| POST | `/api/mappings/customer/preview` `{ "sourceId": "C-300" }` or `{ "source": {…} }` | Viewer/Operator | Side-effect-free preview |
| POST | `/api/executions` `{ "kind": "CustomerSync", "sourceId": "C-300" }` | Operator | Queue the sync (202) |
| GET | `/api/executions/{id}` | Viewer/Operator | Timeline, snapshot, mapped payload |
| GET | `/api/target/customers/{code}` | Viewer/Operator | ERP record and history |

Middleware → systems (service key, fixed routes):
| Call | Headers | Result |
|---|---|---|
| `GET {crm}/api/customers/{id}` | `X-Demo-Scenario` (simulations only) | Source customer |
| `PUT {erp}/api/customers/{accountCode}` with the mapped JSON | `X-Execution-Id`, `X-Source-Version` | `{ accountCode, outcome, changedFields, appliedVersion, receiptId }` |

## End-to-end process
1. Operator clicks **Sync to Modern ERP** (Legacy CRM page) or **Run this integration** (Mapping Studio). The execution is queued with `Queued … Automatic retry budget: 3 attempts.`
2. The worker claims it. `Started`: attempt 1 of 3.
3. `Retrieved`: customer C-300 version 1.
4. `Mapped`: the payload and version are validated and frozen.
5. ERP upsert. `Completed`: "Modern ERP created customer C-300 from source version 1."

## Expected database changes
| Database | Change |
|---|---|
| hub.db `Executions` | 1 row: `Kind=CustomerSync`, `SourceId=C-300`, `SourceVersion=1`, `SourcePayload`, `MappedPayload`, `ReceiptId=SYNC-nnnnnn`, `Status=Completed` |
| hub.db `Logs` | Queued, Started, Retrieved, Mapped, Completed |
| erp.db `ErpCustomers` | 1 row `C-300`, `Origin=Import`, `SourceSystem=LEGACY-CRM`, `SourceVersion=1`, `LastExecutionId` |
| erp.db `CustomerHistory` | 1 row `Action=Created`, `ExecutionId`, `Actor=integration` |
| crm.db | none (read only) |

## Error scenarios
| Case | How to reproduce | Result |
|---|---|---|
| Missing required field | Sync **C-400** (no email) | `Failed`, `Validation`, failed at Validation; ERP not called |
| Invalid source on demand | Simulation `Validation` | CRM returns the customer without email → `Validation` |
| Source unavailable | Simulation `Unavailable` on CRM, or `docker compose stop crm` | Transient, retried; after 3 attempts `RetryExhausted` |
| Target unavailable | Simulation `ServerError`/`Unavailable` on ERP, or `docker compose stop erp` | Transient, retried |
| Concurrent sync | Queue C-300 twice quickly | Second request → **409** with the active execution ID |

## Retry and idempotency
- Customer data is mutable, so the order rule "one execution per record, forever" does **not** apply. Each sync is a new execution. Only **one active** sync per customer is allowed, enforced by a partial unique index (`IX_Executions_ActiveCustomerSync`).
- The ERP keys accounts by `accountCode`, so two syncs can never produce two accounts.
- Re-delivering the same data returns `Unchanged`. Delivering an **older** source version than the ERP holds returns `SkippedStale`, and the record is not changed.

## Verification and reconciliation
1. Modern ERP → C-300 shows **Imported by the integration**, source `LEGACY-CRM C-300, version 1` and the execution ID.
2. **Compare with source** recomputes the expected values from the live CRM record using the same mapping. Every row shows ✓ and the badge says *All fields match*.
3. The history shows `Created` linked to the execution.

## Troubleshooting
| Symptom | Action |
|---|---|
| `Validation: Email is required…` | Add an email in the Legacy CRM, then **Safely retry** or run a new sync |
| `409 A sync for C-300 is already queued or running` | Open that execution and wait for it |
| ERP shows an older version than the CRM | Run the sync again (SCN-003) |
| `Mock CRM unavailable` / `Modern ERP unavailable` | `docker compose ps`; `docker compose start crm`/`erp` |

## Test cases
| Test | Expected |
|---|---|
| `CustomerMappingTests.Customer_mapping_normalizes_every_field` | Trim, case, phone and status rules applied |
| `CustomerMappingTests.Missing_email_and_unknown_status_are_reported_per_field_without_values` | Field-level errors, no source values |
| `CustomerSyncRunnerTests.Customer_sync_maps_delivers_with_version_and_execution_id_and_records_outcome` | Version and execution headers; Created logged |
| `CustomerSyncRunnerTests.Missing_required_email_fails_validation_before_the_ERP_is_called` | Failed, ERP calls = 0 |
| `LabMockApiTests.ERP_customer_upsert_policy_and_history` | Created → Unchanged → Updated → SkippedStale; one account |
| `LabHubApiTests.Customer_sync_queueing_rules` | 202, then 409 while active |
| e2e `lab.spec.ts` "SCN-001…" | UI flow through reconciliation ✓ |
