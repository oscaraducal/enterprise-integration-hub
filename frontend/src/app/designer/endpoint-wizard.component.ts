import { Component, OnInit, computed, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { Api, SessionEnded, errorText } from '../api';
import { ModalComponent } from '../ui';
import { SystemId, TableView } from '../systems';
import { ConnectionView, OperationDef, SchemaRef, roleLabel } from '../connections.component';
import { FunctionDef, ScopeVar } from './flow-model';
import { ExpressionInputComponent } from './expression-input.component';

/** Result of the Invoke wizard: everything the Invoke action stores, plus the contract the designer needs for mapping points. */
export interface InvokeEndpoint {
  connection: string; operationId: string; system: string; table: string | null; operation: string; method: string; path: string;
  key?: string; limit?: number; requestBody: boolean;
}
export interface TriggerEndpoint {
  connection: string;
  endpoint: { name: string; method: string; path: string; parameters: { name: string; type: string; in: 'path' | 'query'; sample?: string }[];
    request: { system: string; table: string } | null; response: { system: string; table: string } | null };
}
const INVOKE_STEPS = ['Connection', 'Operation', 'Business object', 'Request', 'Response', 'Parameters', 'Summary'] as const;
const TRIGGER_STEPS = ['Connection', 'Basic info', 'Resource', 'Request', 'Response', 'Summary'] as const;
const METHOD_HELP: Record<string, string> = { GET: 'Read records. No request body.', POST: 'Create a record. Sends a request body.', PUT: 'Replace or upsert a record. Sends a request body.' };

/**
 * Endpoint configuration wizard, in the spirit of an adapter endpoint wizard: choose a configured connection, then an
 * operation the application genuinely supports, inspect its request and response contracts and set its parameters.
 * Trigger mode defines the inbound REST endpoint of an Application integration (design-time only).
 */
@Component({
  selector: 'app-endpoint-wizard', standalone: true, imports: [CommonModule, FormsModule, MatButtonModule, ModalComponent, ExpressionInputComponent],
  template: `
  <app-modal [label]="mode() === 'invoke' ? 'Invoke endpoint wizard' : 'Trigger endpoint wizard'" [heading]="(mode() === 'invoke' ? 'Configure Invoke: ' : 'Configure Start trigger: ') + actionName()"
    [eyebrow]="'STEP ' + (step() + 1) + ' OF ' + steps().length + ' · ' + steps()[step()].toUpperCase()" [wide]="true" (close)="done.emit(null)">
    <ol class="wizard-steps" aria-label="Wizard steps">@for (s of steps(); track s; let i = $index) { <li [class.done]="i < step()" [class.current]="i === step()" [attr.aria-current]="i === step() ? 'step' : null">{{i + 1}}. {{s}}</li> }</ol>
    @switch (steps()[step()]) {
      @case ('Connection') {
        <div class="choice-grid" role="radiogroup" aria-label="Connection">
          @for (c of connections(); track c.identifier) {
            <button type="button" role="radio" class="choice" [class.selected]="connection()?.identifier === c.identifier" [attr.aria-checked]="connection()?.identifier === c.identifier"
              [disabled]="!fits(c)" (click)="chooseConnection(c)" [attr.aria-label]="c.name + (fits(c) ? '' : ' (role ' + c.role + ')')">
              <b>{{c.name}}</b><small><code>{{c.identifier}}</code> · {{c.applicationName}} · {{roleLabel(c.role)}} · {{c.status}}</small>
              @if (!fits(c)) { <small class="field-warning">Its role is {{roleLabel(c.role)}}; {{mode() === 'invoke' ? 'an Invoke' : 'a trigger'}} needs {{mode() === 'invoke' ? 'Invoke' : 'Trigger'}}.</small> }</button>
          } @empty { <p class="hint">No connections yet. Create one in the Connections workspace first{{mode() === 'invoke' ? ' (role Invoke)' : ' (Integration Hub REST trigger)'}}.</p> }
        </div>
      }
      @case ('Operation') {
        @if (loading()) { <p class="hint">Discovering operations…</p> }
        <div class="choice-grid" role="radiogroup" aria-label="HTTP method">
          @for (m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']; track m) {
            <button type="button" role="radio" class="choice" [class.selected]="method() === m" [attr.aria-checked]="method() === m" [disabled]="!methods().includes(m)" (click)="method.set(m); opId.set('')">
              <b><span [class]="'method ' + m">{{m}}</span></b><small>{{methods().includes(m) ? help(m) : 'Not supported by ' + connection()?.applicationName + '.'}}</small></button>
          }
        </div>
      }
      @case ('Business object') {
        <div class="choice-list" role="radiogroup" aria-label="Business object">
          @for (o of byMethod(); track o.id) {
            <button type="button" role="radio" class="choice row" [class.selected]="opId() === o.id" [attr.aria-checked]="opId() === o.id" (click)="opId.set(o.id)" [attr.aria-label]="o.method + ' ' + o.path">
              <b>{{o.table ?? (o.system | uppercase) + ' catalog'}}</b><code>{{o.method}} {{o.path}}</code><small>{{o.description}}</small></button>
          }
        </div>
      }
      @case ('Request') {
        @if (mode() === 'invoke') { <ng-container *ngTemplateOutlet="schemaTpl; context: { $implicit: op()?.request, label: 'request' }"></ng-container>
          @if (op()?.requestBody) { <p class="hint">An unconfigured request mapping will be placed directly before this Invoke, so you can map the fields into this contract.</p> } }
        @else {
          @if (t.method === 'GET') { <p class="hint">GET endpoints have no request body.</p> }
          @else { <ng-container *ngTemplateOutlet="tablePick; context: { $implicit: 'request' }"></ng-container><p class="hint">The request body is available in the flow as <code>$request</code>.</p> }
        }
      }
      @case ('Response') {
        @if (mode() === 'invoke') { <ng-container *ngTemplateOutlet="schemaTpl; context: { $implicit: op()?.response, label: 'response' }"></ng-container>
          <p class="hint">The output is available as <code>\${{actionName()}}</code>.</p> }
        @else { <ng-container *ngTemplateOutlet="tablePick; context: { $implicit: 'response' }"></ng-container><p class="hint">With a response schema you can add a trigger response mapping before Return.</p> }
      }
      @case ('Parameters') {
        @for (p of op()?.pathParams ?? []; track p.name) {
          <app-expression-input [api]="api()" [label]="'Path parameter {' + p.name + '}'" [variables]="variables()" [functions]="functions()" [value]="key()" (valueChange)="key.set($event)"
            placeholder="e.g. $trigger.customerId"></app-expression-input>
        }
        @for (q of op()?.queryParams ?? []; track q.name) { <label>Query parameter {{q.name}} (1-500)<input type="number" aria-label="Limit" min="1" max="500" [ngModel]="limit()" (ngModelChange)="limit.set($event)"></label> }
        @if (!(op()?.pathParams?.length) && !(op()?.queryParams?.length)) { <p class="hint">This operation has no path or query parameters.</p> }
      }
      @case ('Basic info') {
        <div class="form-grid modal-form">
          <label>Endpoint name<input aria-label="Endpoint name" class="mono" [(ngModel)]="t.name" maxlength="40"></label>
          <label>HTTP method<select aria-label="HTTP method" [ngModel]="t.method" (ngModelChange)="setMethod($event)"><option>GET</option><option>POST</option><option>PUT</option></select></label>
        </div><p class="hint">{{help(t.method)}}</p>
      }
      @case ('Resource') {
        <label>Internal path<input aria-label="Internal path" class="mono" [ngModel]="t.path" (ngModelChange)="t.path = $event; syncParams()" maxlength="100" placeholder="/customers/{customerId}"></label>
        <p class="hint">Relative to this Hub, e.g. <code>/orders/{{'{'}}orderId{{'}'}}</code>. No host or scheme: endpoints are not published in this release.</p>
        <h3>Parameters</h3>
        @for (p of t.parameters; track $index; let i = $index) {
          <div class="param-row"><input [attr.aria-label]="'Parameter ' + (i + 1) + ' name'" class="mono" [(ngModel)]="p.name" [disabled]="p.in === 'path'">
            <select [attr.aria-label]="'Parameter ' + (i + 1) + ' type'" [(ngModel)]="p.type">@for (ty of ['string', 'integer', 'decimal', 'boolean', 'date']; track ty) { <option>{{ty}}</option> }</select>
            <span class="muted small">{{p.in}}</span>
            @if (p.in === 'query') { <button mat-button type="button" (click)="t.parameters.splice(i, 1)" [attr.aria-label]="'Remove parameter ' + (i + 1)">✕</button> } @else { <span></span> }</div>
        }
        <button mat-button type="button" (click)="t.parameters.push({ name: '', type: 'string', in: 'query' })">+ Query parameter</button>
      }
      @case ('Summary') {
        @if (mode() === 'invoke') {
          <dl class="record-dl"><dt>Connection</dt><dd>{{connection()?.name}} (<code>{{connection()?.identifier}}</code>)</dd><dt>Operation</dt><dd><code>{{op()?.method}} {{op()?.path}}</code></dd>
            <dt>Request</dt><dd>{{op()?.request ? 'record of ' + op()!.request!.table : 'none'}}</dd><dt>Response</dt><dd>{{op()?.response ? op()!.response!.kind + ' of ' + (op()!.response!.table ?? 'tables') : 'none'}}</dd>
            @if (op()?.pathParams?.length) { <dt>Key</dt><dd><code>{{key() || '(not set)'}}</code></dd> }
            <dt>Mapping</dt><dd>{{op()?.requestBody ? 'A request mapping is required before this Invoke.' : 'No request mapping needed.'}}</dd></dl>
        } @else {
          <dl class="record-dl"><dt>Connection</dt><dd>{{connection()?.name}}</dd><dt>Endpoint</dt><dd><code>{{t.method}} {{t.path}}</code> ({{t.name}})</dd>
            <dt>Parameters</dt><dd>{{t.parameters.length ? paramText() : 'none'}}</dd><dt>Request</dt><dd>{{t.request ? t.request.system + '.' + t.request.table : 'none'}}</dd>
            <dt>Response</dt><dd>{{t.response ? t.response.system + '.' + t.response.table : 'none'}}</dd><dt>Status</dt><dd>Design-time only: the endpoint is not activated.</dd></dl>
        }
      }
    }
    @if (error()) { <p class="inline-warning flat" role="alert">{{error()}}</p> }
    <div class="form-actions wizard-nav">
      <button mat-button (click)="step.set(step() - 1)" [disabled]="step() === 0">Back</button>
      @if (step() < steps().length - 1) { <button mat-flat-button (click)="next()" [disabled]="!canNext()">Next</button> }
      @else { <button mat-flat-button (click)="finish()">Finish</button> }
      <button mat-button (click)="done.emit(null)">Cancel</button>
    </div>
  </app-modal>
  <ng-template #schemaTpl let-s let-label="label">
    @if (s) { <p class="hint">{{s.kind}} of <b>{{s.table ?? 'catalog tables'}}</b>{{s.system ? ' (' + s.system + ')' : ''}}</p>
      <ul class="schema-list">@for (f of s.fields; track f.name) { <li><code>{{f.name}}</code> <span class="type-tag">{{f.type}}</span>@if (f.required) { <em>required</em> }@if (f.readOnly) { <em>set by application</em> }</li> }</ul> }
    @else { <p class="hint">This operation has no {{label}} body.</p> }
  </ng-template>
  <ng-template #tablePick let-which>
    <div class="form-grid modal-form">
      <label class="check"><input type="checkbox" [attr.aria-label]="'Configure a ' + which + ' schema'" [ngModel]="!!schemaOf(which)" (ngModelChange)="toggleSchema(which, $event)"> Configure a {{which}} schema</label>
      @if (schemaOf(which); as ref) {
        <label>Application<select [attr.aria-label]="which + ' application'" [ngModel]="ref.system" (ngModelChange)="ref.system = $event; ref.table = tablesOf($event)[0]?.name ?? ''"><option value="crm">Legacy CRM</option><option value="erp">Modern ERP</option></select></label>
        <label>Table<select [attr.aria-label]="which + ' table'" [(ngModel)]="ref.table">@for (tb of tablesOf(ref.system); track tb.name) { <option [value]="tb.name">{{tb.name}}</option> }</select></label>
      }
    </div>
  </ng-template>`
})
export class EndpointWizardComponent implements OnInit {
  api = input.required<Api>();
  mode = input<'invoke' | 'trigger'>('invoke');
  actionName = input('callApi');
  connections = input<ConnectionView[]>([]);
  catalogs = input<Record<SystemId, TableView[]>>({ crm: [], erp: [] });
  variables = input<ScopeVar[]>([]);
  functions = input<FunctionDef[]>([]);
  /** Existing configuration when editing. */
  initial = input<Record<string, any> | null>(null);
  done = output<InvokeEndpoint | TriggerEndpoint | null>();
  roleLabel = roleLabel;
  step = signal(0); error = signal(''); loading = signal(false);
  connection = signal<ConnectionView | null>(null); operations = signal<OperationDef[]>([]);
  method = signal('GET'); opId = signal(''); key = signal(''); limit = signal(100);
  t: TriggerEndpoint['endpoint'] = { name: 'start', method: 'POST', path: '/', parameters: [], request: null, response: null };
  steps = computed<readonly string[]>(() => this.mode() === 'invoke' ? INVOKE_STEPS : TRIGGER_STEPS);
  methods = computed(() => [...new Set(this.operations().map(o => o.method))]);
  byMethod = computed(() => this.operations().filter(o => o.method === this.method()));
  op = computed(() => this.operations().find(o => o.id === this.opId()) ?? null);

  async ngOnInit() {
    const i = this.initial();
    if (this.mode() === 'trigger' && i?.['endpoint']) this.t = JSON.parse(JSON.stringify(i['endpoint']));
    if (this.mode() === 'trigger' && !i?.['endpoint']) this.t.name = this.actionName();
    const existing = i?.['connection'] ? this.connections().find(c => c.identifier === i['connection']) : null;
    if (existing && this.fits(existing)) {
      await this.chooseConnection(existing);
      if (this.mode() === 'invoke') {
        const match = this.operations().find(o => o.id === i!['operationId'] || (o.system === i!['system'] && o.table === i!['table'] && o.operation === i!['operation']));
        if (match) { this.method.set(match.method); this.opId.set(match.id); }
        this.key.set(i!['key'] ?? ''); this.limit.set(i!['limit'] ?? 100);
      }
    }
  }
  fits(c: ConnectionView) { const need = this.mode() === 'invoke' ? 'Invoke' : 'Trigger'; return c.role === need || c.role === 'TriggerAndInvoke'; }
  help(m: string) { return METHOD_HELP[m] ?? ''; }
  tablesOf(system: string) { return this.catalogs()[system as SystemId] ?? []; }
  async chooseConnection(c: ConnectionView) {
    this.connection.set(c); this.error.set('');
    if (this.mode() !== 'invoke') return;
    this.loading.set(true); this.operations.set([]); this.opId.set('');
    try {
      const ops = (await this.api().request<{ operations: OperationDef[] }>(`connections/${c.identifier}/operations`)).operations;
      this.operations.set(ops); if (!ops.some(o => o.method === this.method())) this.method.set(ops[0]?.method ?? 'GET');
    } catch (e) { if (!(e instanceof SessionEnded)) this.error.set(errorText(e)); } finally { this.loading.set(false); }
  }
  /** Path parameters always follow the path; query parameters are kept. */
  syncParams() {
    const names = [...this.t.path.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(m => m[1]);
    const query = this.t.parameters.filter(p => p.in === 'query');
    const path = names.map(n => this.t.parameters.find(p => p.in === 'path' && p.name === n) ?? { name: n, type: 'string', in: 'path' as const });
    this.t.parameters = [...path, ...query];
  }
  schemaOf(which: string): { system: string; table: string } | null { return which === 'request' ? this.t.request : this.t.response; }
  toggleSchema(which: string, on: boolean) {
    (this.t as any)[which] = on ? { system: 'crm', table: this.tablesOf('crm')[0]?.name ?? '' } : null;
  }
  setMethod(m: string) { this.t.method = m; if (m === 'GET') this.t.request = null; }
  paramText() { return this.t.parameters.map(p => `${p.name} (${p.in}, ${p.type})`).join(', '); }
  canNext() {
    switch (this.steps()[this.step()]) {
      case 'Connection': return !!this.connection() && this.fits(this.connection()!);
      case 'Operation': return this.methods().includes(this.method());
      case 'Business object': return !!this.op();
      case 'Basic info': return /^[a-z][A-Za-z0-9_]{0,39}$/.test(this.t.name);
      case 'Resource': return /^(\/([a-z0-9][a-z0-9_-]*|\{[A-Za-z][A-Za-z0-9_]{0,39}\}))+$/.test(this.t.path) && this.t.parameters.every(p => /^[a-z][A-Za-z0-9_]{0,39}$/.test(p.name));
      case 'Request': case 'Response': return this.mode() === 'invoke' || ['request', 'response'].every(w => !(this.t as any)[w] || (this.t as any)[w].table);
      default: return true;
    }
  }
  next() {
    this.error.set('');
    if (this.steps()[this.step()] === 'Basic info' && this.t.method === 'GET') this.t.request = null;
    this.step.set(this.step() + 1);
  }
  finish() {
    const c = this.connection()!;
    if (this.mode() === 'invoke') {
      const o = this.op()!;
      const result: InvokeEndpoint = { connection: c.identifier, operationId: o.id, system: o.system!, table: o.table ?? null, operation: o.operation,
        method: o.method, path: o.path, requestBody: o.requestBody };
      if (o.pathParams.length) result.key = this.key();
      if (o.queryParams.some(q => q.name === 'limit')) result.limit = Number(this.limit());
      this.done.emit(result);
    } else this.done.emit({ connection: c.identifier, endpoint: JSON.parse(JSON.stringify(this.t)) });
  }
}
