# SCN-005: Purchase Order Integration

**Status: Planned. Design only.** There are no running endpoints, UI, data or tests for this scenario in the current release.

This is a fictional, independent example. It does not copy any vendor's purchase-order payloads or employer implementations.

## Business context
Purchase orders raised in the fictional Merchandising System must reach the fictional WMS, so the warehouse can expect deliveries (advance receiving) and confirm them.

## Business prerequisites
- Every item on the PO exists in the WMS ([SCN-004](SCN-004-retail-item-master.md)).
- Supplier and warehouse (site) codes are known to the WMS.
- A PO is immutable once sent. Changes would be a versioned amendment message, not a silent overwrite (same principle as SCN-002).

## Proposed nested mapping
| Source | Rule | Target |
|---|---|---|
| poNumber | copy | purchaseOrderRef (idempotency key) |
| supplierId | lookup | vendorCode |
| warehouse | lookup | siteCode |
| expectedDelivery | ISO date, must be today or later | expectedDate |
| lines[].lineNo | copy | lines[].lineRef |
| lines[].sku | must exist in the WMS | lines[].itemCode |
| lines[].quantity | integer > 0, converted to the item's base unit | lines[].expectedQty |

## Proposed validation and confirmation
- Header and line validation report errors as `lines[2].sku`, etc.
- Missing items → permanent `MissingItem`, with guidance to run SCN-004, like SCN-002's `MissingCustomer`.
- The WMS returns an import confirmation with accepted lines. Partial acceptance is out of scope; the whole PO is accepted or rejected.

## Why it is not in this release
Nested mapping, a new pair of systems and confirmation messaging would double the surface area. The CRM-to-ERP scenarios were prioritised to be complete and tested first.
