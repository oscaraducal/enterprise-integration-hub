import { Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { Api, SessionEnded, errorText } from './api';
import { ModalComponent } from './ui';
import { CreateIntegrationComponent, CreatedIntegration, styleLabel } from './designer/create-integration.component';
import { DesignerSession } from './workspaces';

export interface IntegrationSummary {
  name: string; title: string; description?: string; draftRevision: number; draftUpdatedAt: string; draftUpdatedBy: string;
  latestVersion: number; latestPublishedAt?: string; status: string; style: string; identifier: string; versionLabel: string; tags: string[];
  valid: boolean; errors: number; warnings: number; actions: number;
}
interface VersionInfo { version: number; title: string; publishedAt: string; publishedBy: string; nodeCount: number }

/** Exports a flow document (draft or published version) as a downloaded eih-flow JSON file. */
export async function downloadFlow(api: Api, name: string, version?: number) {
  const doc = await api.request<unknown>(`flows/${encodeURIComponent(name)}/export${version ? '?version=' + version : ''}`);
  const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = `${name}${version ? '-v' + version : '-draft'}.eih-flow.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Integrations: the management list of every integration design. Opening one enters the full-screen Designer;
 * this page creates, duplicates, imports and exports designs and shows their versions. Nothing here runs a flow.
 */
@Component({
  selector: 'app-integrations', standalone: true, imports: [DatePipe, FormsModule, MatButtonModule, ModalComponent, CreateIntegrationComponent],
  template: `
  <section class="panel" aria-labelledby="int-list">
    <div class="section-heading"><div><h2 id="int-list">Integrations</h2><p class="hint">Every integration design with its type, version and validation status. Open one to edit it in the Designer.</p></div>
      @if (api().operator()) { <div class="button-row"><button mat-flat-button (click)="creating.set(true)">Create integration</button>
        <button mat-stroked-button (click)="file.click()">Import</button><input #file type="file" accept=".json,application/json" hidden (change)="importFile($event)"></div> }</div>
    @if (error()) { <div class="alert error" role="alert">{{error()}} <button (click)="error.set('')" aria-label="Dismiss error">×</button></div> }
    @if (notice()) { <div class="alert success" role="status">{{notice()}} <button (click)="notice.set('')" aria-label="Dismiss notification">×</button></div> }
    <div class="filters list-filters" role="search" aria-label="Filter integrations">
      <label class="search-field"><span class="sr-only">Search integrations</span><input type="search" aria-label="Search integrations" placeholder="Search name, identifier or tag…" [ngModel]="query()" (ngModelChange)="query.set($event)"></label>
      <label><span class="sr-only">Type filter</span><select aria-label="Type filter" [ngModel]="type()" (ngModelChange)="type.set($event)"><option value="">All types</option><option value="application">Application</option><option value="schedule">Scheduled</option><option value="manual">Manual practice</option></select></label>
      <label><span class="sr-only">Status filter</span><select aria-label="Status filter" [ngModel]="status()" (ngModelChange)="status.set($event)"><option value="">All statuses</option><option value="draft">Draft only</option><option value="published">Published</option></select></label>
      <label><span class="sr-only">Validation filter</span><select aria-label="Validation filter" [ngModel]="validity()" (ngModelChange)="validity.set($event)"><option value="">Any validation</option><option value="valid">Valid</option><option value="invalid">Has errors</option></select></label>
      <span class="muted small" aria-live="polite">{{shown().length}} of {{items().length}}</span>
    </div>
    <div class="table-scroll" tabindex="0" role="region" aria-label="Integrations table, scrolls horizontally">
      <table><caption class="sr-only">Integration designs</caption>
        <thead><tr><th scope="col">Integration</th><th scope="col">Identifier</th><th scope="col">Version</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col">Last updated</th><th scope="col">Validation</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>
          @for (f of shown(); track f.name) {
            <tr>
              <td><button type="button" class="link-button strong" (click)="open.emit(f.name)" [attr.aria-label]="'Open ' + f.title + ' in the Designer'">{{f.title}}</button>
                <small>{{f.actions}} action(s){{f.tags.length ? ' · ' + f.tags.join(', ') : ''}}</small></td>
              <td><code>{{f.identifier}}</code></td><td><code>{{f.versionLabel}}</code></td>
              <td><span class="kind-label">{{label(f.style)}}</span></td>
              <td>@if (f.latestVersion) { <span class="pill Completed">Published v{{f.latestVersion}}</span><small>draft editable</small> } @else { <span class="pill Pending">Draft</span> }</td>
              <td>{{f.draftUpdatedAt | date:'MMM d, HH:mm'}}<small>{{f.draftUpdatedBy}} · rev {{f.draftRevision}}</small></td>
              <td>@if (f.valid) { <span class="ok-text">Valid</span> } @else { <b class="field-error">{{f.errors}} error(s)</b> }@if (f.warnings) { <small class="field-warning">{{f.warnings}} warning(s)</small> }</td>
              <td class="row-actions"><button mat-button (click)="open.emit(f.name)" [attr.aria-label]="'Open designer for ' + f.title">Open</button>
                <button mat-button (click)="showDetails(f)" [attr.aria-label]="'Details of ' + f.title">Details</button>
                @if (api().operator()) { <button mat-button (click)="startDuplicate(f)" [attr.aria-label]="'Duplicate ' + f.title">Duplicate</button> }
                <button mat-button (click)="exportFlow(f.name)" [attr.aria-label]="'Export ' + f.title">Export</button></td>
            </tr>
          } @empty {
            <tr><td colspan="8" class="empty">@if (loading()) { <strong>Loading integrations…</strong> } @else if (items().length) { <strong>No matching integrations</strong><p>Adjust or clear the filters.</p> }
              @else { <strong>No integrations yet</strong><p>{{api().operator() ? 'Create your first integration: it starts with only a Start trigger and a +.' : 'An Operator can create integrations.'}}</p>
                @if (api().operator()) { <button mat-flat-button (click)="creating.set(true)">Create your first integration</button> } }</td></tr>
          }
        </tbody>
      </table>
    </div>
    <p class="hint pad">Designs are validated and versioned. Running integrations arrives in Milestone D, so no action on this page executes a flow or writes to the ERP.</p>
  </section>

  @if (creating()) { <app-create-integration [api]="api()" (created)="created($event)" (closed)="creating.set(false)"></app-create-integration> }
  @if (details(); as d) {
    <app-modal label="Integration details" [heading]="d.f.title" eyebrow="INTEGRATION DETAILS" [wide]="true" (close)="details.set(null)">
      <dl class="record-dl"><dt>Identifier</dt><dd><code>{{d.f.identifier}}</code></dd><dt>Version</dt><dd><code>{{d.f.versionLabel}}</code></dd><dt>Type</dt><dd>{{label(d.f.style)}}</dd>
        <dt>Name (URL)</dt><dd><code>{{d.f.name}}</code></dd><dt>Description</dt><dd>{{d.f.description || '—'}}</dd><dt>Tags</dt><dd>{{d.f.tags.join(', ') || '—'}}</dd>
        <dt>Draft</dt><dd>revision {{d.f.draftRevision}} · {{d.f.draftUpdatedAt | date:'MMM d, HH:mm'}} by {{d.f.draftUpdatedBy}}</dd>
        <dt>Validation</dt><dd>{{d.f.valid ? 'Valid' : d.f.errors + ' error(s)'}}{{d.f.warnings ? ' · ' + d.f.warnings + ' warning(s)' : ''}}</dd></dl>
      <h3>Version history</h3>
      <ul class="problems" aria-label="Version history">@for (v of d.versions; track v.version) {
        <li><span><b>v{{v.version}}</b> {{v.title}} · {{v.nodeCount}} actions · {{v.publishedAt | date:'MMM d, HH:mm'}} by {{v.publishedBy}}</span>
          <button class="link-button" (click)="exportFlow(d.f.name, v.version)">Export v{{v.version}}</button></li>
      } @empty { <li class="hint">{{d.loading ? 'Loading…' : 'Not published yet. Publishing in the Designer stores an immutable version.'}}</li> }</ul>
      <div class="form-actions"><button mat-flat-button (click)="details.set(null); open.emit(d.f.name)">Open in Designer</button><button mat-button (click)="details.set(null)">Close</button></div>
    </app-modal>
  }
  @if (dup(); as d) {
    <app-modal label="Duplicate integration" heading="Duplicate integration" eyebrow="NEW DRAFT FROM SAVED DRAFT" (close)="dup.set(null)">
      <form class="form-grid modal-form" (ngSubmit)="duplicate()">
        <label>Name<input name="dt" aria-label="Duplicate name" [(ngModel)]="d.title" maxlength="80" required></label>
        <label>Identifier<input name="di" aria-label="Duplicate identifier" class="mono" [ngModel]="d.identifier" (ngModelChange)="d.identifier = $event.toUpperCase()" maxlength="50" required></label>
        <p class="hint full">Copies the saved draft of {{d.source.title}} into a new, unpublished integration. The original and its published versions are not changed. Unsaved Designer changes are not included.</p>
        @if (formError()) { <p class="inline-warning flat full" role="alert">{{formError()}}</p> }
        <div class="form-actions"><button mat-flat-button type="submit" [disabled]="busy()">Duplicate</button><button mat-button type="button" (click)="dup.set(null)">Cancel</button></div>
      </form>
    </app-modal>
  }
  @if (importDoc(); as d) {
    <app-modal label="Import integration" heading="Import integration" eyebrow="EIH-FLOW DOCUMENT" (close)="importDoc.set(null)">
      <form class="form-grid modal-form" (ngSubmit)="confirmImport()">
        <p class="full">{{d.doc.title || d.doc.name}} · {{d.doc.source || 'draft'}} · exported {{d.doc.exportedAt | date:'MMM d, HH:mm'}}</p>
        <label>Import as (new flow name)<input name="in" [(ngModel)]="d.name" maxlength="60" required class="mono"></label>
        <p class="hint full">Imports always create a new draft. Existing integrations and published versions are never overwritten.</p>
        @if (formError()) { <p class="inline-warning flat" role="alert">{{formError()}}</p> }
        <div class="form-actions"><button mat-flat-button type="submit" [disabled]="busy()">Import</button><button mat-button type="button" (click)="importDoc.set(null)">Cancel</button></div>
      </form>
    </app-modal>
  }`
})
export class IntegrationsComponent implements OnInit {
  api = input.required<Api>();
  /** Opens the create wizard immediately (e.g. from the Overview's Create Integration action). */
  startCreate = input(false);
  open = output<string>();
  private session = inject(DesignerSession);
  readonly label = styleLabel;
  items = signal<IntegrationSummary[]>([]); loading = signal(true);
  query = signal(''); type = signal(''); status = signal(''); validity = signal('');
  error = signal(''); notice = signal(''); formError = signal(''); busy = signal(false);
  creating = signal(false);
  details = signal<{ f: IntegrationSummary; versions: VersionInfo[]; loading: boolean } | null>(null);
  dup = signal<{ source: IntegrationSummary; title: string; identifier: string } | null>(null);
  importDoc = signal<{ doc: any; name: string } | null>(null);
  shown = computed(() => {
    const q = this.query().trim().toLowerCase();
    return this.items().filter(f => (!q || [f.title, f.name, f.identifier, ...f.tags].some(t => t.toLowerCase().includes(q)))
      && (!this.type() || f.style === this.type())
      && (!this.status() || (this.status() === 'published') === f.latestVersion > 0)
      && (!this.validity() || (this.validity() === 'valid') === f.valid));
  });

  async ngOnInit() {
    if (this.startCreate() && this.api().operator()) this.creating.set(true);
    await this.load();
  }
  async load() {
    this.loading.set(true);
    try { this.items.set(await this.api().request<IntegrationSummary[]>('flows')); }
    catch (e) { this.fail(e); } finally { this.loading.set(false); }
  }
  created(c: CreatedIntegration) {
    this.creating.set(false);
    this.session.notice = c.template === 'blank' ? `Integration "${c.title}" created with an empty canvas. Use + to add actions.` : `Integration "${c.title}" created from a starter template.`;
    this.open.emit(c.name);
  }
  async showDetails(f: IntegrationSummary) {
    this.details.set({ f, versions: [], loading: true });
    try {
      const d = await this.api().request<{ versions: VersionInfo[] }>('flows/' + encodeURIComponent(f.name));
      if (this.details()?.f.name === f.name) this.details.set({ f, versions: d.versions, loading: false });
    } catch (e) { this.details.set(null); this.fail(e); }
  }
  startDuplicate(f: IntegrationSummary) {
    this.formError.set('');
    this.dup.set({ source: f, title: `${f.title} (copy)`.slice(0, 80), identifier: `${f.identifier}_COPY`.slice(0, 50) });
  }
  async duplicate() {
    const d = this.dup(); if (!d) return;
    this.busy.set(true); this.formError.set('');
    try {
      await this.api().request('flows/' + encodeURIComponent(d.source.name) + '/duplicate', 'POST', { identifier: d.identifier, title: d.title.trim() });
      this.dup.set(null); await this.load();
      this.notice.set(`Duplicated ${d.source.title} as ${d.title} (${d.identifier}). The original is unchanged.`);
    } catch (e) { if (!(e instanceof SessionEnded)) this.formError.set(errorText(e)); } finally { this.busy.set(false); }
  }
  async exportFlow(name: string, version?: number) {
    try { await downloadFlow(this.api(), name, version); this.notice.set(`Exported ${version ? 'version ' + version : 'the saved draft'} of ${name} as an eih-flow document.`); }
    catch (e) { this.fail(e); }
  }
  async importFile(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0]; (event.target as HTMLInputElement).value = '';
    if (!file) return;
    if (file.size > 262144) { this.error.set('The file is larger than 256 KB.'); return; }
    try {
      const doc = JSON.parse(await file.text());
      if (doc?.format !== 'eih-flow') { this.error.set('This is not an eih-flow document.'); return; }
      this.formError.set('');
      this.importDoc.set({ doc, name: this.items().some(f => f.name === doc.name) ? `${doc.name}-copy` : doc.name ?? '' });
    } catch { this.error.set('The file is not valid JSON.'); }
  }
  async confirmImport() {
    const d = this.importDoc(); if (!d) return;
    this.busy.set(true); this.formError.set('');
    try {
      await this.api().request('flows/import', 'POST', { document: d.doc, name: d.name.trim() });
      this.importDoc.set(null); await this.load();
      this.notice.set(`Imported as a new draft "${d.name}".`);
    } catch (e) { if (!(e instanceof SessionEnded)) this.formError.set(errorText(e)); } finally { this.busy.set(false); }
  }
  private fail(e: unknown) { if (!(e instanceof SessionEnded)) this.error.set(errorText(e)); }
}
