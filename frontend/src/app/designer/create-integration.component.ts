import { Component, OnInit, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { Api, SessionEnded, errorText } from '../api';
import { ModalComponent } from '../ui';
import { toIdentifier } from '../connections.component';

interface TemplateInfo { id: string; title: string; description: string }
interface Draft { style: string; title: string; identifier: string; idEdited: boolean; version: string; tags: string; description: string; template: string }
export interface CreatedIntegration { name: string; title: string; style: string; template: string }

export const STYLE_CHOICES = [
  { id: 'application', title: 'Application', text: 'Starts when an application calls an inbound REST endpoint. Start is a trigger placeholder until you choose a Trigger connection.' },
  { id: 'schedule', title: 'Scheduled', text: 'Starts on a schedule (manual, daily, weekly or monthly) with schedule parameters. Design-time only in this release.' },
  { id: 'manual', title: 'Manual practice', text: 'A simplified practice mode with a built-in manual trigger and typed sample parameters. Starter templates are available.' },
];
export const styleLabel = (style?: string) => style === 'application' ? 'Application' : style === 'schedule' ? 'Scheduled' : 'Manual practice';

/**
 * New Integration wizard: type (Application, Scheduled, Manual practice), basic information, then Blank (default) or an
 * optional starter template. Blank integrations contain only the Start trigger.
 */
@Component({
  selector: 'app-create-integration', standalone: true, imports: [FormsModule, MatButtonModule, ModalComponent],
  template: `
  <app-modal label="New integration" heading="Create integration" [eyebrow]="'STEP ' + (step() + 1) + ' OF 3 · ' + steps[step()].toUpperCase()" [wide]="true" (close)="closed.emit()">
    <ol class="wizard-steps" aria-label="Wizard steps">@for (s of steps; track s; let i = $index) { <li [class.done]="i < step()" [class.current]="i === step()">{{i + 1}}. {{s}}</li> }</ol>
    @switch (step()) {
      @case (0) {
        <div class="choice-grid" role="radiogroup" aria-label="Integration type">
          @for (st of styles; track st.id) { <button type="button" role="radio" class="choice" [class.selected]="w.style === st.id" [attr.aria-checked]="w.style === st.id" (click)="w.style = st.id; w.template = 'blank'"><b>{{st.title}}</b><small>{{st.text}}</small></button> }
        </div>
      }
      @case (1) {
        <div class="form-grid modal-form">
          <label>Name<input aria-label="Integration name" [ngModel]="w.title" (ngModelChange)="setName($event)" maxlength="80"></label>
          <label>Identifier<input aria-label="Integration identifier" class="mono" [ngModel]="w.identifier" (ngModelChange)="setId($event)" maxlength="50"></label>
          <label>Version<input aria-label="Integration version" class="mono" [(ngModel)]="w.version" maxlength="10" placeholder="01.00.0000"></label>
          <label>Tags (comma separated)<input aria-label="Tags" [(ngModel)]="w.tags" maxlength="200" placeholder="crm, practice"></label>
          <label class="full">Description<input aria-label="Integration description" [(ngModel)]="w.description" maxlength="300"></label>
        </div><p class="hint">The identifier is generated from the name in upper case. The version uses xx.xx.xxxx (default 01.00.0000).</p>
      }
      @case (2) {
        <div class="choice-grid" role="radiogroup" aria-label="Start from">
          <button type="button" role="radio" class="choice" [class.selected]="w.template === 'blank'" [attr.aria-checked]="w.template === 'blank'" (click)="w.template = 'blank'"><b>Blank (recommended)</b><small>{{blankText(w.style)}}</small></button>
          @for (t of templates(); track t.id) { <button type="button" role="radio" class="choice" [class.selected]="w.template === t.id" [attr.aria-checked]="w.template === t.id" [disabled]="w.style !== 'manual'" (click)="w.template = t.id"
            [attr.aria-label]="'Starter template: ' + t.title"><b>{{t.title}}</b><small>{{w.style === 'manual' ? t.description : 'Starter templates use a manual trigger: choose Manual practice to use them.'}}</small></button> }
        </div>
        <dl class="record-dl"><dt>Type</dt><dd>{{label(w.style)}}</dd><dt>Name</dt><dd>{{w.title}}</dd><dt>Identifier</dt><dd><code>{{w.identifier}}</code> · {{w.version}}</dd></dl>
      }
    }
    @if (error()) { <p class="inline-warning flat" role="alert">{{error()}}</p> }
    <div class="form-actions wizard-nav"><button mat-button (click)="step.set(step() - 1)" [disabled]="step() === 0">Back</button>
      @if (step() < 2) { <button mat-flat-button (click)="step.set(step() + 1)" [disabled]="!ready()">Next</button> }
      @else { <button mat-flat-button (click)="create()" [disabled]="busy()">Create</button> }
      <button mat-button (click)="closed.emit()">Cancel</button></div>
  </app-modal>`
})
export class CreateIntegrationComponent implements OnInit {
  api = input.required<Api>();
  created = output<CreatedIntegration>();
  closed = output<void>();
  readonly steps = ['Integration type', 'Basic information', 'Create'];
  readonly styles = STYLE_CHOICES;
  readonly label = styleLabel;
  templates = signal<TemplateInfo[]>([]);
  step = signal(0); busy = signal(false); error = signal('');
  w: Draft = { style: 'application', title: '', identifier: '', idEdited: false, version: '01.00.0000', tags: '', description: '', template: 'blank' };

  async ngOnInit() {
    try { this.templates.set(((await this.api().request<{ templates: TemplateInfo[] }>('flows/actions')).templates ?? []).filter(t => t.id !== 'blank')); }
    catch { /* templates are optional; Blank always works */ }
  }
  setName(title: string) { this.w.title = title; if (!this.w.idEdited) this.w.identifier = toIdentifier(title); }
  setId(id: string) { this.w.identifier = id.toUpperCase(); this.w.idEdited = true; }
  ready() {
    return this.step() === 0 ? !!this.w.style
      : !!this.w.title.trim() && /^[A-Z][A-Z0-9_]{1,49}$/.test(this.w.identifier) && /^\d{2}\.\d{2}\.\d{4}$/.test(this.w.version);
  }
  blankText(style: string) {
    return style === 'application' ? 'Only an unconfigured Start trigger. Choose a Trigger connection, then add actions with +.'
      : style === 'schedule' ? 'Only a Start schedule (manual run by default). Add actions with +.' : 'Only a manual Start trigger. Add actions with +.';
  }
  async create() {
    const w = this.w; this.busy.set(true); this.error.set('');
    try {
      const r = await this.api().request<{ name: string }>('flows', 'POST', { title: w.title.trim(), identifier: w.identifier, versionLabel: w.version, style: w.style,
        description: w.description || null, tags: w.tags.split(',').map(t => t.trim()).filter(t => t), template: w.template });
      this.created.emit({ name: r.name, title: w.title.trim(), style: w.style, template: w.template });
    } catch (e) { if (!(e instanceof SessionEnded)) this.error.set(errorText(e)); } finally { this.busy.set(false); }
  }
}
