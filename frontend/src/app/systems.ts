import { Component, computed, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { Api, ApiError, SessionEnded, errorText } from './api';
import { Column, DataTableComponent, ModalComponent } from './ui';

export type SystemId = 'crm' | 'erp';
export const COLUMN_TYPES = ['string', 'integer', 'decimal', 'boolean', 'date', 'datetime', 'enum'] as const;
export type ColumnType = typeof COLUMN_TYPES[number];
/** Column metadata from the Data Catalog. readOnly columns are set by the application itself. */
export interface ColumnDef { name: string; type: ColumnType; required?: boolean; values?: string[] | null; description?: string | null; readOnly?: boolean }
export interface TableView {
  name: string; title: string; description?: string | null; primaryKey: string; columns: ColumnDef[];
  version: number; builtIn: boolean; recordCount?: number | null; updatedAt?: string | null;
}
export interface TableVersion { version: number; change: string; changedAt: string; columns: ColumnDef[] }
export interface CatalogRecord { key: string; data: Record<string, unknown>; schemaVersion: number; createdAt: string; updatedAt: string }
export interface RecordPage { items: CatalogRecord[]; total: number; page: number; pageSize: number }
export interface EndpointDef {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'; path: string; description: string;
  access: 'Viewer' | 'Operator' | 'Middleware only';
  /** Read-only gateway route the explorer may call, with {param} placeholders. */
  gateway?: string;
}
export interface SystemDef {
  id: SystemId; name: string; endpoints: EndpointDef[];
  /** Gateway routes listing the rows of each built-in table (served by the application's own API). */
  builtInRows: Record<string, string>;
  /** A ready-made synthetic table an Operator can create in one click (it is only created when they confirm). */
  sample: { name: string; title: string; description: string; primaryKey: string; columns: ColumnDef[] };
}

export const SYSTEMS: Record<SystemId, SystemDef> = {
  crm: {
    id: 'crm', name: 'Legacy CRM',
    builtInRows: { customers: 'source/customers', sales_orders: 'source/orders' },
    sample: { name: 'crm_contacts', title: 'Customer contacts', description: 'People at customer accounts (synthetic).', primaryKey: 'contactId',
      columns: [{ name: 'contactId', type: 'string', required: true }, { name: 'customerId', type: 'string', required: true },
        { name: 'fullName', type: 'string', required: true }, { name: 'email', type: 'string' },
        { name: 'role', type: 'enum', required: true, values: ['Buyer', 'Finance', 'Owner'] }, { name: 'since', type: 'date' }] },
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
      { method: 'GET', path: '/api/catalog/tables', description: 'Data Catalog: every table with its columns, types and keys.', access: 'Viewer', gateway: 'catalog/crm/tables' },
      { method: 'GET', path: '/api/catalog/tables/{name}', description: 'Table metadata and schema version history.', access: 'Viewer', gateway: 'catalog/crm/tables/{name}' },
      { method: 'POST', path: '/api/catalog/tables', description: 'Create a logical table (validated metadata, no SQL).', access: 'Operator' },
      { method: 'POST', path: '/api/catalog/tables/{name}/schema', description: 'Approved schema operation: AddColumn, RemoveColumn, SetRequired, AddEnumValues, UpdateDetails.', access: 'Operator' },
    ]
  },
  erp: {
    id: 'erp', name: 'Modern ERP',
    builtInRows: { customer_master: 'target/customers', imported_orders: 'target/orders' },
    sample: { name: 'erp_vendor_accounts', title: 'Vendor accounts', description: 'Supplier master in the ERP (synthetic).', primaryKey: 'vendorCode',
      columns: [{ name: 'vendorCode', type: 'string', required: true }, { name: 'vendorName', type: 'string', required: true },
        { name: 'contactEmail', type: 'string' }, { name: 'paymentTermsDays', type: 'integer', required: true },
        { name: 'creditLimit', type: 'decimal' }, { name: 'vendorStatus', type: 'enum', required: true, values: ['ACTIVE', 'ON_HOLD', 'CLOSED'] },
        { name: 'preferred', type: 'boolean' }] },
    endpoints: [
      { method: 'GET', path: '/api/customers', description: 'List customer master accounts.', access: 'Viewer', gateway: 'target/customers' },
      { method: 'GET', path: '/api/customers/{code}', description: 'Get one account with its last 50 history entries.', access: 'Viewer', gateway: 'target/customers/{code}' },
      { method: 'PUT', path: '/api/customers/{code}', description: 'Integration upsert. Headers X-Source-Version and X-Execution-Id; older versions are skipped.', access: 'Middleware only' },
      { method: 'PUT', path: '/api/fixtures/customers/{code}', description: 'Hand-edit a migrated fixture (audited as FixtureEdit).', access: 'Operator' },
      { method: 'GET', path: '/api/orders', description: 'List imported sales orders.', access: 'Viewer', gateway: 'target/orders' },
      { method: 'GET', path: '/api/orders/{id}', description: 'Get one imported order.', access: 'Viewer', gateway: 'target/orders/{id}' },
      { method: 'POST', path: '/api/orders', description: 'Idempotent order import: same payload returns the original receipt, a changed payload is 409.', access: 'Middleware only' },
      { method: 'GET', path: '/api/history?take=', description: 'Import history across all accounts, newest first (max 200).', access: 'Viewer', gateway: 'target/history' },
      { method: 'GET', path: '/api/catalog/tables', description: 'Data Catalog: every table with its columns, types and keys.', access: 'Viewer', gateway: 'catalog/erp/tables' },
      { method: 'GET', path: '/api/catalog/tables/{name}', description: 'Table metadata and schema version history.', access: 'Viewer', gateway: 'catalog/erp/tables/{name}' },
      { method: 'POST', path: '/api/catalog/tables', description: 'Create a logical table (validated metadata, no SQL).', access: 'Operator' },
      { method: 'POST', path: '/api/catalog/tables/{name}/schema', description: 'Approved schema operation: AddColumn, RemoveColumn, SetRequired, AddEnumValues, UpdateDetails.', access: 'Operator' },
    ]
  }
};

/** Loads the catalog of one system through the middleware gateway. */
export const loadTables = (api: Api, system: SystemId) => api.request<TableView[]>(`catalog/${system}/tables`);
/** First rows of any table (built-in or logical), used as samples for mapping previews. */
export async function sampleRows(api: Api, system: SystemId, table: TableView, take = 25): Promise<Record<string, unknown>[]> {
  if (table.builtIn) {
    const route = SYSTEMS[system].builtInRows[table.name];
    return route ? (await api.request<Record<string, unknown>[]>(route)).slice(0, take) : [];
  }
  const page = await api.request<RecordPage>(`catalog/${system}/tables/${table.name}/records?page=1&pageSize=${take}`);
  return page.items.map(r => r.data);
}

function toLocalInput(iso: string) {
  const d = new Date(iso); if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
interface TableDraft { name: string; title: string; description: string; primaryKey: string; columns: (ColumnDef & { valuesText: string })[] }
const blankColumn = (): ColumnDef & { valuesText: string } => ({ name: '', type: 'string', required: false, valuesText: '' });

/** Data Tables (metadata-driven catalog, record CRUD, schema operations, contract) and API Explorer for one application. */
@Component({
  selector: 'app-system-catalog', standalone: true, imports: [CommonModule, FormsModule, MatButtonModule, DataTableComponent, ModalComponent],
  template: `
  @if (error()) { <div class="alert error" role="alert">{{error()}} <button (click)="error.set('')" aria-label="Dismiss error">×</button></div> }
  @if (notice()) { <div class="alert success" role="status">{{notice()}} <button (click)="notice.set('')" aria-label="Dismiss notification">×</button></div> }
  @if (mode() === 'tables') {
    <div class="catalog-layout">
      <section class="panel catalog-list" [attr.aria-label]="system().name + ' tables'">
        <div class="section-heading"><h2>Tables</h2><span class="muted">{{tables().length}}</span></div>
        <ul>@for (t of tables(); track t.name) {
          <li><button type="button" [class.active]="table()?.name === t.name" (click)="selectTable(t)"><code>{{t.name}}</code>
            <small>{{t.builtIn ? 'Built-in' : 'Logical · v' + t.version}} · {{t.columns.length}} fields · {{t.recordCount ?? 0}} rows</small></button></li>
        } @empty { <li class="hint pad">{{loading() ? 'Loading…' : 'No tables.'}}</li> }</ul>
        @if (api().operator()) {
          <div class="catalog-actions"><button mat-stroked-button (click)="newTable()">+ New table</button>
            @if (!hasSample()) { <button mat-button (click)="newTable(true)">Use sample schema</button> }</div>
        }
        <p class="hint catalog-note">Built-in tables are read-only here. Logical tables are stored as validated metadata and JSON rows; no SQL is ever generated from input.</p>
      </section>
      @if (table(); as t) {
        <div class="catalog-main">
          <section class="panel" [attr.aria-label]="'Schema of ' + t.name">
            <div class="section-heading"><div><span class="eyebrow">{{t.builtIn ? 'BUILT-IN' : 'LOGICAL TABLE · SCHEMA VERSION ' + t.version}} · {{system().name | uppercase}}</span>
              <h2><code>{{t.name}}</code></h2><p class="hint">{{t.title}}{{t.description ? ' · ' + t.description : ''}}</p></div>
              <span class="pill Pending">Primary key: {{t.primaryKey}}</span></div>
            <div class="tabs table-tabs" role="tablist" aria-label="Table views">
              @for (v of views; track v) { <button role="tab" [attr.aria-selected]="view() === v" [class.active]="view() === v" (click)="view.set(v)">{{v}}</button> }
            </div>
            @if (view() === 'Columns') {
              <div class="table-scroll" tabindex="0" role="region" [attr.aria-label]="t.name + ' schema table, scrolls horizontally'">
                <table><thead><tr><th scope="col">Field</th><th scope="col">Type</th><th scope="col">Required</th><th scope="col">Notes</th>@if (canChange()) { <th scope="col"><span class="sr-only">Actions</span></th> }</tr></thead>
                  <tbody>@for (c of t.columns; track c.name) {
                    <tr><td><code>{{c.name}}</code>@if (c.name === t.primaryKey) { <small>primary key</small> }@if (c.readOnly) { <small>set by the application</small> }</td>
                      <td><span class="type-tag">{{c.type}}</span></td><td>{{c.required ? 'Yes' : 'No'}}</td>
                      <td class="wrap">{{c.values ? c.values.join(' | ') : ''}}{{c.values && c.description ? ' · ' : ''}}{{c.description || ''}}</td>
                      @if (canChange()) { <td class="row-actions">@if (c.name !== t.primaryKey) {
                        <button mat-button (click)="schema({ operation: 'SetRequired', columnName: c.name, required: !c.required })" [attr.aria-label]="(c.required ? 'Make optional ' : 'Make required ') + c.name">{{c.required ? 'Make optional' : 'Make required'}}</button>
                        @if (c.type === 'enum') { <button mat-button (click)="enumDraft.set({ column: c.name, text: '' })" [attr.aria-label]="'Add values to ' + c.name">+ Values</button> }
                        <button mat-button (click)="schema({ operation: 'RemoveColumn', columnName: c.name })" [attr.aria-label]="'Remove column ' + c.name">Remove</button> }</td> }</tr>
                  }</tbody></table></div>
              @if (canChange()) {
                <form class="inline-form" (ngSubmit)="addColumn()" aria-label="Add column">
                  <label>New column<input name="ncn" [(ngModel)]="newColumn.name" maxlength="40" placeholder="e.g. region"></label>
                  <label>Type<select name="nct" [(ngModel)]="newColumn.type">@for (ty of types; track ty) { <option>{{ty}}</option> }</select></label>
                  @if (newColumn.type === 'enum') { <label>Values (comma separated)<input name="ncv" [(ngModel)]="newColumn.valuesText" maxlength="400"></label> }
                  <label class="check"><input type="checkbox" name="ncr" [(ngModel)]="newColumn.required"> Required</label>
                  <button mat-stroked-button type="submit" [disabled]="busy() || !newColumn.name">Add column</button>
                </form>
                <p class="hint pad">Approved operations only: add, remove an unused column, change required, add enum values. Type changes and renames are not supported, and nothing is deleted while records still use it.</p>
              }
            }
            @if (view() === 'History') {
              <ol class="timeline pad-timeline">@for (v of versions(); track v.version) {
                <li><div><b>Version {{v.version}}</b><time>{{v.changedAt | date:'MMM d, HH:mm:ss'}}</time></div><p>{{v.change}}</p><small>{{v.columns.length}} columns</small></li>
              } @empty { <li><p>{{t.builtIn ? 'Built-in tables are defined in code; their schema has a single version.' : 'No history.'}}</p></li> }</ol>
            }
            @if (view() === 'REST contract') {
              <div class="pad"><p class="hint">Generated from the schema registry. Through the Integration Hub gateway the routes are under <code>/api/catalog/{{system().id}}</code>; the Hub adds the service key server-side.</p>
                <pre tabindex="0" aria-label="Generated REST contract" class="response-body">{{contract() | json}}</pre></div>
            }
          </section>
          <section class="panel" [attr.aria-label]="'Records in ' + t.name">
            <div class="section-heading"><div><h2>Records</h2>
              <code class="muted">GET /api/{{t.builtIn ? system().builtInRows[t.name] : 'catalog/' + system().id + '/tables/' + t.name + '/records'}}</code></div>
              @if (canChange()) { <button mat-stroked-button (click)="editRecord(null)">+ New record</button> }</div>
            @if (t.builtIn) {
              <app-data-table [rows]="rows()" [columns]="columns()" [label]="t.title" [trackKey]="keyOf" [openLabel]="openLabel" [loading]="loading()" (open)="record.set($event)"></app-data-table>
            } @else {
              <div class="table-tools"><label class="search-field"><span class="sr-only">Search {{t.title}}</span>
                <input type="search" [ngModel]="search()" (ngModelChange)="search.set($event)" (keyup.enter)="loadRecords(1)" (search)="loadRecords(1)" maxlength="60" [placeholder]="'Search ' + t.title.toLowerCase() + ' (Enter)…'"></label>
                <span class="muted" aria-live="polite">{{page().total}} records</span></div>
              <div class="table-scroll" tabindex="0" role="region" [attr.aria-label]="t.title + ' records table, scrolls horizontally'">
                <table><thead><tr>@for (c of columns(); track c.key) { <th scope="col">{{c.label}}</th> }<th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
                  <tbody>@for (r of page().items; track r.key) {
                    <tr>@for (c of columns(); track c.key) { <td>@if (c.kind === 'code') { <code>{{display(r.data[c.key])}}</code> } @else { {{display(r.data[c.key])}} }</td> }
                      <td class="row-actions"><button mat-button (click)="record.set(r.data)" [attr.aria-label]="openLabel(r.data)">Open ↗</button>
                        @if (canChange()) { <button mat-button (click)="editRecord(r)" [attr.aria-label]="'Edit ' + t.name + ' record ' + r.key">Edit</button>
                          <button mat-button (click)="confirmDelete.set(r)" [attr.aria-label]="'Delete ' + t.name + ' record ' + r.key">Delete</button> }</td></tr>
                  } @empty { <tr><td [attr.colspan]="columns().length + 1" class="empty">{{loading() ? 'Loading…' : search() ? 'No matching records.' : 'No records yet.'}}</td></tr> }</tbody></table></div>
              <nav class="pagination" [attr.aria-label]="t.title + ' pages'"><span>Page {{page().page}} of {{pages()}}</span>
                <div><button mat-button [disabled]="page().page <= 1" (click)="loadRecords(page().page - 1)">Previous</button>
                  <button mat-button [disabled]="page().page >= pages()" (click)="loadRecords(page().page + 1)">Next</button></div></nav>
              @if (canChange() && (t.recordCount ?? 0) === 0 && page().total === 0) {
                <p class="hint pad">This table is empty. <button class="link-button" (click)="deleteTable(t)">Delete table {{t.name}}</button></p>
              }
            }
          </section>
        </div>
      }
    </div>
    @if (record(); as r) {
      <app-modal [label]="'Record ' + keyOf(r)" [heading]="keyOf(r)" [eyebrow]="(table()?.name ?? '') | uppercase" (close)="record.set(null)">
        <dl class="record-dl">@for (c of table()?.columns ?? []; track c.name) { <dt>{{c.name}}</dt><dd>{{display(r[c.name])}}</dd> }</dl>
        <h3>Raw JSON</h3><pre tabindex="0" aria-label="Record JSON">{{r | json}}</pre>
      </app-modal>
    }
    @if (recordForm(); as f) {
      <app-modal label="Record form" [heading]="f.key ? 'Edit ' + f.key : 'New ' + (table()?.title ?? 'record')" [eyebrow]="(table()?.name ?? '') | uppercase" (close)="recordForm.set(null)">
        <form class="form-grid modal-form" (ngSubmit)="saveRecord()">
          @for (c of table()?.columns ?? []; track c.name) {
            @switch (c.type) {
              @case ('boolean') { <label class="check"><input type="checkbox" [name]="'f_' + c.name" [(ngModel)]="f.values[c.name]"> {{c.name}}</label> }
              @case ('enum') { <label>{{c.name}}{{c.required ? ' *' : ''}}<select [name]="'f_' + c.name" [(ngModel)]="f.values[c.name]" [disabled]="!!f.key && c.name === table()!.primaryKey">
                <option [ngValue]="null">—</option>@for (v of c.values ?? []; track v) { <option [ngValue]="v">{{v}}</option> }</select></label> }
              @default { <label>{{c.name}}{{c.required ? ' *' : ''}} <small class="muted">{{c.type}}</small>
                <input [name]="'f_' + c.name" [type]="inputType(c)" [step]="c.type === 'decimal' ? '0.01' : c.type === 'integer' ? '1' : null" [(ngModel)]="f.values[c.name]"
                  [disabled]="!!f.key && c.name === table()!.primaryKey" maxlength="500"></label> }
            }
            @if (fieldErrors()[c.name]; as msg) { <p class="field-error" role="alert">{{c.name}}: {{msg}}</p> }
          }
          @if (formError()) { <p class="inline-warning flat" role="alert">{{formError()}}</p> }
          <div class="form-actions"><button mat-flat-button type="submit" [disabled]="busy()">{{f.key ? 'Save record' : 'Create record'}}</button><button mat-button type="button" (click)="recordForm.set(null)">Cancel</button></div>
        </form>
      </app-modal>
    }
    @if (confirmDelete(); as r) {
      <app-modal label="Confirm delete" heading="Delete this synthetic record?" eyebrow="CONFIRM" (close)="confirmDelete.set(null)">
        <p>Record <code>{{r.key}}</code> will be permanently removed from <code>{{table()?.name}}</code>.</p>
        <div class="form-actions"><button mat-flat-button (click)="deleteRecord(r)" [disabled]="busy()">Delete record</button><button mat-button (click)="confirmDelete.set(null)">Cancel</button></div>
      </app-modal>
    }
    @if (enumDraft(); as d) {
      <app-modal label="Add enum values" [heading]="'Add values to ' + d.column" eyebrow="SCHEMA OPERATION" (close)="enumDraft.set(null)">
        <form class="form-grid modal-form" (ngSubmit)="schema({ operation: 'AddEnumValues', columnName: d.column, values: split(d.text) }); enumDraft.set(null)">
          <label>New values (comma separated)<input name="ev" [(ngModel)]="d.text" maxlength="400" required></label>
          <div class="form-actions"><button mat-flat-button type="submit" [disabled]="!d.text.trim()">Add values</button></div>
        </form>
      </app-modal>
    }
    @if (tableDraft(); as d) {
      <app-modal label="New table form" heading="New logical table" [eyebrow]="system().name | uppercase" [wide]="true" (close)="tableDraft.set(null)">
        <form (ngSubmit)="createTable()">
          <div class="form-grid modal-form">
            <label>Table name<input name="tn" [(ngModel)]="d.name" maxlength="40" placeholder="lowercase_with_underscores" required></label>
            <label>Title<input name="tt" [(ngModel)]="d.title" maxlength="80" required></label>
            <label>Description<input name="td" [(ngModel)]="d.description" maxlength="300"></label>
            <label>Primary key<select name="tpk" [(ngModel)]="d.primaryKey">@for (c of d.columns; track $index) { @if (c.name) { <option [value]="c.name">{{c.name}}</option> } }</select></label>
          </div>
          <h3>Columns</h3>
          <div class="column-editor">
            @for (c of d.columns; track $index; let i = $index) {
              <div class="column-row">
                <label>Name<input [name]="'cn' + i" [(ngModel)]="c.name" maxlength="40"></label>
                <label>Type<select [name]="'ct' + i" [(ngModel)]="c.type">@for (ty of types; track ty) { <option>{{ty}}</option> }</select></label>
                @if (c.type === 'enum') { <label>Values<input [name]="'cv' + i" [(ngModel)]="c.valuesText" placeholder="A, B, C" maxlength="400"></label> }
                <label class="check"><input type="checkbox" [name]="'cr' + i" [(ngModel)]="c.required"> Required</label>
                <button mat-button type="button" (click)="d.columns.splice(i, 1)" [attr.aria-label]="'Remove column row ' + (i + 1)">Remove</button>
              </div>
            }
            <button mat-button type="button" (click)="d.columns.push(blank())">+ Add column</button>
          </div>
          @for (e of draftErrors(); track e) { <p class="inline-warning flat" role="alert">{{e}}</p> }
          <div class="form-actions"><button mat-flat-button type="submit" [disabled]="busy()">Create table</button><button mat-button type="button" (click)="tableDraft.set(null)">Cancel</button></div>
        </form>
      </app-modal>
    }
  } @else {
    <section class="panel" [attr.aria-label]="system().name + ' API'">
      <div class="section-heading"><div><h2>{{system().name}} REST API</h2>
        <p class="hint">The browser never calls the {{system().name}} directly. Read-only requests go through the Integration Hub gateway, which adds the service key server-side. Write operations are listed for reference and are performed through the application screens or by the middleware.</p></div></div>
      <ul class="endpoint-list">
        @for (e of endpoints(); track e.method + e.path) {
          <li class="endpoint" [class.open]="selected() === e">
            <button type="button" class="endpoint-head" (click)="selectEndpoint(e)" [attr.aria-expanded]="selected() === e">
              <span [class]="'method ' + e.method">{{e.method}}</span><code>{{e.path}}</code><span class="endpoint-desc">{{e.description}}</span>
              <span class="access" [class.locked]="e.access !== 'Viewer'">{{e.access}}</span></button>
            @if (selected() === e) {
              <div class="endpoint-body">
                @if (e.gateway) {
                  <form class="try-form" (ngSubmit)="send(e)">
                    @for (p of params(e); track p) { <label>{{p}}<input [name]="p" [(ngModel)]="paramValues[p]" maxlength="60" required [placeholder]="example(e, p)"></label> }
                    <button mat-flat-button type="submit" [disabled]="busy()">Send request</button>
                    <code class="muted">GET /api/{{resolved(e)}}</code>
                  </form>
                  @if (response(); as r) {
                    <p class="response-line"><span [class]="'pill ' + (r.ok ? 'Completed' : 'Failed')">{{r.status}}</span> {{r.ms}} ms</p>
                    <pre tabindex="0" aria-label="Response body" class="response-body">{{r.body}}</pre>
                  }
                } @else {
                  <p class="hint">{{e.access === 'Middleware only' ? 'Called only by the Integration Hub during an execution, with the service key. Not exposed to the browser.' : 'Use the ' + system().name + ' screens as an Operator. Writes are not sent from the explorer.'}}</p>
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
  readonly types = COLUMN_TYPES;
  readonly views = ['Columns', 'History', 'REST contract'] as const;
  view = signal<'Columns' | 'History' | 'REST contract'>('Columns');
  tables = signal<TableView[]>([]); table = signal<TableView | null>(null); versions = signal<TableVersion[]>([]); contract = signal<unknown>(null);
  rows = signal<any[]>([]); page = signal<RecordPage>({ items: [], total: 0, page: 1, pageSize: 10 }); search = signal('');
  loading = signal(false); busy = signal(false); error = signal(''); notice = signal('');
  record = signal<any | null>(null); confirmDelete = signal<CatalogRecord | null>(null);
  recordForm = signal<{ key: string | null; values: Record<string, any> } | null>(null);
  fieldErrors = signal<Record<string, string>>({}); formError = signal('');
  tableDraft = signal<TableDraft | null>(null); draftErrors = signal<string[]>([]);
  enumDraft = signal<{ column: string; text: string } | null>(null);
  newColumn = blankColumn();
  selected = signal<EndpointDef | null>(null);
  response = signal<{ status: number; ok: boolean; ms: number; body: string } | null>(null);
  paramValues: Record<string, string> = {};
  blank = blankColumn;

  canChange = computed(() => this.api().operator() && !!this.table() && !this.table()!.builtIn);
  hasSample = computed(() => this.tables().some(t => t.name === this.system().sample.name));
  pages = computed(() => Math.max(1, Math.ceil(this.page().total / this.page().pageSize)));
  columns = computed<Column[]>(() => (this.table()?.columns ?? []).slice(0, 6)
    .map(c => ({ key: c.name, label: c.name, kind: c.name === this.table()!.primaryKey ? 'code' : c.type === 'datetime' ? 'date' : c.type === 'decimal' ? 'money' : 'text' })));
  /** Discovery endpoints plus the generated routes of every logical table. */
  endpoints = computed<EndpointDef[]>(() => [...this.system().endpoints, ...this.tables().filter(t => !t.builtIn).flatMap(t => [
    { method: 'GET' as const, path: `/api/catalog/tables/${t.name}/records`, description: `${t.title}: list records (generated route, paginated).`, access: 'Viewer' as const, gateway: `catalog/${this.system().id}/tables/${t.name}/records` },
    { method: 'GET' as const, path: `/api/catalog/tables/${t.name}/records/{key}`, description: `${t.title}: get one record by ${t.primaryKey}.`, access: 'Viewer' as const, gateway: `catalog/${this.system().id}/tables/${t.name}/records/{key}` },
    { method: 'POST' as const, path: `/api/catalog/tables/${t.name}/records`, description: `${t.title}: create a record (schema-validated).`, access: 'Operator' as const },
  ])]);
  keyOf = (row: any) => String(row?.[this.table()?.primaryKey ?? ''] ?? '');
  openLabel = (row: any) => `Open ${this.table()?.name} record ${this.keyOf(row)}`;

  async ngOnInit() { await this.loadCatalog(); }
  async loadCatalog(select?: string) {
    this.loading.set(true);
    try {
      const tables = await loadTables(this.api(), this.system().id);
      this.tables.set(tables);
      if (this.mode() === 'tables') {
        const next = tables.find(t => t.name === (select ?? this.table()?.name)) ?? tables[0];
        if (next) await this.selectTable(next);
      }
    } catch (e) { this.fail(e); } finally { this.loading.set(false); }
  }
  async selectTable(t: TableView) {
    const changed = this.table()?.name !== t.name;
    this.table.set(t); this.record.set(null); this.error.set('');
    if (changed) { this.rows.set([]); this.search.set(''); this.page.set({ items: [], total: 0, page: 1, pageSize: 10 }); this.view.set('Columns'); }
    try {
      const [detail, contract] = await Promise.all([
        this.api().request<{ table: TableView; versions: TableVersion[] }>(`catalog/${this.system().id}/tables/${t.name}`),
        this.api().request<unknown>(`catalog/${this.system().id}/tables/${t.name}/contract`)]);
      if (this.table()?.name !== t.name) return;
      this.table.set(detail.table); this.versions.set(detail.versions); this.contract.set(contract);
      if (t.builtIn) { this.loading.set(true); const route = this.system().builtInRows[t.name]; this.rows.set(route ? await this.api().request<any[]>(route) : []); }
      else await this.loadRecords(changed ? 1 : this.page().page);
    } catch (e) { this.fail(e); } finally { this.loading.set(false); }
  }
  async loadRecords(page: number) {
    const t = this.table(); if (!t || t.builtIn) return;
    const params = new URLSearchParams({ page: String(Math.max(1, page)), pageSize: '10' });
    if (this.search().trim()) params.set('search', this.search().trim());
    try { this.page.set(await this.api().request<RecordPage>(`catalog/${this.system().id}/tables/${t.name}/records?${params}`)); }
    catch (e) { this.fail(e); }
  }
  // ----- table creation and approved schema operations -----
  newTable(sample = false) {
    const s = this.system().sample;
    this.draftErrors.set([]);
    this.tableDraft.set(sample
      ? { name: s.name, title: s.title, description: s.description, primaryKey: s.primaryKey, columns: s.columns.map(c => ({ ...c, valuesText: (c.values ?? []).join(', ') })) }
      : { name: '', title: '', description: '', primaryKey: 'id', columns: [{ name: 'id', type: 'string', required: true, valuesText: '' }, blankColumn()] });
  }
  async createTable() {
    const d = this.tableDraft(); if (!d) return;
    const body = { name: d.name.trim(), title: d.title.trim(), description: d.description.trim() || null, primaryKey: d.primaryKey,
      columns: d.columns.filter(c => c.name.trim()).map(c => this.toColumn(c)) };
    this.busy.set(true); this.draftErrors.set([]);
    try {
      await this.api().request(`catalog/${this.system().id}/tables`, 'POST', body);
      this.tableDraft.set(null); this.notice.set(`Logical table ${body.name} created (schema version 1).`);
      await this.loadCatalog(body.name);
    } catch (e) {
      if (e instanceof SessionEnded) return;
      this.draftErrors.set(e instanceof ApiError && Object.keys(e.fieldErrors).length
        ? Object.entries(e.fieldErrors).map(([f, m]) => `${f}: ${m.join(' ')}`) : [errorText(e)]);
    } finally { this.busy.set(false); }
  }
  async addColumn() {
    const c = this.toColumn(this.newColumn);
    if (await this.schema({ operation: 'AddColumn', column: c })) this.newColumn = blankColumn();
  }
  async schema(change: Record<string, unknown>): Promise<boolean> {
    const t = this.table(); if (!t) return false;
    this.busy.set(true); this.error.set('');
    try {
      const updated = await this.api().request<TableView>(`catalog/${this.system().id}/tables/${t.name}/schema`, 'POST', change);
      this.notice.set(`Schema updated to version ${updated.version}.`);
      await this.loadCatalog(t.name);
      return true;
    } catch (e) { this.fail(e); return false; } finally { this.busy.set(false); }
  }
  async deleteTable(t: TableView) {
    this.busy.set(true);
    try { await this.api().request(`catalog/${this.system().id}/tables/${t.name}`, 'DELETE'); this.notice.set(`Empty table ${t.name} deleted.`); this.table.set(null); await this.loadCatalog(); }
    catch (e) { this.fail(e); } finally { this.busy.set(false); }
  }
  private toColumn(c: ColumnDef & { valuesText?: string }): ColumnDef {
    return { name: c.name.trim(), type: c.type, required: !!c.required, values: c.type === 'enum' ? this.split(c.valuesText ?? '') : null };
  }
  split(text: string) { return text.split(',').map(v => v.trim()).filter(v => v); }
  // ----- record CRUD -----
  editRecord(r: CatalogRecord | null) {
    const values: Record<string, any> = {};
    for (const c of this.table()?.columns ?? []) {
      const v = r ? r.data[c.name] ?? (c.type === 'boolean' ? false : null) : c.type === 'boolean' ? false : null;
      // datetime-local inputs take local "yyyy-MM-ddTHH:mm"; stored values are UTC ISO strings.
      values[c.name] = c.type === 'datetime' && typeof v === 'string' ? toLocalInput(v) : v;
    }
    this.fieldErrors.set({}); this.formError.set('');
    this.recordForm.set({ key: r?.key ?? null, values });
  }
  inputType(c: ColumnDef) { return c.type === 'integer' || c.type === 'decimal' ? 'number' : c.type === 'date' ? 'date' : c.type === 'datetime' ? 'datetime-local' : 'text'; }
  async saveRecord() {
    const f = this.recordForm(); const t = this.table(); if (!f || !t) return;
    const body: Record<string, unknown> = {};
    for (const c of t.columns) {
      let v = f.values[c.name];
      if (v === '' || v === undefined || v === null) continue;
      if (c.type === 'integer' || c.type === 'decimal') v = Number(v);
      if (c.type === 'datetime' && typeof v === 'string' && !/Z|[+-]\d\d:\d\d$/.test(v)) v = new Date(v).toISOString();
      body[c.name] = v;
    }
    this.busy.set(true); this.fieldErrors.set({}); this.formError.set('');
    const base = `catalog/${this.system().id}/tables/${t.name}/records`;
    try {
      if (f.key) await this.api().request(`${base}/${encodeURIComponent(f.key)}`, 'PUT', body);
      else await this.api().request(base, 'POST', body);
      this.recordForm.set(null); this.notice.set(`Record ${String(body[t.primaryKey])} saved.`);
      await this.loadRecords(this.page().page); void this.refreshCounts();
    } catch (e) {
      if (e instanceof SessionEnded) return;
      if (e instanceof ApiError && Object.keys(e.fieldErrors).length) this.fieldErrors.set(Object.fromEntries(Object.entries(e.fieldErrors).map(([k, m]) => [k, m.join(' ')])));
      else this.formError.set(errorText(e));
    } finally { this.busy.set(false); }
  }
  async deleteRecord(r: CatalogRecord) {
    const t = this.table(); if (!t) return;
    this.busy.set(true);
    try {
      await this.api().request(`catalog/${this.system().id}/tables/${t.name}/records/${encodeURIComponent(r.key)}`, 'DELETE');
      this.confirmDelete.set(null); this.notice.set(`Record ${r.key} deleted.`);
      await this.loadRecords(this.page().page); void this.refreshCounts();
    } catch (e) { this.confirmDelete.set(null); this.fail(e); } finally { this.busy.set(false); }
  }
  private async refreshCounts() { try { this.tables.set(await loadTables(this.api(), this.system().id)); } catch { /* counts are informational */ } }
  // ----- API explorer -----
  selectEndpoint(e: EndpointDef) { this.selected.set(this.selected() === e ? null : e); this.response.set(null); }
  params(e: EndpointDef) { return [...(e.gateway ?? '').matchAll(/\{(\w+)\}/g)].map(m => m[1]); }
  example(e: EndpointDef, p: string) { return p === 'name' ? (this.system().id === 'crm' ? 'customers' : 'customer_master') : e.gateway!.includes('orders') ? 'ORD-001' : 'C-100'; }
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
      this.response.set({ status: (err as any)?.status ?? 0, ok: false, ms: Math.round(performance.now() - started), body: errorText(err) });
    } finally { this.busy.set(false); }
  }
  display(v: unknown) { return v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v); }
  private fail(e: unknown) { if (!(e instanceof SessionEnded)) this.error.set(errorText(e)); }
}
