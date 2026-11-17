import { Component, EventEmitter, Input, OnChanges, Output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { Focus } from './api';
import { GLOSSARY, PIPELINE, SCENARIOS, ScenarioDef } from './catalog';

/** Scenario catalog ("Scenarios") and guided walkthroughs ("Guides"). */
@Component({
  selector: 'app-scenarios', standalone: true, imports: [CommonModule, MatButtonModule],
  template: `
  <section class="panel pipeline-panel" aria-label="Integration pipeline">
    <ol class="pipeline">@for (p of pipeline; track p; let i = $index) { <li><span>{{i + 1}}</span>{{p}}</li> }</ol>
    <p class="hint">Every implemented scenario follows this path: a source record is retrieved over REST, validated, mapped field by field, delivered to the target, stored as an imported record and monitored as one execution.</p>
  </section>
  @if (mode === 'catalog') {
    <div class="scenario-grid">
      @for (s of scenarios; track s.id) {
        <article class="panel scenario-card" [class.planned]="s.status === 'Planned'" [attr.aria-label]="s.id + ' ' + s.title">
          <div class="section-heading"><div><span class="eyebrow">{{s.id}}</span><h2>{{s.title}}</h2></div>
            <span class="pill" [class]="s.status === 'Implemented' ? 'pill Completed' : s.status === 'Design only' ? 'pill Running' : 'pill Pending'">{{s.status}}</span></div>
          <div class="card-body">
            <p class="route-line"><b>{{s.source}}</b> → <b>{{s.target}}</b></p>
            <p>{{s.businessCase}}</p>
            <h3>Field mapping</h3>
            <ul class="field-pairs">@for (f of s.fields; track f[0]) { <li><code>{{f[0]}}</code> → <code>{{f[1]}}</code></li> }</ul>
            <h3>Business rules</h3><ul>@for (r of s.requirements; track r) { <li>{{r}}</li> }</ul>
            <h3>Sample data</h3><ul>@for (d of s.samples; track d) { <li>{{d}}</li> }</ul>
            <div class="button-row">
              @if (s.status === 'Implemented') {
                <button mat-flat-button (click)="open.emit({ view: 'Guides', scenario: s.id })">Open guide</button>
                <button mat-stroked-button (click)="open.emit({ view: 'Mapping Studio', kind: s.id === 'SCN-002' ? 'order' : 'customer', id: s.id === 'SCN-002' ? 'ORD-013' : 'C-300' })">Mapping Studio</button>
              } @else if (s.status === 'Design only') {
                <button mat-flat-button (click)="open.emit({ view: 'Guides', scenario: s.id })">Open guide</button>
                <button mat-stroked-button (click)="open.emit({ view: 'Integration Designer' })">Integration Designer</button>
                <span class="hint">Designed and validated now; runs in Milestone D.</span>
              } @else { <span class="hint">Documented design only. Not implemented in this release.</span> }
              <a class="doc-link" [href]="s.doc" target="_blank" rel="noopener">Documentation ↗</a>
            </div>
          </div>
        </article>
      }
    </div>
  } @else {
    <section class="panel">
      <div class="tabs guide-tabs" role="tablist" aria-label="Scenario guides">
        @for (s of implemented; track s.id) { <button role="tab" [attr.aria-selected]="active().id === s.id" [class.active]="active().id === s.id" (click)="select(s.id)">{{s.id}}</button> }
      </div>
      @if (active(); as s) {
        <div class="guide">
          <span class="eyebrow">GUIDED WALKTHROUGH · {{s.id}}</span><h2>{{s.title}}</h2>
          <p class="muted">{{s.objective}}</p>
          <ol class="steps">@for (step of s.steps; track $index) {
            <li><div><p>{{step.text}}</p>@if (step.detail) { <small>{{step.detail}}</small> }</div>
              @if (step.go) { <button mat-stroked-button (click)="open.emit(step.go!)">{{step.label || 'Go'}} →</button> }</li>
          }</ol>
          <h3>How to verify</h3><ul>@for (v of s.verify; track v) { <li>{{v}}</li> }</ul>
          <a class="doc-link" [href]="s.doc" target="_blank" rel="noopener">Full scenario documentation ↗</a>
        </div>
      }
    </section>
    <section class="panel glossary"><details><summary><h2>Integration terms explained</h2></summary>
      <dl>@for (g of glossary; track g[0]) { <dt>{{g[0]}}</dt><dd>{{g[1]}}</dd> }</dl></details></section>
  }`
})
export class ScenariosComponent implements OnChanges {
  @Input() mode: 'catalog' | 'guides' = 'catalog';
  @Input() scenario: string | undefined;
  @Output() open = new EventEmitter<Focus>();
  readonly scenarios = SCENARIOS;
  readonly implemented = SCENARIOS.filter(s => s.status !== 'Planned');
  readonly glossary = GLOSSARY;
  readonly pipeline = PIPELINE;
  active = signal<ScenarioDef>(this.implemented[0]);
  ngOnChanges() { if (this.scenario) this.select(this.scenario); }
  select(id: string) { const s = this.implemented.find(x => x.id === id); if (s) this.active.set(s); }
}
