import { Focus } from './api';

export interface GuideStep { text: string; detail?: string; go?: Focus; label?: string }
export interface ScenarioDef {
  id: string; title: string; status: 'Implemented' | 'Design only' | 'Planned';
  source: string; target: string; businessCase: string; objective: string;
  requirements: string[]; fields: [string, string][]; samples: string[];
  verify: string[]; steps: GuideStep[]; doc: string;
}
const DOCS = 'https://github.com/oscaraducal/enterprise-integration-hub/blob/feature/integration-portfolio-lab/docs/scenarios/';
const DESIGNER_DOC = 'https://github.com/oscaraducal/enterprise-integration-hub/blob/feature/visual-integration-workbench/docs/designer/README.md';

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
      { text: 'Start the integration from the middleware: click Run this integration, or use the run console (SCN-001/003 · Customer sync, C-300).', detail: 'Operator role required. The CRM itself has no integration buttons: the Integration Hub initiates every import.', go: { view: 'Executions', kind: 'customer', id: 'C-300', run: true }, label: 'Run console' },
      { text: 'Follow the execution: Queued → Started → Retrieved → Mapped → Completed (Created).' },
      { text: 'Open the Modern ERP customer master and select C-300.', go: { view: 'Target System', kind: 'customer', id: 'C-300' }, label: 'Open ERP' },
      { text: 'Use Compare with source and check every row is ✓. Its history shows a Created entry linked to the execution.' },
      { text: 'Optional failure: run the customer sync for C-400. It fails at Validation because the ERP requires an email.', go: { view: 'Executions', kind: 'customer', id: 'C-400', run: true }, label: 'Run C-400' },
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
      { text: 'Run ORD-013 from the run console. If C-300 is not yet in the ERP, it fails as MissingCustomer at target delivery, with guidance.', go: { view: 'Executions', kind: 'order', id: 'ORD-013', run: true }, label: 'Run ORD-013' },
      { text: 'Run SCN-001 for C-300 from the run console (Customer sync).', go: { view: 'Executions', kind: 'customer', id: 'C-300', run: true }, label: 'Run C-300' },
      { text: 'Back on the failed ORD-013 execution, click Safely retry. The frozen payload is reused and the order completes.', go: { view: 'Executions' }, label: 'Executions' },
      { text: 'Open the Modern ERP imported orders and select ORD-013.', go: { view: 'Target System', kind: 'order', id: 'ORD-013' }, label: 'Open ERP' },
      { text: 'Compare with source: externalOrderId, accountCode, currencyCode and totalMinorUnits all match ✓.' },
      { text: 'Try ORD-014 (JPY): it fails at Validation and never reaches the ERP.', go: { view: 'Executions', kind: 'order', id: 'ORD-014', run: true }, label: 'Run ORD-014' },
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
      { text: 'Run the customer sync for C-300 from the run console. The execution completes with "updated … emailAddress, contactNumber".', go: { view: 'Executions', kind: 'customer', id: 'C-300', run: true }, label: 'Run C-300' },
      { text: 'Open C-300 in the Modern ERP. History shows Updated with before → after values, and the execution ID.', go: { view: 'Target System', kind: 'customer', id: 'C-300' }, label: 'Open ERP' },
      { text: 'Run the sync again without editing: the outcome is Unchanged, and no duplicate record is created.' },
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
  },
  {
    id: 'DSN-001', title: 'Design the customer master flow', status: 'Design only',
    source: 'Legacy CRM · customers', target: 'Modern ERP · customer_master',
    businessCase: 'Rebuild SCN-001 visually: an integration developer composes the flow from actions instead of relying on built-in code.',
    objective: 'Create the flow from a template, inspect each action, re-map a field by drag-and-drop, validate, save a draft and publish version 1.',
    requirements: ['Invoke reads one CRM customer by $trigger.customerId.', 'A Switch raises MissingEmail when the email is empty.',
      'Map applies the SCN-001 rules; Invoke upserts erp.customer_master.', 'The global fault handler logs and returns CustomerSyncFailed.'],
    fields: [['customerId', 'accountCode'], ['customerName', 'displayName'], ['email', 'emailAddress'], ['phone', 'contactNumber'], ['status', 'accountStatus']],
    samples: ['Trigger sample: customerId = C-300', 'Template: "Legacy CRM customer → Modern ERP customer"'],
    verify: ['The toolbar shows Valid; Problems lists only warnings (the ERP write that happens once runs exist, and the optional CRM email feeding a required ERP field).',
      'Versions shows v1; editing the draft afterwards never changes v1.', 'Executions shows no new run: designing never calls the ERP.'],
    doc: DESIGNER_DOC,
    steps: [
      { text: 'In the Integration Workbench, open Integrations and click Create integration (Operator).', go: { view: 'Integrations' }, label: 'Open Integrations' },
      { text: 'Choose Manual practice, name it "Customer Sync" (identifier CUSTOMER_SYNC), then pick the starter template "Legacy CRM customer → Modern ERP customer".', detail: 'Blank is the default; templates are an explicit, optional choice.' },
      { text: 'Select readCustomer. It is an Invoke: crm.customers, operation get, key $trigger.customerId. Only list and get exist for the CRM.' },
      { text: 'Select checkEmail. Its case "Email missing" holds a Throw New Fault; Otherwise continues.' },
      { text: 'Select mapCustomer and click Open field mapper. Remove contactNumber, then drag phone onto contactNumber. Click Preview to see real CRM values transformed, then Apply.' },
      { text: 'Watch the Problems tab: it updates as you edit. Click a problem to jump to its action.' },
      { text: 'Save draft, then Publish. The Versions tab shows v1 with its author and time.' },
      { text: 'Export the version: you get an eih-flow JSON document you can import as a new flow.' },
    ]
  },
  {
    id: 'DSN-002', title: 'Stage a CRM order as an XML file', status: 'Design only',
    source: 'Legacy CRM · sales_orders', target: 'Stage area · order-export.xml',
    businessCase: 'Some partners receive files instead of API calls. The flow maps an order and stages it as XML, separate from ERP delivery.',
    objective: 'Configure a Stage File write with an XML root and record element, and see the sandbox rules for file names.',
    requirements: ['File names are 1-60 safe characters with .xml, .json or .csv; paths are refused.', 'XML needs root and record element names.',
      'Read entire file and List files are designable; segments, zip and encryption are planned.'],
    fields: [['id', 'externalOrderId'], ['customerId', 'accountCode'], ['currency', 'currencyCode'], ['amount', 'totalMinorUnits']],
    samples: ['Trigger sample: orderId = ORD-013', 'Template: "Legacy CRM order → staged XML file"'],
    verify: ['Changing the file name to ../secret.xml shows "Paths are not allowed".', 'Undo restores it and the flow is valid again.'],
    doc: DESIGNER_DOC,
    steps: [
      { text: 'Integrations → Create integration → Manual practice → starter template "Legacy CRM order → staged XML file".', go: { view: 'Integrations' }, label: 'Open Integrations' },
      { text: 'Select writeOrderXml: operation Write file, format xml, root SalesOrders, record SalesOrder, data $mapOrder.' },
      { text: 'Change the file name to ../secret.xml and read the problem; press Undo (Ctrl+Z).' },
      { text: 'Open the Stage File operation list: planned operations are visible but disabled.' },
      { text: 'Open mapOrder in the field mapper and Preview: 410.25 becomes 41025 minor units.' },
      { text: 'Save and publish. Generating the XML file happens when flows run (Milestone D).' },
    ]
  },
  {
    id: 'DSN-003', title: 'Loops, branches, scopes and faults', status: 'Design only',
    source: 'Legacy CRM · sales_orders (list)', target: 'Execution log',
    businessCase: 'Review a batch of orders: iterate, branch on currency, summarize, and handle faults locally with a Scope.',
    objective: 'Practise nested containers, scoped variables, collection functions, the expression builder and fault-handler rules.',
    requirements: ['For Each iterates a collection with a 1-500 item limit; $order exists only inside the loop.',
      'Switch cases are checked top to bottom; Otherwise is last.', 'Re-throw Fault is only valid inside a fault handler.'],
    fields: [['listOrders (collection)', 'order (loop item)'], ['count($listOrders)', 'orderCount'], ["sum($listOrders, 'amount')", 'orderTotal']],
    samples: ['Template: "Review CRM orders (loop and branch)"'],
    verify: ['Referencing $order after the loop shows "unknown variable $order".', 'Re-throw Fault outside a handler is an error; inside a Scope fault handler it is valid.'],
    doc: DESIGNER_DOC,
    steps: [
      { text: 'Integrations → Create integration → Manual practice → starter template "Review CRM orders (loop and branch)".', go: { view: 'Integrations' }, label: 'Open Integrations' },
      { text: 'Collapse eachOrder to see "3 inside", expand it again, and search for logUnsupported.' },
      { text: 'Select logSummary and set its message to $order.id: the Problems tab reports the out-of-scope variable. Undo.' },
      { text: 'Drag a Scope into the main flow, then drag a Throw New Fault into its body and a Re-throw Fault into its fault handler.' },
      { text: 'Drag another Re-throw Fault into the main flow: it is reported as invalid outside a handler. Delete it.' },
      { text: 'Open the expression builder (ƒx) on a Logger, insert $order.currency and a function, then Check syntax.' },
    ]
  },
  {
    id: 'DSN-004', title: 'Build an Application integration from a blank canvas', status: 'Design only',
    source: 'Hub REST trigger + Legacy CRM connection', target: 'Modern ERP connection (customer_master)',
    businessCase: 'An application calls the Hub to synchronize one customer. Practise the full authoring path: connections, trigger, invokes and mapping points.',
    objective: 'Create connections, start from a genuinely empty canvas, configure the REST trigger, add invokes with +, map the request contract and review it in all three layouts.',
    requirements: ['Connections only point at approved internal applications; the Hub resolves addresses and keys.',
      'Invokes are configured with an endpoint wizard and only offer operations the application supports.',
      'A body operation gets an unconfigured request mapping directly before it; changing the operation never deletes rules.'],
    fields: [['$trigger.customerId', 'GET /customers/{customerId} key'], ['$readCustomer.*', 'request mapping → customer_master'], ['customer_master', 'PUT /customer_master/{accountCode}']],
    samples: ['Connections: LEGACY_CRM_REST, MODERN_ERP_REST (Invoke), HUB_REST_TRIGGER (Trigger)', 'Trigger: POST /accounts/{customerId}'],
    verify: ['A new Application integration shows only Start and +.', 'The request mapping is listed as Unconfigured in Outline until fields are mapped.',
      'Switching layouts never marks the draft as changed.'],
    doc: DESIGNER_DOC,
    steps: [
      { text: 'In Connections, create LEGACY_CRM_REST and MODERN_ERP_REST (role Invoke) and HUB_REST_TRIGGER (role Trigger, Integration Hub REST trigger). Test each one.', go: { view: 'Connections' }, label: 'Connections' },
      { text: 'Integrations → Create integration → Application → name "Account Sync" → Create. The full-screen Designer opens with only the Start trigger and a +.', go: { view: 'Integrations' }, label: 'Open Integrations' },
      { text: 'Click Configure trigger…: choose HUB_REST_TRIGGER, POST /accounts/{customerId}, request crm.customers, response erp.customer_master.' },
      { text: 'Click + below Start → Connections / Invokes → Invoke Legacy CRM REST → GET /customers/{customerId} with key $trigger.customerId.' },
      { text: 'Click + below it → Invoke Modern ERP REST → PUT /customer_master/{accountCode}. A request mapping appears before the Invoke; set its source and open the field mapper.' },
      { text: 'Edit the ERP endpoint to a GET operation and read the impact dialog: the mapping is kept and flagged, never deleted. Undo to restore.' },
      { text: 'Switch between Vertical, Horizontal and Outline. Outline shows connection, operation, schema, mapping status and validation per action.' },
    ]
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
  ['Orchestration flow', 'An ordered set of actions (invoke, assign, map, branch, loop…) designed in the Integration Designer.'],
  ['Draft and published version', 'The draft is editable; publishing a valid draft stores an immutable numbered version.'],
  ['Expression', 'A safe formula such as concat($a, \'-\', upper($b)). It is parsed and checked, never executed as code.'],
  ['Connection', 'A reusable, tested link to an approved internal application with a role (Trigger or Invoke). The Hub keeps its address and credentials.'],
  ['Mapping point', 'Where a mapping belongs: before an Invoke\'s request, after its response, before Return for a trigger response, or before a Stage File write.'],
];

/** The integration pipeline shown across the lab. */
export const PIPELINE = ['Source record', 'REST retrieval', 'Validation', 'Field mapping', 'Target delivery', 'Imported record', 'Execution monitoring'];
