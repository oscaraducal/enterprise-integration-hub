import { Component, ElementRef, HostListener, Injector, OnDestroy, OnInit, TemplateRef, ViewChild, ViewContainerRef, WritableSignal, afterNextRender, computed, effect, inject, input, output, signal } from '@angular/core';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { CdkScrollable } from '@angular/cdk/scrolling';
import { TemplatePortal } from '@angular/cdk/portal';
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
import { ConnectionView } from '../connections.component';
import { styleLabel } from './create-integration.component';
import { downloadFlow } from '../integrations.component';
import { DesignerSession } from '../workspaces';

interface Current { name: string; title: string; description?: string; revision: number; versions: VersionInfo[]; style: string; identifier: string; versionLabel: string; tags: string[] }
interface PickerItem { key: string; label: string; description: string; icon: string; reason: string; def?: ActionDef; connection?: string; group?: string }
type Layout = 'Vertical' | 'Horizontal' | 'Outline';
const LAYOUT_KEY = 'eih.designer.layout';
const PICKER_TABS = ['Suggestions', 'Invokes', 'Actions'] as const;
/** Action groups listed (in this order, as one column) under the picker's Actions tab. */
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
 * Integration Designer: a full-screen editor for one integration, opened from the Integrations page. Left: action palette. Centre: nested,
 * drag-and-drop canvas. Right: properties. Bottom: problems, variables, versions and JSON. Designs are validated
 * and versioned on the server; execution arrives in Milestone D.
 */
@Component({
  selector: 'app-designer', standalone: true, imports: [CommonModule, FormsModule, MatButtonModule, CdkScrollable, ModalComponent, NodePropertiesComponent, EndpointWizardComponent],
  template: `
  <div class="designer" [class.fullscreen]="fullscreen()" [class.palette-hidden]="!showPalette()" [class.props-hidden]="!showProps()" [class.bottom-hidden]="!showBottom()">
    <header class="designer-top" role="region" aria-label="Integration header">
      <button type="button" class="back-btn" (click)="back.emit()" [attr.aria-label]="backTo() === 'project' ? 'Back to project' : 'Back to Integrations'"><span aria-hidden="true">←</span> {{backTo() === 'project' ? 'Project' : 'Integrations'}}</button>
      <nav class="crumbs" aria-label="Breadcrumb"><ol><li>Integration Workbench</li><li><button type="button" class="link-button" (click)="back.emit()">{{backTo() === 'project' ? 'Practice Project' : 'Integrations'}}</button></li><li aria-current="page">{{current()?.title ?? flowName()}}</li></ol></nav>
      @if (current(); as c) {
        <div class="designer-id"><h1>{{c.title}}</h1>
          <span class="muted small"><code>{{c.identifier}}</code> · {{c.versionLabel}} · {{styleLabel(c.style)}}</span>
          <span [class]="'pill ' + (c.versions.length ? 'Completed' : 'Pending')" aria-label="Publication status">{{c.versions.length ? 'Published v' + c.versions[0].version + ' · draft' : 'Draft'}}</span></div>
        <div class="designer-actions">
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
    <div class="designer-bar" role="toolbar" aria-label="Designer toolbar">
      @if (current(); as c) {
        <div class="tool-group" aria-label="Panels">
          <button type="button" class="tool" (click)="togglePanel(showPalette)" [attr.aria-pressed]="showPalette()" aria-label="Toggle action palette" title="Show or hide the actions and connections panel">☰</button>
          <button type="button" class="tool" (click)="togglePanel(showProps)" [attr.aria-pressed]="showProps()" aria-label="Toggle properties panel" title="Show or hide properties">▤</button>
          <button type="button" class="tool" (click)="togglePanel(showBottom)" [attr.aria-pressed]="showBottom()" aria-label="Toggle bottom panel" title="Show or hide Problems, Variables, Versions, JSON and Execution">▁</button>
        </div>
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
          <button type="button" class="tool" (click)="handMode.set(!handMode())" [attr.aria-pressed]="handMode()" aria-label="Hand mode" title="Hand mode: drag anywhere to move the canvas (or hold Space, or drag the empty background)" [disabled]="layout() === 'Outline'">✋</button>
          <button type="button" class="tool" (click)="setZoom(zoom() - 0.1)" aria-label="Zoom out" title="Zoom out (Ctrl + wheel zooms at the pointer)" [disabled]="layout() === 'Outline'">−</button>
          <button type="button" class="tool zoom-label" (click)="setZoom(1)" aria-label="Reset zoom" [disabled]="layout() === 'Outline'">{{zoom() * 100 | number:'1.0-0'}}%</button>
          <button type="button" class="tool" (click)="setZoom(zoom() + 0.1)" aria-label="Zoom in" [disabled]="layout() === 'Outline'">+</button>
          <button type="button" class="tool" (click)="fit()" aria-label="Fit to screen" title="Fit the whole flow" [disabled]="layout() === 'Outline'">⤢</button>
          <button type="button" class="tool" (click)="centerSelected()" aria-label="Center selected action" title="Center the selected action" [disabled]="!selectedId() || layout() === 'Outline'">⌖</button>
          <button type="button" class="tool" (click)="previousView()" aria-label="Previous view" title="Return to the previous view" [disabled]="!viewHistory().length || layout() === 'Outline'">⟲</button>
          <button type="button" class="tool" (click)="showMinimap.set(!showMinimap())" [attr.aria-pressed]="showMinimap()" aria-label="Toggle overview map" title="Show or hide the overview map" [disabled]="layout() === 'Outline'">▣</button>
          <label class="search-box"><span class="sr-only">Search actions</span><input type="search" placeholder="Search actions…" [ngModel]="search()" (ngModelChange)="search.set($event)" (keyup.enter)="nextMatch()" aria-label="Search actions"></label>
          @if (search()) { <span class="muted small">{{matches().length}} match(es)</span> }
          <button type="button" class="tool" (click)="fullscreen.set(!fullscreen())" [attr.aria-pressed]="fullscreen()" aria-label="Full screen" title="Full screen">⛶</button>
        </div>
      }
    </div>
    @if (error()) { <div class="alert error" role="alert">{{error()}} @if (conflict()) { <button class="link-button" (click)="reload()">Reload the latest draft</button> } <button (click)="error.set(''); conflict.set(false)" aria-label="Dismiss error">×</button></div> }
    @if (notice()) { <div class="alert success" role="status">{{notice()}} <button (click)="notice.set('')" aria-label="Dismiss notification">×</button></div> }

    @if (current(); as c) {
      <div class="designer-main">
        @if (showPalette()) {
        <aside class="palette" aria-label="Action palette">
          <h2>Connections</h2>
          <ul>@for (c of invokeConnections(); track c.identifier) {
            <li><button type="button" class="palette-item conn" [disabled]="readOnly()" [draggable]="!readOnly()" (dragstart)="dragConnection($event, c.identifier)" (click)="addConnectionInvoke(c.identifier)"
              [title]="'Invoke ' + c.name + ': drag onto a + or click to add after the selected action'" [attr.aria-label]="'Invoke with connection ' + c.identifier">
              <span class="icon" aria-hidden="true">⇄</span><span class="conn-text">{{c.name}}<small>{{c.identifier}}</small></span></button></li>
          } @empty { <li class="hint">No Invoke connections yet. Create one in Connections.</li> }</ul>
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
        }

        <div class="canvas-area">
        <section class="canvas-wrap" cdkScrollable #canvasWrap aria-label="Flow canvas" [attr.aria-describedby]="'canvas-help'"
          [class.can-pan]="(handMode() || spaceHeld()) && layout() !== 'Outline'" [class.panning]="panning()"
          (click)="select(null)" (pointerdown)="panStart($event)"
          (wheel)="onWheel($event)" (scroll)="onScroll()">
          @if (layout() === 'Outline') { <ng-container *ngTemplateOutlet="outline"></ng-container> } @else {
          <div class="canvas" #canvas [class.horizontal]="layout() === 'Horizontal'" [style.zoom]="zoom()">
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
        <p class="sr-only" id="canvas-help">Drag the empty background, hold Space and drag, or use the middle mouse button to move the canvas. Ctrl and the mouse wheel zoom at the pointer.</p>
        @if (showMinimap() && layout() !== 'Outline' && mini(); as m) {
          <div class="minimap" role="group" aria-label="Overview map" [style.width.px]="m.w" [style.height.px]="m.h" (pointerdown)="miniPointer($event)" (pointermove)="$event.buttons === 1 && miniPointer($event)">
            <svg [attr.width]="m.w" [attr.height]="m.h" aria-hidden="true">
              @for (b of m.boxes; track $index) { <rect [attr.x]="b.x" [attr.y]="b.y" [attr.width]="b.w" [attr.height]="b.h" [class]="b.cls" rx="1.5"></rect> }
              <rect class="mm-view" [attr.x]="m.vx" [attr.y]="m.vy" [attr.width]="m.vw" [attr.height]="m.vh"></rect>
            </svg>
          </div>
        }
        </div>

        @if (showProps()) {
        <aside class="properties" aria-label="Properties">
          <app-node-properties [api]="api()" [node]="selectedNode()" [def]="selectedDef()" [variables]="scopeVars()" [functions]="catalog()?.functions ?? []"
            [catalogs]="tables()" [issues]="selectedIssues()" [readOnly]="readOnly()" [connections]="connections()" (changed)="updateNode($event)"
            (editEndpoint)="editEndpoint($event)" (configureTrigger)="configureTrigger()" (addMapping)="addMapping($event)"></app-node-properties>
        </aside>
        }
      </div>

      <section class="bottom-panel" aria-label="Designer panel">
        <div class="tabs" role="tablist" aria-label="Designer panel tabs">
          @for (t of bottomTabs; track t) { <button role="tab" [attr.aria-selected]="showBottom() && bottomTab() === t" [class.active]="showBottom() && bottomTab() === t" (click)="openBottom(t)">{{t}}{{t === 'Problems' ? ' (' + (report()?.issues?.length ?? 0) + ')' : ''}}</button> }
          <button type="button" class="link-button bottom-toggle" (click)="togglePanel(showBottom)" [attr.aria-expanded]="showBottom()">{{showBottom() ? 'Hide panel ▾' : 'Show panel ▴'}}</button>
        </div>
        @if (showBottom()) {
        <div class="bottom-body">
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
          @case ('Execution') { <p class="hint pad">Execution is not available yet. Milestone D adds a bounded executor for the supported actions, with a per-action trace here. Runtime instances will appear in Monitoring.</p> }
        }
        </div>
        }
      </section>
    } @else {
      <section class="panel empty-designer"><h2>{{busy() ? 'Opening integration…' : 'Integration not available'}}</h2>
        @if (!busy()) { <p class="muted">This integration could not be opened. It may have been renamed or removed.</p><button mat-flat-button (click)="back.emit()">Back to Integrations</button> }</section>
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
    <div class="slot" [class.active]="dropKey() === key(lane, index)" [class.picking]="pickerKey() === key(lane, index)" (dragover)="allowDrop($event, lane, index)" (dragleave)="dropKey.set('')" (drop)="dropOn($event, lane, index)"
      [attr.data-slot]="key(lane, index)">
      @if (!readOnly()) { <button type="button" class="slot-btn" (click)="$event.stopPropagation(); openPicker(lane, index, $any($event.currentTarget))" [attr.aria-expanded]="pickerKey() === key(lane, index)" [attr.aria-label]="'Insert action at ' + slotLabel(lane, index)">+</button> }
      @else { <span aria-hidden="true">+</span> }</div>
  </ng-template>
  <ng-template #card let-node>
    <div class="node" [class]="'node type-' + node.type" [class.selected]="selectedId() === node.id" [class.match]="isMatch(node)" [class.error]="nodeErrors(node.id) > 0"
      [attr.data-node-id]="node.id" (click)="$event.stopPropagation(); select(node.id)">
      <button type="button" class="node-head" [draggable]="!readOnly() && node.type !== 'trigger' && !handMode() && !spaceHeld()" (dragstart)="dragNode($event, node)" (click)="$event.stopPropagation(); select(node.id)" [attr.aria-label]="label(node) + (nodeErrors(node.id) ? ', ' + nodeErrors(node.id) + ' error(s)' : '')" [attr.aria-pressed]="selectedId() === node.id">
        <span class="icon" aria-hidden="true">{{icon(node.type)}}</span>
        <span class="node-text"><span class="node-type">{{typeLabel(node)}}@if (connectionOf(node); as cn) { <span class="conn-chip" [title]="'Connection ' + cn">⚭ {{cn}}</span> }</span>
          <b>{{node.name}}</b><small>{{summary(node)}}</small></span>
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
    <div class="picker" role="dialog" aria-label="Add action" [attr.aria-describedby]="'picker-where'" (click)="$event.stopPropagation()" (keydown)="pickerKeys($event)">
      <div class="picker-head"><h2>Add action</h2><button type="button" class="picker-close" (click)="closePicker()" aria-label="Close action picker">×</button></div>
      <p class="picker-where" id="picker-where">{{slotLabel(lane, index)}}</p>
      <input type="search" class="picker-search" aria-label="Search actions and connections" placeholder="Search actions and connections" [ngModel]="pickerQuery()" (ngModelChange)="pickerQuery.set($event)" maxlength="40">
      @if (!pickerQuery().trim()) {
        <div class="picker-tabs" role="tablist" aria-label="Action categories">@for (t of pickerTabs; track t) { <button type="button" role="tab" [attr.aria-selected]="pickerTab() === t" [class.active]="pickerTab() === t" (click)="pickerTab.set(t)">{{t}}</button> }</div>
      }
      <ul class="picker-list" [attr.aria-label]="pickerQuery().trim() ? 'Search results' : pickerTab()">
        @for (item of pickerItems(lane, index); track item.key) {
          @if (item.group) { <li class="picker-group" aria-hidden="true">{{item.group}}</li> }
          <li><button type="button" [disabled]="!!item.reason" (click)="pick(item, lane, index)" [attr.aria-label]="item.label + (item.reason ? ' (unavailable)' : '')" [title]="item.reason || item.description">
            <span class="icon" aria-hidden="true">{{item.icon}}</span><span><b>{{item.label}}</b><small>{{item.reason || item.description}}</small></span></button></li>
        } @empty { <li class="hint">{{pickerQuery().trim() ? 'No action or connection matches “' + pickerQuery().trim() + '”.' : pickerTab() === 'Invokes' ? 'No Invoke connections yet. Create one in Connections.' : 'Nothing available here.'}}</li> }
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
  @if (pendingOpen(); as p) {
    <app-modal label="Unsaved changes" heading="Discard unsaved changes?" eyebrow="CONFIRM" (close)="pendingOpen.set(null)">
      <p>The draft of <b>{{current()?.title}}</b> has unsaved changes. Loading version {{p.target}} replaces the canvas.</p>
      <div class="form-actions"><button mat-flat-button (click)="confirmPending()">Discard changes</button><button mat-button (click)="pendingOpen.set(null)">Keep editing</button></div>
    </app-modal>
  }
  @if (leaving()) {
    <app-modal label="Leave the Designer" heading="Leave with unsaved changes?" eyebrow="UNSAVED CHANGES" (close)="resolveLeave('stay')">
      <p><b>{{current()?.title}}</b> has changes that are not saved yet.</p>
      <ul class="hint"><li><b>Save draft and leave</b> stores a new draft revision.</li><li><b>Keep changes for later</b> holds them in this browser tab; they are restored when you reopen this integration (until you sign out).</li></ul>
      <div class="form-actions">@if (!readOnly()) { <button mat-flat-button (click)="resolveLeave('save')" [disabled]="busy()">Save draft and leave</button> }
        <button mat-stroked-button (click)="resolveLeave('keep')">Keep changes for later</button>
        <button mat-button (click)="resolveLeave('discard')">Discard changes</button>
        <button mat-button (click)="resolveLeave('stay')">Stay</button></div>
    </app-modal>
  }`
})
export class DesignerComponent implements OnInit, OnDestroy {
  api = input.required<Api>();
  /** The integration (flow name) this Designer edits. */
  flowName = input.required<string>();
  /** Where Back returns: the Integrations list or the project it was opened from. */
  backTo = input<'integrations' | 'project'>('integrations');
  /** Back to the Integrations list or project (the route guard asks about unsaved changes). */
  back = output<void>();
  private injector = inject(Injector);
  showProps = signal(true); showBottom = signal(true); showMinimap = signal(true);
  handMode = signal(false); spaceHeld = signal(false); panning = signal(false);
  viewHistory = signal<{ zoom: number; left: number; top: number }[]>([]);
  mini = signal<{ w: number; h: number; boxes: { x: number; y: number; w: number; h: number; cls: string }[]; vx: number; vy: number; vw: number; vh: number } | null>(null);
  @ViewChild('picker') pickerTpl?: TemplateRef<unknown>;
  private overlay = inject(Overlay);
  private vcr = inject(ViewContainerRef);
  private session = inject(DesignerSession);
  private pickerRef: OverlayRef | null = null;
  private pickerAnchor: HTMLElement | null = null;
  private validateSeq = 0;
  canvasWrap?: ElementRef<HTMLElement>;
  @ViewChild('canvas') canvas?: ElementRef<HTMLElement>;
  readonly categories = CATEGORY_ORDER;
  readonly bottomTabs = ['Problems', 'Variables', 'Versions', 'JSON', 'Execution'] as const;
  catalog = signal<Catalog | null>(null);
  tables = signal<Record<SystemId, TableView[]>>({ crm: [], erp: [] });
  current = signal<Current | null>(null);
  flow = signal<FlowDefinition>({ schemaVersion: 1, trigger: null, steps: [], globalFaultHandler: [] });
  report = signal<FlowReport | null>(null);
  undoStack = signal<string[]>([]); redoStack = signal<string[]>([]);
  dirty = signal(false); busy = signal(false); error = signal(''); notice = signal(''); conflict = signal(false); formError = signal('');
  selectedId = signal<string | null>(null); clipboard = signal<FlowNode | null>(null);
  zoom = signal(1); search = signal(''); fullscreen = signal(false); showFault = signal(true); showPalette = signal(true);
  collapsed = signal<Set<string>>(new Set()); dropKey = signal('');
  bottomTab = signal<'Problems' | 'Variables' | 'Versions' | 'JSON' | 'Execution'>('Problems');
  readonly layouts: Layout[] = ['Vertical', 'Horizontal', 'Outline'];
  readonly pickerTabs = PICKER_TABS;
  readonly styleLabel = styleLabel;
  layout = signal<Layout>(this.storedLayout());
  connections = signal<ConnectionView[]>([]);
  pickerKey = signal(''); pickerTab = signal<typeof PICKER_TABS[number]>('Suggestions'); pickerQuery = signal('');
  /** Resolves the route guard's question when leaving with unsaved changes. */
  leaving = signal<((choice: 'save' | 'keep' | 'discard' | 'stay') => void) | null>(null);
  wizard = signal<{ mode: 'invoke' | 'trigger'; name: string; nodeId?: string; lane?: Lane; index?: number; initial: Record<string, any> | null; variables: any[] } | null>(null);
  impact = signal<{ message: string; options: { label: string; apply: () => void }[] } | null>(null);
  pendingOpen = signal<{ action: 'version'; target: string } | null>(null);
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

  constructor() {
    // The anchored picker follows zoom and layout changes; Outline has no + slots, so it closes there.
    effect(() => { this.zoom(); if (this.layout() === 'Outline') this.closePicker(false); else queueMicrotask(() => this.pickerRef?.updatePosition()); });
    effect(() => {
      this.flow(); this.zoom(); this.layout(); this.collapsed(); this.showFault(); this.selectedId(); this.report(); this.showMinimap();
      afterNextRender(() => this.measureMini(), { injector: this.injector });
    });
  }
  async ngOnInit() {
    this.session.register(() => this.confirmLeave());
    this.busy.set(true);
    try {
      const [catalog, crm, erp] = await Promise.all([this.api().request<Catalog>('flows/actions'), loadTables(this.api(), 'crm'), loadTables(this.api(), 'erp')]);
      this.catalog.set(catalog); this.tables.set({ crm, erp });
      try { this.connections.set(await this.api().request<ConnectionView[]>('connections')); } catch { /* connections are optional for viewing */ }
      await this.open(this.flowName());
      const notice = this.session.notice; this.session.notice = '';
      if (notice && this.current()) {
        this.notice.set(notice);
        if (this.current()!.style === 'application' && !this.flow().steps.length) this.select(this.flow().trigger?.id ?? null);
      }
    } catch (e) { this.fail(e); } finally { this.busy.set(false); }
  }
  ngOnDestroy() { clearTimeout(this.validateTimer); this.closePicker(false); this.session.register(null); this.resize?.disconnect();
    document.removeEventListener('pointermove', this.onPanMove); document.removeEventListener('pointerup', this.onPanEnd); document.removeEventListener('pointercancel', this.onPanEnd); }

  // ----------------------------------------------------------- leaving the Designer
  /** Route guard: leave freely when saved; otherwise ask whether to save, keep the changes for later, discard them or stay. */
  confirmLeave(): Promise<boolean> {
    if (!this.dirty() || !this.current()) return Promise.resolve(true);
    this.closePicker(false);
    return new Promise<boolean>(resolve => this.leaving.set(async choice => {
      if (choice === 'save') { await this.save(); if (this.dirty()) { this.leaving.set(null); resolve(false); return; } }
      if (choice === 'keep') {
        const c = this.current()!;
        this.session.keep(c.name, { baseRevision: c.revision, title: c.title, definition: JSON.stringify(this.flow()), keptAt: new Date() });
      }
      this.leaving.set(null);
      if (choice !== 'stay') this.dirty.set(false);
      resolve(choice !== 'stay');
    }));
  }
  resolveLeave(choice: 'save' | 'keep' | 'discard' | 'stay') { this.leaving()?.(choice); }
  @HostListener('window:beforeunload', ['$event']) beforeUnload(e: BeforeUnloadEvent) { if (this.dirty()) { e.preventDefault(); e.returnValue = ''; } }

  // ----------------------------------------------------------- flows
  async confirmPending() {
    const p = this.pendingOpen(); this.pendingOpen.set(null); if (!p) return;
    this.dirty.set(false);
    await this.loadVersion(Number(p.target), true);
  }
  async open(name: string) {
    this.busy.set(true); this.error.set(''); this.conflict.set(false);
    try {
      const f = await this.api().request<Current & { definition: FlowDefinition; report: FlowReport }>('flows/' + encodeURIComponent(name));
      this.current.set({ name: f.name, title: f.title, description: f.description, revision: f.revision, versions: f.versions, style: f.style, identifier: f.identifier, versionLabel: f.versionLabel, tags: f.tags });
      this.flow.set(this.normalize(f.definition)); this.report.set(f.report);
      this.undoStack.set([]); this.redoStack.set([]); this.dirty.set(false); this.selectedId.set(null); this.collapsed.set(new Set());
      // Changes kept when leaving earlier are restored on top of their base revision; Undo returns to the saved draft,
      // and saving over a newer draft is refused (409) as usual.
      const kept = this.session.take(f.name);
      if (kept) {
        this.undoStack.set([JSON.stringify(this.flow())]);
        this.current.set({ ...this.current()!, title: kept.title, revision: kept.baseRevision });
        this.flow.set(this.normalize(JSON.parse(kept.definition))); this.dirty.set(true); this.scheduleValidation();
        this.notice.set(`Restored the unsaved changes you kept at ${kept.keptAt.toLocaleTimeString()}. Save the draft to keep them, or Undo to return to the saved draft.`);
      }
    } catch (e) { this.fail(e); } finally { this.busy.set(false); }
  }
  reload() { this.error.set(''); this.conflict.set(false); this.dirty.set(false); const c = this.current(); if (c) void this.open(c.name); }
  private normalize(d: FlowDefinition): FlowDefinition {
    const fix = (n: FlowNode) => { n.config ??= {}; n.branches ??= []; n.branches.forEach(b => (b.steps ??= []).forEach(fix)); };
    d.steps ??= []; d.globalFaultHandler ??= [];
    if (d.trigger) fix(d.trigger); d.steps.forEach(fix); d.globalFaultHandler.forEach(fix);
    return d;
  }
  async save() {
    const c = this.current(); if (!c) return;
    this.busy.set(true); this.error.set('');
    try {
      const r = await this.api().request<{ revision: number; report: FlowReport }>(`flows/${c.name}/draft`, 'PUT', { title: c.title, definition: this.flow(), revision: c.revision });
      this.current.set({ ...c, revision: r.revision }); this.report.set(r.report); this.dirty.set(false);
      this.notice.set(r.report.valid ? `Draft saved (revision ${r.revision}). It is valid and can be published.` : `Draft saved (revision ${r.revision}) with ${this.errorCount()} error(s) to fix before publishing.`);
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
      await this.open(c.name); this.bottomTab.set('Versions');
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
      await downloadFlow(this.api(), c.name, version);
      this.notice.set(`Exported ${version ? 'version ' + version : 'the saved draft'} as an eih-flow document.`);
    } catch (e) { this.fail(e); }
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
    const seq = ++this.validateSeq;
    this.validateTimer = setTimeout(async () => {
      try { const r = await this.api().request<FlowReport>('flows/validate', 'POST', { definition: this.flow() }); if (seq === this.validateSeq) this.report.set(r); }
      catch (e) { if (!(e instanceof SessionEnded) && seq === this.validateSeq) this.report.set(null); }
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
    if (createdId) { this.selectedId.set(createdId); this.notice.set(''); this.focusInserted(createdId); }
  }
  /** Moves keyboard focus to a newly inserted action so its properties can be edited straight away. */
  private focusInserted(id: string) {
    setTimeout(() => {
      const sel = CSS.escape(id);
      const el = document.querySelector<HTMLElement>(`[data-node-id="${sel}"] .node-head, [data-node-id="${sel}"] .o-select`);
      el?.focus({ preventScroll: true }); el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
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

  // ----------------------------------------------------------- inline + picker (anchored overlay)
  /**
   * Opens the Add action popup anchored to the clicked +. It is a CDK overlay rendered outside the canvas, so it never
   * moves or resizes the flow; it repositions near screen edges, while the canvas scrolls and when zooming. On small
   * screens it becomes a bottom sheet. Only one popup is open at a time.
   */
  openPicker(lane: Lane, index: number, anchor: HTMLElement) {
    const k = this.key(lane, index);
    const reopen = this.pickerKey() !== k;
    this.closePicker(false);
    if (!reopen || !this.pickerTpl) return;
    this.pickerKey.set(k); this.pickerQuery.set(''); this.pickerTab.set('Suggestions'); this.pickerAnchor = anchor;
    const sheet = window.matchMedia('(max-width: 640px)').matches;
    const side = this.layout() === 'Vertical';
    const right = { originX: 'end', originY: 'center', overlayX: 'start', overlayY: 'center', offsetX: 8 } as const;
    const left = { originX: 'start', originY: 'center', overlayX: 'end', overlayY: 'center', offsetX: -8 } as const;
    const below = { originX: 'center', originY: 'bottom', overlayX: 'center', overlayY: 'top', offsetY: 8 } as const;
    const above = { originX: 'center', originY: 'top', overlayX: 'center', overlayY: 'bottom', offsetY: -8 } as const;
    const position = sheet ? this.overlay.position().global().centerHorizontally().bottom('0')
      : this.overlay.position().flexibleConnectedTo(anchor).withPositions(side ? [right, left, below, above] : [below, above, right, left])
        .withPush(true).withViewportMargin(12).withFlexibleDimensions(false);
    this.pickerRef = this.overlay.create({
      positionStrategy: position, scrollStrategy: this.overlay.scrollStrategies.reposition(),
      panelClass: sheet ? ['picker-pane', 'picker-sheet'] : 'picker-pane', hasBackdrop: sheet, backdropClass: 'cdk-overlay-dark-backdrop',
      // A fixed pane size lets the position be chosen correctly before the content has rendered.
      width: sheet ? '100%' : 360, height: sheet ? '78vh' : 'min(460px, 72vh)',
    });
    this.pickerRef.attach(new TemplatePortal(this.pickerTpl, this.vcr, { lane, index }));
    // The content renders on the next change detection; position again with its real size so the best side is chosen.
    afterNextRender(() => this.pickerRef?.updatePosition(), { injector: this.injector });
    this.pickerRef.keydownEvents().subscribe(e => { if (e.key === 'Escape') { e.preventDefault(); this.closePicker(); } });
    this.pickerRef.backdropClick().subscribe(() => this.closePicker());
    this.pickerRef.outsidePointerEvents().subscribe(e => { if (!anchor.contains(e.target as Node)) this.closePicker(false); });
    setTimeout(() => this.pickerRef?.overlayElement.querySelector<HTMLElement>('.picker-search')?.focus());
  }
  /** Closes the popup; returns focus to its + unless an action was chosen (focus then moves to the new action). */
  closePicker(restoreFocus = true) {
    if (!this.pickerRef) return;
    this.pickerRef.dispose(); this.pickerRef = null; this.pickerKey.set('');
    const anchor = this.pickerAnchor; this.pickerAnchor = null;
    if (restoreFocus && anchor?.isConnected) anchor.focus();
  }
  /** Arrow keys move between the search box and the enabled actions in the list. */
  pickerKeys(e: KeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const root = this.pickerRef?.overlayElement; if (!root) return;
    const items = [root.querySelector<HTMLElement>('.picker-search')!, ...Array.from(root.querySelectorAll<HTMLElement>('.picker-list button:not([disabled])'))];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = items[Math.min(items.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    e.preventDefault(); next?.focus();
  }
  slotLabel(lane: Lane, index: number) {
    const where = lane.kind === 'root' ? 'main flow' : lane.kind === 'fault' ? 'global fault handler'
      : (this.allBranches().find(b => b.id === lane.branchId)?.label ?? 'branch');
    return `${where}, position ${index + 1}`;
  }
  private allBranches() { return allNodes(this.flow()).flatMap(n => n.branches ?? []); }
  private invokeItems(): PickerItem[] {
    const invokers = this.connections().filter(c => c.role === 'Invoke' || c.role === 'TriggerAndInvoke');
    const generic = this.catalog()?.actions.find(a => a.type === 'invoke');
    return [
      ...invokers.map(c => ({ key: 'c:' + c.identifier, label: `Invoke ${c.name}`, description: `${c.applicationName ?? c.application} · ${c.identifier}`, icon: '⇄', reason: '', connection: c.identifier })),
      ...(generic ? [{ key: 'invoke', label: 'Invoke (choose connection)', description: 'Opens the endpoint wizard.', icon: '⇄', reason: invokers.length ? '' : 'Create a connection with the Invoke role first (Connections).', def: generic }] : []),
    ];
  }
  private actionItems(lane: Lane, index: number): PickerItem[] {
    const ctx = laneContext(this.flow(), lane);
    const steps = stepsOf(this.flow(), lane) ?? [];
    let data: boolean | null = null;
    const hasData = () => data ??= this.varsAt(lane, index).some(v => v.kind !== 'scalar' && !!v.table);
    return Object.entries(PICKER_TYPES).flatMap(([group, types]) => types.map(t => this.catalog()?.actions.find(a => a.type === t)).filter((a): a is ActionDef => !!a).map((a, i) => {
      let reason = '';
      if (a.status === 'Planned') reason = `Planned (${a.planned}). Not available in this release.`;
      else if (a.type === 'rethrowFault' && !ctx.inFault) reason = 'Only inside a fault handler (Scope fault handler or the global fault handler).';
      else if (END_TYPES.includes(a.type) && index < steps.length) reason = 'End actions go at the end of a path; the actions after this position would become unreachable.';
      else if (a.type === 'map' && !hasData()) reason = 'No record or collection is in scope here to map from. Add an Invoke (or a trigger with a request schema) before this point.';
      return { key: a.type, label: a.label, description: a.description, icon: this.icon(a.type), reason, def: a, group: i === 0 ? group : undefined };
    }));
  }
  /** Items offered at a slot, with the reason when one cannot go there. Search spans invokes and actions. */
  pickerItems(lane: Lane, index: number): PickerItem[] {
    const q = this.pickerQuery().trim().toLowerCase();
    if (q) return [...this.invokeItems(), ...this.actionItems(lane, index)].map(i => ({ ...i, group: undefined }))
      .filter(i => i.label.toLowerCase().includes(q) || i.description.toLowerCase().includes(q) || (i.def?.type ?? '').toLowerCase().includes(q));
    switch (this.pickerTab()) {
      case 'Invokes': return this.invokeItems();
      case 'Actions': return this.actionItems(lane, index);
      default: {
        // Suggestions: what usually goes at this point and is usable here.
        const ctx = laneContext(this.flow(), lane);
        const atEnd = index >= (stepsOf(this.flow(), lane) ?? []).length;
        const wanted = ctx.inFault ? ['logger', 'assign', 'throwFault', 'rethrowFault', 'faultReturn'] : ['map', 'assign', 'switch', 'forEach', 'logger', ...(atEnd ? ['return'] : [])];
        const actions = this.actionItems(lane, index).filter(i => !i.reason && wanted.includes(i.def!.type)).map(i => ({ ...i, group: undefined }));
        return [...(ctx.inFault ? [] : this.invokeItems().filter(i => !i.reason).slice(0, 3)), ...actions];
      }
    }
  }
  pick(item: PickerItem, lane: Lane, index: number) {
    if (item.reason) return;
    this.closePicker(false);
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
      this.selectedId.set(invokeId); this.focusInserted(invokeId);
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

  // ----------------------------------------------------------- viewport: pan, zoom, fit, center, overview map
  /**
   * The canvas uses CSS zoom (not a transform), so scroll extents, element rectangles, pointer coordinates and the
   * anchored + popup all agree with what is drawn. Native scrolling handles wheel and trackpad; pointer drags pan by
   * changing the scroll position; Ctrl + wheel zooms around the pointer. The flow model is never touched.
   */
  private wrapEl?: HTMLElement;
  private pan: { id: number; x: number; y: number; left: number; top: number; moved: boolean } | null = null;
  private suppressClick = false;
  private resize?: ResizeObserver;
  /** Whether the pointer is over the canvas (a :hover check: mouse enter/leave events are suppressed during a pan). */
  private overCanvas() { return !!this.wrapEl?.matches(':hover'); }
  @ViewChild('canvasWrap') set canvasWrapRef(ref: ElementRef<HTMLElement> | undefined) {
    const el = ref?.nativeElement;
    if (el === this.wrapEl) return;
    this.resize?.disconnect(); this.wrapEl = el; this.canvasWrap = ref;
    if (!el) return;
    // A drag that panned must not also select (or deselect) what was under the pointer.
    el.addEventListener('click', e => { if (this.suppressClick) { this.suppressClick = false; e.stopPropagation(); e.preventDefault(); } }, true);
    this.resize = new ResizeObserver(() => this.measureMini()); this.resize.observe(el);
    this.measureMini();
  }
  private isEditable(t: EventTarget | null) { return !!(t as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable], app-modal, .picker'); }
  panMode() { return this.handMode() || this.spaceHeld(); }
  panStart(e: PointerEvent) {
    const wrap = this.wrapEl; if (!wrap || this.layout() === 'Outline' || this.isEditable(e.target)) return;
    const onControl = !!(e.target as HTMLElement).closest('button, a, label, .slot, .node-head, .minimap');
    const start = e.button === 1 || (e.button === 0 && (this.panMode() || !onControl));
    if (!start) return;
    // No middle-button autoscroll, text selection (whose autoscroll would fight the pan) or drag start; clicks still fire.
    e.preventDefault();
    this.pan = { id: e.pointerId, x: e.clientX, y: e.clientY, left: wrap.scrollLeft, top: wrap.scrollTop, moved: false };
    // Follow the pointer on the whole document, so the drag keeps working when it leaves the canvas.
    document.addEventListener('pointermove', this.onPanMove);
    document.addEventListener('pointerup', this.onPanEnd);
    document.addEventListener('pointercancel', this.onPanEnd);
  }
  private onPanMove = (e: PointerEvent) => this.panMove(e);
  private onPanEnd = (e: PointerEvent) => this.panEnd(e);
  panMove(e: PointerEvent) {
    const p = this.pan, wrap = this.wrapEl; if (!p || !wrap || e.pointerId !== p.id) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (!p.moved) {
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;          // a click, not a drag
      p.moved = true; this.panning.set(true); this.closePicker(false);
    }
    e.preventDefault();
    wrap.scrollLeft = p.left - dx; wrap.scrollTop = p.top - dy;
  }
  panEnd(e: PointerEvent) {
    const p = this.pan; if (!p || e.pointerId !== p.id) return;
    this.pan = null;
    document.removeEventListener('pointermove', this.onPanMove);
    document.removeEventListener('pointerup', this.onPanEnd);
    document.removeEventListener('pointercancel', this.onPanEnd);
    if (p.moved) { this.suppressClick = true; this.panning.set(false); setTimeout(() => this.suppressClick = false); }
  }
  /** Space held over the canvas arms panning (called from the single document keydown listener, onKey). */
  spaceDown(e: KeyboardEvent) {
    if (e.code !== 'Space' || !this.overCanvas() || this.isEditable(e.target) || this.layout() === 'Outline') return;
    e.preventDefault(); if (!e.repeat) this.spaceHeld.set(true);
  }
  @HostListener('document:keyup', ['$event']) spaceUp(e: KeyboardEvent) {
    if (e.code === 'Space' && this.spaceHeld()) { e.preventDefault(); this.spaceHeld.set(false); }
  }
  @HostListener('window:blur') windowBlur() { this.spaceHeld.set(false); }
  onWheel(e: WheelEvent) {
    if (!(e.ctrlKey || e.metaKey) || this.layout() === 'Outline') return;  // plain wheel / trackpad scrolls natively
    e.preventDefault();
    this.zoomAt(this.zoom() * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX, e.clientY);
  }
  onScroll() { this.updateMiniView(); }
  private clampZoom(z: number) { return Math.round(Math.min(2, Math.max(0.1, z)) * 100) / 100; }
  /** Zooms keeping the content point under (clientX, clientY), or the viewport centre, in place. */
  zoomAt(z: number, clientX?: number, clientY?: number) {
    const wrap = this.wrapEl, canvas = this.canvas?.nativeElement, next = this.clampZoom(z), prev = this.zoom();
    if (!wrap || !canvas || next === prev) { this.zoom.set(next); return; }
    const r = wrap.getBoundingClientRect();
    const px = (clientX ?? r.left + wrap.clientWidth / 2) - r.left, py = (clientY ?? r.top + wrap.clientHeight / 2) - r.top;
    const ox = canvas.offsetLeft, oy = canvas.offsetTop;
    const cx = (wrap.scrollLeft + px - ox) / prev, cy = (wrap.scrollTop + py - oy) / prev;
    this.zoom.set(next);
    afterNextRender(() => { wrap.scrollLeft = cx * next + ox - px; wrap.scrollTop = cy * next + oy - py; this.measureMini(); }, { injector: this.injector });
  }
  setZoom(z: number) { this.zoomAt(z); }
  private remember() {
    const wrap = this.wrapEl; if (!wrap) return;
    this.viewHistory.set([...this.viewHistory(), { zoom: this.zoom(), left: wrap.scrollLeft, top: wrap.scrollTop }].slice(-20));
  }
  /** Fits the whole flow into the viewport (never enlarging past 100%) and centres it. */
  fit() {
    const wrap = this.wrapEl, canvas = this.canvas?.nativeElement; if (!wrap || !canvas) return;
    this.remember();
    const z = this.zoom(), rect = canvas.getBoundingClientRect();
    const naturalW = rect.width / z, naturalH = rect.height / z;
    const next = this.clampZoom(Math.floor(Math.min((wrap.clientWidth - 24) / naturalW, (wrap.clientHeight - 24) / naturalH, 1) * 20) / 20);
    this.zoom.set(next);
    afterNextRender(() => { wrap.scrollTo({ left: (wrap.scrollWidth - wrap.clientWidth) / 2, top: 0 }); this.measureMini(); }, { injector: this.injector });
  }
  /** Scrolls so an action's card is in the middle of the viewport; the previous view can be restored. */
  centerOn(id: string, smooth = true) {
    const wrap = this.wrapEl; if (!wrap) return;
    const el = wrap.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"] > .node-head`) ?? wrap.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`);
    if (!el) return;
    this.remember();
    const w = wrap.getBoundingClientRect(), r = el.getBoundingClientRect();
    wrap.scrollTo({ left: wrap.scrollLeft + (r.left + r.width / 2) - (w.left + wrap.clientWidth / 2),
      top: wrap.scrollTop + (r.top + r.height / 2) - (w.top + wrap.clientHeight / 2), behavior: smooth ? 'smooth' : 'auto' });
  }
  centerSelected() { const id = this.selectedId(); if (id) this.centerOn(id); }
  previousView() {
    const stack = this.viewHistory(); const v = stack.at(-1); const wrap = this.wrapEl; if (!v || !wrap) return;
    this.viewHistory.set(stack.slice(0, -1)); this.zoom.set(v.zoom);
    afterNextRender(() => { wrap.scrollTo({ left: v.left, top: v.top }); this.measureMini(); }, { injector: this.injector });
  }
  /** Opening or closing a side panel changes the canvas width; keep the same content point in the middle. */
  togglePanel(panel: WritableSignal<boolean>) {
    const wrap = this.wrapEl;
    const center = wrap ? { x: wrap.scrollLeft + wrap.clientWidth / 2, y: wrap.scrollTop + wrap.clientHeight / 2 } : null;
    panel.set(!panel());
    if (center) afterNextRender(() => {
      const w = this.wrapEl; if (!w) return;
      w.scrollLeft = center.x - w.clientWidth / 2; w.scrollTop = center.y - w.clientHeight / 2; this.measureMini();
    }, { injector: this.injector });
  }
  openBottom(tab: typeof this.bottomTabs[number]) { this.bottomTab.set(tab); if (!this.showBottom()) this.togglePanel(this.showBottom); }
  /** Overview map: action boxes and the visible window, in scroll coordinates scaled to at most 200 × 140 px. */
  measureMini() {
    const wrap = this.wrapEl;
    if (!wrap || !this.showMinimap() || this.layout() === 'Outline') { this.mini.set(null); return; }
    const W = Math.max(wrap.scrollWidth, 1), H = Math.max(wrap.scrollHeight, 1);
    const k = Math.min(200 / W, 140 / H), wr = wrap.getBoundingClientRect();
    const boxes = Array.from(wrap.querySelectorAll<HTMLElement>('.node-head')).map(el => {
      const r = el.getBoundingClientRect(), node = el.closest('.node');
      return { x: (r.left - wr.left + wrap.scrollLeft) * k, y: (r.top - wr.top + wrap.scrollTop) * k, w: Math.max(2, r.width * k), h: Math.max(2, r.height * k),
        cls: node?.classList.contains('selected') ? 'mm-node sel' : node?.classList.contains('error') ? 'mm-node err' : 'mm-node' };
    });
    this.miniScale = k;
    this.mini.set({ w: Math.ceil(W * k), h: Math.ceil(H * k), boxes, vx: wrap.scrollLeft * k, vy: wrap.scrollTop * k, vw: wrap.clientWidth * k, vh: wrap.clientHeight * k });
  }
  private miniScale = 1;
  private updateMiniView() {
    const m = this.mini(), wrap = this.wrapEl; if (!m || !wrap) return;
    const k = this.miniScale;
    this.mini.set({ ...m, vx: wrap.scrollLeft * k, vy: wrap.scrollTop * k });
  }
  miniPointer(e: PointerEvent) {
    const wrap = this.wrapEl; if (!wrap) return;
    e.preventDefault(); e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect(), k = this.miniScale;
    wrap.scrollTo({ left: (e.clientX - r.left) / k - wrap.clientWidth / 2, top: (e.clientY - r.top) / k - wrap.clientHeight / 2 });
  }
  invokeConnections = computed(() => this.connections().filter(c => c.role === 'Invoke' || c.role === 'TriggerAndInvoke'));
  connectionOf(n: FlowNode): string | null {
    return n.type === 'invoke' ? n.config?.['connection'] ?? null : n.type === 'trigger' && n.config?.['mode'] === 'rest' ? n.config?.['connection'] ?? null : null;
  }
  dragConnection(e: DragEvent, id: string) { e.dataTransfer?.setData('application/x-eih-connection', id); e.dataTransfer!.effectAllowed = 'copy'; }
  addConnectionInvoke(id: string) {
    const sel = this.selectedId() ? locate(this.flow(), this.selectedId()!) : null;
    if (sel) this.openInvokeWizard(sel.lane, sel.index + 1, { connection: id });
    else this.openInvokeWizard({ kind: 'root' }, Math.max(0, this.flow().steps.length - (END_TYPES.includes(this.flow().steps.at(-1)?.type ?? '') ? 1 : 0)), { connection: id });
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
    const connection = e.dataTransfer?.getData('application/x-eih-connection');
    if (connection) this.openInvokeWizard(lane, index, { connection });
    else if (def && def.status !== 'Planned') this.insert(def, lane, index);
    else if (nodeId) this.move(nodeId, lane, index);
  }

  // ----------------------------------------------------------- view
  select(id: string | null) { this.selectedId.set(id); }
  focusNode(id: string) {
    this.select(id);
    // Expand collapsed ancestors so the node is visible.
    const ancestors = allNodes(this.flow()).filter(n => descendants(n).some(d => d.id === id)).map(n => n.id);
    if (ancestors.some(a => this.collapsed().has(a))) this.collapsed.set(new Set([...this.collapsed()].filter(c => !ancestors.includes(c))));
    afterNextRender(() => this.layout() === 'Outline'
      ? document.querySelector(`[data-node-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center' })
      : this.centerOn(id), { injector: this.injector });
  }
  toggle(id: string) {
    const wrap = this.wrapEl, head = wrap?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"] > .node-head`);
    const before = head?.getBoundingClientRect();
    const s = new Set(this.collapsed()); s.has(id) ? s.delete(id) : s.add(id); this.collapsed.set(s);
    if (wrap && before) afterNextRender(() => {
      const after = wrap.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"] > .node-head`)?.getBoundingClientRect();
      if (after) { wrap.scrollLeft += after.left - before.left; wrap.scrollTop += after.top - before.top; }
    }, { injector: this.injector });
  }
  countInside(n: FlowNode) { return descendants(n).length; }
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

  // One document keydown listener per component: Angular binds only one method per host event.
  @HostListener('document:keydown', ['$event']) onKey(e: KeyboardEvent) {
    this.spaceDown(e); if (this.spaceHeld()) return;
    const target = e.target as HTMLElement;
    if (!this.current() || target.closest('input, textarea, select, [contenteditable], .mapper-shell, app-modal, .picker')) return;
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
