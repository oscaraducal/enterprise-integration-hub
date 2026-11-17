import { Component, computed, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { Api, SessionEnded, errorText } from './api';
import { Column, DataTableComponent, ModalComponent } from './ui';

export type SystemId = 'crm' | 'erp';
export type FieldType = 'string' | 'integer' | 'decimal' | 'boolean' | 'date' | 'datetime' | 'enum' | 'json';
export interface FieldDef { name: string; type: FieldType; required?: boolean; key?: boolean; values?: string[]; note?: string }
export interface TableDef {
  name: string; title: string; description: string; fields: FieldDef[];
  /** Read-only gateway route (relative to /api/) that lists the table's rows; null when rows are only shown per record. */
  browse: string | null; browseNote?: string;
}
export interface EndpointDef {
  method: 'GET' | 'POST' | 'PUT'; path: string; description: string;
  access: 'Viewer' | 'Operator' | 'Middleware only';
  /** Read-only gateway route the explorer may call, with {param} placeholders. */
  gateway?: string;
}
export interface SystemDef { id: SystemId; name: string; tables: TableDef[]; endpoints: EndpointDef[] }

/**
 * Built-in schema and REST contract of each fictional application. Milestone A documents the existing,
 * hard-coded tables; the metadata-driven catalog (user-defined tables) arrives with the Dynamic Data Catalog.
 */
export const SYSTEMS: Record<SystemId, SystemDef> = {
  crm: {
    id: 'crm', name: 'Legacy CRM',
    tables: [
      { name: 'customers', title: 'Customers', browse: 'source/customers',
        description: 'Customer master owned by the CRM. Every edit increments the version and stores a revision.',
        fields: [
          { name: 'customerId', type: 'string', required: true, key: true, note: 'e.g. C-300' },
          { name: 'customerName', type: 'string', required: true },
          { name: 'email', type: 'string', note: 'Optional in the CRM, required by the ERP' },
          { name: 'phone', type: 'string' },
          { name: 'status', type: 'enum', required: true, values: ['Active', 'Inactive', 'OnHold'] },
          { name: 'version', type: 'integer', required: true, note: 'Increments on every change' },
          { name: 'updatedAt', type: 'datetime' }] },
      { name: 'sales_orders', title: 'Sales orders', browse: 'source/orders',
        description: 'Sales orders captured in the CRM. Each references a customer.',
        fields: [
          { name: 'id', type: 'string', required: true, key: true, note: 'e.g. ORD-013' },
          { name: 'customerId', type: 'string', required: true, note: 'References customers.customerId' },
          { name: 'currency', type: 'string', required: true, note: 'ISO 4217 code' },
          { name: 'amount', type: 'decimal', required: true, note: 'Major units, e.g. 410.25' }] },
      { name: 'customer_revisions', title: 'Customer revisions', browse: null,
        browseNote: 'Revisions are shown inside each customer\'s record details.',
        description: 'Immutable snapshot of a customer at each version.',
        fields: [
          { name: 'id', type: 'integer', required: true, key: true },
          { name: 'customerId', type: 'string', required: true },
          { name: 'version', type: 'integer', required: true },
          { name: 'snapshot', type: 'json', required: true },
          { name: 'changedAt', type: 'datetime', required: true }] },
    ],
    endpoints: [
      { method: 'GET', path: '/api/customers', description: 'List all customers.', access: 'Viewer', gateway: 'source/customers' },
      { method: 'GET', path: '/api/customers/{id}', description: 'Get one customer (the gateway also returns its revisions).', access: 'Viewer', gateway: 'source/customers/{id}' },
      { method: 'GET', path: '/api/customers/{id}/revisions', description: 'Revision history, newest first.', access: 'Viewer' },
      { method: 'POST', path: '/api/customers', description: 'Create a customer (version 1).', access: 'Operator' },
      { method: 'PUT', path: '/api/customers/{id}', description: 'Update a customer; a real change increments the version.', access: 'Operator' },
      { method: 'GET', path: '/api/orders', description: 'List all sales orders.', access: 'Viewer', gateway: 'source/orders' },
      { method: 'GET', path: '/api/orders/{id}', description: 'Get one sales order.', access: 'Viewer', gateway: 'source/orders/{id}' },
      { method: 'POST', path: '/api/orders', description: 'Create a sales order.', access: 'Operator' },
      { method: 'PUT', path: '/api/orders/{id}', description: 'Update a sales order.', access: 'Operator' },
    ]
  },
  erp: {
    id: 'erp', name: 'Modern ERP',
    tables: [
      { name: 'customer_master', title: 'Customer master', browse: 'target/customers',
        description: 'ERP accounts. Imported records are owned by the integration; migrated fixtures are synthetic.',
        fields: [
          { name: 'accountCode', type: 'string', required: true, key: true },
          { name: 'displayName', type: 'string', required: true },
          { name: 'emailAddress', type: 'string', required: true },
          { name: 'contactNumber', type: 'string' },
          { name: 'accountStatus', type: 'enum', required: true, values: ['ACTIVE', 'INACTIVE', 'BLOCKED'] },
          { name: 'origin', type: 'enum', required: true, values: ['Fixture', 'Import'] },
          { name: 'sourceSystem', type: 'string' }, { name: 'sourceReference', type: 'string', note: 'Source record ID' },
          { name: 'sourceVersion', type: 'integer', note: 'Highest applied source version' },
          { name: 'lastExecutionId', type: 'string' }, { name: 'lastSyncedAt', type: 'datetime' },
          { name: 'createdAt', type: 'datetime', required: true }, { name: 'updatedAt', type: 'datetime', required: true }] },
      { name: 'imported_orders', title: 'Imported sales orders', browse: 'target/orders',
        description: 'Mapped orders accepted exactly once, with the receipt and the delivering execution.',
        fields: [
          { name: 'externalOrderId', type: 'string', required: true, key: true, note: 'Source order ID' },
          { name: 'receiptId', type: 'string', required: true },
          { name: 'accountCode', type: 'string' }, { name: 'currencyCode', type: 'string' },
          { name: 'totalMinorUnits', type: 'integer', note: 'e.g. 41025 = 410.25' },
          { name: 'executionId', type: 'string' }, { name: 'sourceSystem', type: 'string' },
          { name: 'acceptedAt', type: 'datetime', required: true }] },
      { name: 'customer_history', title: 'Import history', browse: 'target/history',
        description: 'Audit of every create, update, unchanged, stale skip and fixture edit, with before/after values.',
        fields: [
          { name: 'id', type: 'integer', required: true, key: true },
          { name: 'accountCode', type: 'string', required: true },
          { name: 'action', type: 'enum', required: true, values: ['Created', 'Updated', 'Unchanged', 'SkippedStale', 'FixtureEdit', 'FixtureSeeded'] },
          { name: 'executionId', type: 'string' }, { name: 'sourceVersion', type: 'integer' },
          { name: 'changedFields', type: 'string', required: true },
          { name: 'before', type: 'json' }, { name: 'after', type: 'json', required: true },
          { name: 'note', type: 'string' }, { name: 'actor', type: 'string', required: true },
          { name: 'at', type: 'datetime', required: true }] },
    ],
    endpoints: [
      { method: 'GET', path: '/api/customers', description: 'List customer master accounts.', access: 'Viewer', gateway: 'target/customers' },
      { method: 'GET', path: '/api/customers/{code}', description: 'Get one account with its last 50 history entries.', access: 'Viewer', gateway: 'target/customers/{code}' },
      { method: 'PUT', path: '/api/customers/{code}', description: 'Integration upsert. Headers X-Source-Version and X-Execution-Id; older versions are skipped.', access: 'Middleware only' },
      { method: 'PUT', path: '/api/fixtures/customers/{code}', description: 'Hand-edit a migrated fixture (audited as FixtureEdit).', access: 'Operator' },
      { method: 'GET', path: '/api/orders', description: 'List imported sales orders.', access: 'Viewer', gateway: 'target/orders' },
      { method: 'GET', path: '/api/orders/{id}', description: 'Get one imported order.', access: 'Viewer', gateway: 'target/orders/{id}' },
      { method: 'POST', path: '/api/orders', description: 'Idempotent order import: same payload returns the original receipt, a changed payload is 409.', access: 'Middleware only' },
      { method: 'GET', path: '/api/history?take=', description: 'Import history across all accounts, newest first (max 200).', access: 'Viewer', gateway: 'target/history' },
    ]
  }
};

const CELL_KINDS: Partial<Record<FieldType, Column['kind']>> = { datetime: 'date', decimal: 'money' };

/** Data Tables (schema catalog + record browser) and API Explorer for one fictional application. */
@Component({
  selector: 'app-system-catalog', standalone: true, imports: [CommonModule, FormsModule, MatButtonModule, DataTableComponent, ModalComponent],
  template: `
  @if (mode() === 'tables') {
    <div class="catalog-layout">
      <section class="panel catalog-list" [attr.aria-label]="system().name + ' tables'">
        <div class="section-heading"><h2>Tables</h2><span class="muted">{{system().tables.length}} built-in</span></div>
        <ul>@for (t of system().tables; track t.name) {
          <li><button type="button" [class.active]="table().name === t.name" (click)="selectTable(t)"><code>{{t.name}}</code><small>{{t.fields.length}} fields · {{t.title}}</small></button></li>
        }</ul>
        <p class="hint catalog-note">Built-in tables are read-only here. User-defined tables are planned for the Dynamic Data Catalog milestone.</p>
      </section>
      <div class="catalog-main">
        <section class="panel" [attr.aria-label]="'Schema of ' + table().name">
          <div class="section-heading"><div><span class="eyebrow">SCHEMA · {{system().name | uppercase}}</span><h2><code>{{table().name}}</code></h2><p class="hint">{{table().description}}</p></div>
            <span class="pill Pending">Primary key: {{primaryKey()}}</span></div>
          <div class="table-scroll" tabindex="0" role="region" [attr.aria-label]="table().name + ' schema table, scrolls horizontally'">
            <table><thead><tr><th scope="col">Field</th><th scope="col">Type</th><th scope="col">Required</th><th scope="col">Notes</th></tr></thead>
              <tbody>@for (f of table().fields; track f.name) {
                <tr><td><code>{{f.name}}</code>@if (f.key) { <small>primary key</small> }</td><td><span class="type-tag">{{f.type}}</span></td>
                  <td>{{f.required ? 'Yes' : 'No'}}</td><td class="wrap">{{f.values ? f.values.join(' | ') : ''}}{{f.values && f.note ? ' · ' : ''}}{{f.note || ''}}</td></tr>
              }</tbody></table></div>
        </section>
        <section class="panel" [attr.aria-label]="'Records in ' + table().name">
          <div class="section-heading"><h2>Records</h2>@if (table().browse) { <code class="muted">GET /api/{{table().browse}}</code> }</div>
          @if (error()) { <p class="inline-warning" role="status">{{error()}}</p> }
          @if (table().browse) {
            <app-data-table [rows]="rows()" [columns]="columns()" [label]="table().title" [trackKey]="keyOf" [openLabel]="openLabel" [loading]="loading()" (open)="record.set($event)"></app-data-table>
          } @else { <p class="hint pad">{{table().browseNote}}</p> }
        </section>
      </div>
    </div>
    @if (record(); as r) {
      <app-modal [label]="'Record ' + keyOf(r)" [heading]="keyOf(r)" [eyebrow]="table().name | uppercase" (close)="record.set(null)">
        <dl class="record-dl">@for (f of table().fields; track f.name) { <dt>{{f.name}}</dt><dd>{{display(r[f.name])}}</dd> }</dl>
        <h3>Raw JSON</h3><pre tabindex="0" aria-label="Record JSON">{{r | json}}</pre>
      </app-modal>
    }
  } @else {
    <section class="panel" [attr.aria-label]="system().name + ' API'">
      <div class="section-heading"><div><h2>{{system().name}} REST API</h2>
        <p class="hint">The browser never calls the {{system().name}} directly. Read-only requests go through the Integration Hub gateway, which adds the service key server-side. Write operations are listed for reference and are performed through the application screens or by the middleware.</p></div></div>
      <ul class="endpoint-list">
        @for (e of system().endpoints; track e.method + e.path) {
          <li class="endpoint" [class.open]="selected() === e">
            <button type="button" class="endpoint-head" (click)="selectEndpoint(e)" [attr.aria-expanded]="selected() === e">
              <span [class]="'method ' + e.method">{{e.method}}</span><code>{{e.path}}</code><span class="endpoint-desc">{{e.description}}</span>
              <span class="access" [class.locked]="e.access !== 'Viewer'">{{e.access}}</span></button>
            @if (selected() === e) {
              <div class="endpoint-body">
                @if (e.gateway) {
                  <form class="try-form" (ngSubmit)="send(e)">
                    @for (p of params(e); track p) { <label>{{p}}<input [name]="p" [(ngModel)]="paramValues[p]" maxlength="60" required [placeholder]="e.gateway!.includes('orders') ? 'ORD-001' : 'C-100'"></label> }
                    <button mat-flat-button type="submit" [disabled]="busy()">Send request</button>
                    <code class="muted">GET /api/{{resolved(e)}}</code>
                  </form>
                  @if (response(); as r) {
                    <p class="response-line"><span [class]="'pill ' + (r.ok ? 'Completed' : 'Failed')">{{r.status}}</span> {{r.ms}} ms</p>
                    <pre tabindex="0" aria-label="Response body" class="response-body">{{r.body}}</pre>
                  }
                } @else {
                  <p class="hint">{{e.access === 'Middleware only' ? 'Called only by the Integration Hub during an execution, with the service key. Not exposed to the browser.' : 'Use the ' + system().name + ' screens (create and edit forms) as an Operator. Writes are not sent from the explorer.'}}</p>
                }
              </div>
            }
          </li>
        }
      </ul>
    </section>
  }`
})
export class SystemCatalogComponent {
  api = input.required<Api>();
  system = input.required<SystemDef>();
  mode = input<'tables' | 'api'>('tables');
  table = signal<TableDef>(SYSTEMS.crm.tables[0]);
  rows = signal<any[]>([]); loading = signal(false); error = signal(''); record = signal<any | null>(null);
  selected = signal<EndpointDef | null>(null); busy = signal(false);
  response = signal<{ status: number; ok: boolean; ms: number; body: string } | null>(null);
  paramValues: Record<string, string> = {};
  primaryKey = computed(() => this.table().fields.filter(f => f.key).map(f => f.name).join(', '));
  columns = computed<Column[]>(() => this.table().fields.filter(f => f.type !== 'json').slice(0, 6)
    .map(f => ({ key: f.name, label: f.name, kind: f.key ? 'code' : CELL_KINDS[f.type] ?? 'text' })));
  keyOf = (row: any) => String(this.table().fields.filter(f => f.key).map(f => row?.[f.name]).join(' / '));
  openLabel = (row: any) => `Open ${this.table().name} record ${this.keyOf(row)}`;
  ngOnInit() { void this.selectTable(this.system().tables[0]); }
  async selectTable(t: TableDef) {
    this.table.set(t); this.rows.set([]); this.error.set(''); this.record.set(null);
    if (!t.browse) return;
    this.loading.set(true);
    try { const rows = await this.api().request<any[]>(t.browse); if (this.table() === t) this.rows.set(rows); }
    catch (e) { if (!(e instanceof SessionEnded)) this.error.set(errorText(e)); }
    finally { this.loading.set(false); }
  }
  selectEndpoint(e: EndpointDef) { this.selected.set(this.selected() === e ? null : e); this.response.set(null); }
  params(e: EndpointDef) { return [...(e.gateway ?? '').matchAll(/\{(\w+)\}/g)].map(m => m[1]); }
  resolved(e: EndpointDef) {
    return (e.gateway ?? '').replace(/\{(\w+)\}/g, (_, p) => encodeURIComponent((this.paramValues[p] ?? '').trim()) || `{${p}}`);
  }
  async send(e: EndpointDef) {
    if (this.params(e).some(p => !(this.paramValues[p] ?? '').trim())) return;
    this.busy.set(true); const started = performance.now();
    try {
      const body = await this.api().request<unknown>(this.resolved(e));
      this.response.set({ status: 200, ok: true, ms: Math.round(performance.now() - started), body: JSON.stringify(body, null, 2) });
    } catch (err) {
      if (err instanceof SessionEnded) return;
      const status = (err as any)?.status ?? 0;
      this.response.set({ status, ok: false, ms: Math.round(performance.now() - started), body: errorText(err) });
    } finally { this.busy.set(false); }
  }
  display(v: unknown) { return v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v); }
}
