import { Focus } from './api';

export interface GuideStep { text: string; detail?: string; go?: Focus; label?: string }
export interface ScenarioDef {
  id: string; title: string; status: 'Implemented' | 'Planned';
  source: string; target: string; businessCase: string; objective: string;
  requirements: string[]; fields: [string, string][]; samples: string[];
  verify: string[]; steps: GuideStep[]; doc: string;
}
const DOCS = 'https://github.com/oscaraducal/enterprise-integration-hub/blob/feature/integration-portfolio-lab/docs/scenarios/';

export const SCENARIOS: ScenarioDef[] = [
  {
    id: 'SCN-001', title: 'Customer Master Synchronization', status: 'Implemented',
    source: 'Legacy CRM · Customers', target: 'Modern ERP · Customer master',
    businessCase: 'Customer master records maintained in the Legacy CRM must exist in the Modern ERP before orders can be imported.',
    objective: 'Validate a CRM customer, transform it to the ERP schema and create or update the ERP account without duplicates.',
    requirements: ['Customer ID, name and email are required.', 'Phone is normalized to digits with an optional leading +.',
      'CRM status maps to an ERP account status (OnHold → BLOCKED).', 'One ERP account per customer ID, recorded with source reference, version and sync time.'],
    fields: [['customerId', 'accountCode'], ['customerName', 'displayName'], ['email', 'emailAddress'], ['phone', 'contactNumber'], ['status', 'accountStatus']],
    samples: ['C-300: new customer, not yet in ERP', 'C-400: missing email → validation failure', 'C-500: OnHold → BLOCKED account'],
    verify: ['Execution reaches Completed with outcome Created.', 'Modern ERP shows C-300 with Origin Imported, source version and execution link.', 'Compare with source shows every mapped field matching.'],
    doc: DOCS + 'SCN-001-customer-master-sync.md',
    steps: [
      { text: 'Open the Legacy CRM and select customer C-300.', detail: 'It exists only in the source system.', go: { view: 'Source System', kind: 'customer', id: 'C-300' }, label: 'Open C-300' },
      { text: 'Open the Mapping Studio for C-300 and inspect the five field rules.', go: { view: 'Mapping Studio', kind: 'customer', id: 'C-300' }, label: 'Open mapper' },
      { text: 'Click Preview mapping. The name is trimmed, the email lower-cased and the phone normalized. Nothing is written.' },
      { text: 'Click Run this integration (or Sync to Modern ERP in the CRM).', detail: 'Operator role required.' },
      { text: 'Follow the execution: Queued → Started → Retrieved → Mapped → Completed (Created).' },
      { text: 'Open the Modern ERP customer master and select C-300.', go: { view: 'Target System', kind: 'customer', id: 'C-300' }, label: 'Open ERP' },
      { text: 'Use Compare with source and check every row is ✓. Its history shows a Created entry linked to the execution.' },
      { text: 'Optional failure: sync C-400. It fails at Validation because email is required by the ERP.', go: { view: 'Source System', kind: 'customer', id: 'C-400' }, label: 'Open C-400' },
    ]
  },
  {
    id: 'SCN-002', title: 'Sales Order Integration', status: 'Implemented',
    source: 'Legacy CRM · Sales orders', target: 'Modern ERP · Imported orders',
    businessCase: 'Sales orders captured in the Legacy CRM must be imported into the Modern ERP exactly once.',
    objective: 'Retrieve an order, convert its amount to minor units, deliver it idempotently and store the mapped order in the ERP.',
    requirements: ['Currency must be USD, PHP or EUR.', 'Amount 125.50 becomes 12550 minor units (round half away from zero).',
      'The ERP account must exist and be ACTIVE. New customers need SCN-001 first.', 'The first valid mapping is frozen; retries never change it.'],
    fields: [['id', 'externalOrderId'], ['customerId', 'accountCode'], ['currency', 'currencyCode'], ['amount', 'totalMinorUnits']],
    samples: ['ORD-001…012: customers C-100/C-200 (migrated)', 'ORD-013: customer C-300 → needs SCN-001 first', 'ORD-014: JPY → unsupported currency', 'ORD-015: C-500 → rejected while BLOCKED'],
    verify: ['Execution Completed with an ERP receipt.', 'Modern ERP imported order shows accountCode, currencyCode and totalMinorUnits.', 'Resubmitting the same order is rejected as already tracked.'],
    doc: DOCS + 'SCN-002-sales-order-integration.md',
    steps: [
      { text: 'Open the Legacy CRM sales orders and select ORD-013 (customer C-300).', go: { view: 'Source System', kind: 'order', id: 'ORD-013' }, label: 'Open ORD-013' },
      { text: 'Open the Mapping Studio and preview the order mapping (410.25 USD → 41025).', go: { view: 'Mapping Studio', kind: 'order', id: 'ORD-013' }, label: 'Open mapper' },
      { text: 'Run the integration. If C-300 is not yet in the ERP, it fails as MissingCustomer at target delivery, with guidance.' },
      { text: 'Run SCN-001 for C-300 (Legacy CRM → Sync to Modern ERP).', go: { view: 'Source System', kind: 'customer', id: 'C-300' }, label: 'Open C-300' },
      { text: 'Back on the failed ORD-013 execution, click Safely retry. The frozen payload is reused and the order completes.', go: { view: 'Executions' }, label: 'Executions' },
      { text: 'Open the Modern ERP imported orders and select ORD-013.', go: { view: 'Target System', kind: 'order', id: 'ORD-013' }, label: 'Open ERP' },
      { text: 'Compare with source: externalOrderId, accountCode, currencyCode and totalMinorUnits all match ✓.' },
      { text: 'Try ORD-014 (JPY): it fails at Validation and never reaches the ERP.', go: { view: 'Source System', kind: 'order', id: 'ORD-014' }, label: 'Open ORD-014' },
    ]
  },
  {
    id: 'SCN-003', title: 'Customer Update Synchronization', status: 'Implemented',
    source: 'Legacy CRM · Edited customer', target: 'Modern ERP · Existing customer',
    businessCase: 'Customer details change in the Legacy CRM and the existing ERP account must be updated, not duplicated.',
    objective: 'Apply a controlled upsert: update changed fields, record before/after values, and never let an older version overwrite a newer one.',
    requirements: ['Every CRM edit increments the customer version and stores a revision.', 'ERP applies a version only if it is the same or newer than the one it holds.',
      'Identical data is recorded as Unchanged (idempotent).', 'Changed fields and before/after values are kept in the ERP history.'],
    fields: [['customerName', 'displayName'], ['email', 'emailAddress'], ['phone', 'contactNumber'], ['status', 'accountStatus']],
    samples: ['C-300 after SCN-001: edit email or name', 'C-100: migrated fixture, the first sync links it to the integration'],
    verify: ['ERP history shows Updated with only the changed fields.', 'Compare with source shows the new values.', 'Re-running the same version reports Unchanged.'],
    doc: DOCS + 'SCN-003-customer-update-sync.md',
    steps: [
      { text: 'Make sure C-300 exists in the ERP (run SCN-001 first).', go: { view: 'Guides', scenario: 'SCN-001' }, label: 'SCN-001 guide' },
      { text: 'In the Legacy CRM, edit C-300: change the email and phone. The version increases and a revision is stored.', go: { view: 'Source System', kind: 'customer', id: 'C-300' }, label: 'Edit C-300' },
      { text: 'Compare the original and modified source records in the revision history.' },
      { text: 'Preview the mapped update in the Mapping Studio.', go: { view: 'Mapping Studio', kind: 'customer', id: 'C-300' }, label: 'Open mapper' },
      { text: 'Click Sync to Modern ERP. The execution completes with "updated … emailAddress, contactNumber".' },
      { text: 'Open C-300 in the Modern ERP. History shows Updated with before → after values, and the execution ID.', go: { view: 'Target System', kind: 'customer', id: 'C-300' }, label: 'Open ERP' },
      { text: 'Sync again without editing: the outcome is Unchanged, and no duplicate record is created.' },
    ]
  },
  {
    id: 'SCN-004', title: 'Retail Item Master Integration', status: 'Planned',
    source: 'Fictional Merchandising System', target: 'Fictional Warehouse Management System',
    businessCase: 'Item master data (SKU, description, barcode, unit of measure, status) must be available in the warehouse before receiving stock.',
    objective: 'Planned: validate barcodes and units of measure and upsert items by SKU. Not implemented in this release.',
    requirements: ['Barcode check-digit validation', 'Unit-of-measure lookup', 'SKU-keyed upsert like SCN-003'],
    fields: [['sku', 'itemCode'], ['description', 'itemDescription'], ['barcode', 'gtin'], ['uom', 'baseUnit'], ['status', 'itemStatus']],
    samples: ['Design only: no running endpoints'], verify: ['Planned'], steps: [], doc: DOCS + 'SCN-004-retail-item-master.md'
  },
  {
    id: 'SCN-005', title: 'Purchase Order Integration', status: 'Planned',
    source: 'Fictional Merchandising System', target: 'Fictional Warehouse Management System',
    businessCase: 'Purchase orders must reach the warehouse so it can expect and receive deliveries.',
    objective: 'Planned: nested line mapping, item and supplier prerequisites, import confirmation. Not implemented in this release.',
    requirements: ['Header and line mapping', 'Items (SCN-004) must exist first', 'Confirmation back to the source'],
    fields: [['poNumber', 'purchaseOrderRef'], ['supplierId', 'vendorCode'], ['warehouse', 'siteCode'], ['lines[].sku', 'lines[].itemCode'], ['lines[].qty', 'lines[].expectedQty']],
    samples: ['Design only: no running endpoints'], verify: ['Planned'], steps: [], doc: DOCS + 'SCN-005-purchase-order.md'
  }
];

export const GLOSSARY: [string, string][] = [
  ['Source system', 'The application that owns the data being sent. Here: the fictional Legacy CRM.'],
  ['Target system', 'The application that receives the data. Here: the fictional Modern ERP.'],
  ['Transformation / mapping', 'Rules that convert source fields into the target format, e.g. 125.50 USD → 12550 minor units.'],
  ['Execution ID', 'A unique ID for one integration run. Every log entry and ERP import refers to it, so you can trace a record end to end.'],
  ['Retry', 'Trying again after a temporary failure (timeout, 429, 503). Automatic retries are limited to 3 attempts; permanent failures need a person.'],
  ['Idempotency', 'Sending the same thing twice has the same effect as sending it once. The ERP returns the original receipt instead of creating a duplicate.'],
  ['Upsert', 'Create the record if it is missing, otherwise update it. Used for mutable customer data (SCN-001/003).'],
  ['Reconciliation', 'Comparing source and target records to prove they match. See Compare with source in the Modern ERP page.'],
  ['Fixture', 'A synthetic record placed in the target for demonstration (here: migrated at go-live). Only fixtures may be edited by hand.'],
];

/** The integration pipeline shown across the lab. */
export const PIPELINE = ['Source record', 'REST retrieval', 'Validation', 'Field mapping', 'Target delivery', 'Imported record', 'Execution monitoring'];
