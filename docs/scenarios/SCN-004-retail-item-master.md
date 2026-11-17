# SCN-004: Retail Item Master Integration

**Status: Planned. Design only.** There are no running endpoints, UI, data or tests for this scenario in the current release.

This is an independent, fictional example of common merchandising-to-warehouse concepts. It does not reproduce Oracle Merchandising Foundation Cloud Service, any WMS product, proprietary payloads, contracts or employer implementations.

## Business context
A fictional Merchandising System owns item master data. A fictional Warehouse Management System (WMS) must know each item before stock can be received, located or picked.

## Proposed systems
| System | Role |
|---|---|
| Fictional Merchandising System | Source: item master |
| Integration Middleware | Same execution, retry and audit model as SCN-001 |
| Fictional WMS | Target: warehouse item records |

## Proposed schemas and mapping
| Source | Rule | Target |
|---|---|---|
| sku | trim, upper-case | itemCode (upsert key) |
| description | trim, max 60 chars (WMS label limit) | itemDescription |
| barcode | digits only; GTIN-8/12/13/14 check-digit validation | gtin |
| unitOfMeasure | lookup EA → EACH, CS → CASE, KG → KILOGRAM | baseUnit |
| status | lookup Active → ENABLED, Discontinued → DISABLED | itemStatus |

## Proposed rules
- Mutable master data: reuse the SCN-003 versioned upsert (never overwrite with an older version).
- An invalid check digit or an unknown unit of measure is a permanent `Validation` failure, reported per field.
- A discontinued item is disabled in the WMS, never deleted.

## Prerequisites before implementation
SCN-001 to SCN-003 stable (done); a new pair of mock services or a module per service; seed data; mapping catalog entries; tests mirroring SCN-001.

## Verification plan
Reconciliation by `itemCode`, same as the ERP customer comparison; check-digit unit tests; e2e create → preview → sync → compare.
