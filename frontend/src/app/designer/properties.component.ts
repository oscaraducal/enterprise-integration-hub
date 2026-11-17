import { Component, OnChanges, SimpleChanges, computed, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { Api } from '../api';
import { SystemId, TableView } from '../systems';
import { ActionDef, FlowIssue, FlowNode, FunctionDef, ScopeVar, clone, fieldsOf, newBranchId, operationsFor } from './flow-model';
import { ExpressionInputComponent } from './expression-input.component';
import { FieldMapperComponent, FieldRule } from './field-mapper.component';

/** Configuration panel for the selected action. Edits are emitted as a whole updated node; the designer records undo history. */
@Component({
  selector: 'app-node-properties', standalone: true, imports: [CommonModule, FormsModule, MatButtonModule, ExpressionInputComponent, FieldMapperComponent],
  template: `
  @if (n(); as node) {
    <div class="props" [attr.aria-label]="'Properties of ' + node.name">
      <header><span class="eyebrow">{{def()?.label | uppercase}} · {{def()?.category}}</span><h2>{{node.name}}</h2><p class="hint">{{def()?.description}}</p></header>
      @if (readOnly()) { <p class="inline-warning flat">Viewing as Viewer: properties are read-only.</p> }
      @if (notice()) { <p class="inline-warning flat" role="alert">{{notice()}}</p> }
      <fieldset [disabled]="readOnly()">
        <label>Name (also its output variable)<input aria-label="Action name" [ngModel]="node.name" (ngModelChange)="set('name', $event)" maxlength="40" class="mono"></label>
        <label>Description<textarea aria-label="Action description" rows="2" [ngModel]="node.description" (ngModelChange)="set('description', $event)" maxlength="500"></textarea></label>
        @switch (node.type) {
          @case ('trigger') {
            <h3>Parameters</h3>
            @for (p of node.config['parameters']; track $index; let i = $index) {
              <div class="param-row">
                <input [attr.aria-label]="'Parameter ' + (i + 1) + ' name'" [ngModel]="p.name" (ngModelChange)="p.name = $event; emit()" placeholder="name" class="mono">
                <select [attr.aria-label]="'Parameter ' + (i + 1) + ' type'" [ngModel]="p.type" (ngModelChange)="p.type = $event; emit()">@for (t of paramTypes; track t) { <option>{{t}}</option> }</select>
                <input [attr.aria-label]="'Parameter ' + (i + 1) + ' sample'" [ngModel]="p.sample" (ngModelChange)="p.sample = $event; emit()" placeholder="sample">
                <button mat-button type="button" (click)="node.config['parameters'].splice(i, 1); emit()" [attr.aria-label]="'Remove parameter ' + (i + 1)">✕</button>
              </div>
            }
            <button mat-button type="button" (click)="node.config['parameters'].push({ name: '', type: 'string', required: true, sample: '' }); emit()">+ Parameter</button>
            <p class="hint">Referenced as <code>$trigger.name</code>. Milestone D runs the flow manually with these sample values.</p>
          }
          @case ('invoke') {
            <label>Application<select aria-label="Application" [ngModel]="node.config['system']" (ngModelChange)="node.config['system'] = $event; node.config['table'] = tablesOf($event)[0]?.name ?? ''; fixOperation(); emit()">
              <option value="crm">Legacy CRM</option><option value="erp">Modern ERP</option></select></label>
            <label>Table<select aria-label="Table" [ngModel]="node.config['table']" (ngModelChange)="node.config['table'] = $event; fixOperation(); emit()">
              @for (t of tablesOf(node.config['system']); track t.name) { <option [value]="t.name">{{t.name}}{{t.builtIn ? '' : ' (logical)'}}</option> }</select></label>
            <label>Operation<select aria-label="Operation" [ngModel]="node.config['operation']" (ngModelChange)="node.config['operation'] = $event; emit()">
              @for (o of operations(); track o) { <option>{{o}}</option> }</select></label>
            @if (node.config['operation'] === 'get' || node.config['operation'] === 'update') {
              <app-expression-input [api]="api()" label="Key" [variables]="variables()" [functions]="functions()" [value]="node.config['key'] ?? ''" (valueChange)="node.config['key'] = $event; emit()"></app-expression-input>
            }
            @if (node.config['operation'] === 'list') { <label>Limit<input type="number" aria-label="Limit" min="1" max="500" [ngModel]="node.config['limit'] ?? 100" (ngModelChange)="node.config['limit'] = $event; emit()"></label> }
            @if (['create', 'update', 'upsert'].includes(node.config['operation'])) {
              <label>Input variable<select aria-label="Input variable" [ngModel]="node.config['input']" (ngModelChange)="node.config['input'] = $event; emit()">
                <option value="">— choose —</option>@for (v of tableVars(); track v.name) { <option [value]="v.name">\${{v.name}} ({{v.table?.name}})</option> }</select></label>
              <p class="hint">Sends a record shaped like <code>{{node.config['table']}}</code>, usually a Map output. Nothing is sent while designing.</p>
            }
            <p class="hint">Output <code>\${{node.name}}</code>: {{node.config['operation'] === 'list' ? 'a collection of records' : 'one record'}}.</p>
          }
          @case ('assign') {
            @for (a of node.config['assignments']; track $index; let i = $index) {
              <div class="assign-row">
                <label>Variable<input [attr.aria-label]="'Variable ' + (i + 1)" [ngModel]="a.variable" (ngModelChange)="a.variable = $event; emit()" maxlength="40" class="mono"></label>
                <app-expression-input [api]="api()" [label]="'Value of ' + (a.variable || 'variable ' + (i + 1))" [variables]="variables()" [functions]="functions()" [value]="a.expression" (valueChange)="a.expression = $event; emit()"></app-expression-input>
                <button mat-button type="button" (click)="node.config['assignments'].splice(i, 1); emit()" [attr.aria-label]="'Remove assignment ' + (i + 1)">Remove</button>
              </div>
            }
            <button mat-button type="button" (click)="node.config['assignments'].push({ variable: '', expression: '' }); emit()">+ Assignment</button>
          }
          @case ('map') {
            <label>Input variable<select aria-label="Input variable" [ngModel]="node.config['input']" (ngModelChange)="node.config['input'] = $event; emit()">
              <option value="">— choose —</option>@for (v of tableVars(); track v.name) { <option [value]="v.name">\${{v.name}} ({{v.kind}} of {{v.table?.name}})</option> }</select></label>
            <label>Target application<select aria-label="Target application" [ngModel]="node.config['targetSystem']" (ngModelChange)="node.config['targetSystem'] = $event; node.config['targetTable'] = ''; emit()">
              <option value="crm">Legacy CRM</option><option value="erp">Modern ERP</option></select></label>
            <label>Target table<select aria-label="Target table" [ngModel]="node.config['targetTable']" (ngModelChange)="node.config['targetTable'] = $event; emit()">
              <option value="">— choose —</option>@for (t of tablesOf(node.config['targetSystem']); track t.name) { <option [value]="t.name">{{t.name}}</option> }</select></label>
            <div class="map-summary"><b>{{(node.config['rules'] ?? []).length}}</b> field rule(s)
              <button mat-flat-button type="button" (click)="openMapper()" [disabled]="!mapperReady()">Open field mapper</button></div>
            @if (!mapperReady()) { <p class="hint">Choose an input variable with a table schema and a target table to open the mapper.</p> }
            <ul class="rule-list">@for (r of node.config['rules'] ?? []; track r.target) { <li><code>{{r.target}}</code> ← {{r.transform}}({{r.source ?? (r.sources ?? []).join(' + ') ?? r.value}})</li> }</ul>
          }
          @case ('logger') {
            <label>Level<select aria-label="Level" [ngModel]="node.config['level']" (ngModelChange)="node.config['level'] = $event; emit()"><option>info</option><option>warning</option><option>error</option></select></label>
            <app-expression-input [api]="api()" label="Message" [variables]="variables()" [functions]="functions()" [value]="node.config['message']" (valueChange)="node.config['message'] = $event; emit()"></app-expression-input>
          }
          @case ('note') { <label>Note<textarea aria-label="Note text" rows="5" [ngModel]="node.config['text']" (ngModelChange)="node.config['text'] = $event; emit()" maxlength="1000"></textarea></label><p class="hint">Notes document the design and never execute.</p> }
          @case ('wait') { <label>Seconds (1-60)<input type="number" aria-label="Seconds" min="1" max="60" [ngModel]="node.config['seconds']" (ngModelChange)="node.config['seconds'] = $event; emit()"></label> }
          @case ('stageFile') {
            <label>Operation<select aria-label="Stage file operation" [ngModel]="node.config['operation']" (ngModelChange)="node.config['operation'] = $event; emit()">
              <option value="writeFile">Write file</option><option value="readFile">Read entire file</option><option value="listFiles">List files</option>
              <option value="readSegments" disabled>Read in segments (planned)</option><option value="zip" disabled>Zip (planned)</option><option value="unzip" disabled>Unzip (planned)</option><option value="encrypt" disabled>Encrypt (planned)</option></select></label>
            @if (node.config['operation'] !== 'listFiles') {
              <label>File name<input aria-label="File name" [ngModel]="node.config['fileName']" (ngModelChange)="node.config['fileName'] = $event; emit()" maxlength="64" class="mono"></label>
              <label>Format<select aria-label="Format" [ngModel]="node.config['format']" (ngModelChange)="node.config['format'] = $event; emit()"><option>xml</option><option>json</option><option>csv</option></select></label>
            }
            @if (node.config['operation'] === 'writeFile') {
              <label>Data to write<select aria-label="Data to write" [ngModel]="node.config['input']" (ngModelChange)="node.config['input'] = $event; emit()">
                <option value="">— choose —</option>@for (v of dataVars(); track v.name) { <option [value]="v.name">\${{v.name}} ({{v.kind}})</option> }</select></label>
              @if (node.config['format'] === 'xml') {
                <label>Root element<input aria-label="Root element" [ngModel]="node.config['rootElement']" (ngModelChange)="node.config['rootElement'] = $event; emit()" class="mono"></label>
                <label>Record element<input aria-label="Record element" [ngModel]="node.config['recordElement']" (ngModelChange)="node.config['recordElement'] = $event; emit()" class="mono"></label>
              }
            }
            <p class="hint">Files live in a sandboxed stage area per execution; paths are not accepted.</p>
          }
          @case ('switch') {
            @for (b of node.branches; track b.id; let i = $index) {
              @if (b.kind === 'case') {
                <div class="case-row">
                  <label>Case label<input [attr.aria-label]="'Case ' + (i + 1) + ' label'" [ngModel]="b.label" (ngModelChange)="b.label = $event; emit()" maxlength="60"></label>
                  <app-expression-input [api]="api()" [label]="'Condition of ' + b.label" [variables]="variables()" [functions]="functions()" [value]="b.condition ?? ''" (valueChange)="b.condition = $event; emit()"></app-expression-input>
                  @if (cases() > 1) { <button mat-button type="button" (click)="removeBranch(b.id)" [attr.aria-label]="'Remove case ' + b.label">Remove case</button> }
                </div>
              }
            }
            <button mat-button type="button" (click)="addCase()">+ Case</button>
            <p class="hint">Cases are checked top to bottom; Otherwise runs when none matches.</p>
          }
          @case ('forEach') {
            <label>Collection<select aria-label="Collection" [ngModel]="node.config['collection']" (ngModelChange)="node.config['collection'] = $event; emit()">
              <option value="">— choose —</option>@for (v of collections(); track v.name) { <option [value]="v.name">\${{v.name}}</option> }</select></label>
            <label>Item variable<input aria-label="Item variable" [ngModel]="node.config['itemVariable']" (ngModelChange)="node.config['itemVariable'] = $event; emit()" class="mono"></label>
            <label>Maximum items (1-500)<input type="number" aria-label="Maximum items" min="1" max="500" [ngModel]="node.config['maxItems']" (ngModelChange)="node.config['maxItems'] = $event; emit()"></label>
          }
          @case ('while') {
            <app-expression-input [api]="api()" label="Condition" [variables]="variables()" [functions]="functions()" [value]="node.config['condition'] ?? ''" (valueChange)="node.config['condition'] = $event; emit()"></app-expression-input>
            <label>Maximum iterations (1-1000)<input type="number" aria-label="Maximum iterations" min="1" max="1000" [ngModel]="node.config['maxIterations']" (ngModelChange)="node.config['maxIterations'] = $event; emit()"></label>
          }
          @case ('parallel') {
            @for (b of node.branches; track b.id; let i = $index) {
              <div class="case-row"><label>Branch label<input [attr.aria-label]="'Branch ' + (i + 1) + ' label'" [ngModel]="b.label" (ngModelChange)="b.label = $event; emit()" maxlength="60"></label>
                @if (node.branches.length > 2) { <button mat-button type="button" (click)="removeBranch(b.id)">Remove branch</button> }</div>
            }
            @if (node.branches.length < 5) { <button mat-button type="button" (click)="addParallel()">+ Branch</button> }
          }
          @case ('scope') { <p class="hint">Actions in the body run with this Scope's fault handler. Inside the handler, <code>$fault.code</code> and <code>$fault.message</code> describe the error.</p> }
          @case ('throwFault') { <ng-container *ngTemplateOutlet="faultFields"></ng-container> }
          @case ('faultReturn') { <ng-container *ngTemplateOutlet="faultFields"></ng-container> }
          @case ('return') {
            <app-expression-input [api]="api()" label="Output (optional)" [variables]="variables()" [functions]="functions()" [value]="node.config['output'] ?? ''" (valueChange)="node.config['output'] = $event; emit()"></app-expression-input>
          }
          @case ('rethrowFault') { <p class="hint">Passes the current fault to the enclosing handler. Only valid inside a fault handler.</p> }
          @case ('stop') { <p class="hint">Ends the flow immediately.</p> }
        }
        <ng-template #faultFields>
          <label>Fault code<input aria-label="Fault code" [ngModel]="node.config['code']" (ngModelChange)="node.config['code'] = $event; emit()" maxlength="40" class="mono"></label>
          <app-expression-input [api]="api()" label="Message" [variables]="variables()" [functions]="functions()" [value]="node.config['message'] ?? ''" (valueChange)="node.config['message'] = $event; emit()"></app-expression-input>
        </ng-template>
      </fieldset>
      @if (issues().length) {
        <h3>Problems</h3>
        <ul class="issue-list">@for (i of issues(); track $index) { <li [class]="i.severity"><b>{{i.severity}}</b> {{i.message}}</li> }</ul>
      }
      <h3>Variables available here</h3>
      <ul class="var-list">@for (v of variables(); track v.name) { <li><code>\${{v.name}}</code> <small>{{v.kind}}{{v.table ? ' · ' + v.table.name : ''}}{{fieldsOf(v).length ? ' · ' + fieldsOf(v).join(', ') : ''}}</small></li> } @empty { <li class="hint">None yet.</li> }</ul>
    </div>
    @if (mapperOpen()) {
      <app-field-mapper [api]="api()" [nodeName]="node.name" [source]="mapSource()!.table!" [sourceSystem]="$any(mapSource()!.system)"
        [target]="mapTarget()!" [targetSystem]="node.config['targetSystem']" [rules]="mapperRules()" (done)="closeMapper($event)"></app-field-mapper>
    }
  } @else { <p class="hint pad">Select an action on the canvas to configure it, or drag one from the palette.</p> }`
})
export class NodePropertiesComponent implements OnChanges {
  api = input.required<Api>();
  node = input<FlowNode | null>(null);
  def = input<ActionDef | null>(null);
  variables = input<ScopeVar[]>([]);
  functions = input<FunctionDef[]>([]);
  catalogs = input<Record<SystemId, TableView[]>>({ crm: [], erp: [] });
  issues = input<FlowIssue[]>([]);
  readOnly = input(false);
  changed = output<FlowNode>();
  n = signal<FlowNode | null>(null); mapperOpen = signal(false); notice = signal('');
  readonly paramTypes = ['string', 'integer', 'decimal', 'boolean', 'date'];
  clone = clone; fieldsOf = fieldsOf;
  tableVars = computed(() => this.variables().filter(v => v.table && v.kind !== 'scalar'));
  dataVars = computed(() => this.variables().filter(v => v.kind !== 'scalar'));
  collections = computed(() => this.variables().filter(v => v.kind === 'collection'));
  cases = computed(() => this.n()?.branches.filter(b => b.kind === 'case').length ?? 0);
  operations = computed(() => { const c = this.n()?.config ?? {}; return operationsFor(c['system'], this.tablesOf(c['system']).find(t => t.name === c['table']) ?? null); });
  mapSource = computed(() => this.variables().find(v => v.name === this.n()?.config['input'] && v.table) ?? null);
  mapTarget = computed(() => { const c = this.n()?.config ?? {}; return this.tablesOf(c['targetSystem']).find(t => t.name === c['targetTable']) ?? null; });
  mapperReady = computed(() => !!this.mapSource()?.system && !!this.mapTarget());

  ngOnChanges(changes: SimpleChanges) {
    if (changes['node']) {
      const incoming = this.node();
      // Keep editing the same object while it is the same action; replace it when another action is selected or undo/redo ran.
      if (!incoming || !this.n() || incoming.id !== this.n()!.id || JSON.stringify(incoming) !== JSON.stringify(this.n())) this.n.set(incoming ? clone(incoming) : null);
      if (incoming?.id !== changes['node'].previousValue?.id) this.mapperOpen.set(false);
    }
  }
  tablesOf(system: string) { return this.catalogs()[system as SystemId] ?? []; }
  set(field: 'name' | 'description', value: string) { (this.n() as any)[field] = value; this.emit(); }
  emit() { const n = this.n(); if (n) this.changed.emit(clone(n)); }
  fixOperation() { const c = this.n()!.config; if (!this.operations().includes(c['operation'])) c['operation'] = this.operations()[0] ?? 'get'; }
  addCase() {
    const n = this.n()!; const i = n.branches.findIndex(b => b.kind === 'otherwise');
    n.branches.splice(i < 0 ? n.branches.length : i, 0, { id: newBranchId(), kind: 'case', label: `Case ${this.cases() + 1}`, condition: '', steps: [] });
    this.emit();
  }
  addParallel() { const n = this.n()!; n.branches.push({ id: newBranchId(), kind: 'branch', label: `Branch ${n.branches.length + 1}`, steps: [] }); this.emit(); }
  /** Removing a branch that still holds actions is refused, so nothing is deleted by accident. */
  removeBranch(id: string) {
    const n = this.n()!; const b = n.branches.find(x => x.id === id);
    if (b && b.steps.length) { this.notice.set(`'${b.label}' still contains ${b.steps.length} action(s). Move or delete them first.`); return; }
    this.notice.set('');
    n.branches = n.branches.filter(x => x.id !== id); this.emit();
  }
  /** Snapshot taken once: the mapper edits its own copy until Apply or Cancel. */
  mapperRules = signal<FieldRule[]>([]);
  openMapper() { this.mapperRules.set(clone(this.n()?.config['rules'] ?? [])); this.mapperOpen.set(true); }
  closeMapper(rules: FieldRule[] | null) {
    this.mapperOpen.set(false);
    if (rules) { this.n()!.config['rules'] = rules; this.emit(); }
  }
}
