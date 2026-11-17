import { Component, EventEmitter, Input, OnChanges, OnInit, Output, SimpleChanges, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { Api, Focus, SessionEnded, errorText } from './api';
import { CrmCustomer, ErpCustomer, ErpHistory, ErpOrder, PreviewResult } from './models';
import { Column, DataTableComponent, ModalComponent, SubnavComponent } from './ui';
import { SYSTEMS, SystemCatalogComponent } from './systems';

interface CompareRow { field: string; source: unknown; expected: unknown; actual: unknown; ok: boolean }
interface Reconciliation { rows: CompareRow[]; note: string; allOk: boolean; errors: string[] }
interface Diff { field: string; from: unknown; to: unknown }
interface HistoryView extends ErpHistory { diffs: Diff[] }
/** One record the integration imported, customer or order, in a single list. */
interface ImportedRow {
  type: 'Customer' | 'Sales order'; key: string; sourceId: string; sourceVersion: number | null;
  executionId: string | null; importedAt: string | null; mapped: string;
}
export const ERP_SECTIONS = ['Dashboard', 'Customer Master', 'Sales Orders', 'Imported Data', 'Import History', 'Data Tables', 'API Explorer'] as const;
type ErpSection = typeof ERP_SECTIONS[number];
const CUSTOMER_FIELDS = ['displayName', 'emailAddress', 'contactNumber', 'accountStatus'];

/** Modern ERP: the fictional target application, showing the business data the integration actually imported. */
@Component({
  selector: 'app-target', standalone: true,
  imports: [CommonModule, FormsModule, MatButtonModule, DataTableComponent, ModalComponent, SubnavComponent, SystemCatalogComponent],
  template: `
  <div class="business-app erp-app">
    <header class="app-bar target-tone">
      <div class="app-brand"><span class="app-logo" aria-hidden="true">ME</span><div><b>Modern ERP</b><small>Target application · customer master & order management</small></div></div>
      @if (showNav) { <app-subnav label="Modern ERP navigation" [items]="sections" [active]="section()" (select)="go($any($event))"></app-subnav> }
    </header>
    @if (error()) { <div class="alert error" role="alert">{{error()}} <button (click)="error.set('')" aria-label="Dismiss error">×</button></div> }
    @if (notice()) { <div class="alert success" role="status">{{notice()}} <button (click)="notice.set('')" aria-label="Dismiss notification">×</button></div> }
    @if (missing()) { <p class="inline-warning standalone" role="status">{{missing()}} is not in the Modern ERP yet. It appears here after the Integration Hub imports it.</p> }

    @switch (section()) {
      @case ('Dashboard') {
        <section class="kpis" aria-label="Modern ERP summary">
          <article class="metric panel"><span>Customer accounts</span><strong>{{customers().length}}</strong><small>{{importedCustomers()}} imported · {{customers().length - importedCustomers()}} migrated fixtures</small></article>
          <article class="metric panel"><span>Imported orders</span><strong>{{orders().length}}</strong><small>Accepted exactly once</small></article>
          <article class="metric panel"><span>Import events</span><strong>{{importEvents()}}</strong><small>Created, updated, unchanged or skipped</small></article>
          <article class="metric panel"><span>Last import</span><strong class="metric-small">{{lastImport() ? (lastImport() | date:'MMM d, HH:mm') : '—'}}</strong><small>Customer or order</small></article>
        </section>
        <div class="dash-grid">
          <section class="panel" aria-labelledby="erp-activity">
            <div class="section-heading"><h2 id="erp-activity">Recent import activity</h2><button mat-button (click)="go('Import History')">Import history →</button></div>
            <ul class="activity">
              @for (h of history().slice(0, 6); track h.id) {
                <li><button type="button" class="activity-item" (click)="historyEntry.set(h)" [attr.aria-label]="'Open history entry ' + h.id">
                  <span [class]="'pill action-' + h.action">{{h.action}}</span>
                  <span><b>{{h.accountCode}}</b><small>{{h.changedFields || actorText(h)}}</small></span>
                  <time>{{h.at | date:'MMM d, HH:mm'}}</time></button></li>
              } @empty { <li class="hint pad">{{loading() ? 'Loading…' : 'No import activity yet.'}}</li> }
            </ul>
          </section>
          <section class="panel" aria-labelledby="erp-status">
            <div class="section-heading"><h2 id="erp-status">Accounts by status</h2><button mat-button (click)="go('Customer Master')">Customer master →</button></div>
            <ul class="bars">
              @for (s of byStatus(); track s.status) {
                <li><span class="bar-label"><b>{{s.status}}</b></span><span class="bar-track"><span class="bar-fill" [style.width.%]="s.share"></span></span><span class="bar-value">{{s.count}}</span></li>
              } @empty { <li class="hint pad">No accounts.</li> }
            </ul>
            <p class="hint pad">Imports are initiated by the Integration Hub. The ERP validates, stores and audits what it receives.</p>
          </section>
        </div>
      }
      @case ('Customer Master') {
        <section class="panel">
          <div class="section-heading"><div><h2>Customer master</h2><p class="hint">Imported records are owned by the integration. Migrated fixtures are synthetic and may be edited by hand.</p></div></div>
          <app-data-table [rows]="customers()" [columns]="customerColumns" label="Customer master" [trackKey]="customerKey" [openLabel]="customerLabel"
            [selectedKey]="selected()?.accountCode ?? null" [loading]="loading()" (open)="openCustomer($event.accountCode)"></app-data-table>
        </section>
      }
      @case ('Sales Orders') {
        <section class="panel">
          <div class="section-heading"><div><h2>Sales orders</h2><p class="hint">Orders imported from the Legacy CRM, stored as mapped payloads with their receipt and execution.</p></div></div>
          <app-data-table [rows]="orders()" [columns]="orderColumns" label="Imported orders" [trackKey]="orderKey" [openLabel]="orderLabel"
            [selectedKey]="selectedOrder()?.externalOrderId ?? null" [loading]="loading()" emptyText="No imported orders yet." (open)="selectOrder($event)"></app-data-table>
        </section>
      }
      @case ('Imported Data') {
        <section class="panel">
          <div class="section-heading"><div><h2>Imported data</h2><p class="hint">Every record the integration delivered: source ID, source version, execution ID, import time and the mapped fields stored.</p></div></div>
          <app-data-table [rows]="imported()" [columns]="importedColumns" label="Imported records" [trackKey]="importedKey" [openLabel]="importedLabel"
            [loading]="loading()" emptyText="Nothing has been imported yet." (open)="openImported($event)"></app-data-table>
        </section>
      }
      @case ('Import History') {
        <section class="panel">
          <div class="section-heading"><div><h2>Import history</h2><p class="hint">Audit of customer master changes across all accounts, newest first (latest 200).</p></div></div>
          <app-data-table [rows]="history()" [columns]="historyColumns" label="Import history" [trackKey]="historyKey" [openLabel]="historyLabel"
            [pageSize]="15" [loading]="loading()" emptyText="No history yet." (open)="historyEntry.set($event)"></app-data-table>
        </section>
      }
      @case ('Data Tables') { <app-system-catalog [api]="api" [system]="system" mode="tables"></app-system-catalog> }
      @case ('API Explorer') { <app-system-catalog [api]="api" [system]="system" mode="api"></app-system-catalog> }
    }
  </div>

  @if (selected(); as c) {
    <app-modal label="Modern ERP customer details" eyebrow="MODERN ERP ACCOUNT" [heading]="c.accountCode + ' · ' + c.displayName" [wide]="true" (close)="closeCustomer()">
      <div class="modal-actions">
        <button mat-stroked-button (click)="compareCustomer(c)">Compare with source</button>
        <button mat-button (click)="open.emit({ view: 'Source System', kind: 'customer', id: c.sourceReference || c.accountCode })">Open source record</button>
        @if (c.lastExecutionId) { <button mat-button (click)="inspect.emit(c.lastExecutionId!)">Open last execution</button> }
        @if (api.operator() && c.origin === 'Fixture') { <button mat-stroked-button (click)="editFixture(c)">Edit fixture</button> }
      </div>
      @if (error()) { <p class="inline-warning flat" role="alert">{{error()}}</p> }
      <div class="detail-grid">
        <div><h3>Stored record</h3>
          <dl><dt>accountCode</dt><dd>{{c.accountCode}}</dd><dt>displayName</dt><dd>{{c.displayName}}</dd><dt>emailAddress</dt><dd>{{c.emailAddress}}</dd>
            <dt>contactNumber</dt><dd>{{c.contactNumber || '—'}}</dd><dt>accountStatus</dt><dd>{{c.accountStatus}}</dd>
            <dt>Origin</dt><dd>{{c.origin === 'Fixture' ? 'Migrated fixture (manually maintainable)' : 'Imported by the integration'}}</dd>
            <dt>Source</dt><dd>{{c.sourceSystem}} {{c.sourceReference}}{{c.sourceVersion ? ', version ' + c.sourceVersion : ''}}</dd>
            <dt>Last synced</dt><dd>{{c.lastSyncedAt ? (c.lastSyncedAt | date:'MMM d, HH:mm:ss') : 'Never'}}</dd>
            <dt>Last execution</dt><dd><code>{{c.lastExecutionId || '—'}}</code></dd></dl>
          @if (fixture(); as fx) {
            <form class="form-grid compact" (ngSubmit)="saveFixture()" aria-label="Edit fixture">
              <label>displayName<input name="fdn" [(ngModel)]="fx.displayName" maxlength="100"></label>
              <label>emailAddress<input name="fem" type="email" [(ngModel)]="fx.emailAddress" maxlength="120"></label>
              <label>contactNumber<input name="fcn" [(ngModel)]="fx.contactNumber" maxlength="30"></label>
              <label>accountStatus<select name="fst" [(ngModel)]="fx.accountStatus"><option>ACTIVE</option><option>INACTIVE</option><option>BLOCKED</option></select></label>
              <div class="form-actions"><button mat-flat-button type="submit" [disabled]="busy()">Save fixture</button><button mat-button type="button" (click)="fixture.set(null)">Cancel</button></div>
            </form>
            <p class="hint">Fixture edits are recorded as FixtureEdit in the history. The next import takes ownership of the record.</p>
          }
        </div>
        <div><h3>Import history</h3>
          <ol class="timeline">@for (h of customerHistory(); track h.id) {
            <li [class]="'level-' + (h.action === 'SkippedStale' ? 'Warning' : 'Information')"><div><b>{{h.action}}</b><time>{{h.at | date:'MMM d, HH:mm:ss'}}</time></div>
              <p>{{actorText(h)}}{{h.sourceVersion ? ' · source v' + h.sourceVersion : ''}}{{h.changedFields ? ' · ' + h.changedFields : ''}}</p>
              @if (h.diffs.length) { <table class="diff"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>
                @for (d of h.diffs; track d.field) { <tr><td>{{d.field}}</td><td class="old">{{d.from ?? '—'}}</td><td class="new">{{d.to ?? '—'}}</td></tr> }</tbody></table> }
              @if (h.note) { <small>{{h.note}}</small> }
              @if (h.executionId) { <button class="link-button" (click)="inspect.emit(h.executionId!)">Execution {{h.executionId.slice(0, 12)}} ↗</button> }
            </li>
          }</ol></div>
      </div>
      @if (recon(); as r) { <ng-container *ngTemplateOutlet="reconTpl; context: { $implicit: r }"></ng-container> }
    </app-modal>
  }
  @if (selectedOrder(); as o) {
    <app-modal label="Modern ERP imported order details" eyebrow="MODERN ERP IMPORTED ORDER" [heading]="o.externalOrderId" (close)="selectedOrder.set(null); recon.set(null)">
      <div class="modal-actions">
        <button mat-stroked-button (click)="compareOrder(o)">Compare with source</button>
        <button mat-button (click)="open.emit({ view: 'Source System', kind: 'order', id: o.externalOrderId })">Open source record</button>
        @if (o.executionId) { <button mat-button (click)="inspect.emit(o.executionId!)">Open execution</button> }
      </div>
      <dl class="record-dl"><dt>externalOrderId</dt><dd>{{o.externalOrderId}}</dd><dt>accountCode</dt><dd>{{o.accountCode || '—'}}</dd>
        <dt>currencyCode</dt><dd>{{o.currencyCode || '—'}}</dd><dt>totalMinorUnits</dt><dd>{{o.totalMinorUnits ?? '—'}}</dd>
        <dt>receiptId</dt><dd><code>{{o.receiptId}}</code></dd><dt>importedAt</dt><dd>{{o.acceptedAt | date:'MMM d, y, HH:mm:ss'}}</dd>
        <dt>executionId</dt><dd><code>{{o.executionId || '—'}}</code></dd><dt>source</dt><dd>{{o.sourceSystem || 'LEGACY-CRM'}} {{o.externalOrderId}}</dd></dl>
      @if (o.totalMinorUnits == null) { <p class="hint">This order was imported before the ERP stored mapped payloads, so only its receipt is available.</p> }
      @if (recon(); as r) { <ng-container *ngTemplateOutlet="reconTpl; context: { $implicit: r }"></ng-container> }
    </app-modal>
  }
  @if (historyEntry(); as h) {
    <app-modal label="Import history entry" eyebrow="IMPORT HISTORY" [heading]="h.action + ' · ' + h.accountCode" (close)="historyEntry.set(null)">
      <div class="modal-actions">
        <button mat-stroked-button (click)="historyEntry.set(null); openCustomer(h.accountCode)">Open account {{h.accountCode}}</button>
        @if (h.executionId) { <button mat-button (click)="inspect.emit(h.executionId!)">Open execution</button> }
      </div>
      <dl class="record-dl"><dt>When</dt><dd>{{h.at | date:'MMM d, y, HH:mm:ss'}}</dd><dt>Actor</dt><dd>{{actorText(h)}}</dd>
        <dt>Source version</dt><dd>{{h.sourceVersion ?? '—'}}</dd><dt>Changed fields</dt><dd>{{h.changedFields || '—'}}</dd>
        <dt>Execution</dt><dd><code>{{h.executionId || '—'}}</code></dd>@if (h.note) { <dt>Note</dt><dd>{{h.note}}</dd> }</dl>
      @if (h.diffs.length) { <h3>Before → after</h3><table class="diff"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>
        @for (d of h.diffs; track d.field) { <tr><td>{{d.field}}</td><td class="old">{{d.from ?? '—'}}</td><td class="new">{{d.to ?? '—'}}</td></tr> }</tbody></table> }
    </app-modal>
  }
  <ng-template #reconTpl let-r>
    <div class="reconcile" role="region" aria-label="Reconciliation">
      <h3>Reconciliation: source → expected (mapping) → stored in ERP <span class="pill" [class]="r.allOk ? 'pill Completed' : 'pill Failed'">{{r.allOk ? 'All fields match' : 'Differences found'}}</span></h3>
      <div class="table-scroll" tabindex="0" role="region" aria-label="Reconciliation table, scrolls horizontally"><table class="compare">
        <thead><tr><th scope="col">Target field</th><th scope="col">Source value</th><th scope="col">Expected</th><th scope="col">Stored in ERP</th><th scope="col">Match</th></tr></thead>
        <tbody>@for (row of r.rows; track row.field) { <tr><td>{{row.field}}</td><td>{{row.source ?? '—'}}</td><td>{{row.expected ?? '—'}}</td><td>{{row.actual ?? '—'}}</td><td [class.ok]="row.ok" [class.bad]="!row.ok">{{row.ok ? '✓' : '✗'}}</td></tr> }</tbody>
      </table></div>
      @for (e of r.errors; track e) { <p class="inline-warning flat">{{e}}</p> }
      <p class="hint">{{r.note}}</p>
    </div>
  </ng-template>`
})
export class TargetComponent implements OnInit, OnChanges {
  @Input({ required: true }) api!: Api;
  @Input() focus: Focus | null = null;
  @Input() refreshTick = 0;
  /** False when the shell's Modern ERP sidebar provides the section navigation. */
  @Input() showNav = true;
  /** Reports section changes so the shell can keep the URL and sidebar in sync. */
  @Output() sectionChange = new EventEmitter<string>();
  @Output() inspect = new EventEmitter<string>();
  @Output() open = new EventEmitter<Focus>();
  readonly sections = ERP_SECTIONS;
  readonly system = SYSTEMS.erp;
  section = signal<ErpSection>('Dashboard');
  customers = signal<ErpCustomer[]>([]); orders = signal<ErpOrder[]>([]); history = signal<HistoryView[]>([]);
  selected = signal<ErpCustomer | null>(null); customerHistory = signal<HistoryView[]>([]);
  selectedOrder = signal<ErpOrder | null>(null); recon = signal<Reconciliation | null>(null);
  historyEntry = signal<HistoryView | null>(null);
  fixture = signal<ErpCustomer | null>(null); missing = signal('');
  loading = signal(false); busy = signal(false); error = signal(''); notice = signal('');

  readonly customerColumns: Column<ErpCustomer>[] = [
    { key: 'accountCode', label: 'Account', kind: 'code', sub: c => c.displayName },
    { key: 'emailAddress', label: 'Email' },
    { key: 'accountStatus', label: 'Status', kind: 'pill', pillClass: c => 'acct-' + c.accountStatus },
    { key: 'origin', label: 'Origin', value: c => c.origin === 'Fixture' ? 'Migrated fixture' : 'Imported' },
    { key: 'sourceReference', label: 'Source', value: c => `${c.sourceSystem ?? ''} · ${c.sourceReference ?? ''}${c.sourceVersion ? ' v' + c.sourceVersion : ''}` },
    { key: 'lastSyncedAt', label: 'Last synced', kind: 'date' }];
  readonly orderColumns: Column<ErpOrder>[] = [
    { key: 'externalOrderId', label: 'External order', kind: 'code', sub: o => 'receipt ' + o.receiptId.slice(0, 10) },
    { key: 'accountCode', label: 'Account' },
    { key: 'totalMinorUnits', label: 'Total (minor units)', sub: o => o.totalMinorUnits == null ? 'Imported before payload storage' : `${o.currencyCode} ${(o.totalMinorUnits / 100).toFixed(2)}` },
    { key: 'executionId', label: 'Execution', kind: 'code', value: o => o.executionId?.slice(0, 12) ?? null },
    { key: 'acceptedAt', label: 'Imported', kind: 'date' }];
  readonly importedColumns: Column<ImportedRow>[] = [
    { key: 'type', label: 'Type', kind: 'pill', pillClass: r => r.type === 'Customer' ? 'Running' : 'Pending' },
    { key: 'key', label: 'ERP record', kind: 'code' },
    { key: 'sourceId', label: 'Source ID', sub: r => r.sourceVersion ? 'source version ' + r.sourceVersion : null },
    { key: 'executionId', label: 'Execution ID', kind: 'code', value: r => r.executionId?.slice(0, 12) ?? null },
    { key: 'importedAt', label: 'Imported', kind: 'date' },
    { key: 'mapped', label: 'Mapped fields' }];
  readonly historyColumns: Column<HistoryView>[] = [
    { key: 'at', label: 'When', kind: 'date' },
    { key: 'action', label: 'Action', kind: 'pill', pillClass: h => 'action-' + h.action },
    { key: 'accountCode', label: 'Account', kind: 'code' },
    { key: 'changedFields', label: 'Changed fields', value: h => h.changedFields || '—' },
    { key: 'sourceVersion', label: 'Source v', value: h => h.sourceVersion ?? '—' },
    { key: 'executionId', label: 'Execution', kind: 'code', value: h => h.executionId?.slice(0, 12) ?? null }];
  customerKey = (c: ErpCustomer) => c.accountCode;
  customerLabel = (c: ErpCustomer) => 'Open ERP account ' + c.accountCode;
  orderKey = (o: ErpOrder) => o.externalOrderId;
  orderLabel = (o: ErpOrder) => 'Open imported order ' + o.externalOrderId;
  importedKey = (r: ImportedRow) => r.type + ':' + r.key;
  importedLabel = (r: ImportedRow) => `Open imported ${r.type.toLowerCase()} ${r.key}`;
  historyKey = (h: HistoryView) => String(h.id);
  historyLabel = (h: HistoryView) => 'Open history entry ' + h.id;

  importedCustomers = computed(() => this.customers().filter(c => c.origin === 'Import').length);
  importEvents = computed(() => this.history().filter(h => h.actor === 'integration').length);
  lastImport = computed(() => [...this.customers().map(c => c.lastSyncedAt ?? ''), ...this.orders().map(o => o.acceptedAt)].sort().pop() || null);
  byStatus = computed(() => {
    const counts = new Map<string, number>();
    for (const c of this.customers()) counts.set(c.accountStatus, (counts.get(c.accountStatus) ?? 0) + 1);
    const max = Math.max(1, ...counts.values());
    return [...counts].map(([status, count]) => ({ status, count, share: count / max * 100 }));
  });
  imported = computed<ImportedRow[]>(() => [
    ...this.customers().filter(c => c.origin === 'Import').map(c => ({ type: 'Customer' as const, key: c.accountCode, sourceId: c.sourceReference ?? c.accountCode,
      sourceVersion: c.sourceVersion ?? null, executionId: c.lastExecutionId ?? null, importedAt: c.lastSyncedAt ?? null,
      mapped: `accountCode, ${CUSTOMER_FIELDS.join(', ')}` })),
    ...this.orders().map(o => ({ type: 'Sales order' as const, key: o.externalOrderId, sourceId: o.externalOrderId, sourceVersion: null,
      executionId: o.executionId ?? null, importedAt: o.acceptedAt,
      mapped: o.totalMinorUnits == null ? 'receipt only' : 'externalOrderId, accountCode, currencyCode, totalMinorUnits' }))
  ].sort((a, b) => (b.importedAt ?? '').localeCompare(a.importedAt ?? '')));

  async ngOnInit() { await this.load(); this.applyFocus(); }
  async ngOnChanges(changes: SimpleChanges) {
    if (changes['refreshTick'] && !changes['refreshTick'].firstChange) await this.load();
    if (changes['focus'] && !changes['focus'].firstChange) this.applyFocus();
  }
  go(section: ErpSection) { if (section !== this.section()) this.sectionChange.emit(section); this.section.set(section); this.missing.set(''); }
  private applyFocus() {
    const f = this.focus; if (!f) return;
    if (f.section && (ERP_SECTIONS as readonly string[]).includes(f.section)) this.go(f.section as ErpSection);
    if (!f.id) return;
    if (f.kind === 'order') {
      this.go('Sales Orders'); const o = this.orders().find(x => x.externalOrderId === f.id);
      if (o) this.selectOrder(o); else { this.selectedOrder.set(null); this.missing.set(f.id); }
    } else {
      this.go('Customer Master');
      if (this.customers().some(c => c.accountCode === f.id)) void this.openCustomer(f.id); else { this.selected.set(null); this.missing.set(f.id); }
    }
  }
  async load() {
    this.loading.set(true);
    try {
      const [customers, orders, history] = await Promise.all([this.api.request<ErpCustomer[]>('target/customers'),
        this.api.request<ErpOrder[]>('target/orders'), this.api.request<ErpHistory[]>('target/history?take=200')]);
      this.customers.set(customers); this.orders.set(orders); this.history.set(history.map(h => this.view(h)));
      const sel = this.selected(); if (sel) await this.openCustomer(sel.accountCode);
    } catch (e) { this.fail(e); } finally { this.loading.set(false); }
  }
  async openCustomer(code: string) {
    try {
      const detail = await this.api.request<{ customer: ErpCustomer; history: ErpHistory[] }>('target/customers/' + encodeURIComponent(code));
      if (this.selected()?.accountCode !== code) { this.recon.set(null); this.fixture.set(null); }
      this.selectedOrder.set(null);
      this.selected.set(detail.customer); this.missing.set('');
      this.customerHistory.set(detail.history.map(h => this.view(h)));
    } catch (e) { this.fail(e); }
  }
  closeCustomer() { this.selected.set(null); this.recon.set(null); this.fixture.set(null); }
  selectOrder(o: ErpOrder) { this.selected.set(null); this.selectedOrder.set(o); this.recon.set(null); this.missing.set(''); }
  openImported(r: ImportedRow) {
    if (r.type === 'Customer') void this.openCustomer(r.key);
    else { const o = this.orders().find(x => x.externalOrderId === r.key); if (o) this.selectOrder(o); }
  }
  actorText(h: ErpHistory) { return h.actor === 'integration' ? 'By integration' : h.actor === 'seed' ? 'Seeded' : 'Manual edit by ' + h.actor; }
  private view(h: ErpHistory): HistoryView { return { ...h, diffs: this.diff(h.before, h.after) }; }
  private diff(before?: string | null, after?: string): Diff[] {
    if (!before || !after) return [];
    try {
      const b = JSON.parse(before), a = JSON.parse(after);
      return CUSTOMER_FIELDS.filter(k => b[k] !== a[k]).map(k => ({ field: k, from: b[k], to: a[k] }));
    } catch { return []; }
  }
  /** Reconciliation reuses the server-side mapping preview, so "expected" is computed by the same C# rules as the integration. */
  async compareCustomer(c: ErpCustomer) {
    try {
      const id = c.sourceReference || c.accountCode;
      const src = await this.api.request<{ customer: CrmCustomer }>('source/customers/' + encodeURIComponent(id));
      const preview = await this.api.request<PreviewResult>('mappings/customer/preview', 'POST', { source: src.customer });
      const pairs: [string, string][] = [['accountCode', 'customerId'], ['displayName', 'customerName'], ['emailAddress', 'email'], ['contactNumber', 'phone'], ['accountStatus', 'status']];
      const rows = pairs.map(([t, s]) => {
        const expected = preview.output?.[t] ?? null, actual = (c as any)[t] ?? null;
        return { field: t, source: (src.customer as any)[s] ?? null, expected, actual, ok: preview.valid && expected === actual };
      });
      const newer = src.customer.version > (c.sourceVersion ?? 0);
      this.recon.set({ rows, allOk: rows.every(r => r.ok), errors: preview.errors.map(e => `${e.field}: ${e.message}`),
        note: c.origin === 'Fixture' ? 'This is a migrated fixture that has not been synchronized yet. Run SCN-001 from the Integration Hub to take ownership.'
          : newer ? `The Legacy CRM is at version ${src.customer.version} but the ERP holds version ${c.sourceVersion}. Run the SCN-003 customer sync from the Integration Hub.`
          : `ERP holds source version ${c.sourceVersion}, the current CRM version.` });
    } catch (e) { this.fail(e); }
  }
  async compareOrder(o: ErpOrder) {
    try {
      const src = await this.api.request<any>('source/orders/' + encodeURIComponent(o.externalOrderId)).catch(() => null);
      if (!src) { this.recon.set({ rows: [], allOk: false, errors: ['Source order not found in the Legacy CRM.'], note: '' }); return; }
      const preview = await this.api.request<PreviewResult>('mappings/sales-order/preview', 'POST', { source: src });
      const pairs: [string, string][] = [['externalOrderId', 'id'], ['accountCode', 'customerId'], ['currencyCode', 'currency'], ['totalMinorUnits', 'amount']];
      const rows = pairs.map(([t, s]) => {
        const expected = preview.output?.[t] ?? null, actual = (o as any)[t] ?? null;
        return { field: t, source: src[s], expected, actual, ok: preview.valid && expected === actual };
      });
      this.recon.set({ rows, allOk: rows.every(r => r.ok), errors: preview.errors.map(e => `${e.field}: ${e.message}`),
        note: rows.every(r => r.ok) ? 'The stored ERP order matches the current source order.'
          : 'A difference means the source order was edited after import. Imported orders are immutable; the ERP keeps the originally delivered payload.' });
    } catch (e) { this.fail(e); }
  }
  editFixture(c: ErpCustomer) { this.fixture.set({ ...c, contactNumber: c.contactNumber ?? '' }); }
  async saveFixture() {
    const f = this.fixture(); if (!f) return;
    this.busy.set(true); this.error.set('');
    try {
      await this.api.request('target/fixtures/customers/' + encodeURIComponent(f.accountCode), 'PUT',
        { accountCode: f.accountCode, displayName: f.displayName, emailAddress: f.emailAddress, contactNumber: f.contactNumber || null, accountStatus: f.accountStatus });
      this.fixture.set(null); this.notice.set(`Fixture ${f.accountCode} updated; the change is recorded as FixtureEdit.`);
      await this.load();
    } catch (e) { this.fail(e); } finally { this.busy.set(false); }
  }
  private fail(e: unknown) { if (!(e instanceof SessionEnded)) this.error.set(errorText(e)); }
}
