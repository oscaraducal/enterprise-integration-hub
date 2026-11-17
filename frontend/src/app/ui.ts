import { AfterViewInit, Component, ElementRef, EventEmitter, HostListener, Input, OnDestroy, Output, computed, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';

/**
 * Accessible modal dialog: Esc and the backdrop close it, focus moves into it on open, Tab stays inside it,
 * and focus returns to the element that opened it.
 */
@Component({
  selector: 'app-modal', standalone: true, imports: [MatButtonModule],
  template: `
  <div class="modal-backdrop" (click)="close.emit()"></div>
  <section class="modal panel" [class.wide]="wide" role="dialog" aria-modal="true" [attr.aria-label]="label" tabindex="-1">
    <header class="modal-head"><div>@if (eyebrow) { <span class="eyebrow">{{eyebrow}}</span> }<h2>{{heading}}</h2></div>
      <button mat-button type="button" class="modal-close" (click)="close.emit()" [attr.aria-label]="'Close ' + label">Close ✕</button></header>
    <div class="modal-body"><ng-content></ng-content></div>
  </section>`
})
export class ModalComponent implements AfterViewInit, OnDestroy {
  @Input({ required: true }) label = '';
  @Input() heading = '';
  @Input() eyebrow = '';
  @Input() wide = false;
  @Output() close = new EventEmitter<void>();
  /** Open dialogs, oldest first; Escape closes only the topmost one. */
  private static stack: ModalComponent[] = [];
  private opener = document.activeElement as HTMLElement | null;
  constructor(private host: ElementRef<HTMLElement>) {}
  ngAfterViewInit() {
    ModalComponent.stack.push(this); document.body.classList.add('modal-open');
    setTimeout(() => (this.host.nativeElement.querySelector('[role=dialog]') as HTMLElement | null)?.focus());
  }
  ngOnDestroy() {
    ModalComponent.stack = ModalComponent.stack.filter(m => m !== this);
    if (!ModalComponent.stack.length) document.body.classList.remove('modal-open');
    if (this.opener?.isConnected) this.opener.focus();
  }
  @HostListener('document:keydown.escape', ['$event']) onEscape(e: Event) {
    if (ModalComponent.stack[ModalComponent.stack.length - 1] !== this) return;
    e.preventDefault(); this.close.emit();
  }
  @HostListener('keydown', ['$event']) onKey(e: KeyboardEvent) {
    if (e.key !== 'Tab') return;
    const items = Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>(
      'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea,[tabindex]:not([tabindex="-1"]),a[href]'));
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
  }
}

export type ColumnKind = 'text' | 'code' | 'pill' | 'date' | 'number' | 'money';
export interface Column<T = any> {
  key: string; label: string; kind?: ColumnKind;
  /** Computed cell value; defaults to row[key]. */
  value?: (row: T) => unknown;
  /** Secondary line under the value. */
  sub?: (row: T) => string | null | undefined;
  /** CSS class for pills (e.g. a status). */
  pillClass?: (row: T) => string;
}

/** Searchable, paginated table used by the CRM and ERP screens. Search matches every column's displayed value. */
@Component({
  selector: 'app-data-table', standalone: true, imports: [CommonModule, FormsModule, MatButtonModule],
  template: `
  <div class="table-tools">
    <label class="search-field"><span class="sr-only">Search {{label()}}</span>
      <input type="search" [ngModel]="query()" (ngModelChange)="query.set($event); page.set(1)" [placeholder]="'Search ' + label().toLowerCase() + '…'" maxlength="80"></label>
    <span class="muted" aria-live="polite">{{filtered().length}} {{filtered().length === 1 ? 'record' : 'records'}}{{query() ? ' · filtered' : ''}}</span>
  </div>
  <div class="table-scroll" tabindex="0" role="region" [attr.aria-label]="label() + ' table, scrolls horizontally'">
    <table><caption class="sr-only">{{label()}}. Page {{page()}} of {{pages()}}.</caption>
      <thead><tr>@for (c of columns(); track c.key) { <th scope="col">{{c.label}}</th> }<th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>
        @for (row of visible(); track trackKey()(row)) {
          <tr [class.selected-row]="selectedKey() === trackKey()(row)">
            @for (c of columns(); track c.key) {
              <td>@switch (c.kind) {
                @case ('code') { <code>{{cell(c, row) ?? '—'}}</code> }
                @case ('pill') { <span [class]="'pill ' + (c.pillClass ? c.pillClass(row) : '')">{{cell(c, row) ?? '—'}}</span> }
                @case ('date') { {{cell(c, row) ? ($any(cell(c, row)) | date:'MMM d, HH:mm') : '—'}} }
                @case ('money') { {{cell(c, row) == null ? '—' : ($any(cell(c, row)) | number:'1.2-2')}} }
                @default { {{cell(c, row) ?? '—'}} }
              }@if (c.sub && c.sub(row)) { <small>{{c.sub(row)}}</small> }</td>
            }
            <td><button mat-button type="button" (click)="open.emit(row)" [attr.aria-label]="openLabel()(row)">Open ↗</button></td>
          </tr>
        } @empty {
          <tr><td [attr.colspan]="columns().length + 1" class="empty">@if (loading()) { Loading… } @else if (query()) { <strong>No matching records</strong><p>Change or clear the search.</p> } @else { <strong>{{emptyText()}}</strong> }</td></tr>
        }
      </tbody></table></div>
  <nav class="pagination" [attr.aria-label]="label() + ' pages'"><span>Page {{page()}} of {{pages()}}</span>
    <div><button mat-button type="button" [disabled]="page() <= 1" (click)="page.set(page() - 1)">Previous</button>
      <button mat-button type="button" [disabled]="page() >= pages()" (click)="page.set(page() + 1)">Next</button></div></nav>`
})
export class DataTableComponent<T = any> {
  rows = input.required<T[]>();
  columns = input.required<Column<T>[]>();
  label = input.required<string>();
  trackKey = input.required<(row: T) => string>();
  openLabel = input<(row: T) => string>(() => 'Open record');
  selectedKey = input<string | null>(null);
  pageSize = input(10);
  loading = input(false);
  emptyText = input('No records.');
  /** Search text applied when the table first renders (e.g. "orders for C-300"). */
  initialQuery = input('');
  open = output<T>();
  query = signal(''); page = signal(1);
  ngOnInit() { if (this.initialQuery()) this.query.set(this.initialQuery()); }
  filtered = computed(() => {
    const q = this.query().trim().toLowerCase(); const rows = this.rows() ?? [];
    if (!q) return rows;
    return rows.filter(r => this.columns().some(c => String(this.cell(c, r) ?? '').toLowerCase().includes(q) || (c.sub?.(r) ?? '').toLowerCase().includes(q)));
  });
  pages = computed(() => Math.max(1, Math.ceil(this.filtered().length / this.pageSize())));
  visible = computed(() => {
    const page = Math.min(this.page(), this.pages());
    return this.filtered().slice((page - 1) * this.pageSize(), page * this.pageSize());
  });
  cell(c: Column<T>, row: T): any { return c.value ? c.value(row) : (row as any)[c.key]; }
}

/** Secondary navigation inside a business application (CRM or ERP). */
@Component({
  selector: 'app-subnav', standalone: true,
  template: `
  <nav class="app-subnav" [attr.aria-label]="label()">
    @for (item of items(); track item) {
      <button type="button" [class.active]="active() === item" [attr.aria-current]="active() === item ? 'page' : null" (click)="select.emit(item)">{{item}}</button>
    }
  </nav>`
})
export class SubnavComponent {
  label = input.required<string>();
  items = input.required<readonly string[]>();
  active = input.required<string>();
  select = output<string>();
}

/** Pretty-prints a JSON string, falling back to the raw text. */
export function prettyJson(text?: string | null): string {
  if (!text) return '';
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}
