# Integration scenario catalog

The portfolio lab demonstrates integration engineering with **fictional** business applications:

| Component | Role in the lab | Service |
|---|---|---|
| **Legacy CRM** | Source system: existing business application that owns customers and sales orders | `src/MockCrm` (port 5101) |
| **Integration Middleware** | Integration layer: retrieve, validate, map, deliver, track, retry, audit | `src/Hub` (port 5100) |
| **Modern ERP** | Target system: stores the imported business records and their audit history | `src/MockErp` (port 5102) |

```text
SOURCE RECORD → REST RETRIEVAL → VALIDATION → FIELD MAPPING → TARGET DELIVERY → IMPORTED RECORD → EXECUTION MONITORING
```

This is not an Oracle Integration Cloud, Dell Boomi, Oracle MFCS/WMS or ESP dSeries implementation. It copies no vendor payloads, user interfaces or employer implementations. All records are synthetic.

## Scenarios

| ID | Scenario | Source → Target | Status | Document |
|---|---|---|---|---|
| SCN-001 | Customer Master Synchronization | Legacy CRM → Modern ERP | **Implemented** | [SCN-001](SCN-001-customer-master-sync.md) |
| SCN-002 | Sales Order Integration | Legacy CRM → Modern ERP | **Implemented** | [SCN-002](SCN-002-sales-order-integration.md) |
| SCN-003 | Customer Update Synchronization | Legacy CRM → Modern ERP | **Implemented** | [SCN-003](SCN-003-customer-update-sync.md) |
| SCN-004 | Retail Item Master Integration | Fictional Merchandising → Fictional WMS | Planned (design only) | [SCN-004](SCN-004-retail-item-master.md) |
| SCN-005 | Purchase Order Integration | Fictional Merchandising → Fictional WMS | Planned (design only) | [SCN-005](SCN-005-purchase-order.md) |

"Planned" scenarios have no running endpoints, UI or tests. They are documented designs only.

## Synthetic seed data

| Record | Purpose |
|---|---|
| CRM C-100, C-200 | Original demo customers; also present in the ERP as **migrated fixtures** (go-live data) |
| CRM C-300 | New customer that exists only in the CRM (SCN-001 create, SCN-003 update). Its name, email and phone need normalizing |
| CRM C-400 | Missing email: validation failure demonstration |
| CRM C-500 | Status OnHold, which maps to ERP `BLOCKED`; its orders are rejected by the ERP |
| CRM ORD-001…012 | Orders for C-100/C-200 (original demo set) |
| CRM ORD-013 | Order for C-300: requires SCN-001 first |
| CRM ORD-014 | JPY order: unsupported currency |
| CRM ORD-015 | Order for C-500: ERP business-rule rejection once C-500 is synchronized as BLOCKED |

Seed records are inserted only when missing, so existing demo data is never overwritten.

## Where things are

| Need | Location |
|---|---|
| Field rules (single source of truth) | `src/Shared/Contracts.cs` → `Mapping`, `MappingCatalog` |
| Execution logic | `src/Hub/Application/IntegrationRunner.cs` |
| Browser-facing lab API | `src/Hub/Api/PortfolioEndpoints.cs` |
| ERP upsert and history | `src/MockErp/Program.cs` |
| In-app walkthroughs | Dashboard → **Guides** |
| Tests | `tests/Hub.Tests/LabTests.cs`, `frontend/e2e/lab.spec.ts` |

## Common error simulations

Any implemented scenario can be run with a simulation. Open **Simulate a failure (optional)** on a Legacy CRM record.

| Simulation | Where | Classification | Automatic retry |
|---|---|---|---|
| Unavailable (503) / ServerError (500) | CRM or ERP | UpstreamUnavailable | Yes, up to 3 attempts |
| RateLimit (429) | CRM or ERP | RateLimited (honours `Retry-After`) | Yes |
| Timeout | CRM or ERP | Timeout | Yes |
| Validation | CRM returns an invalid record | Validation | No |
| BadRequest (400) | CRM or ERP | InvalidRequest | No |
| Duplicate | ERP (orders only) | DuplicateConflict | No |
| Stopped container (`docker compose stop crm`/`erp`) | Infrastructure | Timeout / Connection | Yes |
| Unknown or blocked ERP account | ERP business rule (422) | MissingCustomer / TargetRejected | No |

After a permanent failure is fixed (data corrected, prerequisite synchronized, service restarted), **Safely retry** starts a new 3-attempt cycle with the same execution ID and frozen payload.
