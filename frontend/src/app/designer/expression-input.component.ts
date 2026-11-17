import { Component, ElementRef, ViewChild, computed, input, model, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { Api, SessionEnded, errorText } from '../api';
import { FunctionDef, ScopeVar, fieldsOf } from './flow-model';

const OPERATORS = ['==', '!=', '<', '<=', '>', '>=', 'and', 'or', 'not', '+', '-', '*', '/', "'text'", 'true', 'false', 'null'];

/**
 * Expression field with an Expression Builder: insert variables (with their fields), allowlisted functions and
 * operators, then check the syntax on the server. Expressions are parsed, never evaluated as code.
 */
@Component({
  selector: 'app-expression-input', standalone: true, imports: [FormsModule, MatButtonModule],
  template: `
  <div class="expr">
    <label>{{label()}}
      <span class="expr-row"><input #box [attr.aria-label]="label()" [ngModel]="value()" (ngModelChange)="value.set($event); result.set(null)" maxlength="500"
        [placeholder]="placeholder()" spellcheck="false" class="mono">
        <button type="button" class="fx" (click)="open.set(!open())" [attr.aria-expanded]="open()" [attr.aria-label]="'Expression builder for ' + label()">ƒx</button></span></label>
    @if (open()) {
      <div class="builder" role="group" [attr.aria-label]="'Expression builder: ' + label()">
        <div class="tabs builder-tabs" role="tablist">
          @for (t of tabs; track t) { <button type="button" role="tab" [attr.aria-selected]="tab() === t" [class.active]="tab() === t" (click)="tab.set(t)">{{t}}</button> }
        </div>
        @switch (tab()) {
          @case ('Variables') {
            <ul class="chips">@for (v of variables(); track v.name) {
              <li><button type="button" (click)="insert('$' + v.name)" [title]="v.kind + ' from ' + v.source">\${{v.name}} <small>{{v.kind}}</small></button>
                @if (v.kind === 'record') { @for (f of fields(v); track f) { <button type="button" class="field-chip" (click)="insert('$' + v.name + '.' + f)">.{{f}}</button> } }</li>
            } @empty { <li class="hint">No variables are in scope here yet.</li> }</ul>
          }
          @case ('Functions') {
            <select aria-label="Function category" [ngModel]="category()" (ngModelChange)="category.set($event)">@for (c of categories(); track c) { <option>{{c}}</option> }</select>
            <ul class="fn-list">@for (f of shown(); track f.name) {
              <li><button type="button" (click)="insert(template(f))"><code>{{f.signature}}</code></button><small>{{f.description}}</small></li>
            }</ul>
          }
          @case ('Operators') { <ul class="chips">@for (o of operators; track o) { <li><button type="button" (click)="insert(' ' + o + ' ')"><code>{{o}}</code></button></li> }</ul> }
        }
        <div class="builder-foot"><button mat-stroked-button type="button" (click)="check()" [disabled]="busy()">Check syntax</button>
          @if (result(); as r) { <span [class]="r.ok ? 'ok-text' : 'field-error'" role="status">{{r.text}}</span> }</div>
      </div>
    }
  </div>`
})
export class ExpressionInputComponent {
  api = input.required<Api>();
  label = input.required<string>();
  variables = input<ScopeVar[]>([]);
  functions = input<FunctionDef[]>([]);
  placeholder = input('e.g. concat($trigger.customerId, \'-A\')');
  value = model<string>('');
  @ViewChild('box') box?: ElementRef<HTMLInputElement>;
  readonly tabs = ['Variables', 'Functions', 'Operators'] as const;
  readonly operators = OPERATORS;
  tab = signal<'Variables' | 'Functions' | 'Operators'>('Variables');
  open = signal(false); busy = signal(false);
  result = signal<{ ok: boolean; text: string } | null>(null);
  categories = computed(() => [...new Set(this.functions().map(f => f.category))]);
  category = signal('String');
  shown = computed(() => this.functions().filter(f => f.category === this.category()));
  fields = fieldsOf;
  template(f: FunctionDef) { return f.name + '(' + (f.minArgs === 0 ? '' : Array(f.minArgs).fill('').join(', ')) + ')'; }
  insert(text: string) {
    const el = this.box?.nativeElement; const current = this.value() ?? '';
    const start = el?.selectionStart ?? current.length, end = el?.selectionEnd ?? current.length;
    const next = (current.slice(0, start) + text + current.slice(end)).slice(0, 500);
    this.value.set(next); this.result.set(null);
    setTimeout(() => { el?.focus(); const pos = Math.min(start + text.length, next.length); el?.setSelectionRange(pos, pos); });
  }
  async check() {
    this.busy.set(true);
    try {
      const r = await this.api().request<{ valid: boolean; errors: { position: number; message: string }[] }>('flows/expressions/check', 'POST', { expression: this.value() });
      this.result.set(r.valid ? { ok: true, text: 'Syntax OK. Variables are checked against the flow when it is validated.' }
        : { ok: false, text: r.errors.map(e => `${e.message} (position ${e.position + 1})`).join(' ') });
    } catch (e) { if (!(e instanceof SessionEnded)) this.result.set({ ok: false, text: errorText(e) }); }
    finally { this.busy.set(false); }
  }
}
