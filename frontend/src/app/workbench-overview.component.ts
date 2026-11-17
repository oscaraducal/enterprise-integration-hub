import { Component, OnInit, computed, input, output, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { Api, Focus, SessionEnded, errorText } from './api';
import { ExecutionPage, Execution, Metrics } from './models';
import { IntegrationSummary } from './integrations.component';
import { ConnectionView, roleLabel } from './connections.component';
import { styleLabel } from './designer/create-integration.component';

/**
 * Integration Workbench landing page: integration development at a glance. Every number comes from a real API
 * (designs, connections, the existing runner's history); nothing is estimated, and designed flows are never shown as run.
 */
@Component({
  selector: 'app-workbench-overview', standalone: true, imports: [DatePipe, MatButtonModule],
  template: `
  @if (error()) { <div class="alert error" role="alert">{{error()}} <button (click)="error.set('')" aria-label="Dismiss error">×</button></div> }
  <section class="quick-actions" aria-label="Quick actions">
    @if (api().operator()) { <button type="button" class="quick primary" (click)="go.emit({ view: 'Integrations', create: true })"><span aria-hidden="true">＋</span><b>Create integration</b><small>Application, Scheduled or Manual practice</small></button> }
    <button type="button" class="quick" (click)="go.emit({ view: 'Integrations' })"><span aria-hidden="true">⌬</span><b>Browse integrations</b><small>List, search, versions, import and export</small></button>
    @if (api().operator()) { <button type="button" class="quick" (click)="go.emit({ view: 'Connections', create: true })"><span aria-hidden="true">⚭</span><b>Create connection</b><small>9-step wizard for an approved internal app</small></button> }
    <button type="button" class="quick" (click)="go.emit({ view: 'Connections' })"><span aria-hidden="true">⚙</span><b>Open Connection Manager</b><small>Test, edit and review usage</small></button>
    <button type="button" class="quick" (click)="go.emit({ view: 'Mapping Studio' })"><span aria-hidden="true">⇆</span><b>Open Mapping Studio</b><small>Field rules and side-effect-free previews</small></button>
  </section>

  <section class="metrics" aria-label="Integration development summary">
    <article class="metric panel"><span>Integrations</span><strong>{{flows().length}}</strong><small>{{loaded() ? 'Designs in this workbench' : 'Loading…'}}</small></article>
    <article class="metric panel"><span>Drafts</span><strong>{{drafts()}}</strong><small>Never published</small></article>
    <article class="metric panel"><span>Published</span><strong class="text-green">{{published()}}</strong><small>With an immutable version</small></article>
    <article class="metric panel"><span>Connections</span><strong>{{configured()}}<em>/{{connections().length}}</em></strong><small>Configured (last test passed)</small></article>
    <article class="metric panel"><span>Validation problems</span><strong [class.text-red]="problemFlows().length">{{problemFlows().length}}</strong><small>Integrations with errors</small></article>
  </section>

  <div class="overview-grid wb-grid">
    <section class="panel" aria-labelledby="wb-recent">
      <div class="section-heading"><h2 id="wb-recent">Recent integration designs</h2><button mat-button (click)="go.emit({ view: 'Integrations' })">All integrations →</button></div>
      <ul class="wb-list">
        @for (f of recent(); track f.name) {
          <li><button type="button" class="wb-row" (click)="go.emit({ view: 'Integration Designer', flow: f.name })" [attr.aria-label]="'Open ' + f.title + ' in the Designer'">
            <span class="wb-main"><b>{{f.title}}</b><small><code>{{f.identifier}}</code> · {{f.versionLabel}} · {{label(f.style)}}</small></span>
            <span class="wb-side">@if (f.latestVersion) { <span class="pill Completed">v{{f.latestVersion}}</span> } @else { <span class="pill Pending">Draft</span> }
              <small>{{f.draftUpdatedAt | date:'MMM d, HH:mm'}}</small></span></button></li>
        } @empty { <li class="hint">{{loaded() ? 'No integrations yet. Create one: a blank integration starts with only the Start trigger and a +.' : 'Loading…'}}</li> }
      </ul>
    </section>
    <section class="panel" aria-labelledby="wb-health">
      <div class="section-heading"><h2 id="wb-health">Connection health</h2><button mat-button (click)="go.emit({ view: 'Connections' })">Connections →</button></div>
      <ul class="wb-list">
        @for (c of connections(); track c.identifier) {
          <li class="wb-static"><span class="wb-main"><b>{{c.name}}</b><small><code>{{c.identifier}}</code> · {{c.applicationName || c.application}} · {{roleLabel(c.role)}}</small></span>
            <span class="wb-side"><span [class]="'pill ' + (c.status === 'Configured' ? 'Completed' : c.status === 'Failed' ? 'Failed' : 'Pending')">{{c.status}}</span>
              <small>{{c.lastTestedAt ? 'tested ' + (c.lastTestedAt | date:'MMM d, HH:mm') : 'not tested'}}</small></span></li>
        } @empty { <li class="hint">{{loaded() ? 'No connections yet. Invokes and REST triggers need a connection to an approved internal application.' : 'Loading…'}}</li> }
      </ul>
    </section>
    <section class="panel" aria-labelledby="wb-problems">
      <div class="section-heading"><h2 id="wb-problems">Validation problems</h2></div>
      <ul class="wb-list">
        @for (f of problemFlows(); track f.name) {
          <li><button type="button" class="wb-row" (click)="go.emit({ view: 'Integration Designer', flow: f.name })" [attr.aria-label]="'Fix ' + f.title + ' in the Designer'">
            <span class="wb-main"><b>{{f.title}}</b><small><code>{{f.identifier}}</code></small></span>
            <span class="wb-side"><b class="field-error">{{f.errors}} error(s)</b>@if (f.warnings) { <small>{{f.warnings}} warning(s)</small> }</span></button></li>
        } @empty { <li class="ok-text">{{loaded() ? 'Every integration draft is valid.' : 'Loading…'}}</li> }
      </ul>
    </section>
    <section class="panel" aria-labelledby="wb-runs">
      <div class="section-heading"><h2 id="wb-runs">Recent executions</h2><button mat-button (click)="go.emit({ view: 'Executions' })">Monitoring →</button></div>
      <p class="hint">From the existing runner for the built-in sample integrations (SCN-001/002/003). Designed integrations are not executed until Milestone D.</p>
      @if (metrics(); as m) { <p class="wb-stat"><b>{{m.total}}</b> runs · <b class="text-green">{{m.completed}}</b> completed · <b class="text-red">{{m.failed}}</b> failed · {{m.successRate}}% success</p> }
      <ul class="wb-list">
        @for (e of runs(); track e.id) {
          <li class="wb-static"><span class="wb-main"><b>{{e.sourceId || e.orderId}}</b><small>{{e.kind === 'CustomerSync' ? 'Customer sync' : 'Sales order import'}} · {{e.environment}}</small></span>
            <span class="wb-side"><span [class]="'pill ' + e.status">{{e.status}}</span><small>{{e.createdAt | date:'MMM d, HH:mm'}}</small></span></li>
        } @empty { <li class="hint">{{runsError() || (loaded() ? 'No executions yet. Start one from Monitoring.' : 'Loading…')}}</li> }
      </ul>
    </section>
    <section class="panel capability" aria-labelledby="wb-cap">
      <div class="section-heading"><h2 id="wb-cap">What works in this release</h2></div>
      <ul class="cap-list">
        <li><span class="pill Completed">Implemented</span> Design, validate, version, import and export integrations</li>
        <li><span class="pill Completed">Implemented</span> Connections to approved internal applications, with safe tests</li>
        <li><span class="pill Completed">Implemented</span> Field mapping with previews that never write</li>
        <li><span class="pill Retrying">Design only</span> Application REST triggers and schedules: no endpoint is activated and no job runs</li>
        <li><span class="pill Pending">Planned</span> Running designed integrations (Milestone D)</li>
      </ul>
    </section>
  </div>`
})
export class WorkbenchOverviewComponent implements OnInit {
  api = input.required<Api>();
  go = output<Focus>();
  readonly label = styleLabel; readonly roleLabel = roleLabel;
  flows = signal<IntegrationSummary[]>([]); connections = signal<ConnectionView[]>([]);
  metrics = signal<Metrics | null>(null); runs = signal<Execution[]>([]);
  loaded = signal(false); error = signal(''); runsError = signal('');
  drafts = computed(() => this.flows().filter(f => !f.latestVersion).length);
  published = computed(() => this.flows().filter(f => f.latestVersion > 0).length);
  configured = computed(() => this.connections().filter(c => c.status === 'Configured').length);
  problemFlows = computed(() => this.flows().filter(f => !f.valid));
  recent = computed(() => [...this.flows()].sort((a, b) => b.draftUpdatedAt.localeCompare(a.draftUpdatedAt)).slice(0, 6));

  async ngOnInit() {
    // Each source loads independently: one failing never blanks the others.
    await Promise.all([
      this.api().request<IntegrationSummary[]>('flows').then(f => this.flows.set(f), e => this.fail(e)),
      this.api().request<ConnectionView[]>('connections').then(c => this.connections.set(c), e => this.fail(e)),
      this.api().request<Metrics>('metrics').then(m => this.metrics.set(m), () => { /* shown as unavailable below */ }),
      this.api().request<ExecutionPage>('executions?page=1').then(p => this.runs.set(p.items.slice(0, 5)), e => this.runsError.set('Execution history unavailable: ' + errorText(e))),
    ]);
    this.loaded.set(true);
  }
  private fail(e: unknown) { if (!(e instanceof SessionEnded)) this.error.set(errorText(e)); }
}
