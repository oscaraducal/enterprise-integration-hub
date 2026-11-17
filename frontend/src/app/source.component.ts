import { Component, EventEmitter, Input, OnChanges, OnInit, Output, SimpleChanges, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { Api, ApiError, Focus, SessionEnded, errorText } from './api';
import { CrmCustomer, CrmOrder, CustomerRevision } from './models';

interface RevisionView { version: number; changedAt: string; changes: { field: string; from: unknown; to: unknown }[]; snapshot: any }
const SIMULATIONS = ['None', 'Unavailable', 'ServerError', 'RateLimit', 'Timeout', 'Validation', 'BadRequest'];

/** Legacy CRM: the fictional source system. Reads and writes go through the middleware's /api/source routes. */
@Component({
  selector: 'app-source', standalone: true, imports: [CommonModule, FormsModule, MatButtonModule],
  template: `
  <section class="panel system-intro source-tone">
    <div><span class="system-tag">SOURCE SYSTEM</span><h2>Legacy CRM</h2>
      <p class="muted">A fictional existing business application. It owns customers and sales orders; the integration reads from it through REST.</p></div>
    <div class="tabs" role="tablist" aria-label="Legacy CRM records">
      <button role="tab" [attr.aria-selected]="tab() === 'customers'" [class.active]="tab() === 'customers'" (click)="tab.set('customers')">Customers</button>
      <button role="tab" [attr.aria-selected]="tab() === 'orders'" [class.active]="tab() === 'orders'" (click)="tab.set('orders')">Sales orders</button>
    </div>
  </section>
  @if (error()) { <div class="alert error" role="alert">{{error()}} @if (conflictId()) { <button class="link-button" (click)="inspect.emit(conflictId()!)">Open execution</button> } <button (click)="clear()" aria-label="Dismiss error">×</button></div> }
  @if (notice()) { <div class="alert success" role="status">{{notice()}} <button (click)="notice.set('')" aria-label="Dismiss notification">×</button></div> }

  @if (tab() === 'customers') {
    <section class="panel">
      <div class="section-heading"><div><h2>Customers</h2><p class="hint">Edits increase the version and keep a revision, which drives SCN-003 update synchronization.</p></div>
        @if (api.operator()) { <button mat-stroked-button (click)="startCreateCustomer()">+ New customer</button> }</div>
      <div class="table-scroll" tabindex="0" role="region" aria-label="Legacy CRM customers table, scrolls horizontally">
        <table><caption class="sr-only">Legacy CRM customers</caption>
          <thead><tr><th scope="col">Customer</th><th scope="col">Email</th><th scope="col">Phone</th><th scope="col">Status</th><th scope="col">Version</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>
            @for (c of customers(); track c.customerId) {
              <tr [class.selected-row]="selected()?.customerId === c.customerId">
                <td><code>{{c.customerId}}</code><small>{{c.customerName}}</small></td>
                <td>{{c.email || '— missing —'}}</td><td>{{c.phone || '—'}}</td>
                <td><span class="pill" [class]="'pill status-' + c.status">{{c.status}}</span></td><td>v{{c.version}}</td>
                <td><button mat-button (click)="openCustomer(c.customerId)" [attr.aria-label]="'Open customer ' + c.customerId">Open ↗</button></td>
              </tr>
            } @empty { <tr><td colspan="6" class="empty">{{loading() ? 'Loading customers…' : 'No customers.'}}</td></tr> }
          </tbody></table></div>
    </section>

    @if (customerForm(); as f) {
      <section class="panel form-panel" aria-label="Customer form">
        <div class="section-heading"><h2>{{f.mode === 'create' ? 'New customer' : 'Edit ' + f.customerId}}</h2><button mat-button (click)="customerForm.set(null)">Cancel</button></div>
        <form class="form-grid" (ngSubmit)="saveCustomer()">
          <label>Customer ID<input name="cid" [(ngModel)]="f.customerId" [disabled]="f.mode === 'edit'" placeholder="C-600" maxlength="60" required></label>
          <label>Customer name<input name="cname" [(ngModel)]="f.customerName" maxlength="100" required></label>
          <label>Email<input name="cemail" type="email" [(ngModel)]="f.email" maxlength="120" placeholder="Leave empty to demo a validation failure"></label>
          <label>Phone<input name="cphone" [(ngModel)]="f.phone" maxlength="30" placeholder="+1 (555) 010-1234"></label>
          <label>Status<select name="cstatus" aria-label="Status" [(ngModel)]="f.status"><option>Active</option><option>Inactive</option><option>OnHold</option></select></label>
          <div class="form-actions"><button mat-flat-button type="submit" [disabled]="busy()">{{f.mode === 'create' ? 'Create customer' : 'Save changes'}}</button></div>
        </form>
      </section>
    }

    @if (selected(); as c) {
      <section class="panel investigation" id="crm-customer" tabindex="-1" aria-label="Legacy CRM customer details">
        <div class="section-heading"><div><span class="eyebrow">LEGACY CRM CUSTOMER</span><h2>{{c.customerId}} · {{c.customerName}}</h2></div>
          <div class="button-row">
            <button mat-stroked-button (click)="open.emit({ view: 'Mapping Studio', kind: 'customer', id: c.customerId })">Preview mapping</button>
            <button mat-stroked-button (click)="open.emit({ view: 'Target System', kind: 'customer', id: c.customerId })">View in Modern ERP</button>
            @if (api.operator()) {
              <button mat-stroked-button (click)="editCustomer(c)">Edit</button>
              <button mat-flat-button (click)="sync(c.customerId)" [disabled]="busy()">Sync to Modern ERP</button>
            }
          </div></div>
        @if (api.operator()) { <details class="sim"><summary>Simulate a failure (optional)</summary>
          <div class="sim-grid"><label>Scenario<select [(ngModel)]="sim.scenario" name="ssc">@for (s of simulations; track s) {<option>{{s}}</option>}</select></label>
          <label>Target<select [(ngModel)]="sim.target" name="sst" [disabled]="sim.scenario === 'Validation'"><option>CRM</option><option>ERP</option></select></label>
          <label>Fail first<select [(ngModel)]="sim.failures" name="ssf"><option [ngValue]="1">1 · recover</option><option [ngValue]="3">3 · exhaust</option></select></label></div></details> }
        <div class="detail-grid">
          <div><h3>Current record (version {{c.version}})</h3>
            <dl><dt>customerId</dt><dd>{{c.customerId}}</dd><dt>customerName</dt><dd>{{c.customerName}}</dd><dt>email</dt><dd>{{c.email || '— missing (ERP requires it)'}}</dd>
              <dt>phone</dt><dd>{{c.phone || '—'}}</dd><dt>status</dt><dd>{{c.status}}</dd><dt>updatedAt</dt><dd>{{c.updatedAt | date:'MMM d, HH:mm:ss'}}</dd></dl>
            <h3>Source JSON (GET /api/customers/{{c.customerId}})</h3><pre tabindex="0" aria-label="Source customer JSON">{{c | json}}</pre></div>
          <div><h3>Revision history: original vs modified</h3>
            <ol class="timeline">@for (r of revisions(); track r.version) {
              <li><div><b>Version {{r.version}}</b><time>{{r.changedAt | date:'MMM d, HH:mm:ss'}}</time></div>
                @if (r.changes.length) { <table class="diff"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>
                  @for (d of r.changes; track d.field) { <tr><td>{{d.field}}</td><td class="old">{{d.from ?? '—'}}</td><td class="new">{{d.to ?? '—'}}</td></tr> }</tbody></table> }
                @else { <p>{{r.version === 1 || r === revisions()[revisions().length - 1] ? 'Original record.' : 'No field changes.'}}</p> }</li>
            } @empty { <li><p>No revisions recorded.</p></li> }</ol></div>
        </div>
      </section>
    }
  } @else {
    <section class="panel">
      <div class="section-heading"><div><h2>Sales orders</h2><p class="hint">Run an order to import it into the Modern ERP (SCN-002). New customers must be synchronized first (SCN-001).</p></div>
        @if (api.operator()) { <button mat-stroked-button (click)="startCreateOrder()">+ New order</button> }</div>
      <div class="table-scroll" tabindex="0" role="region" aria-label="Legacy CRM sales orders table, scrolls horizontally">
        <table><caption class="sr-only">Legacy CRM sales orders</caption>
          <thead><tr><th scope="col">Order</th><th scope="col">Customer</th><th scope="col">Currency</th><th scope="col">Amount</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>
            @for (o of orders(); track o.id) {
              <tr [class.selected-row]="selectedOrder()?.id === o.id">
                <td><code>{{o.id}}</code></td><td>{{o.customerId}}</td><td>{{o.currency}}</td><td>{{o.amount | number:'1.2-2'}}</td>
                <td class="row-actions"><button mat-button (click)="selectOrder(o)" [attr.aria-label]="'Open order ' + o.id">Open ↗</button></td>
              </tr>
            } @empty { <tr><td colspan="5" class="empty">{{loading() ? 'Loading orders…' : 'No orders.'}}</td></tr> }
          </tbody></table></div>
    </section>
    @if (orderForm(); as f) {
      <section class="panel form-panel" aria-label="Order form">
        <div class="section-heading"><h2>{{f.mode === 'create' ? 'New sales order' : 'Edit ' + f.id}}</h2><button mat-button (click)="orderForm.set(null)">Cancel</button></div>
        <form class="form-grid" (ngSubmit)="saveOrder()">
          <label>Order ID<input name="oid" [(ngModel)]="f.id" [disabled]="f.mode === 'edit'" placeholder="ORD-100" maxlength="60" required></label>
          <label>Customer<select name="ocust" aria-label="Customer" [(ngModel)]="f.customerId">@for (c of customers(); track c.customerId) {<option [value]="c.customerId">{{c.customerId}} · {{c.customerName}}</option>}</select></label>
          <label>Currency<input name="ocur" [(ngModel)]="f.currency" maxlength="3" placeholder="USD"></label>
          <label>Amount<input name="oamt" type="number" step="0.01" min="0.01" [(ngModel)]="f.amount"></label>
          <div class="form-actions"><button mat-flat-button type="submit" [disabled]="busy()">{{f.mode === 'create' ? 'Create order' : 'Save changes'}}</button></div>
        </form>
        @if (f.mode === 'edit') { <p class="hint">Editing an order that was already imported does not change the ERP: orders are immutable once imported, and the middleware never re-sends a changed payload under the same ID.</p> }
      </section>
    }
    @if (selectedOrder(); as o) {
      <section class="panel investigation" id="crm-order" tabindex="-1" aria-label="Legacy CRM order details">
        <div class="section-heading"><div><span class="eyebrow">LEGACY CRM SALES ORDER</span><h2>{{o.id}}</h2></div>
          <div class="button-row">
            <button mat-stroked-button (click)="open.emit({ view: 'Mapping Studio', kind: 'order', id: o.id })">Preview mapping</button>
            <button mat-stroked-button (click)="open.emit({ view: 'Target System', kind: 'order', id: o.id })">View in Modern ERP</button>
            @if (api.operator()) {
              <button mat-stroked-button (click)="editOrder(o)">Edit</button>
              <button mat-flat-button (click)="runOrder(o.id)" [disabled]="busy()">Run integration</button>
            }
          </div></div>
        @if (api.operator()) { <details class="sim"><summary>Simulate a failure (optional)</summary>
          <div class="sim-grid"><label>Scenario<select [(ngModel)]="sim.scenario" name="osc">@for (s of orderSimulations; track s) {<option>{{s}}</option>}</select></label>
          <label>Target<select [(ngModel)]="sim.target" name="ost" [disabled]="sim.scenario === 'Validation' || sim.scenario === 'Duplicate'"><option>CRM</option><option>ERP</option></select></label>
          <label>Fail first<select [(ngModel)]="sim.failures" name="osf"><option [ngValue]="1">1 · recover</option><option [ngValue]="3">3 · exhaust</option></select></label></div></details> }
        <dl class="inline-dl"><dt>customerId</dt><dd>{{o.customerId}}</dd><dt>currency</dt><dd>{{o.currency}}</dd><dt>amount</dt><dd>{{o.amount}}</dd></dl>
        <pre tabindex="0" aria-label="Source order JSON">{{o | json}}</pre>
      </section>
    }
  }`
})
export class SourceComponent implements OnInit, OnChanges {
  @Input({ required: true }) api!: Api;
  @Input() focus: Focus | null = null;
  @Input() refreshTick = 0;
  @Output() inspect = new EventEmitter<string>();
  @Output() open = new EventEmitter<Focus>();
  readonly simulations = SIMULATIONS;
  readonly orderSimulations = [...SIMULATIONS, 'Duplicate'];
  tab = signal<'customers' | 'orders'>('customers');
  customers = signal<CrmCustomer[]>([]); orders = signal<CrmOrder[]>([]);
  selected = signal<CrmCustomer | null>(null); revisions = signal<RevisionView[]>([]);
  selectedOrder = signal<CrmOrder | null>(null);
  customerForm = signal<(Partial<CrmCustomer> & { mode: 'create' | 'edit' }) | null>(null);
  orderForm = signal<(Partial<CrmOrder> & { mode: 'create' | 'edit' }) | null>(null);
  loading = signal(false); busy = signal(false); error = signal(''); notice = signal(''); conflictId = signal<string | null>(null);
  sim = { scenario: 'None', target: 'ERP', failures: 1 };

  async ngOnInit() { await this.load(); this.applyFocus(); }
  async ngOnChanges(changes: SimpleChanges) {
    if (changes['refreshTick'] && !changes['refreshTick'].firstChange) await this.load();
    if (changes['focus'] && !changes['focus'].firstChange) this.applyFocus();
  }
  private applyFocus() {
    const f = this.focus; if (!f?.id) return;
    if (f.kind === 'order') { this.tab.set('orders'); const o = this.orders().find(x => x.id === f.id); if (o) this.selectOrder(o); }
    else { this.tab.set('customers'); void this.openCustomer(f.id); }
  }
  async load() {
    this.loading.set(true);
    try {
      const [customers, orders] = await Promise.all([this.api.request<CrmCustomer[]>('source/customers'), this.api.request<CrmOrder[]>('source/orders')]);
      this.customers.set(customers); this.orders.set(orders);
      const sel = this.selected(); if (sel) { const fresh = customers.find(c => c.customerId === sel.customerId); if (fresh && fresh.version !== sel.version) await this.openCustomer(sel.customerId, false); }
    } catch (e) { this.fail(e); } finally { this.loading.set(false); }
  }
  async openCustomer(id: string, scroll = true) {
    try {
      const detail = await this.api.request<{ customer: CrmCustomer; revisions: CustomerRevision[] | null }>('source/customers/' + encodeURIComponent(id));
      this.selected.set(detail.customer); this.revisions.set(this.toViews(detail.revisions ?? []));
      if (scroll) setTimeout(() => document.getElementById('crm-customer')?.focus());
    } catch (e) { this.fail(e); }
  }
  selectOrder(o: CrmOrder) { this.selectedOrder.set(o); setTimeout(() => document.getElementById('crm-order')?.focus()); }
  /** Revisions arrive newest first; compare each with its predecessor to show what changed. */
  private toViews(revs: CustomerRevision[]): RevisionView[] {
    const parsed = revs.map(r => ({ ...r, data: JSON.parse(r.snapshot) }));
    return parsed.map((r, i) => {
      const prev = parsed[i + 1]?.data;
      const changes = prev ? ['customerName', 'email', 'phone', 'status'].filter(k => prev[k] !== r.data[k]).map(k => ({ field: k, from: prev[k], to: r.data[k] })) : [];
      return { version: r.version, changedAt: r.changedAt, changes, snapshot: r.data };
    });
  }
  startCreateCustomer() { this.customerForm.set({ mode: 'create', customerId: '', customerName: '', email: '', phone: '', status: 'Active' }); }
  editCustomer(c: CrmCustomer) { this.customerForm.set({ mode: 'edit', ...c, email: c.email ?? '', phone: c.phone ?? '' }); }
  async saveCustomer() {
    const f = this.customerForm(); if (!f) return;
    const body = { customerId: (f.customerId ?? '').trim().toUpperCase(), customerName: f.customerName ?? '', email: f.email || null, phone: f.phone || null, status: f.status };
    await this.act(async () => {
      const saved = f.mode === 'create'
        ? await this.api.request<CrmCustomer>('source/customers', 'POST', body)
        : await this.api.request<CrmCustomer>('source/customers/' + encodeURIComponent(body.customerId), 'PUT', body);
      this.customerForm.set(null);
      this.notice.set(f.mode === 'create' ? `Customer ${saved.customerId} created in the Legacy CRM (version 1).` : `Customer ${saved.customerId} saved (now version ${saved.version}).`);
      await this.load(); await this.openCustomer(saved.customerId);
    });
  }
  startCreateOrder() { this.orderForm.set({ mode: 'create', id: '', customerId: this.customers()[0]?.customerId, currency: 'USD', amount: 100 }); }
  editOrder(o: CrmOrder) { this.orderForm.set({ mode: 'edit', ...o }); }
  async saveOrder() {
    const f = this.orderForm(); if (!f) return;
    const body = { id: (f.id ?? '').trim().toUpperCase(), customerId: f.customerId, currency: (f.currency ?? '').trim().toUpperCase(), amount: Number(f.amount) };
    await this.act(async () => {
      const saved = f.mode === 'create' ? await this.api.request<CrmOrder>('source/orders', 'POST', body)
        : await this.api.request<CrmOrder>('source/orders/' + encodeURIComponent(body.id), 'PUT', body);
      this.orderForm.set(null); this.notice.set(`Order ${saved.id} saved in the Legacy CRM.`);
      await this.load(); this.selectOrder(saved);
    });
  }
  sync(customerId: string) { return this.queue({ kind: 'CustomerSync', sourceId: customerId }); }
  runOrder(orderId: string) { return this.queue({ kind: 'SalesOrder', sourceId: orderId }); }
  private async queue(body: { kind: string; sourceId: string }) {
    const s = this.sim;
    const target = s.scenario === 'Validation' ? 'CRM' : s.scenario === 'Duplicate' ? 'ERP' : s.target;
    await this.act(async () => {
      const r = await this.api.request<{ id: string }>('executions', 'POST', { ...body, environment: 'DEV', scenario: s.scenario, target, failuresBeforeSuccess: Number(s.failures) });
      this.inspect.emit(r.id);
    });
  }
  private async act(work: () => Promise<void>) {
    this.busy.set(true); this.clear();
    try { await work(); } catch (e) { this.fail(e); } finally { this.busy.set(false); }
  }
  clear() { this.error.set(''); this.conflictId.set(null); }
  private fail(e: unknown) {
    if (e instanceof SessionEnded) return;
    this.error.set(errorText(e));
    this.conflictId.set(e instanceof ApiError ? e.body?.executionId ?? null : null);
  }
}
