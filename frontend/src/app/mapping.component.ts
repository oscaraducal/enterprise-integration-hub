import { Component, EventEmitter, Input, OnChanges, OnInit, Output, SimpleChanges, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { Api, ApiError, Focus, SessionEnded, errorText } from './api';
import { CrmCustomer, CrmOrder, MappingSpec, PreviewResult } from './models';
import { SchemaMapperComponent } from './schema-mapper.component';

type MapKind = 'customer' | 'sales-order';

/** Source fields left, transformation rules in the middle, target fields right. Preview never writes or calls the target. */
@Component({
  selector: 'app-mapping', standalone: true, imports: [CommonModule, FormsModule, MatButtonModule, SchemaMapperComponent],
  template: `
  <div class="tabs studio-tabs" role="tablist" aria-label="Mapping Studio mode">
    <button role="tab" [attr.aria-selected]="mode() === 'scenario'" [class.active]="mode() === 'scenario'" (click)="mode.set('scenario')">Scenario mappings (SCN-001…003)</button>
    <button role="tab" [attr.aria-selected]="mode() === 'schema'" [class.active]="mode() === 'schema'" (click)="mode.set('schema')">Schema mapper (Data Catalog)</button>
  </div>
  @if (mode() === 'schema') { <app-schema-mapper [api]="api"></app-schema-mapper> } @else {
  <section class="panel mapper-controls">
    <div class="section-heading"><div><h2>Choose a mapping and a source record</h2><p class="hint">Rules come from the middleware's C# mapping, the same code the integration runs. Preview is read-only: it creates no execution, writes nothing and never calls the Modern ERP.</p></div></div>
    <div class="mapper-pickers">
      <label>Mapping<select aria-label="Mapping" [ngModel]="kind()" (ngModelChange)="setKind($event)" name="mk">
        <option value="customer">Customer master · SCN-001 / SCN-003</option><option value="sales-order">Sales order · SCN-002</option></select></label>
      <label>Source record<select aria-label="Source record" [ngModel]="sourceId()" (ngModelChange)="pick($event)" name="msrc">
        <option value="">Custom JSON…</option>
        @for (id of sourceIds(); track id) { <option [value]="id">{{id}}</option> }</select></label>
      <div class="mapper-buttons"><button mat-flat-button (click)="preview()" [disabled]="busy()">Preview mapping</button>
        @if (api.operator() && sourceId() && result()?.valid) { <button mat-stroked-button (click)="run()" [disabled]="busy()">Run this integration</button> }</div>
    </div>
  </section>
  @if (error()) { <div class="alert error" role="alert">{{error()}} @if (conflictId()) { <button class="link-button" (click)="inspect.emit(conflictId()!)">Open execution</button> } <button (click)="error.set('')" aria-label="Dismiss error">×</button></div> }

  @if (spec(); as s) {
    <section class="panel mapper" aria-label="Field mapping">
      <div class="mapper-head"><div><span class="system-tag source-tag">SOURCE</span><b>{{s.source}}</b></div><div class="center">Transformation</div><div><span class="system-tag target-tag">TARGET</span><b>{{s.target}}</b></div></div>
      @for (m of s.fields; track m.sourceField) {
        <div class="map-row" [class.has-error]="errorFor(m.sourceField)">
          <div class="field source-field"><code>{{m.sourceField}}</code><span>{{m.sourceType}}</span>@if (m.sourceRequired) { <em>required</em> }
            @if (result()) { <output>{{show(result()!.input?.[m.sourceField])}}</output> }</div>
          <div class="rule" [attr.aria-label]="'Rule: ' + m.rule"><span class="line"></span><span class="fn">{{m.rule}}</span><span class="line arrow"></span>
            <small>{{m.description}}</small></div>
          <div class="field target-field"><code>{{m.targetField}}</code><span>{{m.targetType}}</span>@if (m.targetRequired) { <em>required</em> }
            @if (result()) { <output>{{result()!.valid ? show(result()!.output?.[m.targetField]) : '—'}}</output> }</div>
          @if (errorFor(m.sourceField); as e) { <p class="map-error" role="alert">{{e}}</p> }
        </div>
      }
    </section>
  }

  <section class="detail-grid json-grid">
    <div class="panel json-panel"><div class="section-heading"><h3>Input JSON (source)</h3><span class="muted">{{sourceId() ? 'GET from Legacy CRM' : 'Editable'}}</span></div>
      <textarea aria-label="Source JSON" [ngModel]="inputText()" (ngModelChange)="inputText.set($event)" name="injson" spellcheck="false" [readonly]="!!sourceId()"></textarea></div>
    <div class="panel json-panel"><div class="section-heading"><h3>Output JSON (target)</h3>
      @if (result(); as r) { <span class="pill" [class]="r.valid ? 'pill Completed' : 'pill Failed'">{{r.valid ? 'Valid' : r.errors.length + ' validation error(s)'}}</span> }</div>
      <pre tabindex="0" aria-label="Mapped target JSON">{{result()?.valid ? (result()!.output | json) : result() ? 'Not produced: fix the validation errors.' : 'Click Preview mapping.'}}</pre>
      @if (result(); as r) {
        @for (e of r.errors; track e.field + e.message) { <p class="inline-warning flat"><b>{{e.field}}</b>: {{e.message}}</p> }
        @for (n of r.notes; track n) { <p class="hint">{{n}}</p> }
      }</div>
  </section>
  }`
})
export class MappingComponent implements OnInit, OnChanges {
  @Input({ required: true }) api!: Api;
  @Input() focus: Focus | null = null;
  @Output() inspect = new EventEmitter<string>();
  /** Scenario mappings are the C# rules the running integrations use; the schema mapper builds new, versioned definitions. */
  mode = signal<'scenario' | 'schema'>('scenario');
  kind = signal<MapKind>('customer');
  specs = signal<{ customer: MappingSpec; salesOrder: MappingSpec } | null>(null);
  spec = signal<MappingSpec | null>(null);
  customers: CrmCustomer[] = []; orders: CrmOrder[] = [];
  sourceIds = signal<string[]>([]); sourceId = signal('');
  inputText = signal(''); result = signal<PreviewResult | null>(null);
  busy = signal(false); error = signal(''); conflictId = signal<string | null>(null);

  async ngOnInit() {
    try {
      const [specs, customers, orders] = await Promise.all([
        this.api.request<{ customer: MappingSpec; salesOrder: MappingSpec }>('mappings'),
        this.api.request<CrmCustomer[]>('source/customers'), this.api.request<CrmOrder[]>('source/orders')]);
      this.specs.set(specs); this.customers = customers; this.orders = orders;
      this.applyFocus();
      if (!this.sourceId()) this.setKind(this.kind());
    } catch (e) { this.fail(e); }
  }
  ngOnChanges(changes: SimpleChanges) { if (changes['focus'] && !changes['focus'].firstChange && this.specs()) this.applyFocus(); }
  private applyFocus() {
    const f = this.focus; if (!f?.id) return;
    this.mode.set('scenario');
    this.setKind(f.kind === 'order' ? 'sales-order' : 'customer', f.id);
    void this.preview();
  }
  setKind(kind: MapKind, select?: string) {
    this.kind.set(kind); this.result.set(null);
    const specs = this.specs(); if (!specs) return;
    this.spec.set(kind === 'customer' ? specs.customer : specs.salesOrder);
    this.sourceIds.set(kind === 'customer' ? this.customers.map(c => c.customerId) : this.orders.map(o => o.id));
    this.pick(select && this.sourceIds().includes(select) ? select : this.sourceIds()[0] ?? '');
  }
  pick(id: string) {
    this.sourceId.set(id); this.result.set(null);
    const record = this.kind() === 'customer' ? this.customers.find(c => c.customerId === id) : this.orders.find(o => o.id === id);
    if (record) this.inputText.set(JSON.stringify(record, null, 2));
    else if (!id) this.inputText.set(JSON.stringify(this.kind() === 'customer'
      ? { customerId: 'C-900', customerName: '  Custom  Preview Co ', email: 'Team@Preview.example', phone: '+1 (555) 019-0000', status: 'OnHold', version: 1 }
      : { id: 'ORD-900', customerId: 'C-100', currency: 'PHP', amount: 1234.565 }, null, 2));
  }
  async preview() {
    this.busy.set(true); this.error.set(''); this.conflictId.set(null);
    try {
      let body: unknown;
      if (this.sourceId()) body = { sourceId: this.sourceId() };
      else { try { body = { source: JSON.parse(this.inputText()) }; } catch { this.error.set('Input JSON is not valid JSON.'); return; } }
      this.result.set(await this.api.request<PreviewResult>(`mappings/${this.kind()}/preview`, 'POST', body));
      // Show the record exactly as the CRM API returned it.
      if (this.sourceId() && this.result()) this.inputText.set(JSON.stringify(this.result()!.input, null, 2));
    } catch (e) { this.fail(e); } finally { this.busy.set(false); }
  }
  async run() {
    this.busy.set(true); this.error.set('');
    try {
      const r = await this.api.request<{ id: string }>('executions', 'POST',
        { kind: this.kind() === 'customer' ? 'CustomerSync' : 'SalesOrder', sourceId: this.sourceId(), environment: 'DEV', scenario: 'None' });
      this.inspect.emit(r.id);
    } catch (e) { this.fail(e); } finally { this.busy.set(false); }
  }
  errorFor(sourceField: string) { return this.result()?.errors.filter(e => e.field === sourceField).map(e => e.message).join(' ') || ''; }
  show(v: unknown) { return v === null || v === undefined ? 'null' : typeof v === 'string' ? `"${v}"` : String(v); }
  private fail(e: unknown) {
    if (e instanceof SessionEnded) return;
    this.error.set(errorText(e)); this.conflictId.set(e instanceof ApiError ? e.body?.executionId ?? null : null);
  }
}
