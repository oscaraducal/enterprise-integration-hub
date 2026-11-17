import { Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild, computed, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { Api, ApiError, SessionEnded, errorText } from '../api';
import { ModalComponent } from '../ui';
import { SystemId, TableView, loadTables } from '../systems';
import {
  ActionDef, CATEGORY_ORDER, Catalog, FlowDefinition, FlowNode, FlowReport, ICONS, Lane, allNodes, clone, cloneWithNewIds, createNode, uniqueName,
  descendants, findNode, laneContext, laneKey, locate, stepsOf, variablesBefore
} from './flow-model';
import { NodePropertiesComponent } from './properties.component';
import { EndpointWizardComponent, InvokeEndpoint, TriggerEndpoint } from './endpoint-wizard.component';
import { ConnectionView, toIdentifier } from '../connections.component';

interface FlowSummary { name: string; title: string; description?: string; draftRevision: number; draftUpdatedAt: string; draftUpdatedBy: string; latestVersion: number; status: string;
  style: string; identifier: string; versionLabel: string; tags: string[] }
interface Current { name: string; title: string; description?: string; revision: number; versions: VersionInfo[]; style: string; identifier: string; versionLabel: string; tags: string[] }
interface PickerItem { key: string; label: string; description: string; icon: string; reason: string; def?: ActionDef; connection?: string }
type Layout = 'Vertical' | 'Horizontal' | 'Outline';
const LAYOUT_KEY = 'eih.designer.layout';
const PICKER_TABS = ['Connections / Invokes', 'Data Processing', 'Logic', 'Error Handling', 'End Actions'] as const;
const PICKER_TYPES: Record<string, string[]> = {
  'Data Processing': ['assign', 'map', 'stageFile', 'logger', 'note', 'wait', 'dataStitch', 'dataTranslate'],
  'Logic': ['switch', 'forEach', 'while', 'scope', 'parallel'],
  'Error Handling': ['throwFault', 'rethrowFault'],
  'End Actions': ['return', 'faultReturn', 'stop', 'callback'],
};
const END_TYPES = ['return', 'faultReturn', 'stop', 'callback'];
const PURPOSE_LABEL: Record<string, string> = { explicit: 'Map', invokeRequest: 'Request mapping', invokeResponse: 'Response mapping', triggerResponse: 'Trigger response mapping', stageFile: 'File structure mapping' };
interface VersionInfo { version: number; title: string; publishedAt: string; publishedBy: string; nodeCount: number }
const HISTORY_LIMIT = 100;

/**
 * Integration Designer: an original visual editor for orchestration flows. Left: action palette. Centre: nested,
 * drag-and-drop canvas. Right: properties. Bottom: problems, variables, versions and JSON. Designs are validated
 * and versioned on the server; execution arrives in Milestone D.
 */
@Component({
  selector: 'app-designer', standalone: true, imports: [CommonModule, FormsModule, MatButtonModule, ModalComponent, NodePropertiesComponent, EndpointWizardComponent],
  template: `
  <div class="designer" [class.fullscreen]="fullscreen()">
    <header class="designer-bar" role="toolbar" aria-label="Designer toolbar">
      <div class="flow-pick">
        <label class="sr-only" for="flowSelect">Flow</label>
        <select id="flowSelect" aria-label="Flow" [ngModel]="current()?.name ?? ''" (ngModelChange)="requestOpen($event)">
          <option value="" disabled>{{flows().length ? 'Choose a flow…' : 'No flows yet'}}</option>
          @for (f of flows(); track f.name) { <option [value]="f.name">{{f.title}} ({{f.name}})</option> }</select>
        @if (api().operator()) { <button mat-stroked-button (click)="startCreate()">+ New integration</button>
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
          <div class="layout-switch" role="radiogroup" aria-label="Layout">@for (l of layouts; track l) { <button type="button" role="radio" [attr.aria-checked]="layout() === l" [class.active]="layout() === l" (click)="setLayout(l)">{{l}}</button> }</div>
          <button type="button" class="tool" (click)="setZoom(zoom() - 0.1)" aria-label="Zoom out" [disabled]="layout() === 'Outline'">−</button>
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
          @if (layout() === 'Outline') { <ng-container *ngTemplateOutlet="outline"></ng-container> } @else {
          <div class="canvas" #canvas [class.horizontal]="layout() === 'Horizontal'" [style.transform]="'scale(' + zoom() + ')'">
            <div class="flow-title"><input aria-label="Flow title" class="title-input" [ngModel]="c.title" (ngModelChange)="setTitle($event)" [disabled]="readOnly()" maxlength="80" (click)="$event.stopPropagation()">
              <small class="muted">{{c.identifier}} · {{c.versionLabel}} · {{styleLabel(c.style)}} · {{c.versions.length ? 'published v' + c.versions[0].version : 'never published'}} · draft rev {{c.revision}}</small></div>
            <div class="flow-line">
            @if (flow().trigger; as t) { <ng-container *ngTemplateOutlet="card; context: { $implicit: t }"></ng-container> }
            <ng-container *ngTemplateOutlet="seq; context: { $implicit: flow().steps, lane: { kind: 'root' } }"></ng-container>
            </div>
            <div class="lane fault-lane">
              <button type="button" class="lane-toggle" (click)="$event.stopPropagation(); showFault.set(!showFault())" [attr.aria-expanded]="showFault()">
                {{showFault() ? '▾' : '▸'}} Global fault handler ({{flow().globalFaultHandler.length}})</button>
              @if (showFault()) { <ng-container *ngTemplateOutlet="seq; context: { $implicit: flow().globalFaultHandler, lane: { kind: 'fault' } }"></ng-container> }
            </div>
          </div>
          }
        </section>

        <aside class="properties" aria-label="Properties">
          <app-node-properties [api]="api()" [node]="selectedNode()" [def]="selectedDef()" [variables]="scopeVars()" [functions]="catalog()?.functions ?? []"
            [catalogs]="tables()" [issues]="selectedIssues()" [readOnly]="readOnly()" [connections]="connections()" (changed)="updateNode($event)"
            (editEndpoint)="editEndpoint($event)" (configureTrigger)="configureTrigger()" (addMapping)="addMapping($event)"></app-node-properties>
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
        @if (api().operator()) { <button mat-flat-button (click)="startCreate()">Create your first integration</button> }
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
    <div class="slot" [class.active]="dropKey() === key(lane, index) || pickerKey() === key(lane, index)" (dragover)="allowDrop($event, lane, index)" (dragleave)="dropKey.set('')" (drop)="dropOn($event, lane, index)"
      [attr.data-slot]="key(lane, index)">
      @if (!readOnly()) { <button type="button" class="slot-btn" (click)="$event.stopPropagation(); openPicker(lane, index)" [attr.aria-expanded]="pickerKey() === key(lane, index)" [attr.aria-label]="'Insert action at ' + slotLabel(lane, index)">+</button> }
      @else { <span aria-hidden="true">+</span> }</div>
    @if (pickerKey() === key(lane, index)) { <ng-container *ngTemplateOutlet="picker; context: { lane: lane, index: index }"></ng-container> }
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
      @if (node.type === 'trigger' && triggerNeedsSetup(node)) {
        <div class="trigger-setup"><p>Choose a Trigger connection and define the inbound REST endpoint.</p>
          @if (!readOnly()) { <button mat-stroked-button type="button" (click)="$event.stopPropagation(); configureTrigger()">Configure trigger…</button> }</div>
      }
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

  <ng-template #picker let-lane="lane" let-index="index">
    <div class="picker" role="dialog" [attr.aria-label]="'Insert action at ' + slotLabel(lane, index)" (click)="$event.stopPropagation()" (keydown.escape)="pickerKey.set('')">
      <div class="picker-head"><div class="tabs" role="tablist" aria-label="Action categories">@for (t of pickerTabs; track t) { <button type="button" role="tab" [attr.aria-selected]="pickerTab() === t" [class.active]="pickerTab() === t" (click)="pickerTab.set(t)">{{t}}</button> }</div>
        <button type="button" class="link-button" (click)="pickerKey.set('')" aria-label="Close action picker">Close</button></div>
      <ul class="picker-list">
        @for (item of pickerItems(lane, index); track item.key) {
          <li><button type="button" [disabled]="!!item.reason" (click)="pick(item, lane, index)" [attr.aria-label]="item.label + (item.reason ? ' (unavailable)' : '')">
            <span class="icon" aria-hidden="true">{{item.icon}}</span><span><b>{{item.label}}</b><small>{{item.reason || item.description}}</small></span></button></li>
        } @empty { <li class="hint">{{pickerTab() === 'Connections / Invokes' ? 'No Invoke connections yet. Create one in the Connections workspace.' : 'Nothing here.'}}</li> }
      </ul>
    </div>
  </ng-template>
  <ng-template #outline>
    <div class="outline" role="tree" aria-label="Flow outline">
      <div class="outline-head" aria-hidden="true"><span>Action</span><span>Type</span><span>Connection / operation</span><span>Schema</span><span>Mapping</span><span>Validation</span><span>Summary</span></div>
      @for (r of outlineRows(); track r.node.id) {
        <div class="outline-row" role="treeitem" [attr.aria-level]="r.depth + 1" [attr.aria-expanded]="r.node.branches.length ? !collapsed().has(r.node.id) : null" [attr.aria-selected]="selectedId() === r.node.id"
          [class.selected]="selectedId() === r.node.id" [class.match]="isMatch(r.node)" [attr.data-node-id]="r.node.id">
          <span class="o-name" [style.padding-left.px]="r.depth * 18">
            @if (r.node.branches.length) { <button type="button" class="o-toggle" (click)="toggle(r.node.id)" [attr.aria-label]="(collapsed().has(r.node.id) ? 'Expand ' : 'Collapse ') + r.node.name">{{collapsed().has(r.node.id) ? '▸' : '▾'}}</button> }
            <button type="button" class="o-select" (click)="select(r.node.id)" [attr.aria-label]="'Outline ' + label(r.node)">{{r.branch ? r.branch + ' · ' : ''}}<b>{{r.node.name}}</b></button></span>
          <span>{{typeLabel(r.node)}}</span><span>{{connectionText(r.node)}}</span><span>{{schemaText(r.node)}}</span><span>{{mappingText(r.node)}}</span>
          <span>@if (nodeErrors(r.node.id)) { <b class="field-error">{{nodeErrors(r.node.id)}} error(s)</b> } @else if (nodeWarnings(r.node.id)) { <span class="field-warning">{{nodeWarnings(r.node.id)}} warning(s)</span> } @else { <span class="ok-text">OK</span> }</span>
          <span class="o-summary">{{r.node.description || summary(r.node)}}</span>
        </div>
      }
    </div>
  </ng-template>
  @if (create(); as w) {
    <app-modal label="New integration" heading="Create integration" [eyebrow]="'STEP ' + (createStep() + 1) + ' OF 3 · ' + createStepNames[createStep()].toUpperCase()" [wide]="true" (close)="create.set(null)">
      <ol class="wizard-steps" aria-label="Wizard steps">@for (s of createStepNames; track s; let i = $index) { <li [class.done]="i < createStep()" [class.current]="i === createStep()">{{i + 1}}. {{s}}</li> }</ol>
      @switch (createStep()) {
        @case (0) {
          <div class="choice-grid" role="radiogroup" aria-label="Integration type">
            @for (st of styleChoices; track st.id) { <button type="button" role="radio" class="choice" [class.selected]="w.style === st.id" [attr.aria-checked]="w.style === st.id" (click)="w.style = st.id; w.template = 'blank'"><b>{{st.title}}</b><small>{{st.text}}</small></button> }
          </div>
        }
        @case (1) {
          <div class="form-grid modal-form">
            <label>Name<input aria-label="Integration name" [ngModel]="w.title" (ngModelChange)="setCreateName(w, $event)" maxlength="80"></label>
            <label>Identifier<input aria-label="Integration identifier" class="mono" [ngModel]="w.identifier" (ngModelChange)="setCreateId(w, $event)" maxlength="50"></label>
            <label>Version<input aria-label="Integration version" class="mono" [(ngModel)]="w.version" maxlength="10" placeholder="01.00.0000"></label>
            <label>Tags (comma separated)<input aria-label="Tags" [(ngModel)]="w.tags" maxlength="200" placeholder="crm, practice"></label>
            <label class="full">Description<input aria-label="Integration description" [(ngModel)]="w.description" maxlength="300"></label>
          </div><p class="hint">The identifier is generated from the name in upper case. The version uses xx.xx.xxxx (default 01.00.0000).</p>
        }
        @case (2) {
          <div class="choice-grid" role="radiogroup" aria-label="Start from">
            <button type="button" role="radio" class="choice" [class.selected]="w.template === 'blank'" [attr.aria-checked]="w.template === 'blank'" (click)="w.template = 'blank'"><b>Blank (recommended)</b><small>{{blankText(w.style)}}</small></button>
            @for (t of starterTemplates(); track t.id) { <button type="button" role="radio" class="choice" [class.selected]="w.template === t.id" [attr.aria-checked]="w.template === t.id" [disabled]="w.style !== 'manual'" (click)="w.template = t.id"
              [attr.aria-label]="'Starter template: ' + t.title"><b>{{t.title}}</b><small>{{w.style === 'manual' ? t.description : 'Starter templates use a manual trigger: choose Manual practice to use them.'}}</small></button> }
          </div>
          <dl class="record-dl"><dt>Type</dt><dd>{{styleLabel(w.style)}}</dd><dt>Name</dt><dd>{{w.title}}</dd><dt>Identifier</dt><dd><code>{{w.identifier}}</code> · {{w.version}}</dd></dl>
        }
      }
      @if (formError()) { <p class="inline-warning flat" role="alert">{{formError()}}</p> }
      <div class="form-actions wizard-nav"><button mat-button (click)="createStep.set(createStep() - 1)" [disabled]="createStep() === 0">Back</button>
        @if (createStep() < 2) { <button mat-flat-button (click)="createStep.set(createStep() + 1)" [disabled]="!createReady()">Next</button> }
        @else { <button mat-flat-button (click)="createIntegration()" [disabled]="busy()">Create</button> }
        <button mat-button (click)="create.set(null)">Cancel</button></div>
    </app-modal>
  }
  @if (wizard(); as wz) {
    <app-endpoint-wizard [api]="api()" [mode]="wz.mode" [actionName]="wz.name" [connections]="connections()" [catalogs]="tables()" [variables]="wz.variables"
      [functions]="catalog()?.functions ?? []" [initial]="wz.initial" (done)="endpointDone($event)"></app-endpoint-wizard>
  }
  @if (impact(); as im) {
    <app-modal label="Mapping impact" heading="This change affects a mapping" eyebrow="CONFIRM" (close)="impact.set(null)">
      <p>{{im.message}}</p><p class="hint">Mapping rules are never deleted automatically. Rules that no longer fit are reported in Problems until you review them, and publishing stays blocked until the flow is valid.</p>
      <div class="form-actions">@for (o of im.options; track o.label) { <button mat-stroked-button (click)="o.apply(); impact.set(null)">{{o.label}}</button> }
        <button mat-button (click)="impact.set(null)">Cancel</button></div>
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
  current = signal<Current | null>(null);
  flow = signal<FlowDefinition>({ schemaVersion: 1, trigger: null, steps: [], globalFaultHandler: [] });
  report = signal<FlowReport | null>(null);
  undoStack = signal<string[]>([]); redoStack = signal<string[]>([]);
  dirty = signal(false); busy = signal(false); error = signal(''); notice = signal(''); conflict = signal(false); formError = signal('');
  selectedId = signal<string | null>(null); clipboard = signal<FlowNode | null>(null);
  zoom = signal(1); search = signal(''); fullscreen = signal(false); showFault = signal(true);
  collapsed = signal<Set<string>>(new Set()); dropKey = signal('');
  bottomTab = signal<'Problems' | 'Variables' | 'Versions' | 'JSON' | 'Execution'>('Problems');
  readonly layouts: Layout[] = ['Vertical', 'Horizontal', 'Outline'];
  readonly pickerTabs = PICKER_TABS;
  readonly createStepNames = ['Integration type', 'Basic information', 'Create'];
  readonly styleChoices = [
    { id: 'application', title: 'Application', text: 'Starts when an application calls an inbound REST endpoint. Start is a trigger placeholder until you choose a Trigger connection.' },
    { id: 'schedule', title: 'Scheduled', text: 'Starts on a schedule (manual, daily, weekly or monthly) with schedule parameters. Design-time only in this release.' },
    { id: 'manual', title: 'Manual practice', text: 'A simplified practice mode with a built-in manual trigger and typed sample parameters. Starter templates are available.' },
  ];
  layout = signal<Layout>(this.storedLayout());
  connections = signal<ConnectionView[]>([]);
  pickerKey = signal(''); pickerTab = signal<typeof PICKER_TABS[number]>('Data Processing');
  create = signal<{ style: string; title: string; identifier: string; idEdited: boolean; version: string; tags: string; description: string; template: string } | null>(null);
  createStep = signal(0);
  wizard = signal<{ mode: 'invoke' | 'trigger'; name: string; nodeId?: string; lane?: Lane; index?: number; initial: Record<string, any> | null; variables: any[] } | null>(null);
  impact = signal<{ message: string; options: { label: string; apply: () => void }[] } | null>(null);
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
      try { this.connections.set(await this.api().request<ConnectionView[]>('connections')); } catch { /* connections are optional for viewing */ }
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
      const f = await this.api().request<Current & { definition: FlowDefinition; report: FlowReport }>('flows/' + encodeURIComponent(name));
      this.current.set({ name: f.name, title: f.title, description: f.description, revision: f.revision, versions: f.versions, style: f.style, identifier: f.identifier, versionLabel: f.versionLabel, tags: f.tags });
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
  // ----------------------------------------------------------- create integration wizard
  startCreate() {
    this.formError.set(''); this.createStep.set(0);
    this.create.set({ style: 'application', title: '', identifier: '', idEdited: false, version: '01.00.0000', tags: '', description: '', template: 'blank' });
  }
  setCreateName(w: { title: string; identifier: string; idEdited: boolean }, title: string) { w.title = title; if (!w.idEdited) w.identifier = toIdentifier(title); }
  setCreateId(w: { identifier: string; idEdited: boolean }, id: string) { w.identifier = id.toUpperCase(); w.idEdited = true; }
  createReady() {
    const w = this.create(); if (!w) return false;
    return this.createStep() === 0 ? !!w.style : !!w.title.trim() && /^[A-Z][A-Z0-9_]{1,49}$/.test(w.identifier) && /^\d{2}\.\d{2}\.\d{4}$/.test(w.version);
  }
  starterTemplates() { return (this.catalog()?.templates ?? []).filter(t => t.id !== 'blank'); }
  styleLabel(style?: string) { return style === 'application' ? 'Application' : style === 'schedule' ? 'Scheduled' : 'Manual practice'; }
  blankText(style: string) {
    return style === 'application' ? 'Only an unconfigured Start trigger. Choose a Trigger connection, then add actions with +.'
      : style === 'schedule' ? 'Only a Start schedule (manual run by default). Add actions with +.' : 'Only a manual Start trigger. Add actions with +.';
  }
  async createIntegration() {
    const w = this.create(); if (!w) return;
    this.busy.set(true); this.formError.set('');
    try {
      const r = await this.api().request<{ name: string }>('flows', 'POST', { title: w.title.trim(), identifier: w.identifier, versionLabel: w.version, style: w.style,
        description: w.description || null, tags: w.tags.split(',').map(t => t.trim()).filter(t => t), template: w.template });
      this.create.set(null); await this.loadFlows(); await this.open(r.name);
      this.notice.set(w.template === 'blank' ? `Integration "${w.title}" created with an empty canvas. Use + to add actions.` : `Integration "${w.title}" created from a starter template.`);
      if (w.style === 'application' && w.template === 'blank') this.select(this.flow().trigger?.id ?? null);
    } catch (e) { if (!(e instanceof SessionEnded)) this.formError.set(errorText(e)); } finally { this.busy.set(false); }
  }
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
  /** Invokes are configured through the endpoint wizard before they are inserted; other actions are inserted directly. */
  insert(def: ActionDef, lane: Lane, index: number, initial: Record<string, any> | null = null) {
    if (def.type === 'invoke') { this.openInvokeWizard(lane, index, initial); return; }
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

  // ----------------------------------------------------------- inline + picker
  openPicker(lane: Lane, index: number) {
    const k = this.key(lane, index);
    this.pickerKey.set(this.pickerKey() === k ? '' : k);
    setTimeout(() => (document.querySelector('.picker [role=tab][aria-selected=true]') as HTMLElement | null)?.focus());
  }
  slotLabel(lane: Lane, index: number) {
    const where = lane.kind === 'root' ? 'main flow' : lane.kind === 'fault' ? 'global fault handler'
      : (this.allBranches().find(b => b.id === lane.branchId)?.label ?? 'branch');
    return `${where}, position ${index + 1}`;
  }
  private allBranches() { return allNodes(this.flow()).flatMap(n => n.branches ?? []); }
  /** Actions offered at a slot, with the reason when one cannot go there. */
  pickerItems(lane: Lane, index: number): PickerItem[] {
    const tab = this.pickerTab();
    if (tab === 'Connections / Invokes') {
      const invokers = this.connections().filter(c => c.role === 'Invoke' || c.role === 'TriggerAndInvoke');
      const generic = this.catalog()?.actions.find(a => a.type === 'invoke');
      return [
        ...invokers.map(c => ({ key: 'c:' + c.identifier, label: `Invoke ${c.name}`, description: `${c.applicationName} · ${c.identifier}`, icon: '⇄', reason: '', connection: c.identifier })),
        ...(generic ? [{ key: 'invoke', label: 'Invoke (choose connection)', description: 'Opens the endpoint wizard.', icon: '⇄', reason: invokers.length ? '' : 'Create a connection with the Invoke role first (Connections workspace).', def: generic }] : []),
      ];
    }
    const ctx = laneContext(this.flow(), lane);
    const steps = stepsOf(this.flow(), lane) ?? [];
    return (PICKER_TYPES[tab] ?? []).map(t => this.catalog()?.actions.find(a => a.type === t)).filter((a): a is ActionDef => !!a).map(a => {
      let reason = '';
      if (a.status === 'Planned') reason = `Planned (${a.planned}). Not available in this release.`;
      else if (a.type === 'rethrowFault' && !ctx.inFault) reason = 'Only inside a fault handler (Scope fault handler or the global fault handler).';
      else if (END_TYPES.includes(a.type) && index < steps.length) reason = 'End actions go at the end of a path; the actions after this position would become unreachable.';
      return { key: a.type, label: a.label, description: a.description, icon: this.icon(a.type), reason, def: a };
    });
  }
  pick(item: PickerItem, lane: Lane, index: number) {
    if (item.reason) return;
    this.pickerKey.set('');
    if (item.connection) this.openInvokeWizard(lane, index, { connection: item.connection });
    else if (item.def) this.insert(item.def, lane, index);
  }

  // ----------------------------------------------------------- endpoint wizards and mapping points
  private tableFinder = (s: string, t: string) => this.tables()[s as SystemId]?.find(x => x.name === t) ?? null;
  /** Variables in scope at an insertion point, computed by placing a temporary marker there. */
  private varsAt(lane: Lane, index: number) {
    const draft = clone(this.flow()); const steps = stepsOf(draft, lane); if (!steps) return [];
    steps.splice(index, 0, { id: '__marker__', type: 'note', name: '__marker__', config: {}, branches: [] });
    return variablesBefore(draft, '__marker__', this.tableFinder);
  }
  openInvokeWizard(lane: Lane, index: number, initial: Record<string, any> | null) {
    const name = uniqueName(this.flow(), 'callApi');
    this.wizard.set({ mode: 'invoke', name, lane, index, initial, variables: this.varsAt(lane, index) });
  }
  editEndpoint(nodeId: string) {
    const node = findNode(this.flow(), nodeId); if (!node) return;
    this.wizard.set({ mode: 'invoke', name: node.name, nodeId, initial: clone(node.config), variables: variablesBefore(this.flow(), nodeId, this.tableFinder) });
  }
  configureTrigger() {
    const t = this.flow().trigger; if (!t) return;
    this.wizard.set({ mode: 'trigger', name: t.name, nodeId: t.id, initial: clone(t.config), variables: [] });
  }
  triggerNeedsSetup(n: FlowNode) { return n.config?.['mode'] === 'rest' && (!n.config['connection'] || !n.config['endpoint']); }
  private invokeConfig(ep: InvokeEndpoint, keepInput?: string) {
    const c: Record<string, any> = { connection: ep.connection, operationId: ep.operationId, system: ep.system, table: ep.table, operation: ep.operation, method: ep.method, path: ep.path };
    if (ep.key !== undefined) c['key'] = ep.key;
    if (ep.limit !== undefined) c['limit'] = ep.limit;
    if (ep.requestBody && keepInput) c['input'] = keepInput;
    return c;
  }
  private newMap(draft: FlowDefinition, base: string, config: Record<string, any>) {
    const def = this.catalog()!.actions.find(a => a.type === 'map')!;
    const map = createNode(draft, def); map.name = uniqueName(draft, base); map.config = { rules: [], ...config };
    return map;
  }
  endpointDone(result: InvokeEndpoint | TriggerEndpoint | null) {
    const wz = this.wizard(); this.wizard.set(null);
    if (!result || !wz) return;
    if (wz.mode === 'trigger') this.applyTrigger(result as TriggerEndpoint);
    else if (wz.nodeId) this.reconfigureInvoke(wz.nodeId, result as InvokeEndpoint);
    else this.insertInvoke(wz.lane!, wz.index!, result as InvokeEndpoint, wz.name);
  }
  private insertInvoke(lane: Lane, index: number, ep: InvokeEndpoint, name: string) {
    let invokeId = '', mapName = '';
    this.commit(draft => {
      const steps = stepsOf(draft, lane); if (!steps) return;
      const node = createNode(draft, this.catalog()!.actions.find(a => a.type === 'invoke')!);
      node.name = uniqueName(draft, name); node.config = this.invokeConfig(ep); invokeId = node.id;
      steps.splice(index, 0, node);
      if (ep.requestBody) {
        // Mapping point: an unconfigured request mapping directly before the Invoke, targeting its request contract.
        const map = this.newMap(draft, 'map' + node.name[0].toUpperCase() + node.name.slice(1) + 'Request',
          { purpose: 'invokeRequest', for: node.id, input: '', targetSystem: ep.system, targetTable: ep.table });
        steps.splice(index, 0, map); node.config['input'] = map.name; mapName = map.name;
      }
    });
    if (invokeId) {
      this.selectedId.set(invokeId);
      this.notice.set(mapName ? `Invoke added with an unconfigured request mapping (${mapName}) before it. Open the mapping to map the fields.` : 'Invoke added. This operation sends no request body, so no mapping was added.');
    }
  }
  /** Reconfiguring an Invoke never deletes mapping rules: affected request mappings are kept, retargeted only on confirmation. */
  private reconfigureInvoke(nodeId: string, ep: InvokeEndpoint) {
    const at = locate(this.flow(), nodeId); if (!at) return;
    const node = at.steps[at.index]; const prev = at.steps[at.index - 1];
    const reqMap = prev?.type === 'map' && prev.config['purpose'] === 'invokeRequest' && prev.config['for'] === nodeId ? prev : null;
    const rules = (reqMap?.config['rules'] ?? []).length;
    const apply = (opts: { retarget?: boolean; addMap?: boolean }) => this.commit(draft => {
      const n = findNode(draft, nodeId); if (!n) return;
      n.config = this.invokeConfig(ep, reqMap?.name ?? n.config['input']);
      if (opts.retarget && reqMap) { const m = findNode(draft, reqMap.id)!; m.config['targetSystem'] = ep.system; m.config['targetTable'] = ep.table; }
      if (opts.addMap) {
        const loc = locate(draft, nodeId)!;
        const map = this.newMap(draft, 'map' + n.name[0].toUpperCase() + n.name.slice(1) + 'Request', { purpose: 'invokeRequest', for: n.id, input: '', targetSystem: ep.system, targetTable: ep.table });
        loc.steps.splice(loc.index, 0, map); n.config['input'] = map.name;
      }
    }, 'endpoint:' + nodeId);
    if (ep.requestBody) {
      if (!reqMap) { apply({ addMap: true }); this.notice.set('The new operation sends a request body: an unconfigured request mapping was added before the Invoke.'); }
      else if (reqMap.config['targetSystem'] === ep.system && reqMap.config['targetTable'] === ep.table) apply({});
      else this.impact.set({ message: `${reqMap.name} has ${rules} rule(s) for ${reqMap.config['targetSystem']}.${reqMap.config['targetTable']}, but the new operation expects ${ep.system}.${ep.table}.`,
        options: [{ label: 'Retarget the mapping (keep its rules for review)', apply: () => apply({ retarget: true }) }, { label: 'Keep the mapping unchanged', apply: () => apply({}) }] });
    } else if (reqMap) {
      this.impact.set({ message: `${reqMap.name} (${rules} rule(s)) feeds ${node.name}, but ${ep.method} ${ep.path} sends no request body.`,
        options: [{ label: 'Apply and keep the mapping for review', apply: () => apply({}) }] });
    } else apply({});
  }
  private applyTrigger(t: TriggerEndpoint) {
    const responseMaps = allNodes(this.flow()).filter(n => n.type === 'map' && n.config['purpose'] === 'triggerResponse');
    const old = this.flow().trigger?.config['endpoint']?.response;
    const changed = responseMaps.length && (old?.system !== t.endpoint.response?.system || old?.table !== t.endpoint.response?.table);
    const apply = (retarget: boolean) => this.commit(draft => {
      if (!draft.trigger) return;
      draft.trigger.config = { mode: 'rest', connection: t.connection, endpoint: t.endpoint };
      if (retarget && t.endpoint.response) for (const m of responseMaps) { const n = findNode(draft, m.id)!; n.config['targetSystem'] = t.endpoint.response.system; n.config['targetTable'] = t.endpoint.response.table; }
    }, 'trigger');
    if (changed) this.impact.set({ message: `The response schema changed and ${responseMaps.map(m => m.name).join(', ')} map to the old one.`,
      options: [...(t.endpoint.response ? [{ label: 'Retarget the response mapping (keep its rules for review)', apply: () => apply(true) }] : []), { label: 'Keep the mapping unchanged', apply: () => apply(false) }] });
    else { apply(false); this.notice.set(`Start trigger configured: ${t.endpoint.method} ${t.endpoint.path} (design-time only, not activated).`); }
  }
  /** Adds a mapping point next to the action it serves; it stays unconfigured until fields are mapped. */
  addMapping(e: { kind: 'invokeResponse' | 'triggerResponse' | 'stageFile'; nodeId: string }) {
    let createdId = '';
    this.commit(draft => {
      if (e.kind === 'triggerResponse') {
        const res = draft.trigger?.config['endpoint']?.response; if (!res) return;
        const map = this.newMap(draft, 'mapResponse', { purpose: 'triggerResponse', input: '', targetSystem: res.system, targetTable: res.table });
        const i = draft.steps.length && END_TYPES.includes(draft.steps[draft.steps.length - 1].type) ? draft.steps.length - 1 : draft.steps.length;
        draft.steps.splice(i, 0, map); createdId = map.id; return;
      }
      const at = locate(draft, e.nodeId); if (!at) return;
      const node = at.steps[at.index];
      if (e.kind === 'invokeResponse') {
        const map = this.newMap(draft, 'map' + node.name[0].toUpperCase() + node.name.slice(1) + 'Response', { purpose: 'invokeResponse', for: node.id, input: node.name, targetSystem: 'erp', targetTable: '' });
        at.steps.splice(at.index + 1, 0, map); createdId = map.id;
      } else {
        const map = this.newMap(draft, 'map' + node.name[0].toUpperCase() + node.name.slice(1) + 'Data', { purpose: 'stageFile', for: node.id, input: '', targetSystem: 'erp', targetTable: '' });
        at.steps.splice(at.index, 0, map); node.config['input'] = map.name; createdId = map.id;
      }
    });
    if (createdId) { this.selectedId.set(createdId); this.notice.set('Mapping added. Choose its source and target, then open the field mapper.'); }
  }

  // ----------------------------------------------------------- layouts and outline
  private storedLayout(): Layout { try { const v = localStorage.getItem(LAYOUT_KEY); return v === 'Horizontal' || v === 'Outline' ? v : 'Vertical'; } catch { return 'Vertical'; } }
  /** The presentation is a per-viewer preference; it never changes the flow definition. */
  setLayout(l: Layout) { this.layout.set(l); try { localStorage.setItem(LAYOUT_KEY, l); } catch { /* preference only */ } }
  outlineRows = computed(() => {
    const rows: { node: FlowNode; depth: number; branch: string | null }[] = [];
    const walk = (steps: FlowNode[], depth: number, branch: string | null) => steps.forEach((n, i) => {
      rows.push({ node: n, depth, branch: i === 0 ? branch : null });
      if (!this.collapsed().has(n.id)) for (const b of n.branches ?? []) walk(b.steps, depth + 1, b.label);
    });
    const t = this.flow().trigger; if (t) rows.push({ node: t, depth: 0, branch: null });
    walk(this.flow().steps, 0, null);
    walk(this.flow().globalFaultHandler, 0, 'Global fault handler');
    return rows;
  });
  typeLabel(n: FlowNode) {
    if (n.type === 'trigger') return n.config?.['mode'] === 'rest' ? 'Start · REST' : n.config?.['mode'] === 'schedule' ? 'Start · Schedule' : 'Start · Manual';
    if (n.type === 'map') return PURPOSE_LABEL[n.config?.['purpose'] ?? 'explicit'] ?? 'Map';
    return this.catalog()?.actions.find(a => a.type === n.type)?.label ?? n.type;
  }
  connectionText(n: FlowNode) {
    const c = n.config ?? {};
    if (n.type === 'invoke') return c['connection'] ? `${c['connection']} · ${c['method'] ?? ''} ${c['path'] ?? c['operation'] ?? ''}` : `(no connection) · ${c['operation'] ?? '?'}`;
    if (n.type === 'trigger' && c['mode'] === 'rest') return c['connection'] ? `${c['connection']} · ${c['endpoint']?.method ?? ''} ${c['endpoint']?.path ?? ''}` : 'Not configured';
    if (n.type === 'trigger' && c['mode'] === 'schedule') return `${c['frequency'] ?? 'manual'}${c['time'] ? ' ' + c['time'] : ''} · ${c['timezone'] ?? 'UTC'}`;
    return '—';
  }
  schemaText(n: FlowNode) {
    const c = n.config ?? {};
    switch (n.type) {
      case 'invoke': return c['table'] ? `${c['system']}.${c['table']}` : c['system'] ? `${c['system']} catalog` : '—';
      case 'map': return `${c['input'] || '?'} → ${c['targetSystem'] ?? '?'}.${c['targetTable'] || '?'}`;
      case 'trigger': return c['mode'] === 'rest' ? `in: ${c['endpoint']?.request?.table ?? 'none'} · out: ${c['endpoint']?.response?.table ?? 'none'}` : '—';
      case 'stageFile': return `${c['format'] ?? ''} ${c['fileName'] ?? ''}`;
      default: return '—';
    }
  }
  mappingText(n: FlowNode) {
    const c = n.config ?? {};
    if (n.type === 'map') { const r = (c['rules'] ?? []).length; return r ? `${r} rule(s)` : 'Unconfigured'; }
    if (n.type === 'invoke') return ['create', 'update', 'upsert'].includes(c['operation']) ? (c['input'] ? `request from ${c['input']}` : 'Needs request mapping') : 'No body';
    return '—';
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
  /** Usable actions first, planned ones after them. */
  byCategory(cat: string) { return (this.catalog()?.actions ?? []).filter(a => a.category === cat).sort((a, b) => Number(a.status === 'Planned') - Number(b.status === 'Planned')); }
  label(n: FlowNode) { return `${this.catalog()?.actions.find(a => a.type === n.type)?.label ?? n.type} ${n.name}`; }
  summary(n: FlowNode): string {
    const c = n.config ?? {};
    switch (n.type) {
      case 'trigger':
        if (c['mode'] === 'rest') return c['endpoint'] ? `REST · ${c['endpoint'].method} ${c['endpoint'].path}` : 'Application trigger · not configured';
        if (c['mode'] === 'schedule') return `Schedule · ${c['frequency'] ?? 'manual'}${c['time'] ? ' ' + c['time'] : ''} · ${c['timezone'] ?? 'UTC'}`;
        return 'Manual · ' + ((c['parameters'] ?? []).map((p: any) => p.name).join(', ') || 'no parameters');
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
