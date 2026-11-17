import { Component, OnInit, computed, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { Api, ApiError, SessionEnded, errorText } from './api';
import { ModalComponent } from './ui';
import { ColumnDef } from './systems';

export interface ApplicationDef {
  id: string; name: string; adapter: string; supportedRoles: string[]; connectionRoles: string[]; description: string; security: string; endpoint: string;
  unsupportedRoles: { role: string; reason: string }[];
}
export interface SchemaRef { kind: 'record' | 'collection'; system?: string | null; table?: string | null; fields: ColumnDef[] }
export interface ParamDef { name: string; type: string; required: boolean; description: string }
export interface OperationDef {
  id: string; method: string; path: string; operation: string; system?: string | null; table?: string | null; requestBody: boolean;
  request?: SchemaRef | null; response?: SchemaRef | null; pathParams: ParamDef[]; queryParams: ParamDef[]; description: string;
}
export interface ConnectionView {
  identifier: string; name: string; description?: string | null; adapter: string; role: string; application: string; applicationName?: string;
  status: string; lastTestedAt?: string | null; lastTestSummary?: string | null; revision: number; createdBy: string; updatedAt: string; security?: string;
}
interface TestResult { ok: boolean; checks: { name: string; ok: boolean; ms: number; detail: string }[] }
const STEPS = ['Name', 'Adapter', 'Role', 'Application', 'Operations', 'Schemas', 'Security', 'Test', 'Save'] as const;
export const roleLabel = (r: string) => r === 'TriggerAndInvoke' ? 'Trigger and Invoke' : r;
export const toIdentifier = (name: string) => name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'C_$1').slice(0, 50);

/**
 * Connections workspace: reusable connections to approved internal applications. The wizard never asks for a URL or a
 * credential: the Hub resolves both. Tests are safe health and metadata reads.
 */
@Component({
  selector: 'app-connections', standalone: true, imports: [CommonModule, FormsModule, MatButtonModule, ModalComponent],
  template: `
  @if (error()) { <div class="alert error" role="alert">{{error()}} <button (click)="error.set('')" aria-label="Dismiss error">×</button></div> }
  @if (notice()) { <div class="alert success" role="status">{{notice()}} <button (click)="notice.set('')" aria-label="Dismiss notification">×</button></div> }
  <section class="panel">
    <div class="section-heading"><div><h2>Connections</h2><p class="hint">Reusable, tested connections to the approved internal applications. Integrations choose a connection; the Hub resolves its address and credentials, which never reach the browser.</p></div>
      @if (api().operator()) { <button mat-flat-button (click)="startWizard()">+ Create connection</button> }</div>
    <div class="table-scroll" tabindex="0" role="region" aria-label="Connections table, scrolls horizontally">
      <table><thead><tr><th scope="col">Connection</th><th scope="col">Adapter</th><th scope="col">Role</th><th scope="col">Application</th><th scope="col">Status</th><th scope="col">Last tested</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>@for (c of connections(); track c.identifier) {
          <tr><td><b>{{c.name}}</b><small><code>{{c.identifier}}</code></small></td><td>{{c.adapter}}</td><td>{{roleLabel(c.role)}}</td><td>{{c.applicationName}}</td>
            <td><span [class]="'pill ' + (c.status === 'Configured' ? 'Completed' : c.status === 'Failed' ? 'Failed' : 'Pending')">{{c.status}}</span></td>
            <td>{{c.lastTestedAt ? (c.lastTestedAt | date:'MMM d, HH:mm') : '—'}}</td>
            <td><button mat-button (click)="open(c)" [attr.aria-label]="'Open connection ' + c.identifier">Open ↗</button></td></tr>
        } @empty { <tr><td colspan="7" class="empty"><strong>No connections yet</strong><p>{{api().operator() ? 'Create one for the Legacy CRM, the Modern ERP, the Data Catalog or the Hub trigger.' : 'An Operator can create connections.'}}</p></td></tr> }</tbody></table></div>
  </section>

  @if (detail(); as d) {
    <app-modal label="Connection details" [heading]="d.connection.name" eyebrow="CONNECTION" [wide]="true" (close)="detail.set(null)">
      <div class="modal-actions">
        @if (api().operator()) {
          <button mat-stroked-button (click)="testSaved(d.connection)" [disabled]="busy()">Test</button>
          <button mat-button (click)="editing.set({ name: d.connection.name, description: d.connection.description ?? '', role: d.connection.role })">Edit</button>
          @if (confirmDelete()) { <button mat-flat-button (click)="remove(d.connection)" [disabled]="busy()">Confirm delete</button><button mat-button (click)="confirmDelete.set(false)">Keep</button> }
          @else { <button mat-button (click)="confirmDelete.set(true)">Delete</button> }
        }
      </div>
      @if (detailError()) { <p class="inline-warning flat" role="alert">{{detailError()}}</p> }
      @if (editing(); as e) {
        <form class="form-grid modal-form" (ngSubmit)="saveEdit(d.connection)" aria-label="Edit connection">
          <label>Name<input name="en" [(ngModel)]="e.name" maxlength="80" required></label>
          <label>Description<input name="ed" [(ngModel)]="e.description" maxlength="300"></label>
          <label>Role<select name="er" [(ngModel)]="e.role">@for (r of appOf(d.connection.application)?.connectionRoles ?? []; track r) { <option [value]="r">{{roleLabel(r)}}</option> }</select></label>
          <div class="form-actions"><button mat-flat-button type="submit" [disabled]="busy()">Save</button><button mat-button type="button" (click)="editing.set(null)">Cancel</button></div>
        </form>
      }
      <dl class="record-dl"><dt>Identifier</dt><dd><code>{{d.connection.identifier}}</code></dd><dt>Adapter</dt><dd>{{d.connection.adapter}}</dd>
        <dt>Role</dt><dd>{{roleLabel(d.connection.role)}}</dd><dt>Application</dt><dd>{{d.connection.applicationName}}</dd>
        <dt>Endpoint</dt><dd>{{appOf(d.connection.application)?.endpoint}}</dd><dt>Security</dt><dd>{{d.connection.security}}</dd>
        <dt>Status</dt><dd>{{d.connection.status}}{{d.connection.lastTestSummary ? ' · ' + d.connection.lastTestSummary : ''}}</dd>
        <dt>Used by</dt><dd>{{d.usage.length ? d.usage.join(', ') : 'No integrations yet'}}</dd></dl>
      @if (test(); as t) { <ng-container *ngTemplateOutlet="testTpl; context: { $implicit: t }"></ng-container> }
      <h3>Operations</h3>
      <ng-container *ngTemplateOutlet="opsTpl; context: { $implicit: ops() }"></ng-container>
    </app-modal>
  }

  @if (wizard(); as w) {
    <app-modal label="Create connection" heading="Create connection" [eyebrow]="'STEP ' + (step() + 1) + ' OF ' + steps.length + ' · ' + steps[step()].toUpperCase()" [wide]="true" (close)="wizard.set(null)">
      <ol class="wizard-steps" aria-label="Wizard steps">@for (s of steps; track s; let i = $index) { <li [class.done]="i < step()" [class.current]="i === step()" [attr.aria-current]="i === step() ? 'step' : null">{{i + 1}}. {{s}}</li> }</ol>
      @switch (steps[step()]) {
        @case ('Name') {
          <div class="form-grid modal-form">
            <label>Name<input aria-label="Connection name" [ngModel]="w.name" (ngModelChange)="setName(w, $event)" maxlength="80"></label>
            <label>Identifier<input aria-label="Connection identifier" class="mono" [ngModel]="w.identifier" (ngModelChange)="w.identifier = $event.toUpperCase(); w.idEdited = true" maxlength="50"></label>
            <label class="full">Description<input aria-label="Connection description" [(ngModel)]="w.description" maxlength="300"></label>
          </div><p class="hint">The identifier is generated from the name in upper case. Integrations reference connections by identifier.</p>
        }
        @case ('Adapter') {
          <div class="choice-grid" role="radiogroup" aria-label="Adapter">
            <button type="button" role="radio" class="choice" [class.selected]="true" aria-checked="true"><b>REST</b><small>JSON over HTTP to the internal applications.</small></button>
            @for (a of ['SOAP', 'FTP', 'Database']; track a) { <button type="button" role="radio" class="choice" disabled aria-checked="false"><b>{{a}}</b><small>Not available: this practice environment uses internal REST APIs only.</small></button> }
          </div>
        }
        @case ('Role') {
          <div class="choice-grid" role="radiogroup" aria-label="Role">
            @for (r of ['Trigger', 'Invoke', 'TriggerAndInvoke']; track r) {
              <button type="button" role="radio" class="choice" [class.selected]="w.role === r" [attr.aria-checked]="w.role === r" (click)="w.role = r; w.application = ''">
                <b>{{roleLabel(r)}}</b><small>{{r === 'Trigger' ? 'Starts integrations (inbound endpoint).' : r === 'Invoke' ? 'Called by integrations (outbound operations).' : 'Both, where an application supports it.'}}</small></button>
            }
          </div>
        }
        @case ('Application') {
          <div class="choice-grid" role="radiogroup" aria-label="Application">
            @for (a of applications(); track a.id) {
              <button type="button" role="radio" class="choice" [class.selected]="w.application === a.id" [attr.aria-checked]="w.application === a.id"
                [disabled]="!a.connectionRoles.includes(w.role)" (click)="w.application = a.id; loadOps(a.id)" [attr.aria-label]="a.name + (a.connectionRoles.includes(w.role) ? '' : ' (not available for this role)')">
                <b>{{a.name}}</b><small>{{a.connectionRoles.includes(w.role) ? a.description : reason(a, w.role)}}</small></button>
            }
          </div><p class="hint">Only approved internal applications are offered. You cannot enter a URL.</p>
        }
        @case ('Operations') {
          @if (w.application === 'integration-hub') { <p class="hint">A trigger connection has no outbound operations. Each integration defines its inbound endpoint (method, path, request and response) in its Start trigger wizard.</p> }
          @else { <ng-container *ngTemplateOutlet="opsTpl; context: { $implicit: ops() }"></ng-container> }
        }
        @case ('Schemas') {
          @if (w.application === 'integration-hub') { <p class="hint">Request and response schemas are chosen per endpoint from the Data Catalog tables.</p> }
          @else {
            <label>Inspect an operation<select aria-label="Inspect operation" [ngModel]="schemaOp()?.id" (ngModelChange)="schemaOpId.set($event)">@for (o of ops(); track o.id) { <option [value]="o.id">{{o.method}} {{o.path}}</option> }</select></label>
            @if (schemaOp(); as o) { <div class="detail-grid"><div><h3>Request</h3><ng-container *ngTemplateOutlet="schemaTpl; context: { $implicit: o.request }"></ng-container></div>
              <div><h3>Response</h3><ng-container *ngTemplateOutlet="schemaTpl; context: { $implicit: o.response }"></ng-container></div></div> }
          }
        }
        @case ('Security') {
          <dl class="record-dl"><dt>Policy</dt><dd>{{appOf(w.application)?.security}}</dd><dt>Endpoint</dt><dd>{{appOf(w.application)?.endpoint}}</dd>
            <dt>Credentials in the browser</dt><dd>None. Keys and signing secrets stay in the Hub.</dd></dl>
        }
        @case ('Test') {
          <p class="hint">The test reads service health and catalog metadata only. It does not read or write business data.</p>
          <button mat-stroked-button (click)="testDraft(w.application)" [disabled]="busy()">Test connection</button>
          @if (test(); as t) { <ng-container *ngTemplateOutlet="testTpl; context: { $implicit: t }"></ng-container> }
        }
        @case ('Save') {
          <dl class="record-dl"><dt>Name</dt><dd>{{w.name}}</dd><dt>Identifier</dt><dd><code>{{w.identifier}}</code></dd><dt>Adapter</dt><dd>REST</dd>
            <dt>Role</dt><dd>{{roleLabel(w.role)}}</dd><dt>Application</dt><dd>{{appOf(w.application)?.name}}</dd><dt>Test</dt><dd>{{test() ? (test()!.ok ? 'Passed' : 'Failed') : 'Not run (you can test after saving)'}}</dd></dl>
        }
      }
      @if (wizardError()) { <p class="inline-warning flat" role="alert">{{wizardError()}}</p> }
      <div class="form-actions wizard-nav">
        <button mat-button (click)="back()" [disabled]="step() === 0">Back</button>
        @if (step() < steps.length - 1) { <button mat-flat-button (click)="next()" [disabled]="!canNext()">Next</button> }
        @else { <button mat-flat-button (click)="save()" [disabled]="busy()">Save connection</button> }
      </div>
    </app-modal>
  }

  <ng-template #opsTpl let-ops>
    <div class="table-scroll" tabindex="0" role="region" aria-label="Operations table, scrolls horizontally">
      <table><thead><tr><th scope="col">Method</th><th scope="col">Path</th><th scope="col">Request</th><th scope="col">Response</th></tr></thead>
        <tbody>@for (o of ops; track o.id) {
          <tr><td><span [class]="'method ' + o.method">{{o.method}}</span></td><td><code>{{o.path}}</code><small>{{o.description}}</small></td>
            <td>{{o.request ? o.request.table + ' (' + o.request.fields.length + ' fields)' : 'none'}}</td><td>{{o.response ? o.response.kind + ' of ' + (o.response.table ?? 'tables') : 'none'}}</td></tr>
        } @empty { <tr><td colspan="4" class="empty">{{opsLoading() ? 'Discovering operations…' : 'No outbound operations.'}}</td></tr> }</tbody></table></div>
  </ng-template>
  <ng-template #schemaTpl let-s>
    @if (s) { <p class="hint">{{s.kind}}{{s.table ? ' of ' + s.system + '.' + s.table : ''}}</p>
      <ul class="schema-list">@for (f of s.fields; track f.name) { <li><code>{{f.name}}</code> <span class="type-tag">{{f.type}}</span>@if (f.required) { <em>required</em> }</li> }</ul> }
    @else { <p class="hint">No body.</p> }
  </ng-template>
  <ng-template #testTpl let-t>
    <div class="test-result" role="status"><b [class]="t.ok ? 'ok-text' : 'field-error'">{{t.ok ? 'Connection test passed' : 'Connection test failed'}}</b>
      <ul>@for (c of t.checks; track c.name) { <li>{{c.ok ? '✓' : '✗'}} {{c.name}}: {{c.detail}} ({{c.ms}} ms)</li> }</ul></div>
  </ng-template>`
})
export class ConnectionsComponent implements OnInit {
  api = input.required<Api>();
  readonly steps = STEPS; roleLabel = roleLabel; toIdentifier = toIdentifier;
  applications = signal<ApplicationDef[]>([]); connections = signal<ConnectionView[]>([]);
  detail = signal<{ connection: ConnectionView; usage: string[] } | null>(null);
  editing = signal<{ name: string; description: string; role: string } | null>(null);
  wizard = signal<{ name: string; identifier: string; idEdited: boolean; description: string; role: string; application: string } | null>(null);
  step = signal(0); ops = signal<OperationDef[]>([]); opsLoading = signal(false); test = signal<TestResult | null>(null);
  schemaOpId = signal(''); schemaOp = computed<OperationDef | null>(() => this.ops().find(o => o.id === this.schemaOpId()) ?? this.ops().find(o => o.requestBody) ?? this.ops()[0] ?? null);
  confirmDelete = signal(false);
  setName(w: { name: string; identifier: string; idEdited: boolean }, name: string) { w.name = name; if (!w.idEdited) w.identifier = toIdentifier(name); }
  busy = signal(false); error = signal(''); notice = signal(''); wizardError = signal(''); detailError = signal('');

  async ngOnInit() {
    try {
      const [apps, conns] = await Promise.all([this.api().request<ApplicationDef[]>('connections/applications'), this.api().request<ConnectionView[]>('connections')]);
      this.applications.set(apps); this.connections.set(conns);
    } catch (e) { this.fail(e); }
  }
  async reload() { this.connections.set(await this.api().request<ConnectionView[]>('connections')); }
  appOf(id: string) { return this.applications().find(a => a.id === id) ?? null; }
  reason(a: ApplicationDef, role: string) { return a.unsupportedRoles.find(r => r.role === role)?.reason ?? 'Not available for this role.'; }
  startWizard() {
    this.wizard.set({ name: '', identifier: '', idEdited: false, description: '', role: 'Invoke', application: '' });
    this.step.set(0); this.ops.set([]); this.test.set(null); this.wizardError.set('');
  }
  canNext() {
    const w = this.wizard()!;
    switch (this.steps[this.step()]) {
      case 'Name': return !!w.name.trim() && /^[A-Z][A-Z0-9_]{1,49}$/.test(w.identifier);
      case 'Application': return !!w.application;
      default: return true;
    }
  }
  next() { this.wizardError.set(''); this.step.set(Math.min(this.step() + 1, this.steps.length - 1)); }
  back() { this.wizardError.set(''); this.step.set(Math.max(this.step() - 1, 0)); }
  async loadOps(app: string) {
    this.ops.set([]); this.test.set(null); this.opsLoading.set(true);
    try { this.ops.set((await this.api().request<{ operations: OperationDef[] }>(`connections/applications/${app}/operations`)).operations); }
    catch (e) { if (!(e instanceof SessionEnded)) this.wizardError.set(errorText(e)); } finally { this.opsLoading.set(false); }
  }
  async testDraft(app: string) {
    this.busy.set(true);
    try { this.test.set(await this.api().request<TestResult>(`connections/applications/${app}/test`, 'POST', {})); }
    catch (e) { if (!(e instanceof SessionEnded)) this.wizardError.set(errorText(e)); } finally { this.busy.set(false); }
  }
  async save() {
    const w = this.wizard()!; this.busy.set(true); this.wizardError.set('');
    try {
      await this.api().request('connections', 'POST', { identifier: w.identifier, name: w.name.trim(), description: w.description || null, adapter: 'REST', role: w.role, application: w.application });
      if (this.test()?.ok) await this.api().request(`connections/${w.identifier}/test`, 'POST', {});
      this.wizard.set(null); await this.reload();
      this.notice.set(`Connection ${w.identifier} saved${this.test()?.ok ? ' and tested' : ''}. Integrations can now use it.`);
    } catch (e) { if (!(e instanceof SessionEnded)) this.wizardError.set(errorText(e)); } finally { this.busy.set(false); }
  }
  async open(c: ConnectionView) {
    this.test.set(null); this.editing.set(null); this.detailError.set(''); this.ops.set([]); this.confirmDelete.set(false);
    try {
      this.detail.set(await this.api().request<{ connection: ConnectionView; usage: string[] }>('connections/' + c.identifier));
      this.opsLoading.set(true);
      this.ops.set((await this.api().request<{ operations: OperationDef[] }>(`connections/${c.identifier}/operations`)).operations);
    } catch (e) { this.detailError.set(errorText(e)); } finally { this.opsLoading.set(false); }
  }
  async testSaved(c: ConnectionView) {
    this.busy.set(true); this.detailError.set('');
    try {
      const r = await this.api().request<TestResult & { connection: ConnectionView }>(`connections/${c.identifier}/test`, 'POST', {});
      this.test.set(r); this.detail.set({ ...this.detail()!, connection: r.connection }); await this.reload();
    } catch (e) { this.detailError.set(errorText(e)); } finally { this.busy.set(false); }
  }
  async saveEdit(c: ConnectionView) {
    const e = this.editing()!; this.busy.set(true); this.detailError.set('');
    try {
      const updated = await this.api().request<ConnectionView>('connections/' + c.identifier, 'PUT', { name: e.name, description: e.description || null, role: e.role, revision: c.revision });
      this.editing.set(null); this.detail.set({ ...this.detail()!, connection: updated }); await this.reload();
    } catch (err) { this.detailError.set(err instanceof ApiError && err.body?.usage ? `${err.message}` : errorText(err)); } finally { this.busy.set(false); }
  }
  async remove(c: ConnectionView) {
    this.busy.set(true); this.detailError.set('');
    try { await this.api().request('connections/' + c.identifier, 'DELETE'); this.detail.set(null); await this.reload(); this.notice.set(`Connection ${c.identifier} deleted.`); }
    catch (e) { this.detailError.set(errorText(e)); } finally { this.busy.set(false); }
  }
  private fail(e: unknown) { if (!(e instanceof SessionEnded)) this.error.set(errorText(e)); }
}
