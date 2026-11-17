# SCN-003: Customer Update Synchronization

**Status:** Implemented · **Source:** edited Legacy CRM customer · **Target:** existing Modern ERP account · **Execution kind:** `CustomerSync`

## Business context
Customer details change in the CRM (new billing email, phone, status). The existing ERP account must be **updated, not duplicated**. The change must be traceable, and a delayed older message must never undo a newer change.

## Objective
Show the original source record, the modified source record, the mapped update, the updated ERP record and the full audit trail, under a deliberate upsert policy for mutable data.

## Why orders and customers use different rules
| | Sales orders (SCN-002) | Customers (SCN-001/003) |
|---|---|---|
| Nature | Immutable business transaction | Mutable master data |
| Middleware | One execution per order, ever | A new execution per change; one **active** per customer |
| Target key | `externalOrderId` + payload fingerprint | `accountCode` |
| Same key, different data | 409 conflict (never overwrite) | Update if the source version is the same or newer |
| Older data | n/a | `SkippedStale`: never overwrites newer data |

## Systems involved and prerequisites
- The customer already exists in the ERP. Run [SCN-001](SCN-001-customer-master-sync.md) for C-300 first, or use C-100/C-200. Those are migrated fixtures, and their first sync takes ownership.
- Operator role for editing and syncing.

## Source and target schemas, mapping and validation
Identical to [SCN-001](SCN-001-customer-master-sync.md#field-mapping). Additional source behaviour:
- Every CRM edit that changes a field increments `version`, stamps `updatedAt` and stores a **revision** (full snapshot). Saving without changes keeps the version.
- `version` is an optimistic-concurrency token: two simultaneous edits cannot both become version n+1. The second gets **409**.

## Upsert policy (Modern ERP `PUT /api/customers/{accountCode}`)
| Situation | Outcome | Record | History |
|---|---|---|---|
| Account missing | `Created` | inserted, `Origin=Import` | Created |
| Incoming version ≥ stored, fields differ | `Updated` | changed fields applied | Updated + changed fields + before/after |
| Incoming version ≥ stored, identical | `Unchanged` | sync time and execution updated only | Unchanged |
| Record is a fixture | `Updated` | ownership moves to the integration | Updated + note |
| Incoming version < stored | `SkippedStale` | **not changed** | SkippedStale + note |

## Sample: original vs modified source
```json
// version 1 (original)
{ "customerId": "C-300", "customerName": "Bluefin  Fictional Outfitters", "email": " Buyer@Bluefin-Outfitters.example ", "phone": "555-0300", "status": "Active", "version": 1 }
// version 2 (edited in the Legacy CRM UI)
{ "customerId": "C-300", "customerName": "Bluefin  Fictional Outfitters", "email": "accounts@bluefin-outfitters.example", "phone": "555-0300", "status": "OnHold", "version": 2 }
```

## Expected mapped update and ERP result
```json
{ "accountCode": "C-300", "displayName": "Bluefin Fictional Outfitters", "emailAddress": "accounts@bluefin-outfitters.example", "contactNumber": "5550300", "accountStatus": "BLOCKED" }
```
ERP response: `{ "outcome": "Updated", "changedFields": ["emailAddress", "accountStatus"], "appliedVersion": 2, "receiptId": "SYNC-…" }`

## REST endpoints
| Method | Route | Purpose |
|---|---|---|
| PUT | `/api/source/customers/{id}` (Operator) | Edit in the CRM; returns the new version |
| GET | `/api/source/customers/{id}` | Current record and revisions (newest first) |
| POST | `/api/executions` `{ "kind": "CustomerSync", "sourceId": "C-300" }` | Sync |
| GET | `/api/target/customers/{code}` | ERP record and history with before/after snapshots |
| PUT | `/api/target/fixtures/customers/{code}` (Operator) | Manual edit, **fixtures only**; recorded as `FixtureEdit` |

## End-to-end process
1. Legacy CRM → C-300 → **Edit**. Change the email and the status → *now version 2*. The revision table shows before → after.
2. Mapping Studio → C-300 → **Preview mapping**: the update payload, with nothing written.
3. Run the customer sync for C-300 from the Integration Hub (**Run an integration** console or **Run this integration**). The execution logs `Mapped… source version 2` and `Completed: updated C-300 from source version 2: emailAddress, accountStatus.`
4. Modern ERP → C-300: the history shows `Updated` with struck-through old values and highlighted new values, plus the execution link.
5. Sync again without editing: `Completed: … already held identical data … (idempotent)`.

## Expected database changes
| Database | Change |
|---|---|
| crm.db `Customers` | `Version` 1 → 2, fields updated |
| crm.db `CustomerRevisions` | +1 row (version 2 snapshot) |
| hub.db `Executions` | +1 `CustomerSync` row per sync, each with its own `SourceVersion` and frozen payload |
| erp.db `ErpCustomers` | same row updated; `SourceVersion=2`, `LastExecutionId`, `UpdatedAt` |
| erp.db `CustomerHistory` | +1 `Updated` (then +1 `Unchanged` for the re-sync) |

## Error scenarios
| Case | Result |
|---|---|
| Two operators edit C-300 at once | Second save → 409 "changed by someone else" |
| Sync while another sync of C-300 is active | 409 with the active execution ID |
| A retried older execution arrives after a newer one | `SkippedStale`; the ERP keeps the newer data |
| CRM changed again during retries | The retry delivers its frozen version; the log says the CRM is now at a newer version and to run a new sync |
| Manual edit of an imported ERP record | 409 `NotAFixture`: change it in the CRM and sync |

## Verification and reconciliation
- **Compare with source** shows ✓ for every field, with the note "ERP holds source version 2, the current CRM version".
- If the CRM is ahead, the note says so and recommends a sync.

## Troubleshooting
| Symptom | Action |
|---|---|
| ERP not updated after an edit | Sync the customer; edits are not pushed automatically |
| `SkippedStale` in history | Expected when an older execution finishes late; no action needed |
| Orders now rejected as `AccountBlocked` | The status was changed to OnHold; set it Active and sync again |

## Test cases
| Test | Expected |
|---|---|
| `LabMockApiTests.CRM_customer_create_update_versions_and_revisions` | No-op save keeps v1; edit → v2; revisions newest first |
| `LabMockApiTests.ERP_customer_upsert_policy_and_history` | Created, Unchanged, Updated (changed fields), SkippedStale |
| `LabMockApiTests.Only_fixture_records_can_be_edited_by_hand_and_edits_are_audited` | FixtureEdit audited; imported records refuse manual edits |
| `CustomerSyncRunnerTests.Retry_reuses_frozen_customer_mapping_and_version_even_if_CRM_changed` | Same payload and version on retry |
| `CustomerSyncRunnerTests.Upsert_outcomes_are_explained_in_the_audit_trail` | Outcome-specific log text |
| e2e `lab.spec.ts` "SCN-003…" | Edit → revision diff → Updated with before/after → re-sync Unchanged |
