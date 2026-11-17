import { Component, computed, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { Api, ApiError, SessionEnded, errorText } from './api';
import { ColumnDef, SystemId, TableView, loadTables, sampleRows } from './systems';

export const TRANSFORMS = ['Copy', 'Trim', 'Uppercase', 'Lowercase', 'Concatenate', 'Default', 'ToNumber', 'Multiply', 'Divide', 'FormatDate', 'Lookup'] as const;
export const DATE_FORMATS = ["yyyy-MM-dd", "yyyy-MM-dd'T'HH:mm:ss'Z'", 'MM/dd/yyyy', 'dd/MM/yyyy', 'yyyyMMdd'];
const TRANSFORM_HELP: Record<string, string> = {
  Copy: 'Copy the value as is', Trim: 'Remove surrounding spaces', Uppercase: 'Trim and upper-case', Lowercase: 'Trim and lower-case',
  Concatenate: 'Join several source fields', Default: 'Constant, or the source value when present', ToNumber: 'Convert text to a number',
  Multiply: 'Multiply by a factor (e.g. 100 for minor units)', Divide: 'Divide by a factor', FormatDate: 'Re-format a date', Lookup: 'Translate values (e.g. status codes)'
};
interface Suggestion { source: string; transform: string; confidence: number; reasons: string[]; factor?: number | null; format?: string | null; lookup?: Record<string, string> | null }
interface TargetSuggestion { target: string; targetType: string; required: boolean; primaryKey: boolean; suggestion: Suggestion | null }
interface Issue { field: string; message: string }
interface Report { valid: boolean; errors: Issue[]; warnings: Issue[] }
/** One editable target row; `confidence` and `reasons` come from the suggestion and are informational. */
interface Row {
  target: ColumnDef; primaryKey: boolean; source: string; transform: string; factor: number | null; format: string; value: string;
  sourcesText: string; separator: string; lookupText: string; confidence: number | null; reasons: string[]; reviewed: boolean;
}
interface DefinitionSummary { name: string; latestVersion: number; versions: number; description?: string; source: { system: SystemId; table: string }; target: { system: SystemId; table: string }; createdBy: string; createdAt: string }
interface DefinitionDetail { name: string; version: number; description?: string; source: { system: SystemId; table: string }; target: { system: SystemId; table: string };
  sourceSchemaVersion: number; targetSchemaVersion: number; fields: any[]; createdBy: string; createdAt: string }

/**
 * Schema mapper: pick a source and a target table from the live Data Catalogs, review suggested field mappings,
 * validate, preview on a sample record and save a versioned mapping definition. Nothing is executed.
 */
@Component({
  selector: 'app-schema-mapper', standalone: true, imports: [CommonModule, FormsModule, MatButtonModule],
  template: `
  <section class="panel mapper-controls" aria-label="Choose tables">
    <div class="section-heading"><div><h2>Schema mapper</h2><p class="hint">Choose tables from the applications' Data Catalogs. Suggestions, validation and preview are read-only. Saved mappings are versioned configuration and are <b>not executed</b> in this release.</p></div></div>
    <div class="table-pickers">
      <fieldset><legend><span class="system-tag source-tag">SOURCE</span></legend>
        <label>Source application<select aria-label="Source application" [ngModel]="sourceSystem()" (ngModelChange)="setSystem('source', $event)"><option value="crm">Legacy CRM</option><option value="erp">Modern ERP</option></select></label>
        <label>Source table<select aria-label="Source table" [ngModel]="sourceName()" (ngModelChange)="sourceName.set($event); reset()">@for (t of sourceTables(); track t.name) { <option [value]="t.name">{{t.name}}{{t.builtIn ? '' : ' (logical)'}}</option> }</select></label>
      </fieldset>
      <span class="picker-arrow" aria-hidden="true">→</span>
      <fieldset><legend><span class="system-tag target-tag">TARGET</span></legend>
        <label>Target application<select aria-label="Target application" [ngModel]="targetSystem()" (ngModelChange)="setSystem('target', $event)"><option value="crm">Legacy CRM</option><option value="erp">Modern ERP</option></select></label>
        <label>Target table<select aria-label="Target table" [ngModel]="targetName()" (ngModelChange)="targetName.set($event); reset()">@for (t of targetTables(); track t.name) { <option [value]="t.name">{{t.name}}{{t.builtIn ? '' : ' (logical)'}}</option> }</select></label>
      </fieldset>
      <div class="mapper-buttons"><button mat-flat-button (click)="suggest()" [disabled]="busy() || !sourceName() || !targetName()">Load fields & suggest mappings</button></div>
    </div>
  </section>
  @if (error()) { <div class="alert error" role="alert">{{error()}} <button (click)="error.set('')" aria-label="Dismiss error">×</button></div> }
  @if (notice()) { <div class="alert success" role="status">{{notice()}} <button (click)="notice.set('')" aria-label="Dismiss notification">×</button></div> }

  @if (rows().length) {
    <section class="panel" aria-label="Field mapping review">
      <div class="section-heading"><div><h2>Review field mappings</h2>
        <p class="hint"><b>{{source()?.name}}</b> ({{sourceColumns().length}} fields, schema v{{source()?.version}}) → <b>{{target()?.name}}</b> (schema v{{target()?.version}}). {{suggestedCount()}} suggested, {{reviewedCount()}} of {{mappedCount()}} mapped rows reviewed. Fields set by the target application are not listed.</p></div>
        <div class="button-row"><button mat-stroked-button (click)="acceptAll()">Mark all reviewed</button><button mat-button (click)="clearAll()">Clear all</button></div></div>
      <div class="table-scroll" tabindex="0" role="region" aria-label="Field mapping rows, scroll horizontally">
        <table class="mapping-table"><thead><tr><th scope="col">Target field</th><th scope="col">Source field</th><th scope="col">Transformation</th><th scope="col">Parameters</th><th scope="col">Suggestion</th><th scope="col">Reviewed</th></tr></thead>
          <tbody>@for (r of rows(); track r.target.name) {
            <tr [class.row-error]="issuesFor(r.target.name, 'errors').length" [attr.aria-label]="'Mapping for ' + r.target.name">
              <td><code>{{r.target.name}}</code><small>{{r.target.type}}{{r.target.required ? ' · required' : ''}}{{r.primaryKey ? ' · key' : ''}}</small></td>
              <td>@if (r.transform === 'Concatenate') { <span class="muted">see parameters</span> } @else {
                <select [attr.aria-label]="'Source for ' + r.target.name" [(ngModel)]="r.source" (ngModelChange)="touch(r)"><option value="">— {{r.transform === 'Default' ? 'none' : 'not mapped'}} —</option>
                  @for (c of sourceColumns(); track c.name) { <option [value]="c.name">{{c.name}} ({{c.type}})</option> }</select> }</td>
              <td><select [attr.aria-label]="'Transformation for ' + r.target.name" [(ngModel)]="r.transform" (ngModelChange)="touch(r)" [title]="help(r.transform)">@for (t of transforms; track t) { <option [value]="t">{{t}}</option> }</select></td>
              <td class="params">@switch (r.transform) {
                @case ('Multiply') { <input type="number" [attr.aria-label]="'Factor for ' + r.target.name" [(ngModel)]="r.factor" (ngModelChange)="touch(r)" placeholder="factor"> }
                @case ('Divide') { <input type="number" [attr.aria-label]="'Factor for ' + r.target.name" [(ngModel)]="r.factor" (ngModelChange)="touch(r)" placeholder="factor"> }
                @case ('FormatDate') { <select [attr.aria-label]="'Format for ' + r.target.name" [(ngModel)]="r.format" (ngModelChange)="touch(r)">@for (f of formats; track f) { <option [value]="f">{{f}}</option> }</select> }
                @case ('Default') { <input [attr.aria-label]="'Default value for ' + r.target.name" [(ngModel)]="r.value" (ngModelChange)="touch(r)" maxlength="500" placeholder="value"> }
                @case ('Concatenate') { <input [attr.aria-label]="'Fields to join for ' + r.target.name" [(ngModel)]="r.sourcesText" (ngModelChange)="touch(r)" placeholder="first, last" maxlength="200">
                  <input class="sep" [attr.aria-label]="'Separator for ' + r.target.name" [(ngModel)]="r.separator" (ngModelChange)="touch(r)" maxlength="5" placeholder="sep"> }
                @case ('Lookup') { <textarea [attr.aria-label]="'Lookup for ' + r.target.name" [(ngModel)]="r.lookupText" (ngModelChange)="touch(r)" rows="3" placeholder="Active=ACTIVE" maxlength="2000"></textarea> }
                @default { <span class="muted">—</span> }
              }</td>
              <td>@if (r.confidence !== null) { <span class="confidence" [class.low]="r.confidence < 0.7">{{r.confidence * 100 | number:'1.0-0'}}%</span><small>{{r.reasons.join('; ')}}</small> } @else { <small class="muted">No suggestion</small> }</td>
              <td><input type="checkbox" [attr.aria-label]="'Reviewed ' + r.target.name" [(ngModel)]="r.reviewed" (ngModelChange)="rows.update(x => [...x])" [disabled]="!r.source && r.transform !== 'Default' && r.transform !== 'Concatenate'"></td>
            </tr>
            @for (i of issuesFor(r.target.name, 'errors'); track i.message) { <tr class="issue-row"><td colspan="6"><span class="field-error" role="alert">{{r.target.name}}: {{i.message}}</span></td></tr> }
            @for (i of issuesFor(r.target.name, 'warnings'); track i.message) { <tr class="issue-row"><td colspan="6"><span class="field-warning">{{r.target.name}}: {{i.message}}</span></td></tr> }
          }</tbody></table></div>
      @for (i of otherIssues(); track i.field + i.message) { <p class="inline-warning">{{i.field}}: {{i.message}}</p> }
      @if (unmatched().length) { <p class="hint pad">Unmapped source fields: {{unmatched().join(', ')}}</p> }
      <div class="mapper-footer">
        <button mat-stroked-button (click)="validate()" [disabled]="busy()">Validate</button>
        @if (report(); as rep) { <span [class]="'pill ' + (rep.valid ? 'Completed' : 'Failed')" role="status">{{rep.valid ? 'Valid' : rep.errors.length + ' error(s)'}}{{rep.warnings.length ? ' · ' + rep.warnings.length + ' warning(s)' : ''}}</span> }
      </div>
    </section>

    <section class="detail-grid json-grid">
      <div class="panel json-panel"><div class="section-heading"><h3>Sample source record</h3>
        <select aria-label="Sample record" [ngModel]="sampleIndex()" (ngModelChange)="pickSample($event)">@for (s of samples(); track $index) { <option [ngValue]="$index">{{sampleLabel(s)}}</option> } @empty { <option [ngValue]="-1">No rows: edit JSON</option> }</select></div>
        <textarea aria-label="Sample source JSON" [ngModel]="sampleText()" (ngModelChange)="sampleText.set($event)" spellcheck="false"></textarea>
        <div class="pad-top"><button mat-flat-button (click)="preview()" [disabled]="busy()">Preview mapped output</button></div></div>
      <div class="panel json-panel"><div class="section-heading"><h3>Mapped output (preview)</h3>
        @if (previewResult(); as p) { <span [class]="'pill ' + (p.errors.length ? 'Failed' : 'Completed')">{{p.errors.length ? p.errors.length + ' field error(s)' : 'No field errors'}}</span> }</div>
        <pre tabindex="0" aria-label="Mapped output JSON">{{previewResult() ? (previewResult()!.output | json) : 'Click Preview mapped output. Nothing is written.'}}</pre>
        @for (e of previewResult()?.errors ?? []; track e.field + e.message) { <p class="inline-warning flat"><b>{{e.field}}</b>: {{e.message}}</p> }</div>
    </section>

    <section class="panel save-panel" aria-label="Save mapping definition">
      <div class="section-heading"><div><h2>Save versioned mapping</h2><p class="hint">Saving validates again on the server and stores a new immutable version. Unreviewed rows are not saved: tick Reviewed to include a row.</p></div></div>
      @if (api().operator()) {
        <form class="form-grid save-form" (ngSubmit)="save()">
          <label>Mapping name<input name="mname" [(ngModel)]="name" maxlength="60" required placeholder="e.g. CRM order to ERP import"></label>
          <label>Description<input name="mdesc" [(ngModel)]="description" maxlength="300"></label>
          <div class="form-actions"><button mat-flat-button type="submit" [disabled]="busy() || !name.trim()">Save new version</button></div>
        </form>
      } @else { <p class="hint pad">Sign in as Operator to save mapping definitions.</p> }
    </section>
  }

  <section class="panel" aria-label="Saved mapping definitions">
    <div class="section-heading"><div><h2>Saved mapping definitions</h2><p class="hint">Each save adds a version. Status: saved configuration, not executed.</p></div></div>
    <div class="table-scroll" tabindex="0" role="region" aria-label="Saved mapping definitions table, scrolls horizontally">
      <table><thead><tr><th scope="col">Name</th><th scope="col">Source → target</th><th scope="col">Latest</th><th scope="col">Saved</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>@for (d of definitions(); track d.name) {
          <tr><td><b>{{d.name}}</b><small>{{d.description || ''}}</small></td><td>{{d.source.system}}.{{d.source.table}} → {{d.target.system}}.{{d.target.table}}</td>
            <td>v{{d.latestVersion}}<small>{{d.versions}} version(s)</small></td><td>{{d.createdAt | date:'MMM d, HH:mm'}}<small>by {{d.createdBy}}</small></td>
            <td><button mat-button (click)="open(d.name)" [attr.aria-label]="'Open mapping ' + d.name">Open ↗</button></td></tr>
        } @empty { <tr><td colspan="5" class="empty">No saved mappings yet.</td></tr> }</tbody></table></div>
    @if (history().length) {
      <div class="pad"><h3>Versions of {{history()[0].name}}</h3>
        <ol class="timeline">@for (v of history(); track v.version) {
          <li><div><b>Version {{v.version}}</b><time>{{v.createdAt | date:'MMM d, HH:mm:ss'}}</time></div>
            <p>{{v.fields.length}} field rules · source schema v{{v.sourceSchemaVersion}} · target schema v{{v.targetSchemaVersion}} · by {{v.createdBy}}</p>
            <button class="link-button" (click)="load(v)">Load version {{v.version}} into the mapper</button></li>
        }</ol></div>
    }
  </section>`
})
export class SchemaMapperComponent {
  api = input.required<Api>();
  readonly transforms = TRANSFORMS; readonly formats = DATE_FORMATS;
  sourceSystem = signal<SystemId>('crm'); targetSystem = signal<SystemId>('erp');
  catalogs = signal<Record<SystemId, TableView[]>>({ crm: [], erp: [] });
  sourceName = signal(''); targetName = signal('');
  source = signal<TableView | null>(null); target = signal<TableView | null>(null);
  rows = signal<Row[]>([]); unmatched = signal<string[]>([]);
  report = signal<Report | null>(null); previewResult = signal<{ output: unknown; errors: Issue[] } | null>(null);
  samples = signal<Record<string, unknown>[]>([]); sampleIndex = signal(0); sampleText = signal('{}');
  definitions = signal<DefinitionSummary[]>([]); history = signal<DefinitionDetail[]>([]);
  busy = signal(false); error = signal(''); notice = signal('');
  name = ''; description = '';
  sourceTables = computed(() => this.catalogs()[this.sourceSystem()]);
  targetTables = computed(() => this.catalogs()[this.targetSystem()]);
  sourceColumns = computed(() => this.source()?.columns ?? []);
  suggestedCount = computed(() => this.rows().filter(r => r.confidence !== null).length);
  mappedCount = computed(() => this.rows().filter(r => this.mapped(r)).length);
  reviewedCount = computed(() => this.rows().filter(r => this.mapped(r) && r.reviewed).length);
  otherIssues = computed(() => [...(this.report()?.errors ?? []), ...(this.report()?.warnings ?? [])].filter(i => !this.rows().some(r => r.target.name === i.field)));

  async ngOnInit() {
    try {
      const [crm, erp] = await Promise.all([loadTables(this.api(), 'crm'), loadTables(this.api(), 'erp')]);
      this.catalogs.set({ crm, erp });
      this.sourceName.set(crm.find(t => t.name === 'sales_orders')?.name ?? crm[0]?.name ?? '');
      this.targetName.set(erp.find(t => t.name === 'imported_orders')?.name ?? erp[0]?.name ?? '');
      await this.loadDefinitions();
    } catch (e) { this.fail(e); }
  }
  setSystem(side: 'source' | 'target', system: SystemId) {
    (side === 'source' ? this.sourceSystem : this.targetSystem).set(system);
    (side === 'source' ? this.sourceName : this.targetName).set(this.catalogs()[system][0]?.name ?? '');
    this.reset();
  }
  reset() { this.rows.set([]); this.report.set(null); this.previewResult.set(null); this.history.set([]); }
  help(t: string) { return TRANSFORM_HELP[t] ?? ''; }
  private mapped(r: Row) { return !!r.source || r.transform === 'Default' || (r.transform === 'Concatenate' && !!r.sourcesText.trim()); }
  touch(r: Row) { r.reviewed = this.mapped(r); this.report.set(null); this.rows.update(rows => [...rows]); }

  async suggest() {
    this.busy.set(true); this.error.set(''); this.notice.set('');
    try {
      const refs = { source: { system: this.sourceSystem(), table: this.sourceName() }, target: { system: this.targetSystem(), table: this.targetName() } };
      const result = await this.api().request<{ source: TableView; target: TableView; suggestions: { fields: TargetSuggestion[]; unmatchedSources: string[]; warnings: Issue[] } }>(
        'mapping-designer/suggest', 'POST', refs);
      this.source.set(result.source); this.target.set(result.target);
      this.rows.set(result.suggestions.fields.map(f => this.toRow(result.target.columns.find(c => c.name === f.target)!, f.primaryKey, f.suggestion)));
      this.unmatched.set(result.suggestions.unmatchedSources);
      this.report.set({ valid: false, errors: [], warnings: result.suggestions.warnings });
      this.previewResult.set(null);
      this.name = `${result.source.name} to ${result.target.name}`.slice(0, 60);
      await this.loadSamples();
    } catch (e) { this.fail(e); } finally { this.busy.set(false); }
  }
  private toRow(target: ColumnDef, primaryKey: boolean, s: Suggestion | null): Row {
    return {
      target, primaryKey, source: s?.source ?? '', transform: s?.transform ?? 'Copy', factor: s?.factor ?? null, format: s?.format ?? 'yyyy-MM-dd',
      value: '', sourcesText: '', separator: ' ', lookupText: Object.entries(s?.lookup ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
      confidence: s?.confidence ?? null, reasons: s?.reasons ?? [], reviewed: false
    };
  }
  acceptAll() { this.rows.update(rows => rows.map(r => ({ ...r, reviewed: this.mapped(r) }))); }
  clearAll() { this.rows.update(rows => rows.map(r => ({ ...r, source: '', transform: 'Copy', reviewed: false }))); this.report.set(null); }

  /** Only reviewed, mapped rows become rules: unreviewed suggestions are never saved or previewed as accepted. */
  private draft() {
    const fields = this.rows().filter(r => r.reviewed && this.mapped(r)).map(r => {
      const rule: Record<string, unknown> = { target: r.target.name, transform: r.transform };
      if (r.transform !== 'Concatenate' && r.source) rule['source'] = r.source;
      if (r.transform === 'Multiply' || r.transform === 'Divide') rule['factor'] = r.factor === null ? null : Number(r.factor);
      if (r.transform === 'FormatDate') rule['format'] = r.format;
      if (r.transform === 'Default') rule['value'] = r.value;
      if (r.transform === 'Concatenate') { rule['sources'] = r.sourcesText.split(',').map(s => s.trim()).filter(s => s); rule['separator'] = r.separator; }
      if (r.transform === 'Lookup') rule['lookup'] = Object.fromEntries(r.lookupText.split('\n').map(l => l.split('=')).filter(p => p.length === 2 && p[0].trim()).map(([k, v]) => [k.trim(), v.trim()]));
      return rule;
    });
    return { name: this.name.trim() || 'draft', description: this.description.trim() || null,
      source: { system: this.sourceSystem(), table: this.source()?.name }, target: { system: this.targetSystem(), table: this.target()?.name }, fields };
  }
  async validate() {
    this.busy.set(true); this.error.set('');
    try { this.report.set(await this.api().request<Report>('mapping-designer/validate', 'POST', this.draft())); }
    catch (e) { this.fail(e); } finally { this.busy.set(false); }
  }
  issuesFor(field: string, kind: 'errors' | 'warnings') { return (this.report()?.[kind] ?? []).filter(i => i.field === field); }

  private async loadSamples() {
    const s = this.source(); if (!s) return;
    try {
      const rows = await sampleRows(this.api(), this.sourceSystem(), s);
      this.samples.set(rows); this.pickSample(0);
    } catch { this.samples.set([]); this.sampleText.set('{}'); }
  }
  pickSample(i: number) { this.sampleIndex.set(i); const row = this.samples()[i]; this.sampleText.set(JSON.stringify(row ?? {}, null, 2)); this.previewResult.set(null); }
  sampleLabel(s: Record<string, unknown>) { const key = this.source()?.primaryKey ?? ''; return String(s[key] ?? 'record'); }
  async preview() {
    let sample: unknown;
    try { sample = JSON.parse(this.sampleText()); } catch { this.error.set('The sample record is not valid JSON.'); return; }
    this.busy.set(true); this.error.set('');
    try {
      const r = await this.api().request<{ output: unknown; errors: Issue[]; report: Report }>('mapping-designer/preview', 'POST', { draft: this.draft(), sample });
      this.previewResult.set({ output: r.output, errors: r.errors }); this.report.set(r.report);
    } catch (e) { this.fail(e); } finally { this.busy.set(false); }
  }
  async save() {
    this.busy.set(true); this.error.set(''); this.notice.set('');
    try {
      const r = await this.api().request<{ definition: DefinitionDetail; report: Report }>('mapping-definitions', 'POST', this.draft());
      this.report.set(r.report);
      this.notice.set(`Saved "${r.definition.name}" version ${r.definition.version}. It is stored as configuration and was not executed.`);
      await this.loadDefinitions(); await this.open(r.definition.name);
    } catch (e) {
      if (e instanceof ApiError && e.body?.report) { this.report.set(e.body.report); this.error.set(e.message); }
      else this.fail(e);
    } finally { this.busy.set(false); }
  }
  async loadDefinitions() { try { this.definitions.set(await this.api().request<DefinitionSummary[]>('mapping-definitions')); } catch (e) { this.fail(e); } }
  async open(name: string) {
    try { this.history.set(await this.api().request<DefinitionDetail[]>('mapping-definitions/' + encodeURIComponent(name))); } catch (e) { this.fail(e); }
  }
  /** Loads a saved version into the editor: tables, then every rule (marked reviewed). */
  async load(v: DefinitionDetail) {
    this.sourceSystem.set(v.source.system); this.targetSystem.set(v.target.system);
    this.sourceName.set(v.source.table); this.targetName.set(v.target.table);
    const history = this.history();
    await this.suggest();
    this.history.set(history);
    this.rows.update(rows => rows.map(r => {
      const f = v.fields.find(x => x.target === r.target.name);
      if (!f) return { ...r, source: '', transform: 'Copy', reviewed: false, confidence: null, reasons: [] };
      return { ...r, source: f.source ?? '', transform: f.transform, factor: f.factor ?? null, format: f.format ?? 'yyyy-MM-dd', value: f.value ?? '',
        sourcesText: (f.sources ?? []).join(', '), separator: f.separator ?? ' ', lookupText: Object.entries(f.lookup ?? {}).map(([k, val]) => `${k}=${val}`).join('\n'), reviewed: true };
    }));
    this.name = v.name; this.description = v.description ?? '';
    this.notice.set(`Loaded "${v.name}" version ${v.version}. Saving creates version ${Math.max(...history.map(h => h.version)) + 1}.`);
  }
  private fail(e: unknown) { if (!(e instanceof SessionEnded)) this.error.set(errorText(e)); }
}
