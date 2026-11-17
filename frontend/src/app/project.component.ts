import { Component, OnInit, computed, input, output, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { Api, Focus, SessionEnded, errorText } from './api';
import { Execution, ExecutionPage } from './models';
import { IntegrationSummary } from './integrations.component';
import { ConnectionView, roleLabel } from './connections.component';
import { styleLabel } from './designer/create-integration.component';
import { PRACTICE_PROJECT } from './workspaces';

/**
 * Projects (list) and a project's workspace (detail). There is one default practice project that groups every existing
 * integration and connection without moving or re-owning them, so no reference can break. Lookups and Libraries are
 * shown as planned. The Design tab lists resources; Observe summarises the runs that exist today.
 */
@Component({
  selector: 'app-project', standalone: true, imports: [DatePipe, MatButtonModule],
  template: `
  @if (error()) { <div class="alert error" role="alert">{{error()}} <button (click)="error.set('')" aria-label="Dismiss error">×</button></div> }
  @if (mode() === 'list') {
    <section class="resource-grid projects" aria-label="Projects">
      <button type="button" class="resource-card project-card" (click)="go.emit({ view: 'Project', project: p.id })" [attr.aria-label]="'Open project ' + p.name">
        <span class="rc-icon" aria-hidden="true">▦</span>
        <span class="rc-body"><span class="rc-title">{{p.name}} <span class="pill Completed">Default</span></span><span class="rc-text">{{p.description}}</span>
          <span class="rc-stat"><b>{{flows().length}} integration(s) · {{connections().length}} connection(s)</b><small><code>{{p.identifier}}</code>{{lastChange() ? ' · updated ' + (lastChange() | date:'MMM d, HH:mm') : ''}}</small></span></span>
        <span class="rc-go" aria-hidden="true">→</span>
      </button>
      <article class="resource-card planned" aria-label="More projects (planned)">
        <span class="rc-icon" aria-hidden="true">＋</span>
        <div class="rc-body"><h3>More projects <span class="pill Pending">Planned</span></h3>
          <p>Creating, renaming and sharing projects, and moving assets between them, are planned. Until then every asset belongs to the practice project.</p></div>
      </article>
    </section>
  } @else {
    <section class="project-head panel" aria-label="Project summary">
      <div><span class="eyebrow">PROJECT · <code>{{p.identifier}}</code></span><h2>{{p.name}}</h2><p class="muted">{{p.description}} Assets are grouped here, not moved: they keep their names and references.</p></div>
      <div class="project-tabs" role="tablist" aria-label="Project views">
        @for (t of tabs; track t) { <button type="button" role="tab" [attr.aria-selected]="tab() === t" [class.active]="tab() === t" (click)="tab.set(t)">{{t}}</button> }
      </div>
    </section>
    @if (tab() === 'Design') {
      <div class="project-grid">
        <section class="panel project-section" aria-labelledby="ps-int">
          <div class="section-heading"><div><h2 id="ps-int">Integrations <span class="count">{{flows().length}}</span></h2><p class="hint">{{drafts()}} draft · {{published()}} published · {{invalid()}} with errors</p></div>
            <div class="button-row">@if (api().operator()) { <button mat-flat-button (click)="go.emit({ view: 'Integrations', create: true })">Create</button> }
              <button mat-stroked-button (click)="go.emit({ view: 'Integrations' })">All integrations</button></div></div>
          <ul class="wb-list">
            @for (f of recentFlows(); track f.name) {
              <li><button type="button" class="wb-row" (click)="go.emit({ view: 'Integration Designer', flow: f.name, from: 'project' })" [attr.aria-label]="'Open ' + f.title + ' from the project'">
                <span class="wb-main"><b>{{f.title}}</b><small><code>{{f.identifier}}</code> · {{f.versionLabel}} · {{label(f.style)}} · {{f.actions}} action(s)</small></span>
                <span class="wb-side">@if (f.latestVersion) { <span class="pill Completed">v{{f.latestVersion}}</span> } @else { <span class="pill Pending">Draft</span> }
                  <small>@if (!f.valid) { <b class="field-error">{{f.errors}} error(s)</b> · } {{f.draftUpdatedAt | date:'MMM d, HH:mm'}}</small></span></button></li>
            } @empty { <li class="hint">{{loaded() ? 'No integrations yet.' : 'Loading…'}}</li> }
          </ul>
        </section>
        <section class="panel project-section" aria-labelledby="ps-con">
          <div class="section-heading"><div><h2 id="ps-con">Connections <span class="count">{{connections().length}}</span></h2><p class="hint">{{configured()}} configured · approved internal REST applications only</p></div>
            <div class="button-row">@if (api().operator()) { <button mat-flat-button (click)="go.emit({ view: 'Connections', create: true })">Create</button> }
              <button mat-stroked-button (click)="go.emit({ view: 'Connections' })">Manage</button></div></div>
          <ul class="wb-list">
            @for (c of connections(); track c.identifier) {
              <li class="wb-static"><span class="wb-main"><b>{{c.name}}</b><small><code>{{c.identifier}}</code> · {{c.applicationName || c.application}} · {{roleLabel(c.role)}}</small></span>
                <span class="wb-side"><span [class]="'pill ' + (c.status === 'Configured' ? 'Completed' : c.status === 'Failed' ? 'Failed' : 'Pending')">{{c.status}}</span>
                  <small>{{c.updatedAt | date:'MMM d, HH:mm'}}</small></span></li>
            } @empty { <li class="hint">{{loaded() ? 'No connections yet.' : 'Loading…'}}</li> }
          </ul>
        </section>
        <section class="panel project-section planned" aria-labelledby="ps-lk">
          <div class="section-heading"><div><h2 id="ps-lk">Lookups <span class="pill Pending">Planned</span></h2></div></div>
          <p class="pad">Named code-value tables (for example ISO country codes to ERP region codes) shared by every integration in the project. Not available yet: today a Mapping Studio Lookup rule holds a fixed value map inside one mapping.</p>
        </section>
        <section class="panel project-section planned" aria-labelledby="ps-lib">
          <div class="section-heading"><div><h2 id="ps-lib">Libraries <span class="pill Pending">Planned</span></h2></div></div>
          <p class="pad">Reusable safe-function libraries for expressions. Not available yet. Expressions already use 30 allowlisted, parsed-not-executed functions; uploaded or arbitrary JavaScript will never run in this workbench.</p>
        </section>
      </div>
    } @else {
      <section class="panel" aria-labelledby="ps-obs">
        <div class="section-heading"><div><h2 id="ps-obs">Observe</h2><p class="hint">Runs of the built-in sample integrations. The project's designed integrations are design-time only until Milestone D, so they have no instances yet.</p></div>
          <button mat-stroked-button (click)="go.emit({ view: 'Executions' })">Open Monitoring</button></div>
        <ul class="wb-list">
          @for (e of runs(); track e.id) {
            <li class="wb-static"><span class="wb-main"><b>{{e.sourceId || e.orderId}}</b><small>{{e.kind === 'CustomerSync' ? 'Customer sync' : 'Sales order import'}} · {{e.environment}} · built-in sample</small></span>
              <span class="wb-side"><span [class]="'pill ' + e.status">{{e.status}}</span><small>{{e.createdAt | date:'MMM d, HH:mm'}}</small></span></li>
          } @empty { <li class="hint">{{loaded() ? 'No executions yet.' : 'Loading…'}}</li> }
        </ul>
      </section>
    }
  }`
})
export class ProjectComponent implements OnInit {
  api = input.required<Api>();
  mode = input<'list' | 'detail'>('list');
  go = output<Focus>();
  readonly p = PRACTICE_PROJECT; readonly label = styleLabel; readonly roleLabel = roleLabel;
  readonly tabs = ['Design', 'Observe'] as const;
  tab = signal<'Design' | 'Observe'>('Design');
  flows = signal<IntegrationSummary[]>([]); connections = signal<ConnectionView[]>([]); runs = signal<Execution[]>([]);
  loaded = signal(false); error = signal('');
  drafts = computed(() => this.flows().filter(f => !f.latestVersion).length);
  published = computed(() => this.flows().filter(f => f.latestVersion > 0).length);
  invalid = computed(() => this.flows().filter(f => !f.valid).length);
  configured = computed(() => this.connections().filter(c => c.status === 'Configured').length);
  recentFlows = computed(() => [...this.flows()].sort((a, b) => b.draftUpdatedAt.localeCompare(a.draftUpdatedAt)).slice(0, 8));
  lastChange = computed(() => [...this.flows().map(f => f.draftUpdatedAt), ...this.connections().map(c => c.updatedAt)].sort().at(-1) ?? null);

  async ngOnInit() {
    await Promise.all([
      this.api().request<IntegrationSummary[]>('flows').then(f => this.flows.set(f), e => this.fail(e)),
      this.api().request<ConnectionView[]>('connections').then(c => this.connections.set(c), e => this.fail(e)),
      this.api().request<ExecutionPage>('executions?page=1').then(p => this.runs.set(p.items.slice(0, 8)), () => { /* Observe shows none */ }),
    ]);
    this.loaded.set(true);
  }
  private fail(e: unknown) { if (!(e instanceof SessionEnded)) this.error.set(errorText(e)); }
}
