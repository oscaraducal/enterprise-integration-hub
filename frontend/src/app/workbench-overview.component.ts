import { Component, OnInit, computed, input, output, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { Api, Focus, SessionEnded, View, errorText } from './api';
import { ExecutionPage, Execution, Metrics } from './models';
import { IntegrationSummary } from './integrations.component';
import { ConnectionView, roleLabel } from './connections.component';
import { styleLabel } from './designer/create-integration.component';
import { SCENARIOS } from './catalog';
import { PRACTICE_PROJECT } from './workspaces';

export interface ResourceCard {
  key: string; title: string; icon: string; text: string;
  /** Destination; absent for planned resources, which are shown but never pretend to open anything. */
  view?: View; focus?: Focus;
  stat?: string; detail?: string; planned?: string;
}

/**
 * Integration Workbench home: resource cards first (Projects, Integrations, Connections, Lookups, Libraries, Mappings,
 * Monitoring, Guides), then recent designs, connection health, validation problems and recent runs. Every number comes
 * from a real API; planned resources say so and are not clickable.
 */
@Component({
  selector: 'app-workbench-overview', standalone: true, imports: [DatePipe, MatButtonModule],
  template: `
  @if (error()) { <div class="alert error" role="alert">{{error()}} <button (click)="error.set('')" aria-label="Dismiss error">×</button></div> }
  <section class="wb-hero" aria-label="Quick actions">
    <div><h2>Design, connect and map integrations</h2><p class="muted">Pick a resource to work with. New integrations start blank: only the Start trigger and a <b>+</b>.</p></div>
    <div class="button-row">
      @if (api().operator()) { <button mat-flat-button (click)="go.emit({ view: 'Integrations', create: true })">Create integration</button>
        <button mat-stroked-button (click)="go.emit({ view: 'Connections', create: true })">Create connection</button> }
      <button mat-stroked-button (click)="go.emit({ view: 'Project', project: practice.id })">Open {{practice.name}}</button>
    </div>
  </section>

  <section class="resource-grid" aria-label="Workbench resources">
    @for (c of cards(); track c.key) {
      @if (c.planned) {
        <article class="resource-card planned" [attr.aria-label]="c.title + ' (planned)'">
          <span class="rc-icon" aria-hidden="true">{{c.icon}}</span>
          <div class="rc-body"><h3>{{c.title}} <span class="pill Pending">Planned</span></h3><p>{{c.text}}</p><small>{{c.planned}}</small></div>
        </article>
      } @else {
        <button type="button" class="resource-card" (click)="go.emit(c.focus ?? { view: c.view! })" [attr.aria-label]="'Open ' + c.title">
          <span class="rc-icon" aria-hidden="true">{{c.icon}}</span>
          <span class="rc-body"><span class="rc-title">{{c.title}}</span><span class="rc-text">{{c.text}}</span>
            @if (c.stat) { <span class="rc-stat"><b>{{c.stat}}</b>@if (c.detail) { <small>{{c.detail}}</small> }</span> }</span>
          <span class="rc-go" aria-hidden="true">→</span>
        </button>
      }
    }
  </section>

  <div class="wb-grid">
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
      <p class="hint">Built-in sample integrations only (SCN-001/002/003, existing runner). Designed integrations are not executed until Milestone D.</p>
      @if (metrics(); as m) { <p class="wb-stat"><b>{{m.total}}</b> runs · <b class="text-green">{{m.completed}}</b> completed · <b class="text-red">{{m.failed}}</b> failed · {{m.successRate}}% success</p> }
      <ul class="wb-list">
        @for (e of runs(); track e.id) {
          <li class="wb-static"><span class="wb-main"><b>{{e.sourceId || e.orderId}}</b><small>{{e.kind === 'CustomerSync' ? 'Customer sync' : 'Sales order import'}} · {{e.environment}}</small></span>
            <span class="wb-side"><span [class]="'pill ' + e.status">{{e.status}}</span><small>{{e.createdAt | date:'MMM d, HH:mm'}}</small></span></li>
        } @empty { <li class="hint">{{runsError() || (loaded() ? 'No executions yet. Start one from Monitoring.' : 'Loading…')}}</li> }
      </ul>
    </section>
  </div>`
})
export class WorkbenchOverviewComponent implements OnInit {
  api = input.required<Api>();
  go = output<Focus>();
  readonly label = styleLabel; readonly roleLabel = roleLabel; readonly practice = PRACTICE_PROJECT;
  flows = signal<IntegrationSummary[]>([]); connections = signal<ConnectionView[]>([]);
  metrics = signal<Metrics | null>(null); runs = signal<Execution[]>([]);
  loaded = signal(false); error = signal(''); runsError = signal('');
  drafts = computed(() => this.flows().filter(f => !f.latestVersion).length);
  published = computed(() => this.flows().filter(f => f.latestVersion > 0).length);
  configured = computed(() => this.connections().filter(c => c.status === 'Configured').length);
  problemFlows = computed(() => this.flows().filter(f => !f.valid));
  recent = computed(() => [...this.flows()].sort((a, b) => b.draftUpdatedAt.localeCompare(a.draftUpdatedAt)).slice(0, 6));
  cards = computed<ResourceCard[]>(() => {
    const n = (x: number, one: string, many = one + 's') => `${x} ${x === 1 ? one : many}`;
    const ready = this.loaded();
    return [
      { key: 'projects', title: 'Projects', icon: '▦', view: 'Projects', text: 'Organize related integrations and their connections, lookups and libraries in one workspace.',
        stat: ready ? n(1, 'project') : '…', detail: ready ? `${this.flows().length + this.connections().length} resources in ${PRACTICE_PROJECT.name}` : '' },
      { key: 'integrations', title: 'Integrations', icon: '⌬', view: 'Integrations', text: 'Browse, create, duplicate, validate, save and publish integration designs.',
        stat: ready ? n(this.flows().length, 'integration') : '…', detail: ready ? `${this.drafts()} draft · ${this.published()} published · ${this.problemFlows().length} with errors` : '' },
      { key: 'connections', title: 'Connections', icon: '⚭', view: 'Connections', text: 'Create, test and reuse REST connections to the approved internal applications.',
        stat: ready ? n(this.connections().length, 'connection') : '…', detail: ready ? `${this.configured()} configured` : '' },
      { key: 'lookups', title: 'Lookups', icon: '⇋', text: 'Named code-value translation tables shared by integrations (for example country or status codes).',
        planned: 'Not available yet. Today the Mapping Studio’s Lookup rule covers fixed value translations inside one mapping.' },
      { key: 'libraries', title: 'Libraries', icon: 'ƒ', text: 'Reusable libraries of safe functions for expressions, inspired by integration platforms’ function libraries.',
        planned: 'Not available yet. Expressions already use 30 allowlisted functions; uploaded or arbitrary JavaScript will never run here.' },
      { key: 'mappings', title: 'Mappings', icon: '⇆', view: 'Mapping Studio', text: 'Mapping Studio: source fields, transformation rules and target fields with side-effect-free previews.',
        stat: 'Mapping Studio', detail: 'SCN-001/002/003 field rules' },
      { key: 'monitoring', title: 'Monitoring', icon: '⇄', view: 'Executions', text: 'Execution history, investigation and safe retry for the built-in sample integrations.',
        stat: ready && this.metrics() ? n(this.metrics()!.total, 'run') : ready ? 'History' : '…', detail: ready && this.metrics() ? `${this.metrics()!.failed} failed · designed flows do not run yet` : '' },
      { key: 'guides', title: 'Guides', icon: '☰', view: 'Scenarios', text: 'Scenario walkthroughs and Designer guides with links straight to each screen.',
        stat: n(SCENARIOS.length, 'guide'), detail: 'Business cases, mappings and steps' },
    ];
  });

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
