import { Component, EventEmitter, Input, OnChanges, OnInit, Output, SimpleChanges, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { Api, Focus, SessionEnded, errorText } from './api';
import { CrmCustomer, CrmOrder, CustomerRevision } from './models';
import { Column, DataTableComponent, ModalComponent, SubnavComponent } from './ui';
import { SYSTEMS, SystemCatalogComponent } from './systems';

interface RevisionView { version: number; changedAt: string; changes: { field: string; from: unknown; to: unknown }[] }
export const CRM_SECTIONS = ['Dashboard', 'Customers', 'Sales Orders', 'Data Tables', 'API Explorer'] as const;
type CrmSection = typeof CRM_SECTIONS[number];

/**
 * Legacy CRM: the fictional source application. It manages customers and sales orders and exposes them over REST.
 * It deliberately has no integration controls: synchronization is initiated by the middleware.
 */
@Component({
  selector: 'app-source', standalone: true,
  imports: [CommonModule, FormsModule, MatButtonModule, DataTableComponent, ModalComponent, SubnavComponent, SystemCatalogComponent],
  template: `
  <div class="business-app crm-app">
    <header class="app-bar source-tone">
      <div class="app-brand"><span class="app-logo" aria-hidden="true">LC</span><div><b>Legacy CRM</b><small>Source application · customer & order management</small></div></div>
      @if (showNav) { <app-subnav label="Legacy CRM navigation" [items]="sections" [active]="section()" (select)="go($any($event))"></app-subnav> }
    </header>
    @if (error()) { <div class="alert error" role="alert">{{error()}} <button (click)="error.set('')" aria-label="Dismiss error">×</button></div> }
    @if (notice()) { <div class="alert success" role="status">{{notice()}} <button (click)="notice.set('')" aria-label="Dismiss notification">×</button></div> }

    @switch (section()) {
      @case ('Dashboard') {
        <section class="kpis" aria-label="Legacy CRM summary">
          <article class="metric panel"><span>Customers</span><strong>{{customers().length}}</strong><small>{{count('Active')}} active · {{count('OnHold')}} on hold · {{count('Inactive')}} inactive</small></article>
          <article class="metric panel"><span>Sales orders</span><strong>{{orders().length}}</strong><small>Across {{orderCustomers()}} customers</small></article>
          <article class="metric panel"><span>Edited customers</span><strong>{{edited()}}</strong><small>Records above version 1</small></article>
          <article class="metric panel"><span>Missing email</span><strong [class.text-red]="missingEmail() > 0">{{missingEmail()}}</strong><small>Data-quality check</small></article>
        </section>
        <div class="dash-grid">
          <section class="panel" aria-labelledby="crm-recent">
            <div class="section-heading"><h2 id="crm-recent">Recent customer updates</h2><button mat-button (click)="go('Customers')">All customers →</button></div>
            <ul class="activity">
              @for (c of recent(); track c.customerId) {
                <li><button type="button" class="activity-item" (click)="openCustomer(c.customerId)" [attr.aria-label]="'Open customer ' + c.customerId">
                  <span class="avatar" aria-hidden="true">{{c.customerName.charAt(0)}}</span>
                  <span><b>{{c.customerName}}</b><small>{{c.customerId}} · version {{c.version}} · {{c.status}}</small></span>
                  <time>{{c.updatedAt ? (c.updatedAt | date:'MMM d, HH:mm') : '—'}}</time></button></li>
              } @empty { <li class="hint pad">{{loading() ? 'Loading…' : 'No customers yet.'}}</li> }
            </ul>
          </section>
          <section class="panel" aria-labelledby="crm-value">
            <div class="section-heading"><h2 id="crm-value">Order value by currency</h2><button mat-button (click)="go('Sales Orders')">All orders →</button></div>
            <ul class="bars">
              @for (c of byCurrency(); track c.currency) {
                <li><span class="bar-label"><b>{{c.currency}}</b><small>{{c.count}} {{c.count === 1 ? 'order' : 'orders'}}</small></span>
                  <span class="bar-track"><span class="bar-fill" [style.width.%]="c.share"></span></span><span class="bar-value">{{c.total | number:'1.2-2'}}</span></li>
              } @empty { <li class="hint pad">No orders yet.</li> }
            </ul>
            @if (api.operator()) {
              <div class="quick-actions"><button mat-stroked-button (click)="startCreateCustomer()">+ New customer</button><button mat-stroked-button (click)="startCreateOrder()">+ New order</button></div>
            }
          </section>
        </div>
      }
      @case ('Customers') {
        <section class="panel">
          <div class="section-heading"><div><h2>Customers</h2><p class="hint">Each edit increases the version and stores a revision.</p></div>
            @if (api.operator()) { <button mat-stroked-button (click)="startCreateCustomer()">+ New customer</button> }</div>
          <app-data-table [rows]="customers()" [columns]="customerColumns" label="Customers" [trackKey]="customerKey" [openLabel]="customerLabel"
            [selectedKey]="selected()?.customerId ?? null" [loading]="loading()" (open)="openCustomer($event.customerId)"></app-data-table>
        </section>
      }
      @case ('Sales Orders') {
        <section class="panel">
          <div class="section-heading"><div><h2>Sales orders</h2><p class="hint">Orders reference a customer by customerId.</p></div>
            @if (api.operator()) { <button mat-stroked-button (click)="startCreateOrder()">+ New order</button> }</div>
          <app-data-table [rows]="orders()" [columns]="orderColumns" label="Sales orders" [trackKey]="orderKey" [openLabel]="orderLabel"
            [selectedKey]="selectedOrder()?.id ?? null" [loading]="loading()" [initialQuery]="orderQuery()" (open)="selectOrder($event)"></app-data-table>
        </section>
      }
      @case ('Data Tables') { <app-system-catalog [api]="api" [system]="system" mode="tables"></app-system-catalog> }
      @case ('API Explorer') { <app-system-catalog [api]="api" [system]="system" mode="api"></app-system-catalog> }
    }
  </div>

  @if (selected(); as c) {
    <app-modal label="Legacy CRM customer details" eyebrow="LEGACY CRM CUSTOMER" [heading]="c.customerId + ' · ' + c.customerName" [wide]="true" (close)="selected.set(null)">
      <div class="modal-actions">
        @if (api.operator()) { <button mat-stroked-button (click)="editCustomer(c)">Edit</button> }
        <button mat-button (click)="ordersFor(c.customerId)">View orders ({{orderCount(c.customerId)}})</button>
      </div>
      <div class="detail-grid">
        <div><h3>Current record (version {{c.version}})</h3>
          <dl><dt>customerId</dt><dd>{{c.customerId}}</dd><dt>customerName</dt><dd>{{c.customerName}}</dd><dt>email</dt><dd>{{c.email || '— not set'}}</dd>
            <dt>phone</dt><dd>{{c.phone || '—'}}</dd><dt>status</dt><dd>{{c.status}}</dd><dt>version</dt><dd>{{c.version}}</dd><dt>updatedAt</dt><dd>{{c.updatedAt | date:'MMM d, y, HH:mm:ss'}}</dd></dl>
          <h3>REST representation · GET /api/customers/{{c.customerId}}</h3><pre tabindex="0" aria-label="Source customer JSON">{{c | json}}</pre></div>
        <div><h3>Revision history</h3>
          <ol class="timeline">@for (r of revisions(); track r.version; let last = $last) {
            <li><div><b>Version {{r.version}}</b><time>{{r.changedAt | date:'MMM d, HH:mm:ss'}}</time></div>
              @if (r.changes.length) { <table class="diff"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>
                @for (d of r.changes; track d.field) { <tr><td>{{d.field}}</td><td class="old">{{d.from ?? '—'}}</td><td class="new">{{d.to ?? '—'}}</td></tr> }</tbody></table> }
              @else { <p>{{r.version === 1 || last ? 'Original record.' : 'No field changes.'}}</p> }</li>
          } @empty { <li><p>No revisions recorded.</p></li> }</ol></div>
      </div>
    </app-modal>
  }
  @if (selectedOrder(); as o) {
    <app-modal label="Legacy CRM order details" eyebrow="LEGACY CRM SALES ORDER" [heading]="o.id" (close)="selectedOrder.set(null)">
      <div class="modal-actions">
        @if (api.operator()) { <button mat-stroked-button (click)="editOrder(o)">Edit</button> }
        <button mat-button (click)="openCustomer(o.customerId)">Open customer {{o.customerId}}</button>
      </div>
      <dl class="record-dl"><dt>id</dt><dd>{{o.id}}</dd><dt>customerId</dt><dd>{{o.customerId}} · {{customerName(o.customerId)}}</dd><dt>currency</dt><dd>{{o.currency}}</dd><dt>amount</dt><dd>{{o.amount | number:'1.2-2'}}</dd></dl>
      <h3>REST representation · GET /api/orders/{{o.id}}</h3><pre tabindex="0" aria-label="Source order JSON">{{o | json}}</pre>
    </app-modal>
  }
  @if (customerForm(); as f) {
    <app-modal label="Customer form" [heading]="f.mode === 'create' ? 'New customer' : 'Edit ' + f.customerId" eyebrow="LEGACY CRM" (close)="customerForm.set(null)">
      <form class="form-grid modal-form" (ngSubmit)="saveCustomer()">
        <label>Customer ID<input name="cid" [(ngModel)]="f.customerId" [disabled]="f.mode === 'edit'" placeholder="C-600" maxlength="60" required></label>
        <label>Customer name<input name="cname" [(ngModel)]="f.customerName" maxlength="100" required></label>
        <label>Email<input name="cemail" type="email" [(ngModel)]="f.email" maxlength="120" placeholder="Optional in the CRM"></label>
        <label>Phone<input name="cphone" [(ngModel)]="f.phone" maxlength="30" placeholder="+1 (555) 010-1234"></label>
        <label>Status<select name="cstatus" aria-label="Status" [(ngModel)]="f.status"><option>Active</option><option>Inactive</option><option>OnHold</option></select></label>
        @if (formError()) { <p class="inline-warning flat" role="alert">{{formError()}}</p> }
        <div class="form-actions"><button mat-flat-button type="submit" [disabled]="busy()">{{f.mode === 'create' ? 'Create customer' : 'Save changes'}}</button><button mat-button type="button" (click)="customerForm.set(null)">Cancel</button></div>
      </form>
    </app-modal>
  }
  @if (orderForm(); as f) {
    <app-modal label="Order form" [heading]="f.mode === 'create' ? 'New sales order' : 'Edit ' + f.id" eyebrow="LEGACY CRM" (close)="orderForm.set(null)">
      <form class="form-grid modal-form" (ngSubmit)="saveOrder()">
        <label>Order ID<input name="oid" [(ngModel)]="f.id" [disabled]="f.mode === 'edit'" placeholder="ORD-100" maxlength="60" required></label>
        <label>Customer<select name="ocust" aria-label="Customer" [(ngModel)]="f.customerId">@for (c of customers(); track c.customerId) {<option [value]="c.customerId">{{c.customerId}} · {{c.customerName}}</option>}</select></label>
        <label>Currency<input name="ocur" [(ngModel)]="f.currency" maxlength="3" placeholder="USD"></label>
        <label>Amount<input name="oamt" type="number" step="0.01" min="0.01" [(ngModel)]="f.amount"></label>
        @if (formError()) { <p class="inline-warning flat" role="alert">{{formError()}}</p> }
        <div class="form-actions"><button mat-flat-button type="submit" [disabled]="busy()">{{f.mode === 'create' ? 'Create order' : 'Save changes'}}</button><button mat-button type="button" (click)="orderForm.set(null)">Cancel</button></div>
      </form>
      @if (f.mode === 'edit') { <p class="hint">Orders already imported by another system are not changed by editing them here.</p> }
    </app-modal>
  }`
})
export class SourceComponent implements OnInit, OnChanges {
  @Input({ required: true }) api!: Api;
  @Input() focus: Focus | null = null;
  @Input() refreshTick = 0;
  /** False when the shell's Legacy CRM sidebar provides the section navigation. */
  @Input() showNav = true;
  /** Reports section changes so the shell can keep the URL and sidebar in sync. */
  @Output() sectionChange = new EventEmitter<string>();
  readonly sections = CRM_SECTIONS;
  readonly system = SYSTEMS.crm;
  section = signal<CrmSection>('Dashboard');
  customers = signal<CrmCustomer[]>([]); orders = signal<CrmOrder[]>([]);
  selected = signal<CrmCustomer | null>(null); revisions = signal<RevisionView[]>([]);
  selectedOrder = signal<CrmOrder | null>(null);
  customerForm = signal<(Partial<CrmCustomer> & { mode: 'create' | 'edit' }) | null>(null);
  orderForm = signal<(Partial<CrmOrder> & { mode: 'create' | 'edit' }) | null>(null);
  loading = signal(false); busy = signal(false); error = signal(''); notice = signal(''); formError = signal('');

  readonly customerColumns: Column<CrmCustomer>[] = [
    { key: 'customerId', label: 'Customer', kind: 'code', sub: c => c.customerName },
    { key: 'email', label: 'Email', value: c => c.email || '— not set' },
    { key: 'phone', label: 'Phone' },
    { key: 'status', label: 'Status', kind: 'pill', pillClass: c => 'status-' + c.status },
    { key: 'version', label: 'Version', value: c => 'v' + c.version },
    { key: 'updatedAt', label: 'Updated', kind: 'date' }];
  readonly orderColumns: Column<CrmOrder>[] = [
    { key: 'id', label: 'Order', kind: 'code' },
    { key: 'customerId', label: 'Customer', sub: o => this.customerName(o.customerId) },
    { key: 'currency', label: 'Currency' },
    { key: 'amount', label: 'Amount', kind: 'money' }];
  customerKey = (c: CrmCustomer) => c.customerId;
  customerLabel = (c: CrmCustomer) => 'Open customer ' + c.customerId;
  orderKey = (o: CrmOrder) => o.id;
  orderLabel = (o: CrmOrder) => 'Open order ' + o.id;

  count = (status: string) => this.customers().filter(c => c.status === status).length;
  edited = computed(() => this.customers().filter(c => c.version > 1).length);
  missingEmail = computed(() => this.customers().filter(c => !c.email).length);
  orderCustomers = computed(() => new Set(this.orders().map(o => o.customerId)).size);
  recent = computed(() => [...this.customers()].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')).slice(0, 6));
  byCurrency = computed(() => {
    const groups = new Map<string, { currency: string; count: number; total: number }>();
    for (const o of this.orders()) {
      const g = groups.get(o.currency) ?? { currency: o.currency, count: 0, total: 0 };
      g.count++; g.total += o.amount; groups.set(o.currency, g);
    }
    const list = [...groups.values()].sort((a, b) => b.count - a.count);
    const max = Math.max(1, ...list.map(g => g.count));
    return list.map(g => ({ ...g, share: g.count / max * 100 }));
  });

  async ngOnInit() { await this.load(); this.applyFocus(); }
  async ngOnChanges(changes: SimpleChanges) {
    if (changes['refreshTick'] && !changes['refreshTick'].firstChange) await this.load();
    if (changes['focus'] && !changes['focus'].firstChange) this.applyFocus();
  }
  orderQuery = signal('');
  go(section: CrmSection) {
    if (section !== this.section() && section !== 'Sales Orders') this.orderQuery.set('');
    if (section !== this.section()) this.sectionChange.emit(section);
    this.section.set(section);
  }
  private applyFocus() {
    const f = this.focus; if (!f) return;
    if (f.section && (CRM_SECTIONS as readonly string[]).includes(f.section)) this.go(f.section as CrmSection);
    if (!f.id) return;
    if (f.kind === 'order') {
      this.go('Sales Orders');
      const o = this.orders().find(x => x.id === f.id);
      if (o) this.selectOrder(o); else this.error.set(`Sales order ${f.id} was not found in the Legacy CRM.`);
    } else { this.go('Customers'); void this.openCustomer(f.id); }
  }
  async load() {
    this.loading.set(true);
    try {
      const [customers, orders] = await Promise.all([this.api.request<CrmCustomer[]>('source/customers'), this.api.request<CrmOrder[]>('source/orders')]);
      this.customers.set(customers); this.orders.set(orders);
      const sel = this.selected(); if (sel) { const fresh = customers.find(c => c.customerId === sel.customerId); if (fresh && fresh.version !== sel.version) await this.openCustomer(sel.customerId); }
    } catch (e) { this.fail(e); } finally { this.loading.set(false); }
  }
  async openCustomer(id: string) {
    try {
      const detail = await this.api.request<{ customer: CrmCustomer; revisions: CustomerRevision[] | null }>('source/customers/' + encodeURIComponent(id));
      this.selectedOrder.set(null);
      this.selected.set(detail.customer); this.revisions.set(this.toViews(detail.revisions ?? []));
    } catch (e) { this.fail(e); }
  }
  selectOrder(o: CrmOrder) { this.selected.set(null); this.selectedOrder.set(o); }
  ordersFor(customerId: string) { this.selected.set(null); this.orderQuery.set(customerId); this.go('Sales Orders'); }
  orderCount(customerId: string) { return this.orders().filter(o => o.customerId === customerId).length; }
  customerName(id: string) { return this.customers().find(c => c.customerId === id)?.customerName ?? 'Unknown customer'; }
  /** Revisions arrive newest first; compare each with its predecessor to show what changed. */
  private toViews(revs: CustomerRevision[]): RevisionView[] {
    const parsed = revs.map(r => ({ ...r, data: JSON.parse(r.snapshot) }));
    return parsed.map((r, i) => {
      const prev = parsed[i + 1]?.data;
      const changes = prev ? ['customerName', 'email', 'phone', 'status'].filter(k => prev[k] !== r.data[k]).map(k => ({ field: k, from: prev[k], to: r.data[k] })) : [];
      return { version: r.version, changedAt: r.changedAt, changes };
    });
  }
  startCreateCustomer() { this.formError.set(''); this.customerForm.set({ mode: 'create', customerId: '', customerName: '', email: '', phone: '', status: 'Active' }); }
  editCustomer(c: CrmCustomer) { this.formError.set(''); this.customerForm.set({ mode: 'edit', ...c, email: c.email ?? '', phone: c.phone ?? '' }); }
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
  startCreateOrder() { this.formError.set(''); this.orderForm.set({ mode: 'create', id: '', customerId: this.customers()[0]?.customerId, currency: 'USD', amount: 100 }); }
  editOrder(o: CrmOrder) { this.formError.set(''); this.orderForm.set({ mode: 'edit', ...o }); }
  async saveOrder() {
    const f = this.orderForm(); if (!f) return;
    const body = { id: (f.id ?? '').trim().toUpperCase(), customerId: f.customerId, currency: (f.currency ?? '').trim().toUpperCase(), amount: Number(f.amount) };
    await this.act(async () => {
      const saved = f.mode === 'create' ? await this.api.request<CrmOrder>('source/orders', 'POST', body)
        : await this.api.request<CrmOrder>('source/orders/' + encodeURIComponent(body.id), 'PUT', body);
      this.orderForm.set(null); this.notice.set(`Order ${saved.id} saved in the Legacy CRM.`);
      await this.load(); this.go('Sales Orders'); this.selectOrder(saved);
    });
  }
  /** Form errors stay inside the open dialog; other errors show on the page. */
  private async act(work: () => Promise<void>) {
    this.busy.set(true); this.error.set(''); this.formError.set('');
    try { await work(); }
    catch (e) { if (!(e instanceof SessionEnded)) { if (this.customerForm() || this.orderForm()) this.formError.set(errorText(e)); else this.error.set(errorText(e)); } }
    finally { this.busy.set(false); }
  }
  private fail(e: unknown) { if (!(e instanceof SessionEnded)) this.error.set(errorText(e)); }
}
