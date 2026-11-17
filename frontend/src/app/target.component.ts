import { Component, EventEmitter, Input, OnChanges, OnInit, Output, SimpleChanges, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { Api, Focus, SessionEnded, errorText } from './api';
import { CrmCustomer, ErpCustomer, ErpHistory, ErpOrder, PreviewResult } from './models';

interface CompareRow { field: string; source: unknown; expected: unknown; actual: unknown; ok: boolean }
interface Reconciliation { rows: CompareRow[]; note: string; allOk: boolean; errors: string[] }
interface HistoryView extends ErpHistory { diffs: { field: string; from: unknown; to: unknown }[] }

/** Modern ERP: the fictional target system, showing the business data the integration actually imported. */
@Component({
  selector: 'app-target', standalone: true, imports: [CommonModule, FormsModule, MatButtonModule],
  template: `
  <section class="panel system-intro target-tone">
    <div><span class="system-tag">TARGET SYSTEM</span><h2>Modern ERP</h2>
      <p class="muted">A fictional receiving application. It stores the mapped business payloads it imports, with the original source IDs, import time and execution ID.</p></div>
    <div class="tabs" role="tablist" aria-label="Modern ERP records">
      <button role="tab" [attr.aria-selected]="tab() === 'customers'" [class.active]="tab() === 'customers'" (click)="tab.set('customers')">Customer master</button>
      <button role="tab" [attr.aria-selected]="tab() === 'orders'" [class.active]="tab() === 'orders'" (click)="tab.set('orders')">Imported orders</button>
    </div>
  </section>
  @if (error()) { <div class="alert error" role="alert">{{error()}} <button (click)="error.set('')" aria-label="Dismiss error">×</button></div> }
  @if (notice()) { <div class="alert success" role="status">{{notice()}} <button (click)="notice.set('')" aria-label="Dismiss notification">×</button></div> }

  @if (tab() === 'customers') {
    <section class="panel">
      <div class="section-heading"><div><h2>Customer master</h2><p class="hint">Imported records are owned by the integration. Migrated fixtures are synthetic and may be edited by hand.</p></div><span class="muted">{{customers().length}} accounts</span></div>
      <div class="table-scroll" tabindex="0" role="region" aria-label="Modern ERP customers table, scrolls horizontally">
        <table><caption class="sr-only">Modern ERP customer master</caption>
          <thead><tr><th scope="col">Account</th><th scope="col">Email</th><th scope="col">Status</th><th scope="col">Origin</th><th scope="col">Source</th><th scope="col">Last synced</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>
            @for (c of customers(); track c.accountCode) {
              <tr [class.selected-row]="selected()?.accountCode === c.accountCode">
                <td><code>{{c.accountCode}}</code><small>{{c.displayName}}</small></td><td>{{c.emailAddress}}</td>
                <td><span class="pill" [class]="'pill acct-' + c.accountStatus">{{c.accountStatus}}</span></td>
                <td><span class="origin" [class.fixture]="c.origin === 'Fixture'">{{c.origin === 'Fixture' ? 'Migrated fixture' : 'Imported'}}</span></td>
                <td>{{c.sourceSystem}} · {{c.sourceReference}}{{c.sourceVersion ? ' v' + c.sourceVersion : ''}}</td>
                <td>{{c.lastSyncedAt ? (c.lastSyncedAt | date:'MMM d, HH:mm:ss') : '—'}}</td>
                <td><button mat-button (click)="openCustomer(c.accountCode)" [attr.aria-label]="'Open ERP account ' + c.accountCode">Open ↗</button></td>
              </tr>
            } @empty { <tr><td colspan="7" class="empty">{{loading() ? 'Loading…' : 'No customer accounts.'}}</td></tr> }
          </tbody></table></div>
    </section>
    @if (missing()) { <p class="inline-warning standalone" role="status">{{missing()}} is not in the Modern ERP yet. Run SCN-001 from the Legacy CRM to create it.</p> }
    @if (selected(); as c) {
      <section class="panel investigation" id="erp-customer" tabindex="-1" aria-label="Modern ERP customer details">
        <div class="section-heading"><div><span class="eyebrow">MODERN ERP ACCOUNT</span><h2>{{c.accountCode}} · {{c.displayName}}</h2></div>
          <div class="button-row">
            <button mat-stroked-button (click)="compareCustomer(c)">Compare with source</button>
            <button mat-stroked-button (click)="open.emit({ view: 'Source System', kind: 'customer', id: c.sourceReference || c.accountCode })">Open source record</button>
            @if (c.lastExecutionId) { <button mat-stroked-button (click)="inspect.emit(c.lastExecutionId!)">Open last execution</button> }
            @if (api.operator() && c.origin === 'Fixture') { <button mat-stroked-button (click)="editFixture(c)">Edit fixture</button> }
          </div></div>
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
              <p class="hint">Fixture edits are recorded as FixtureEdit in the history. The next sync from the CRM takes ownership of the record.</p>
            }
          </div>
          <div><h3>Import history</h3>
            <ol class="timeline">@for (h of history(); track h.id) {
              <li [class]="'level-' + (h.action === 'SkippedStale' ? 'Warning' : 'Information')"><div><b>{{h.action}}</b><time>{{h.at | date:'MMM d, HH:mm:ss'}}</time></div>
                <p>{{h.actor === 'integration' ? 'By integration' : h.actor === 'seed' ? 'Seeded' : 'Manual edit by ' + h.actor}}{{h.sourceVersion ? ' · source v' + h.sourceVersion : ''}}{{h.changedFields ? ' · ' + h.changedFields : ''}}</p>
                @if (h.diffs.length) { <table class="diff"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>
                  @for (d of h.diffs; track d.field) { <tr><td>{{d.field}}</td><td class="old">{{d.from ?? '—'}}</td><td class="new">{{d.to ?? '—'}}</td></tr> }</tbody></table> }
                @if (h.note) { <small>{{h.note}}</small> }
                @if (h.executionId) { <button class="link-button" (click)="inspect.emit(h.executionId!)">Execution {{h.executionId.slice(0, 12)}} ↗</button> }
              </li>
            }</ol></div>
        </div>
        @if (recon(); as r) { <ng-container *ngTemplateOutlet="reconTpl; context: { $implicit: r }"></ng-container> }
      </section>
    }
  } @else {
    <section class="panel">
      <div class="section-heading"><div><h2>Imported orders</h2><p class="hint">The mapped business payload stored by the ERP, with its receipt and the execution that delivered it.</p></div><span class="muted">{{orders().length}} orders</span></div>
      <div class="table-scroll" tabindex="0" role="region" aria-label="Modern ERP imported orders table, scrolls horizontally">
        <table><caption class="sr-only">Modern ERP imported orders</caption>
          <thead><tr><th scope="col">External order</th><th scope="col">Account</th><th scope="col">Total</th><th scope="col">Imported</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>
            @for (o of orders(); track o.externalOrderId) {
              <tr [class.selected-row]="selectedOrder()?.externalOrderId === o.externalOrderId">
                <td><code>{{o.externalOrderId}}</code><small>receipt {{o.receiptId.slice(0, 10)}}</small></td>
                <td>{{o.accountCode || '—'}}</td>
                <td>@if (o.totalMinorUnits != null) { {{o.totalMinorUnits}} <small>{{o.currencyCode}} {{o.totalMinorUnits / 100 | number:'1.2-2'}}</small> } @else { <small>Imported before payload storage</small> }</td>
                <td>{{o.acceptedAt | date:'MMM d, HH:mm:ss'}}</td>
                <td><button mat-button (click)="selectOrder(o)" [attr.aria-label]="'Open imported order ' + o.externalOrderId">Open ↗</button></td>
              </tr>
            } @empty { <tr><td colspan="5" class="empty">{{loading() ? 'Loading…' : 'No imported orders yet. Run SCN-002.'}}</td></tr> }
          </tbody></table></div>
    </section>
    @if (missing()) { <p class="inline-warning standalone" role="status">{{missing()}} has not been imported into the Modern ERP yet.</p> }
    @if (selectedOrder(); as o) {
      <section class="panel investigation" id="erp-order" tabindex="-1" aria-label="Modern ERP imported order details">
        <div class="section-heading"><div><span class="eyebrow">MODERN ERP IMPORTED ORDER</span><h2>{{o.externalOrderId}}</h2></div>
          <div class="button-row">
            <button mat-stroked-button (click)="compareOrder(o)">Compare with source</button>
            <button mat-stroked-button (click)="open.emit({ view: 'Source System', kind: 'order', id: o.externalOrderId })">Open source record</button>
            @if (o.executionId) { <button mat-stroked-button (click)="inspect.emit(o.executionId!)">Open execution</button> }
          </div></div>
        <dl class="inline-dl"><dt>externalOrderId</dt><dd>{{o.externalOrderId}}</dd><dt>accountCode</dt><dd>{{o.accountCode || '—'}}</dd>
          <dt>currencyCode</dt><dd>{{o.currencyCode || '—'}}</dd><dt>totalMinorUnits</dt><dd>{{o.totalMinorUnits ?? '—'}}</dd>
          <dt>receiptId</dt><dd><code>{{o.receiptId}}</code></dd><dt>importedAt</dt><dd>{{o.acceptedAt | date:'MMM d, y, HH:mm:ss'}}</dd>
          <dt>executionId</dt><dd><code>{{o.executionId || '—'}}</code></dd><dt>source</dt><dd>{{o.sourceSystem || 'LEGACY-CRM'}} {{o.externalOrderId}}</dd></dl>
        @if (o.totalMinorUnits == null) { <p class="hint">This order was imported before the ERP stored mapped payloads, so only its receipt is available.</p> }
        @if (recon(); as r) { <ng-container *ngTemplateOutlet="reconTpl; context: { $implicit: r }"></ng-container> }
      </section>
    }
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
  @Output() inspect = new EventEmitter<string>();
  @Output() open = new EventEmitter<Focus>();
  tab = signal<'customers' | 'orders'>('customers');
  customers = signal<ErpCustomer[]>([]); orders = signal<ErpOrder[]>([]);
  selected = signal<ErpCustomer | null>(null); history = signal<HistoryView[]>([]);
  selectedOrder = signal<ErpOrder | null>(null); recon = signal<Reconciliation | null>(null);
  fixture = signal<ErpCustomer | null>(null); missing = signal('');
  loading = signal(false); busy = signal(false); error = signal(''); notice = signal('');

  async ngOnInit() { await this.load(); this.applyFocus(); }
  async ngOnChanges(changes: SimpleChanges) {
    if (changes['refreshTick'] && !changes['refreshTick'].firstChange) await this.load();
    if (changes['focus'] && !changes['focus'].firstChange) this.applyFocus();
  }
  private applyFocus() {
    const f = this.focus; if (!f?.id) return; this.missing.set('');
    if (f.kind === 'order') {
      this.tab.set('orders'); const o = this.orders().find(x => x.externalOrderId === f.id);
      if (o) this.selectOrder(o); else { this.selectedOrder.set(null); this.missing.set(f.id); }
    } else {
      this.tab.set('customers');
      if (this.customers().some(c => c.accountCode === f.id)) void this.openCustomer(f.id); else { this.selected.set(null); this.missing.set(f.id); }
    }
  }
  async load() {
    this.loading.set(true);
    try {
      const [customers, orders] = await Promise.all([this.api.request<ErpCustomer[]>('target/customers'), this.api.request<ErpOrder[]>('target/orders')]);
      this.customers.set(customers); this.orders.set(orders);
      const sel = this.selected(); if (sel) await this.openCustomer(sel.accountCode, false);
    } catch (e) { this.fail(e); } finally { this.loading.set(false); }
  }
  async openCustomer(code: string, scroll = true) {
    try {
      const detail = await this.api.request<{ customer: ErpCustomer; history: ErpHistory[] }>('target/customers/' + encodeURIComponent(code));
      if (this.selected()?.accountCode !== code) { this.recon.set(null); this.fixture.set(null); }
      this.selected.set(detail.customer); this.missing.set('');
      this.history.set(detail.history.map(h => ({ ...h, diffs: this.diff(h.before, h.after) })));
      if (scroll) setTimeout(() => document.getElementById('erp-customer')?.focus());
    } catch (e) { this.fail(e); }
  }
  selectOrder(o: ErpOrder) { this.selectedOrder.set(o); this.recon.set(null); this.missing.set(''); setTimeout(() => document.getElementById('erp-order')?.focus()); }
  private diff(before?: string | null, after?: string): { field: string; from: unknown; to: unknown }[] {
    if (!before || !after) return [];
    const b = JSON.parse(before), a = JSON.parse(after);
    return ['displayName', 'emailAddress', 'contactNumber', 'accountStatus'].filter(k => b[k] !== a[k]).map(k => ({ field: k, from: b[k], to: a[k] }));
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
        note: c.origin === 'Fixture' ? 'This is a migrated fixture that has not been synchronized yet. Run SCN-001 to take ownership.'
          : newer ? `The Legacy CRM is at version ${src.customer.version} but the ERP holds version ${c.sourceVersion}. Run Sync to Modern ERP (SCN-003).`
          : `ERP holds source version ${c.sourceVersion}, the current CRM version.` });
    } catch (e) { this.fail(e); }
  }
  async compareOrder(o: ErpOrder) {
    try {
      const orders = await this.api.request<any[]>('source/orders');
      const src = orders.find(x => x.id === o.externalOrderId);
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
