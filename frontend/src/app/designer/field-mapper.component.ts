import { AfterViewChecked, Component, ElementRef, OnDestroy, OnInit, ViewChild, computed, input, model, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { Api, ApiError, SessionEnded, errorText } from '../api';
import { ColumnDef, TableView, sampleRows, SystemId } from '../systems';
import { TRANSFORMS, DATE_FORMATS } from '../schema-mapper.component';

export interface FieldRule {
  target: string; transform: string; source?: string | null; sources?: string[] | null; value?: string | null;
  separator?: string | null; factor?: number | null; format?: string | null; lookup?: Record<string, string> | null;
}
interface Line { target: string; x1: number; y1: number; x2: number; y2: number; selected: boolean }

/**
 * Full-screen field mapper for a Map action. Drag a source field onto a target field (or click one, then the other)
 * to connect them; each connection is an allowlisted transformation rule. Suggest, validate and preview call the
 * read-only mapping designer API; nothing is written until the flow draft is saved.
 */
@Component({
  selector: 'app-field-mapper', standalone: true, imports: [CommonModule, FormsModule, MatButtonModule],
  template: `
  <div class="mapper-shell" role="dialog" aria-modal="true" aria-label="Field mapper" tabindex="-1" (keydown.escape)="cancel()">
    <header class="mapper-bar">
      <div><span class="eyebrow">MAP ACTION · {{nodeName()}}</span>
        <h2>{{sourceSystem()}}.{{source().name}} <span aria-hidden="true">→</span> {{targetSystem()}}.{{target().name}}</h2>
        <p class="hint">Drag a source field onto a target field, or click a source field and then a target field. {{rules().length}} of {{mappable().length}} target fields mapped.</p></div>
      <div class="button-row">
        <button mat-stroked-button type="button" (click)="suggest()" [disabled]="busy()">Suggest mappings</button>
        <button mat-stroked-button type="button" (click)="validate()" [disabled]="busy()">Validate</button>
        <button mat-stroked-button type="button" (click)="preview()" [disabled]="busy()">Preview</button>
        <button mat-flat-button type="button" (click)="apply()">Apply to action</button>
        <button mat-button type="button" (click)="cancel()">Cancel</button>
      </div>
    </header>
    @if (message()) { <p [class]="'mapper-msg ' + (messageOk() ? 'ok-text' : 'field-error')" role="status">{{message()}}</p> }
    <div class="mapper-body">
      <div class="mapper-grid" #grid>
        <svg class="mapper-lines" aria-hidden="true">
          @for (l of lines(); track l.target) {
            <path [attr.d]="'M' + l.x1 + ',' + l.y1 + ' C' + (l.x1 + 80) + ',' + l.y1 + ' ' + (l.x2 - 80) + ',' + l.y2 + ' ' + l.x2 + ',' + l.y2" [class.selected]="l.selected"></path>
          }
        </svg>
        <section class="field-column" aria-label="Source fields">
          <h3><span class="system-tag source-tag">SOURCE</span> {{source().name}}</h3>
          @for (c of source().columns; track c.name) {
            <button type="button" class="field-card source" [attr.data-source]="c.name" draggable="true" (dragstart)="dragStart($event, c.name)"
              [class.picked]="picked() === c.name" [class.used]="usedSources().has(c.name)" (click)="pick(c.name)" [attr.aria-pressed]="picked() === c.name"
              [attr.aria-label]="'Source field ' + c.name + ', ' + c.type + (c.required ? ', required' : '')">
              <code>{{c.name}}</code><span class="type-tag">{{c.type}}</span>@if (c.required) { <em>req</em> }
              @if (has(sample(), c.name)) { <small class="sample">{{show(sample()![c.name])}}</small> }
            </button>
          }
        </section>
        <section class="field-column targets" aria-label="Target fields">
          <h3><span class="system-tag target-tag">TARGET</span> {{target().name}}</h3>
          @for (c of mappable(); track c.name) {
            <div class="field-card target" [attr.data-target]="c.name" [class.drop]="dropTarget() === c.name" [class.mapped]="ruleFor(c.name)" [class.has-error]="errorsFor(c.name).length"
              (dragover)="$event.preventDefault(); dropTarget.set(c.name)" (dragleave)="dropTarget.set(null)" (drop)="drop($event, c.name)">
              <button type="button" class="target-head" (click)="connect(c.name)" [attr.aria-label]="'Target field ' + c.name + ', ' + c.type + (c.required ? ', required' : '') + (ruleFor(c.name) ? ', mapped from ' + describe(ruleFor(c.name)!) : ', not mapped')">
                <code>{{c.name}}</code><span class="type-tag">{{c.type}}</span>@if (c.required) { <em>req</em> }@if (c.name === target().primaryKey) { <em>key</em> }</button>
              @if (ruleFor(c.name); as r) {
                <div class="rule-editor">
                  <select [attr.aria-label]="'Transformation for ' + c.name" [ngModel]="r.transform" (ngModelChange)="update(c.name, { transform: $event })">@for (t of transforms; track t) { <option>{{t}}</option> }</select>
                  @switch (r.transform) {
                    @case ('Multiply') { <input type="number" [attr.aria-label]="'Factor for ' + c.name" [ngModel]="r.factor" (ngModelChange)="update(c.name, { factor: $event })"> }
                    @case ('Divide') { <input type="number" [attr.aria-label]="'Factor for ' + c.name" [ngModel]="r.factor" (ngModelChange)="update(c.name, { factor: $event })"> }
                    @case ('FormatDate') { <select [attr.aria-label]="'Format for ' + c.name" [ngModel]="r.format" (ngModelChange)="update(c.name, { format: $event })">@for (f of formats; track f) { <option [value]="f">{{f}}</option> }</select> }
                    @case ('Default') { <input [attr.aria-label]="'Default value for ' + c.name" [ngModel]="r.value" (ngModelChange)="update(c.name, { value: $event })" maxlength="500" placeholder="value"> }
                    @case ('Concatenate') { <input [attr.aria-label]="'Fields to join for ' + c.name" [ngModel]="(r.sources ?? []).join(', ')" (ngModelChange)="update(c.name, { sources: split($event) })" placeholder="first, last">
                      <input class="sep" [attr.aria-label]="'Separator for ' + c.name" [ngModel]="r.separator" (ngModelChange)="update(c.name, { separator: $event })" maxlength="5"> }
                    @case ('Lookup') { <textarea [attr.aria-label]="'Lookup for ' + c.name" rows="3" [ngModel]="lookupText(r)" (ngModelChange)="update(c.name, { lookup: parseLookup($event) })" placeholder="Active=ACTIVE"></textarea> }
                  }
                  <small class="muted">{{describe(r)}}</small>
                  <button type="button" class="link-button" (click)="remove(c.name)" [attr.aria-label]="'Remove mapping for ' + c.name">Remove</button>
                </div>
              }
              @if (has(previewOut(), c.name)) { <small class="sample out">→ {{show(previewOut()![c.name])}}</small> }
              @for (e of errorsFor(c.name); track e) { <small class="field-error">{{e}}</small> }
              @for (w of warningsFor(c.name); track w) { <small class="field-warning">{{w}}</small> }
            </div>
          }
          @if (readOnlyTargets().length) { <p class="hint">Set by {{targetSystem()}}: {{readOnlyTargets().join(', ')}}.</p> }
        </section>
      </div>
    </div>
  </div>`
})
export class FieldMapperComponent implements OnInit, AfterViewChecked, OnDestroy {
  api = input.required<Api>();
  nodeName = input.required<string>();
  source = input.required<TableView>(); sourceSystem = input.required<SystemId>();
  target = input.required<TableView>(); targetSystem = input.required<SystemId>();
  rules = model<FieldRule[]>([]);
  done = output<FieldRule[] | null>();
  @ViewChild('grid') grid?: ElementRef<HTMLElement>;
  readonly transforms = TRANSFORMS; readonly formats = DATE_FORMATS;
  picked = signal<string | null>(null); dropTarget = signal<string | null>(null); selected = signal<string | null>(null);
  lines = signal<Line[]>([]); busy = signal(false); message = signal(''); messageOk = signal(true);
  issues = signal<{ field: string; message: string; severity: 'error' | 'warning' }[]>([]);
  sample = signal<Record<string, unknown> | null>(null); previewOut = signal<Record<string, unknown> | null>(null);
  mappable = computed(() => this.target().columns.filter(c => !c.readOnly));
  readOnlyTargets = computed(() => this.target().columns.filter(c => c.readOnly).map(c => c.name));
  usedSources = computed(() => new Set(this.rules().flatMap(r => [r.source ?? '', ...(r.sources ?? [])]).filter(s => s)));
  private resize = new ResizeObserver(() => this.redraw());
  private lastSignature = '';

  async ngOnInit() {
    try { this.sample.set((await sampleRows(this.api(), this.sourceSystem(), this.source(), 1))[0] ?? null); } catch { /* sample values are optional */ }
  }
  ngAfterViewChecked() {
    if (this.grid && !this.observed) { this.resize.observe(this.grid.nativeElement); this.observed = true; }
    const signature = JSON.stringify(this.rules()) + this.selected();
    if (signature !== this.lastSignature) { this.lastSignature = signature; setTimeout(() => this.redraw()); }
  }
  private observed = false;
  ngOnDestroy() { this.resize.disconnect(); }

  /** Connection lines from each mapped source field to its target field (the first source for Concatenate). */
  redraw() {
    const grid = this.grid?.nativeElement; if (!grid) return;
    const box = grid.getBoundingClientRect();
    const lines: Line[] = [];
    for (const r of this.rules()) {
      const sources = r.transform === 'Concatenate' ? (r.sources ?? []) : r.source ? [r.source] : [];
      const t = grid.querySelector<HTMLElement>(`[data-target="${CSS.escape(r.target)}"]`);
      if (!t) continue;
      const tb = t.getBoundingClientRect();
      for (const s of sources) {
        const el = grid.querySelector<HTMLElement>(`[data-source="${CSS.escape(s)}"]`); if (!el) continue;
        const sb = el.getBoundingClientRect();
        lines.push({ target: r.target + ':' + s, x1: sb.right - box.left, y1: sb.top + sb.height / 2 - box.top, x2: tb.left - box.left, y2: tb.top + 22 - box.top, selected: this.selected() === r.target });
      }
    }
    this.lines.set(lines);
  }
  ruleFor(target: string) { return this.rules().find(r => r.target === target) ?? null; }
  errorsFor(target: string) { return this.issues().filter(i => i.field === target && i.severity === 'error').map(i => i.message); }
  warningsFor(target: string) { return this.issues().filter(i => i.field === target && i.severity === 'warning').map(i => i.message); }
  dragStart(e: DragEvent, source: string) { e.dataTransfer?.setData('application/x-eih-field', source); e.dataTransfer!.effectAllowed = 'link'; }
  drop(e: DragEvent, target: string) {
    e.preventDefault(); this.dropTarget.set(null);
    const source = e.dataTransfer?.getData('application/x-eih-field'); if (source) this.link(source, target);
  }
  pick(source: string) { this.picked.set(this.picked() === source ? null : source); }
  connect(target: string) {
    const source = this.picked();
    if (source) { this.link(source, target); this.picked.set(null); } else this.selected.set(target);
  }
  /** Connects a source to a target, choosing a transformation from the two column types. */
  link(source: string, target: string) {
    const s = this.source().columns.find(c => c.name === source); const t = this.target().columns.find(c => c.name === target);
    if (!s || !t || t.readOnly) return;
    const existing = this.ruleFor(target);
    const rule: FieldRule = existing?.transform === 'Concatenate'
      ? { ...existing, sources: [...new Set([...(existing.sources ?? []), source])] }
      : { target, source, ...this.defaultTransform(s, t) } as FieldRule;
    this.rules.set([...this.rules().filter(r => r.target !== target), rule]);
    this.selected.set(target); this.issues.set([]); this.previewOut.set(null);
  }
  private defaultTransform(s: ColumnDef, t: ColumnDef): Partial<FieldRule> {
    if (t.type === 'enum') return { transform: 'Lookup', lookup: Object.fromEntries((s.values ?? []).map(v => [v, (t.values ?? []).find(x => x.toLowerCase() === v.toLowerCase()) ?? ''])) };
    if (s.type === 'decimal' && t.type === 'integer') return /minor|cents/i.test(t.name) ? { transform: 'Multiply', factor: 100 } : { transform: 'ToNumber' };
    if (s.type === 'string' && (t.type === 'integer' || t.type === 'decimal')) return { transform: 'ToNumber' };
    if (s.type === 'datetime' && t.type === 'date') return { transform: 'FormatDate', format: 'yyyy-MM-dd' };
    if (s.type === 'string' && t.type === 'string') return /email/i.test(t.name) ? { transform: 'Lowercase' } : { transform: 'Trim' };
    return { transform: 'Copy' };
  }
  update(target: string, patch: Partial<FieldRule>) {
    this.rules.set(this.rules().map(r => r.target === target ? { ...r, ...patch,
      ...(patch.transform === 'Concatenate' ? { sources: r.source ? [r.source] : [], source: null, separator: ' ' } : {}),
      ...(patch.transform && patch.transform !== 'Concatenate' && r.transform === 'Concatenate' ? { source: r.sources?.[0] ?? null, sources: null } : {}),
      ...(patch.transform === 'Multiply' || patch.transform === 'Divide' ? { factor: r.factor ?? 100 } : {}),
      ...(patch.transform === 'FormatDate' ? { format: r.format ?? 'yyyy-MM-dd' } : {}) } : r));
    this.issues.set([]); this.previewOut.set(null);
  }
  remove(target: string) { this.rules.set(this.rules().filter(r => r.target !== target)); this.selected.set(null); }
  describe(r: FieldRule) {
    const from = r.transform === 'Concatenate' ? (r.sources ?? []).join(' + ') : r.transform === 'Default' ? (r.source ? `${r.source} or '${r.value}'` : `'${r.value ?? ''}'`) : r.source;
    const arg = r.factor != null && (r.transform === 'Multiply' || r.transform === 'Divide') ? `, ${r.factor}` : r.format && r.transform === 'FormatDate' ? `, ${r.format}` : '';
    return `${r.transform}(${from}${arg})`;
  }
  lookupText(r: FieldRule) { return Object.entries(r.lookup ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'); }
  parseLookup(text: string) { return Object.fromEntries(text.split('\n').map(l => l.split('=')).filter(p => p.length === 2 && p[0].trim()).map(([k, v]) => [k.trim(), v.trim()])); }
  split(text: string) { return text.split(',').map(s => s.trim()).filter(s => s); }
  has(row: Record<string, unknown> | null, key: string) { return !!row && row[key] !== undefined; }
  show(v: unknown) { return v === null || v === undefined ? 'null' : typeof v === 'string' ? `"${v}"` : String(v); }
  private draft() {
    return { name: this.nodeName(), source: { system: this.sourceSystem(), table: this.source().name }, target: { system: this.targetSystem(), table: this.target().name }, fields: this.rules() };
  }
  async suggest() {
    await this.run(async () => {
      const r = await this.api().request<{ suggestions: { fields: { target: string; suggestion: any }[] } }>('mapping-designer/suggest', 'POST',
        { source: { system: this.sourceSystem(), table: this.source().name }, target: { system: this.targetSystem(), table: this.target().name } });
      const suggested: FieldRule[] = r.suggestions.fields.filter(f => f.suggestion && !this.ruleFor(f.target)).map(f => ({ target: f.target, source: f.suggestion.source,
        transform: f.suggestion.transform, factor: f.suggestion.factor ?? null, format: f.suggestion.format ?? null, lookup: f.suggestion.lookup ?? null }));
      this.rules.set([...this.rules(), ...suggested]);
      this.say(`${suggested.length} suggestion(s) added for unmapped fields. Review each one before applying.`, true);
    });
  }
  async validate() {
    await this.run(async () => {
      const r = await this.api().request<{ valid: boolean; errors: { field: string; message: string }[]; warnings: { field: string; message: string }[] }>('mapping-designer/validate', 'POST', this.draft());
      this.issues.set([...r.errors.map(e => ({ ...e, severity: 'error' as const })), ...r.warnings.map(w => ({ ...w, severity: 'warning' as const }))]);
      this.say(r.valid ? `Valid${r.warnings.length ? ` with ${r.warnings.length} warning(s)` : ''}.` : `${r.errors.length} error(s): ${r.errors.filter(e => !this.mappable().some(c => c.name === e.field)).map(e => e.message).join(' ')}`, r.valid);
    });
  }
  async preview() {
    if (!this.sample()) { this.say('The source table has no rows to preview with.', false); return; }
    await this.run(async () => {
      const r = await this.api().request<{ output: Record<string, unknown>; errors: { field: string; message: string }[] }>('mapping-designer/preview', 'POST', { draft: this.draft(), sample: this.sample() });
      this.previewOut.set(r.output); this.issues.set(r.errors.map(e => ({ ...e, severity: 'error' as const })));
      this.say(r.errors.length ? `${r.errors.length} field error(s) for this sample.` : 'Preview of the first source row shown under each target. Nothing was written.', !r.errors.length);
    });
  }
  apply() { this.done.emit(this.rules()); }
  cancel() { this.done.emit(null); }
  private say(text: string, ok: boolean) { this.message.set(text); this.messageOk.set(ok); }
  private async run(work: () => Promise<void>) {
    this.busy.set(true); this.message.set('');
    try { await work(); } catch (e) { if (!(e instanceof SessionEnded)) this.say(e instanceof ApiError ? errorText(e) : errorText(e), false); }
    finally { this.busy.set(false); setTimeout(() => this.redraw()); }
  }
}
