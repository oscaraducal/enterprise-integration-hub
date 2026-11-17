import { Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild, computed, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { Api, ApiError, SessionEnded, errorText } from '../api';
import { ModalComponent } from '../ui';
import { SystemId, TableView, loadTables } from '../systems';
import {
  ActionDef, CATEGORY_ORDER, Catalog, FlowDefinition, FlowNode, FlowReport, ICONS, Lane, allNodes, clone, cloneWithNewIds, createNode,
  descendants, findNode, laneKey, locate, stepsOf, variablesBefore
} from './flow-model';
import { NodePropertiesComponent } from './properties.component';

interface FlowSummary { name: string; title: string; description?: string; draftRevision: number; draftUpdatedAt: string; draftUpdatedBy: string; latestVersion: number; status: string }
interface VersionInfo { version: number; title: string; publishedAt: string; publishedBy: string; nodeCount: number }
const HISTORY_LIMIT = 100;

/**
 * Integration Designer: an original visual editor for orchestration flows. Left: action palette. Centre: nested,
 * drag-and-drop canvas. Right: properties. Bottom: problems, variables, versions and JSON. Designs are validated
 * and versioned on the server; execution arrives in Milestone D.
 */
@Component({
  selector: 'app-designer', standalone: true, imports: [CommonModule, FormsModule, MatButtonModule, ModalComponent, NodePropertiesComponent],
  template: `
  <div class="designer" [class.fullscreen]="fullscreen()">
    <header class="designer-bar" role="toolbar" aria-label="Designer toolbar">
      <div class="flow-pick">
        <label class="sr-only" for="flowSelect">Flow</label>
        <select id="flowSelect" aria-label="Flow" [ngModel]="current()?.name ?? ''" (ngModelChange)="requestOpen($event)">
          <option value="" disabled>{{flows().length ? 'Choose a flow…' : 'No flows yet'}}</option>
          @for (f of flows(); track f.name) { <option [value]="f.name">{{f.title}} ({{f.name}})</option> }</select>
        @if (api().operator()) { <button mat-stroked-button (click)="newFlow.set({ name: '', title: '', description: '', template: 'customer-sync' })">+ New flow</button>
          <button mat-button (click)="fileInput.click()">Import</button><input #fileInput type="file" accept=".json,application/json" hidden (change)="importFile($event)"> }
      </div>
      @if (current(); as c) {
        <div class="tool-group" aria-label="Edit">
          <button type="button" class="tool" (click)="undo()" [disabled]="!undoStack().length || readOnly()" title="Undo (Ctrl+Z)" aria-label="Undo">↶</button>
          <button type="button" class="tool" (click)="redo()" [disabled]="!redoStack().length || readOnly()" title="Redo (Ctrl+Y)" aria-label="Redo">↷</button>
          <button type="button" class="tool" (click)="copy()" [disabled]="!selectedMovable()" title="Copy (Ctrl+C)" aria-label="Copy action">⧉</button>
          <button type="button" class="tool" (click)="paste()" [disabled]="!clipboard() || readOnly()" title="Paste after selection (Ctrl+V)" aria-label="Paste action">⎘</button>
          <button type="button" class="tool" (click)="moveSelected(-1)" [disabled]="!selectedMovable() || readOnly()" title="Move up (Alt+↑)" aria-label="Move action up">↑</button>
          <button type="button" class="tool" (click)="moveSelected(1)" [disabled]="!selectedMovable() || readOnly()" title="Move down (Alt+↓)" aria-label="Move action down">↓</button>
          <button type="button" class="tool" (click)="deleteSelected()" [disabled]="!selectedMovable() || readOnly()" title="Delete (Del)" aria-label="Delete action">🗑</button>
        </div>
        <div class="tool-group" aria-label="View">
          <button type="button" class="tool" (click)="setZoom(zoom() - 0.1)" aria-label="Zoom out">−</button>
          <button type="button" class="tool zoom-label" (click)="setZoom(1)" aria-label="Reset zoom">{{zoom() * 100 | number:'1.0-0'}}%</button>
          <button type="button" class="tool" (click)="setZoom(zoom() + 0.1)" aria-label="Zoom in">+</button>
          <button type="button" class="tool" (click)="fit()" aria-label="Fit to screen" title="Fit to screen">⤢</button>
          <label class="search-box"><span class="sr-only">Search actions</span><input type="search" placeholder="Search actions…" [ngModel]="search()" (ngModelChange)="search.set($event)" (keyup.enter)="nextMatch()" aria-label="Search actions"></label>
          @if (search()) { <span class="muted small">{{matches().length}} match(es)</span> }
          <button type="button" class="tool" (click)="fullscreen.set(!fullscreen())" [attr.aria-pressed]="fullscreen()" aria-label="Full screen" title="Full screen">⛶</button>
        </div>
        <div class="tool-group right">
          <span class="save-state" [class.dirty]="dirty()" role="status">{{dirty() ? 'Unsaved changes' : 'Saved · rev ' + c.revision}}</span>
          <span [class]="'pill ' + (report()?.valid ? 'Completed' : 'Failed')" role="status">{{report() ? (report()!.valid ? 'Valid' : errorCount() + ' error(s)') : 'Validating…'}}</span>
          @if (!readOnly()) {
            <button mat-stroked-button (click)="save()" [disabled]="busy() || !dirty()">Save draft</button>
            <button mat-flat-button (click)="publish()" [disabled]="busy() || dirty() || !report()?.valid" [title]="dirty() ? 'Save the draft first' : !report()?.valid ? 'Fix errors before publishing' : 'Publish a new immutable version'">Publish</button>
          }
          <button mat-button (click)="exportFlow()">Export</button>
        </div>
      }
    </header>
    @if (error()) { <div class="alert error" role="alert">{{error()}} @if (conflict()) { <button class="link-button" (click)="reload()">Reload the latest draft</button> } <button (click)="error.set(''); conflict.set(false)" aria-label="Dismiss error">×</button></div> }
    @if (notice()) { <div class="alert success" role="status">{{notice()}} <button (click)="notice.set('')" aria-label="Dismiss notification">×</button></div> }

    @if (current(); as c) {
      <div class="designer-main">
        <aside class="palette" aria-label="Action palette">
          <h2>Actions</h2>
          @for (cat of categories; track cat) {
            <h3>{{cat}}</h3>
            <ul>@for (a of byCategory(cat); track a.type) {
              <li><button type="button" class="palette-item" [class.planned]="a.status === 'Planned'" [disabled]="a.status === 'Planned' || readOnly() || a.type === 'trigger'"
                [draggable]="a.status !== 'Planned' && !readOnly() && a.type !== 'trigger'" (dragstart)="dragAction($event, a)" (click)="addFromPalette(a)"
                [title]="a.description + (a.status === 'Planned' ? ' Planned: ' + a.planned : '')" [attr.aria-label]="(a.status === 'Planned' ? 'Planned: ' : 'Add ') + a.label">
                <span class="icon" aria-hidden="true">{{icon(a.type)}}</span>{{a.label}}@if (a.status === 'Planned') { <em>{{shortPlanned(a.planned)}}</em> }</button></li>
            }</ul>
          }
          <p class="hint">Drag onto a + slot, or click to insert after the selected action. Planned actions are listed but cannot be used yet.</p>
        </aside>

        <section class="canvas-wrap" #canvasWrap aria-label="Flow canvas" (click)="select(null)">
          <div class="canvas" #canvas [style.transform]="'scale(' + zoom() + ')'">
            <div class="flow-title"><input aria-label="Flow title" class="title-input" [ngModel]="c.title" (ngModelChange)="setTitle($event)" [disabled]="readOnly()" maxlength="80" (click)="$event.stopPropagation()">
              <small class="muted">{{c.name}} · {{c.versions.length ? 'published v' + c.versions[0].version : 'never published'}} · draft rev {{c.revision}}</small></div>
            @if (flow().trigger; as t) { <ng-container *ngTemplateOutlet="card; context: { $implicit: t }"></ng-container> }
            <ng-container *ngTemplateOutlet="seq; context: { $implicit: flow().steps, lane: { kind: 'root' } }"></ng-container>
            <div class="lane fault-lane">
              <button type="button" class="lane-toggle" (click)="$event.stopPropagation(); showFault.set(!showFault())" [attr.aria-expanded]="showFault()">
                {{showFault() ? '▾' : '▸'}} Global fault handler ({{flow().globalFaultHandler.length}})</button>
              @if (showFault()) { <ng-container *ngTemplateOutlet="seq; context: { $implicit: flow().globalFaultHandler, lane: { kind: 'fault' } }"></ng-container> }
            </div>
          </div>
        </section>

        <aside class="properties" aria-label="Properties">
          <app-node-properties [api]="api()" [node]="selectedNode()" [def]="selectedDef()" [variables]="scopeVars()" [functions]="catalog()?.functions ?? []"
            [catalogs]="tables()" [issues]="selectedIssues()" [readOnly]="readOnly()" (changed)="updateNode($event)"></app-node-properties>
        </aside>
      </div>

      <section class="bottom-panel" aria-label="Designer panel">
        <div class="tabs" role="tablist" aria-label="Designer panel tabs">
          @for (t of bottomTabs; track t) { <button role="tab" [attr.aria-selected]="bottomTab() === t" [class.active]="bottomTab() === t" (click)="bottomTab.set(t)">{{t}}{{t === 'Problems' ? ' (' + (report()?.issues?.length ?? 0) + ')' : ''}}</button> }
        </div>
        @switch (bottomTab()) {
          @case ('Problems') {
            <ul class="problems">@for (i of report()?.issues ?? []; track $index) {
              <li [class]="i.severity"><button type="button" (click)="i.nodeId && focusNode(i.nodeId)" [disabled]="!i.nodeId">
                <b>{{i.severity}}</b> <code>{{nodeName(i.nodeId)}}</code> {{i.message}}</button></li>
            } @empty { <li class="ok-text">No problems. The flow can be published.</li> }</ul>
          }
          @case ('Variables') {
            <ul class="var-list wide">@for (v of report()?.variables ?? []; track v) { <li><code>\${{v}}</code></li> } @empty { <li class="hint">No variables yet.</li> }</ul>
            <p class="hint">Variables are scoped: loop items and fault details exist only inside their body or handler.</p>
          }
          @case ('Versions') {
            <ul class="problems">@for (v of c.versions; track v.version) {
              <li><span><b>v{{v.version}}</b> {{v.title}} · {{v.nodeCount}} actions · {{v.publishedAt | date:'MMM d, HH:mm'}} by {{v.publishedBy}}</span>
                <span><button class="link-button" (click)="exportFlow(v.version)">Export</button>@if (!readOnly()) { <button class="link-button" (click)="loadVersion(v.version)">Load into draft</button> }</span></li>
            } @empty { <li class="hint">Not published yet. Publishing stores an immutable version; the draft stays editable.</li> }</ul>
          }
          @case ('JSON') { <pre class="response-body" tabindex="0" aria-label="Flow JSON">{{flow() | json}}</pre> }
          @case ('Execution') { <p class="hint pad">Execution is not available yet. Milestone D adds a bounded executor for the supported actions, with a per-action trace here.</p> }
        }
      </section>
    } @else {
      <section class="panel empty-designer"><h2>Integration Designer</h2>
        <p class="muted">Design integrations visually from a palette of actions: invoke the fictional applications, assign variables, map fields, branch, loop and stage files. Designs are validated and versioned; running them arrives in Milestone D.</p>
        @if (api().operator()) { <button mat-flat-button (click)="newFlow.set({ name: 'customer-sync', title: 'Customer master sync', description: '', template: 'customer-sync' })">Create your first flow</button> }
        @else { <p class="hint">Sign in as Operator to create flows.</p> }</section>
    }
  </div>

  <ng-template #seq let-steps let-lane="lane">
    <ol class="seq">
      <li class="slot-li"><ng-container *ngTemplateOutlet="slot; context: { lane: lane, index: 0 }"></ng-container></li>
      @for (node of steps; track node.id; let i = $index) {
        <li><ng-container *ngTemplateOutlet="card; context: { $implicit: node }"></ng-container></li>
        <li class="slot-li"><ng-container *ngTemplateOutlet="slot; context: { lane: lane, index: i + 1 }"></ng-container></li>
      }
    </ol>
  </ng-template>
  <ng-template #slot let-lane="lane" let-index="index">
    <div class="slot" [class.active]="dropKey() === key(lane, index)" (dragover)="allowDrop($event, lane, index)" (dragleave)="dropKey.set('')" (drop)="dropOn($event, lane, index)"
      [attr.data-slot]="key(lane, index)" aria-hidden="true"><span>+</span></div>
  </ng-template>
  <ng-template #card let-node>
    <div class="node" [class]="'node type-' + node.type" [class.selected]="selectedId() === node.id" [class.match]="isMatch(node)" [class.error]="nodeErrors(node.id) > 0"
      [attr.data-node-id]="node.id" [draggable]="!readOnly() && node.type !== 'trigger'" (dragstart)="dragNode($event, node)" (click)="$event.stopPropagation(); select(node.id)">
      <button type="button" class="node-head" (click)="$event.stopPropagation(); select(node.id)" [attr.aria-label]="label(node) + (nodeErrors(node.id) ? ', ' + nodeErrors(node.id) + ' error(s)' : '')" [attr.aria-pressed]="selectedId() === node.id">
        <span class="icon" aria-hidden="true">{{icon(node.type)}}</span>
        <span class="node-text"><b>{{node.name}}</b><small>{{summary(node)}}</small></span>
        @if (nodeErrors(node.id)) { <span class="badge err" aria-hidden="true">{{nodeErrors(node.id)}}</span> }
        @else if (nodeWarnings(node.id)) { <span class="badge warn" aria-hidden="true">!</span> }
      </button>
      @if (node.branches?.length) {
        <button type="button" class="collapse" (click)="$event.stopPropagation(); toggle(node.id)" [attr.aria-expanded]="!collapsed().has(node.id)" [attr.aria-label]="(collapsed().has(node.id) ? 'Expand ' : 'Collapse ') + node.name">{{collapsed().has(node.id) ? '▸ ' + countInside(node) + ' inside' : '▾'}}</button>
        @if (!collapsed().has(node.id)) {
          <div class="branches" [class.side]="node.type === 'switch' || node.type === 'parallel'">
            @for (b of node.branches; track b.id) {
              <div class="branch" [class]="'branch kind-' + b.kind">
                <div class="branch-head">{{b.label}}@if (b.kind === 'case') { <code class="cond">{{b.condition || 'condition?'}}</code> }</div>
                <ng-container *ngTemplateOutlet="seq; context: { $implicit: b.steps, lane: { kind: 'branch', branchId: b.id } }"></ng-container>
              </div>
            }
          </div>
        }
      }
    </div>
  </ng-template>

  @if (newFlow(); as f) {
    <app-modal label="New flow" heading="New integration flow" eyebrow="INTEGRATION DESIGNER" (close)="newFlow.set(null)">
      <form class="form-grid modal-form" (ngSubmit)="createFlow()">
        <label>Name (URL-safe)<input name="fn" [(ngModel)]="f.name" maxlength="60" placeholder="customer-sync" required class="mono"></label>
        <label>Title<input name="ft" [(ngModel)]="f.title" maxlength="80" required></label>
        <label>Start from<select name="ftpl" [(ngModel)]="f.template">@for (t of catalog()?.templates ?? []; track t.id) { <option [value]="t.id">{{t.title}}</option> }</select></label>
        <p class="hint full">{{templateText(f.template)}}</p>
        @if (formError()) { <p class="inline-warning flat" role="alert">{{formError()}}</p> }
        <div class="form-actions"><button mat-flat-button type="submit" [disabled]="busy()">Create flow</button><button mat-button type="button" (click)="newFlow.set(null)">Cancel</button></div>
      </form>
    </app-modal>
  }
  @if (importDoc(); as d) {
    <app-modal label="Import flow" heading="Import flow" eyebrow="EIH-FLOW DOCUMENT" (close)="importDoc.set(null)">
      <form class="form-grid modal-form" (ngSubmit)="confirmImport()">
        <p class="full">{{d.doc.title || d.doc.name}} · {{d.doc.source || 'draft'}} · exported {{d.doc.exportedAt | date:'MMM d, HH:mm'}}</p>
        <label>Import as (new flow name)<input name="in" [(ngModel)]="d.name" maxlength="60" required class="mono"></label>
        <p class="hint full">Imports always create a new draft. Existing flows and published versions are never overwritten.</p>
        @if (formError()) { <p class="inline-warning flat" role="alert">{{formError()}}</p> }
        <div class="form-actions"><button mat-flat-button type="submit" [disabled]="busy()">Import</button><button mat-button type="button" (click)="importDoc.set(null)">Cancel</button></div>
      </form>
    </app-modal>
  }
  @if (pendingOpen(); as p) {
    <app-modal label="Unsaved changes" heading="Discard unsaved changes?" eyebrow="CONFIRM" (close)="pendingOpen.set(null)">
      <p>The draft of <b>{{current()?.title}}</b> has unsaved changes. {{p.action === 'version' ? 'Loading version ' + p.target + ' replaces the canvas.' : 'Opening another flow discards them.'}}</p>
      <div class="form-actions"><button mat-flat-button (click)="confirmPending()">Discard changes</button><button mat-button (click)="pendingOpen.set(null)">Keep editing</button></div>
    </app-modal>
  }`
})
export class DesignerComponent implements OnInit, OnDestroy {
  api = input.required<Api>();
  @ViewChild('canvasWrap') canvasWrap?: ElementRef<HTMLElement>;
  @ViewChild('canvas') canvas?: ElementRef<HTMLElement>;
  readonly categories = CATEGORY_ORDER;
  readonly bottomTabs = ['Problems', 'Variables', 'Versions', 'JSON', 'Execution'] as const;
  catalog = signal<Catalog | null>(null);
  tables = signal<Record<SystemId, TableView[]>>({ crm: [], erp: [] });
  flows = signal<FlowSummary[]>([]);
  current = signal<{ name: string; title: string; description?: string; revision: number; versions: VersionInfo[] } | null>(null);
  flow = signal<FlowDefinition>({ schemaVersion: 1, trigger: null, steps: [], globalFaultHandler: [] });
  report = signal<FlowReport | null>(null);
  undoStack = signal<string[]>([]); redoStack = signal<string[]>([]);
  dirty = signal(false); busy = signal(false); error = signal(''); notice = signal(''); conflict = signal(false); formError = signal('');
  selectedId = signal<string | null>(null); clipboard = signal<FlowNode | null>(null);
  zoom = signal(1); search = signal(''); fullscreen = signal(false); showFault = signal(true);
  collapsed = signal<Set<string>>(new Set()); dropKey = signal('');
  bottomTab = signal<'Problems' | 'Variables' | 'Versions' | 'JSON' | 'Execution'>('Problems');
  newFlow = signal<{ name: string; title: string; description: string; template: string } | null>(null);
  importDoc = signal<{ doc: any; name: string } | null>(null);
  pendingOpen = signal<{ action: 'open' | 'version'; target: string } | null>(null);
  private validateTimer: ReturnType<typeof setTimeout> | undefined;
  private lastCoalesce = { key: '', at: 0 };

  readOnly = computed(() => !this.api().operator());
  selectedNode = computed(() => this.selectedId() ? findNode(this.flow(), this.selectedId()!) : null);
  selectedDef = computed(() => this.catalog()?.actions.find(a => a.type === this.selectedNode()?.type) ?? null);
  selectedMovable = computed(() => !!this.selectedNode() && this.selectedNode()!.type !== 'trigger');
  selectedIssues = computed(() => (this.report()?.issues ?? []).filter(i => i.nodeId === this.selectedId()));
  errorCount = computed(() => (this.report()?.issues ?? []).filter(i => i.severity === 'error').length);
  scopeVars = computed(() => this.selectedId() ? variablesBefore(this.flow(), this.selectedId()!, (s, t) => this.tables()[s as SystemId]?.find(x => x.name === t) ?? null) : []);
  matches = computed(() => {
    const q = this.search().trim().toLowerCase(); if (!q) return [];
    return allNodes(this.flow()).filter(n => [n.name, n.type, n.description ?? '', this.summary(n)].some(t => t.toLowerCase().includes(q)));
  });

  async ngOnInit() {
    try {
      const [catalog, crm, erp, flows] = await Promise.all([this.api().request<Catalog>('flows/actions'), loadTables(this.api(), 'crm'),
        loadTables(this.api(), 'erp'), this.api().request<FlowSummary[]>('flows')]);
      this.catalog.set(catalog); this.tables.set({ crm, erp }); this.flows.set(flows);
      if (flows.length) await this.open(flows[0].name);
    } catch (e) { this.fail(e); }
  }
  ngOnDestroy() { clearTimeout(this.validateTimer); }

  // ----------------------------------------------------------- flows
  async loadFlows() { this.flows.set(await this.api().request<FlowSummary[]>('flows')); }
  requestOpen(name: string) {
    if (this.dirty()) { this.pendingOpen.set({ action: 'open', target: name }); return; }
    void this.open(name);
  }
  async confirmPending() {
    const p = this.pendingOpen(); this.pendingOpen.set(null); if (!p) return;
    this.dirty.set(false);
    if (p.action === 'open') await this.open(p.target); else await this.loadVersion(Number(p.target), true);
  }
  async open(name: string) {
    this.busy.set(true); this.error.set(''); this.conflict.set(false);
    try {
      const f = await this.api().request<{ name: string; title: string; description?: string; revision: number; definition: FlowDefinition; versions: VersionInfo[]; report: FlowReport }>('flows/' + encodeURIComponent(name));
      this.current.set({ name: f.name, title: f.title, description: f.description, revision: f.revision, versions: f.versions });
      this.flow.set(this.normalize(f.definition)); this.report.set(f.report);
      this.undoStack.set([]); this.redoStack.set([]); this.dirty.set(false); this.selectedId.set(null); this.collapsed.set(new Set());
    } catch (e) { this.fail(e); } finally { this.busy.set(false); }
  }
  reload() { this.error.set(''); this.conflict.set(false); this.dirty.set(false); const c = this.current(); if (c) void this.open(c.name); }
  private normalize(d: FlowDefinition): FlowDefinition {
    const fix = (n: FlowNode) => { n.config ??= {}; n.branches ??= []; n.branches.forEach(b => (b.steps ??= []).forEach(fix)); };
    d.steps ??= []; d.globalFaultHandler ??= [];
    if (d.trigger) fix(d.trigger); d.steps.forEach(fix); d.globalFaultHandler.forEach(fix);
    return d;
  }
  async createFlow() {
    const f = this.newFlow(); if (!f) return;
    this.busy.set(true); this.formError.set('');
    try {
      await this.api().request('flows', 'POST', { name: f.name.trim(), title: f.title.trim(), description: f.description || null, template: f.template });
      this.newFlow.set(null); await this.loadFlows(); await this.open(f.name.trim());
      this.notice.set(`Flow "${f.title}" created as a draft.`);
    } catch (e) { if (!(e instanceof SessionEnded)) this.formError.set(errorText(e)); } finally { this.busy.set(false); }
  }
  templateText(id: string) { const t = this.catalog()?.templates.find(x => x.id === id); return t ? `${t.description} (${t.scenario})` : ''; }
  async save() {
    const c = this.current(); if (!c) return;
    this.busy.set(true); this.error.set('');
    try {
      const r = await this.api().request<{ revision: number; report: FlowReport }>(`flows/${c.name}/draft`, 'PUT', { title: c.title, definition: this.flow(), revision: c.revision });
      this.current.set({ ...c, revision: r.revision }); this.report.set(r.report); this.dirty.set(false);
      this.notice.set(r.report.valid ? `Draft saved (revision ${r.revision}). It is valid and can be published.` : `Draft saved (revision ${r.revision}) with ${this.errorCount()} error(s) to fix before publishing.`);
      void this.loadFlows();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) this.conflict.set(true);
      this.fail(e);
    } finally { this.busy.set(false); }
  }
  async publish() {
    const c = this.current(); if (!c) return;
    this.busy.set(true); this.error.set('');
    try {
      const r = await this.api().request<{ version: number }>(`flows/${c.name}/publish`, 'POST', { revision: c.revision });
      this.notice.set(`Published version ${r.version}. It is immutable; keep editing the draft for the next version.`);
      await this.open(c.name); await this.loadFlows(); this.bottomTab.set('Versions');
    } catch (e) {
      if (e instanceof ApiError && e.body?.report) this.report.set(e.body.report);
      if (e instanceof ApiError && e.status === 409) this.conflict.set(true);
      this.fail(e);
    } finally { this.busy.set(false); }
  }
  async loadVersion(version: number, confirmed = false) {
    if (this.dirty() && !confirmed) { this.pendingOpen.set({ action: 'version', target: String(version) }); return; }
    const c = this.current(); if (!c) return;
    try {
      const v = await this.api().request<{ definition: FlowDefinition }>(`flows/${c.name}/versions/${version}`);
      this.commit(() => this.normalize(v.definition));
      this.notice.set(`Version ${version} loaded into the draft. Save to keep it; published versions are unchanged.`);
    } catch (e) { this.fail(e); }
  }
  async exportFlow(version?: number) {
    const c = this.current(); if (!c) return;
    try {
      const doc = await this.api().request<unknown>(`flows/${c.name}/export${version ? '?version=' + version : ''}`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = `${c.name}${version ? '-v' + version : '-draft'}.eih-flow.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.notice.set(`Exported ${version ? 'version ' + version : 'the saved draft'} as an eih-flow document.`);
    } catch (e) { this.fail(e); }
  }
  async importFile(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0]; (event.target as HTMLInputElement).value = '';
    if (!file) return;
    if (file.size > 262144) { this.error.set('The file is larger than 256 KB.'); return; }
    try {
      const doc = JSON.parse(await file.text());
      if (doc?.format !== 'eih-flow') { this.error.set('This is not an eih-flow document.'); return; }
      this.formError.set('');
      this.importDoc.set({ doc, name: this.flows().some(f => f.name === doc.name) ? `${doc.name}-copy` : doc.name ?? '' });
    } catch { this.error.set('The file is not valid JSON.'); }
  }
  async confirmImport() {
    const d = this.importDoc(); if (!d) return;
    this.busy.set(true); this.formError.set('');
    try {
      await this.api().request('flows/import', 'POST', { document: d.doc, name: d.name.trim() });
      this.importDoc.set(null); await this.loadFlows(); await this.open(d.name.trim());
      this.notice.set(`Imported as a new draft "${d.name}".`);
    } catch (e) { if (!(e instanceof SessionEnded)) this.formError.set(errorText(e)); } finally { this.busy.set(false); }
  }

  // ----------------------------------------------------------- editing with undo history
  /** Applies a change to a copy of the flow, recording the previous state. Rapid edits to one field coalesce into one undo step. */
  commit(mutate: (draft: FlowDefinition) => FlowDefinition | void, coalesceKey = '') {
    if (this.readOnly()) return;
    const before = JSON.stringify(this.flow());
    const draft = clone(this.flow());
    const result = mutate(draft) ?? draft;
    if (JSON.stringify(result) === before) return;
    const now = Date.now();
    const coalesce = coalesceKey && coalesceKey === this.lastCoalesce.key && now - this.lastCoalesce.at < 1500;
    if (!coalesce) this.undoStack.set([...this.undoStack(), before].slice(-HISTORY_LIMIT));
    this.lastCoalesce = { key: coalesceKey, at: now };
    this.redoStack.set([]);
    this.flow.set(result); this.dirty.set(true); this.scheduleValidation();
  }
  undo() {
    const stack = this.undoStack(); if (!stack.length) return;
    this.redoStack.set([...this.redoStack(), JSON.stringify(this.flow())]);
    this.flow.set(JSON.parse(stack[stack.length - 1])); this.undoStack.set(stack.slice(0, -1));
    this.lastCoalesce = { key: '', at: 0 }; this.dirty.set(true); this.scheduleValidation();
  }
  redo() {
    const stack = this.redoStack(); if (!stack.length) return;
    this.undoStack.set([...this.undoStack(), JSON.stringify(this.flow())]);
    this.flow.set(JSON.parse(stack[stack.length - 1])); this.redoStack.set(stack.slice(0, -1));
    this.dirty.set(true); this.scheduleValidation();
  }
  private scheduleValidation() {
    clearTimeout(this.validateTimer);
    this.validateTimer = setTimeout(async () => {
      try { this.report.set(await this.api().request<FlowReport>('flows/validate', 'POST', { definition: this.flow() })); }
      catch (e) { if (!(e instanceof SessionEnded)) this.report.set(null); }
    }, 500);
  }
  setTitle(title: string) { const c = this.current(); if (c && !this.readOnly()) { this.current.set({ ...c, title }); this.dirty.set(true); } }
  /** Properties edits replace the node's settings; branch contents always come from the canvas. */
  updateNode(updated: FlowNode) {
    this.commit(draft => {
      const target = draft.trigger?.id === updated.id ? draft.trigger : findNode(draft, updated.id);
      if (!target) return;
      const stepsById = new Map(target.branches.map(b => [b.id, b.steps]));
      target.name = updated.name; target.description = updated.description; target.config = updated.config;
      target.branches = updated.branches.map(b => ({ ...b, steps: stepsById.get(b.id) ?? [] }));
    }, 'node:' + updated.id);
  }
  insert(def: ActionDef, lane: Lane, index: number) {
    let createdId = '';
    this.commit(draft => {
      const steps = stepsOf(draft, lane); if (!steps) return;
      const node = createNode(draft, def); createdId = node.id;
      steps.splice(Math.min(index, steps.length), 0, node);
    });
    if (createdId) { this.selectedId.set(createdId); this.notice.set(''); }
  }
  /** Moves a node (with everything inside it) to another position; a container cannot move into itself. */
  move(nodeId: string, lane: Lane, index: number) {
    this.commit(draft => {
      const from = locate(draft, nodeId); if (!from) return;
      const node = from.steps[from.index];
      if (lane.kind === 'branch' && (node.branches.some(b => b.id === lane.branchId) || descendants(node).some(d => d.branches.some(b => b.id === lane.branchId)))) {
        this.error.set('An action cannot be moved inside itself.'); return;
      }
      const to = stepsOf(draft, lane); if (!to) return;
      from.steps.splice(from.index, 1);
      const adjusted = to === from.steps && index > from.index ? index - 1 : index;
      to.splice(Math.min(adjusted, to.length), 0, node);
    });
  }
  addFromPalette(def: ActionDef) {
    const sel = this.selectedId() ? locate(this.flow(), this.selectedId()!) : null;
    if (sel) this.insert(def, sel.lane, sel.index + 1);
    else this.insert(def, { kind: 'root' }, Math.max(0, this.flow().steps.length - (this.flow().steps.at(-1)?.type === 'return' ? 1 : 0)));
  }
  deleteSelected() {
    const id = this.selectedId(); if (!id) return;
    const node = findNode(this.flow(), id); if (!node || node.type === 'trigger') return;
    const inside = descendants(node).length;
    this.commit(draft => { const at = locate(draft, id); at?.steps.splice(at.index, 1); });
    this.selectedId.set(null);
    this.notice.set(`Deleted ${node.name}${inside ? ` and ${inside} action(s) inside it` : ''}. Undo with Ctrl+Z.`);
  }
  moveSelected(delta: number) {
    const id = this.selectedId(); if (!id) return;
    const at = locate(this.flow(), id); if (!at) return;
    const to = at.index + delta; if (to < 0 || to >= at.steps.length) return;
    this.move(id, at.lane, delta > 0 ? to + 1 : to);
  }
  copy() { const n = this.selectedNode(); if (n && n.type !== 'trigger') { this.clipboard.set(clone(n)); this.notice.set(`Copied ${n.name}.`); } }
  paste() {
    const source = this.clipboard(); if (!source) return;
    let pastedId = '';
    this.commit(draft => {
      const node = cloneWithNewIds(draft, source); pastedId = node.id;
      const sel = this.selectedId() ? locate(draft, this.selectedId()!) : null;
      if (sel) sel.steps.splice(sel.index + 1, 0, node); else draft.steps.push(node);
    });
    if (pastedId) this.selectedId.set(pastedId);
  }

  // ----------------------------------------------------------- drag and drop
  key(lane: Lane, index: number) { return laneKey(lane) + '@' + index; }
  dragAction(e: DragEvent, a: ActionDef) { e.dataTransfer?.setData('application/x-eih-action', a.type); e.dataTransfer!.effectAllowed = 'copy'; }
  dragNode(e: DragEvent, n: FlowNode) { e.stopPropagation(); e.dataTransfer?.setData('application/x-eih-node', n.id); e.dataTransfer!.effectAllowed = 'move'; }
  allowDrop(e: DragEvent, lane: Lane, index: number) {
    if (this.readOnly()) return;
    e.preventDefault(); e.stopPropagation(); this.dropKey.set(this.key(lane, index));
  }
  dropOn(e: DragEvent, lane: Lane, index: number) {
    e.preventDefault(); e.stopPropagation(); this.dropKey.set('');
    const type = e.dataTransfer?.getData('application/x-eih-action');
    const nodeId = e.dataTransfer?.getData('application/x-eih-node');
    const def = this.catalog()?.actions.find(a => a.type === type);
    if (def && def.status !== 'Planned') this.insert(def, lane, index);
    else if (nodeId) this.move(nodeId, lane, index);
  }

  // ----------------------------------------------------------- view
  select(id: string | null) { this.selectedId.set(id); }
  focusNode(id: string) {
    this.select(id);
    // Expand collapsed ancestors so the node is visible.
    const ancestors = allNodes(this.flow()).filter(n => descendants(n).some(d => d.id === id)).map(n => n.id);
    if (ancestors.some(a => this.collapsed().has(a))) this.collapsed.set(new Set([...this.collapsed()].filter(c => !ancestors.includes(c))));
    setTimeout(() => document.querySelector(`[data-node-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' }));
  }
  toggle(id: string) { const s = new Set(this.collapsed()); s.has(id) ? s.delete(id) : s.add(id); this.collapsed.set(s); }
  countInside(n: FlowNode) { return descendants(n).length; }
  setZoom(z: number) { this.zoom.set(Math.round(Math.min(1.5, Math.max(0.4, z)) * 10) / 10); }
  fit() {
    const wrap = this.canvasWrap?.nativeElement, canvas = this.canvas?.nativeElement; if (!wrap || !canvas) return;
    const scale = Math.min((wrap.clientWidth - 32) / canvas.scrollWidth, (wrap.clientHeight - 32) / canvas.scrollHeight, 1.5);
    this.setZoom(Math.floor(scale * 10) / 10); wrap.scrollTo({ top: 0, left: 0 });
  }
  isMatch(n: FlowNode) { return !!this.search().trim() && this.matches().some(m => m.id === n.id); }
  nextMatch() {
    const list = this.matches(); if (!list.length) return;
    const i = list.findIndex(m => m.id === this.selectedId());
    this.focusNode(list[(i + 1) % list.length].id);
  }
  nodeErrors(id: string) { return (this.report()?.issues ?? []).filter(i => i.nodeId === id && i.severity === 'error').length; }
  nodeWarnings(id: string) { return (this.report()?.issues ?? []).filter(i => i.nodeId === id && i.severity === 'warning').length; }
  nodeName(id: string | null) { return id ? findNode(this.flow(), id)?.name ?? id : 'flow'; }
  icon(type: string) { return ICONS[type] ?? '•'; }
  shortPlanned(p?: string | null) { return p?.startsWith('Unsupported') ? 'unsupported' : 'planned'; }
  byCategory(cat: string) { return (this.catalog()?.actions ?? []).filter(a => a.category === cat); }
  label(n: FlowNode) { return `${this.catalog()?.actions.find(a => a.type === n.type)?.label ?? n.type} ${n.name}`; }
  summary(n: FlowNode): string {
    const c = n.config ?? {};
    switch (n.type) {
      case 'trigger': return 'Manual · ' + ((c['parameters'] ?? []).map((p: any) => p.name).join(', ') || 'no parameters');
      case 'invoke': return `${c['operation'] ?? '?'} ${c['system'] ?? '?'}.${c['table'] ?? '?'}`;
      case 'assign': return (c['assignments'] ?? []).map((a: any) => a.variable || '?').join(', ');
      case 'map': return `${c['input'] || '?'} → ${c['targetSystem'] ?? '?'}.${c['targetTable'] || '?'} · ${(c['rules'] ?? []).length} rules`;
      case 'logger': return `${c['level']}: ${c['message'] ?? ''}`;
      case 'note': return String(c['text'] ?? '').slice(0, 60);
      case 'wait': return `${c['seconds']} s`;
      case 'stageFile': return `${c['operation']} ${c['fileName'] ?? ''}`;
      case 'switch': return `${n.branches.filter(b => b.kind === 'case').length} case(s) + otherwise`;
      case 'forEach': return `each ${c['itemVariable'] ?? '?'} in ${c['collection'] || '?'} (max ${c['maxItems']})`;
      case 'while': return `${c['condition'] || '?'} (max ${c['maxIterations']})`;
      case 'throwFault': case 'faultReturn': return c['code'] ?? '';
      case 'return': return c['output'] ? 'returns ' + c['output'] : 'ends the flow';
      default: return this.catalog()?.actions.find(a => a.type === n.type)?.label ?? n.type;
    }
  }

  @HostListener('document:keydown', ['$event']) onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (!this.current() || target.closest('input, textarea, select, [contenteditable], .mapper-shell, app-modal')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); }
    else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); this.redo(); }
    else if (mod && e.key.toLowerCase() === 'c') { this.copy(); }
    else if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); this.paste(); }
    else if (e.key === 'Delete' && this.selectedMovable()) { e.preventDefault(); this.deleteSelected(); }
    else if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); this.moveSelected(-1); }
    else if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); this.moveSelected(1); }
  }
  private fail(e: unknown) { if (!(e instanceof SessionEnded)) this.error.set(errorText(e)); }
}
