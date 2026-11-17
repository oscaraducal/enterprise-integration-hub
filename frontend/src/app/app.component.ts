import { Component, OnDestroy, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { Execution, ExecutionPage, Job, Metrics, Order } from './models';

/** Independently loaded dashboard sections. One failing never blanks another. */
export type Section = 'metrics' | 'executions' | 'orders' | 'jobs' | 'detail';
interface SectionState { error: string; updatedAt: Date | null }
interface Filters { search: string; status: string; environment: string }

const PAGE_SIZE = 20;
const SECTION_LABELS: Record<Section, string> = {
  metrics: 'Metrics', executions: 'Execution history', orders: 'Mock CRM source orders',
  jobs: 'Workload history', detail: 'Execution details'
};
const emptyMetrics = (): Metrics => ({ total: 0, completed: 0, failed: 0, successRate: 0, averageDurationMs: 0, statuses: [] });
const emptySections = (): Record<Section, SectionState> => ({
  metrics: { error: '', updatedAt: null }, executions: { error: '', updatedAt: null }, orders: { error: '', updatedAt: null },
  jobs: { error: '', updatedAt: null }, detail: { error: '', updatedAt: null }
});

/** Raised once a 401 has already ended the session, so callers do not show a second error. */
class SessionEnded extends Error {}

@Component({
  selector: 'app-root', standalone: true, imports: [CommonModule, FormsModule, MatButtonModule],
  templateUrl: './app.component.html'
})
export class AppComponent implements OnDestroy {
  token = ''; username = 'operator'; password = ''; role = signal('');
  signedIn = signal(false); busy = signal(false);
  error = signal(''); notice = signal(''); view = signal('Overview');
  dark = signal(this.storedTheme() === 'dark');
  metrics = signal<Metrics>(emptyMetrics());
  executions = signal<Execution[]>([]); total = signal(0); selected = signal<Execution | null>(null);
  orders = signal<Order[]>([]); jobs = signal<Job[]>([]); job = signal<Job | null>(null);
  sections = signal<Record<Section, SectionState>>(emptySections());
  /** Number of section requests in flight; drives the Refresh button state. */
  private inFlight = signal(0);
  refreshing = computed(() => this.inFlight() > 0);
  /** Sections that failed on their most recent load; their last good data stays on screen, marked stale. */
  degraded = computed(() => (Object.keys(this.sections()) as Section[])
    .filter(s => s !== 'detail' && this.sections()[s].error)
    .map(s => ({ section: s, label: SECTION_LABELS[s], ...this.sections()[s] })));

  // Form values are drafts; `applied` is what the result set and pagination actually reflect.
  search = ''; status = ''; environment = ''; jobEnvironment = '';
  applied = signal<Filters>({ search: '', status: '', environment: '' });
  page = signal(1);
  pages = computed(() => Math.max(1, Math.ceil(this.total() / PAGE_SIZE)));

  orderId = ''; runEnvironment = 'DEV'; scenario = 'None'; target = 'ERP'; failures = 1;
  scenarios = ['None','BadRequest','Unauthorized','NotFound','RateLimit','ServerError','Unavailable','Timeout','Validation','Duplicate'];
  statuses = ['Pending','Running','Completed','Failed','Retrying'];

  // Background polling skips while anything is in flight, so a slow upstream cannot pile requests up.
  private timer = setInterval(() => { if (this.signedIn() && !this.refreshing()) void this.refresh(); }, 2500);
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Incremented on sign-in and sign-out; responses from an older session are discarded. */
  private generation = 0;
  /** Per-section request sequence; only the newest response for a section is applied. */
  private sequence: Record<Section, number> = { metrics: 0, executions: 0, orders: 0, jobs: 0, detail: 0 };
  private aborter = new AbortController();

  constructor() { this.applyTheme(); }
  ngOnDestroy() { clearInterval(this.timer); clearTimeout(this.expiryTimer); this.aborter.abort(); }

  private storedTheme() { try { return localStorage.getItem('hub-theme'); } catch { return null; } }
  private applyTheme() { document.documentElement.dataset['theme'] = this.dark() ? 'dark' : 'light'; }
  toggleTheme() {
    this.dark.update(v => !v);
    try { localStorage.setItem('hub-theme', this.dark() ? 'dark' : 'light'); } catch { /* preference is optional */ }
    this.applyTheme();
  }

  async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const generation = this.generation;
    let response: Response;
    try {
      response = await fetch('/api/' + path, {
        method, signal: this.aborter.signal,
        headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch (e) {
      if (generation !== this.generation) throw new SessionEnded();
      throw new Error('Integration Hub API is unreachable. Check that the hub service is running.');
    }
    if (!response.ok) {
      if (response.status === 401 && path !== 'auth/login') {
        if (generation === this.generation && this.signedIn()) this.logout('Your session expired. Sign in again to continue.');
        throw new SessionEnded();
      }
      const content = await response.json().catch(() => ({}));
      if (response.status === 401) throw new Error('Incorrect demo credentials.');
      if (response.status === 403) throw new Error('Your role cannot perform this action. Sign in as operator to run or retry.');
      if (response.status === 429) throw new Error('Too many requests. Wait a minute and try again.');
      throw new Error(content.error || content.title || 'Request failed (' + response.status + ').');
    }
    return response.json() as Promise<T>;
  }

  async login() {
    this.busy.set(true); this.error.set('');
    try {
      const auth = await this.request<{ token: string; role: string; expiresAt: string }>('auth/login', 'POST', { username: this.username, password: this.password });
      this.generation++;
      this.token = auth.token; this.role.set(auth.role); this.password = ''; this.signedIn.set(true);
      this.scheduleExpiry(auth.expiresAt);
      await this.refresh();
    } catch (e) { this.reportError(e); } finally { this.busy.set(false); }
  }

  private scheduleExpiry(expiresAt: string) {
    clearTimeout(this.expiryTimer);
    const ms = new Date(expiresAt).getTime() - Date.now();
    if (!Number.isFinite(ms)) return;
    // The API also rejects the token with 401; this returns an idle tab to the login screen proactively.
    this.expiryTimer = setTimeout(() => this.logout('Your session expired. Sign in again to continue.'), Math.min(Math.max(ms, 0), 2 ** 31 - 1));
  }

  /** Clears credentials and every piece of protected data, and invalidates requests still in flight. */
  logout(reason = '') {
    this.generation++;
    this.aborter.abort(); this.aborter = new AbortController();
    clearTimeout(this.expiryTimer);
    this.token = ''; this.password = ''; this.signedIn.set(false); this.role.set('');
    this.metrics.set(emptyMetrics()); this.executions.set([]); this.total.set(0); this.selected.set(null);
    this.orders.set([]); this.jobs.set([]); this.job.set(null); this.sections.set(emptySections());
    this.search = ''; this.status = ''; this.environment = ''; this.jobEnvironment = '';
    this.applied.set({ search: '', status: '', environment: '' }); this.page.set(1);
    this.orderId = ''; this.view.set('Overview'); this.notice.set(''); this.busy.set(false);
    this.error.set(reason);
  }

  /**
   * Loads one section in isolation. A failure keeps that section's previous data, records the error for
   * that section only, and never rejects, so independent sections still update.
   */
  private async load<T>(section: Section, path: string, apply: (data: T) => void): Promise<boolean> {
    const generation = this.generation;
    const id = ++this.sequence[section];
    this.inFlight.update(n => n + 1);
    try {
      const data = await this.request<T>(path);
      if (generation !== this.generation || id !== this.sequence[section]) return false;
      apply(data);
      this.setSection(section, { error: '', updatedAt: new Date() });
      return true;
    } catch (e) {
      if (!(e instanceof SessionEnded) && generation === this.generation && id === this.sequence[section])
        this.setSection(section, { ...this.sections()[section], error: this.message(e) });
      return false;
    } finally { this.inFlight.update(n => n - 1); }
  }
  private setSection(section: Section, state: SectionState) { this.sections.update(s => ({ ...s, [section]: state })); }

  async refresh() {
    if (!this.signedIn()) return;
    await Promise.all([this.loadMetrics(), this.loadExecutions(), this.loadOrders(), this.loadJobs(), this.loadDetail()]);
  }
  loadMetrics() { return this.load<Metrics>('metrics', 'metrics', m => this.metrics.set(m)); }
  loadOrders() {
    return this.load<Order[]>('orders', 'orders', orders => {
      this.orders.set(orders);
      if (!orders.some(o => o.id === this.orderId)) this.orderId = orders[0]?.id ?? '';
    });
  }
  loadJobs() {
    return this.load<Job[]>('jobs', 'jobs' + (this.jobEnvironment ? '?environment=' + this.jobEnvironment : ''), jobs => this.jobs.set(jobs));
  }
  async loadExecutions(): Promise<void> {
    const filters = this.applied(), page = this.page();
    const params = new URLSearchParams({ page: String(page) });
    if (filters.search) params.set('search', filters.search);
    if (filters.status) params.set('status', filters.status);
    if (filters.environment) params.set('environment', filters.environment);
    let overflow = false;
    await this.load<ExecutionPage>('executions', 'executions?' + params, result => {
      this.executions.set(result.items); this.total.set(result.total);
      // The result set shrank below the current page (e.g. items changed status): move to the last valid page.
      const last = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
      if (page > last) { this.page.set(last); overflow = true; }
    });
    if (overflow) await this.loadExecutions();
  }
  private loadDetail() {
    const current = this.selected();
    if (!current) return Promise.resolve(false);
    return this.load<Execution>('detail', 'executions/' + encodeURIComponent(current.id), detail => {
      if (this.selected()?.id === detail.id) this.selected.set(detail);
    });
  }

  /** Commits the drafted search and filters, and returns to page 1 of the new result set. */
  async filter() {
    this.applied.set({ search: this.search.trim(), status: this.status, environment: this.environment });
    this.page.set(1);
    await this.loadExecutions();
  }
  async clearFilters() { this.search = ''; this.status = ''; this.environment = ''; await this.filter(); }
  async navigatePage(delta: number) {
    const next = Math.min(Math.max(this.page() + delta, 1), this.pages());
    if (next === this.page()) return;
    this.page.set(next);
    await this.loadExecutions();
  }
  async filterJobs() { await this.loadJobs(); }
  filtersActive() { const f = this.applied(); return !!(f.search || f.status || f.environment); }
  filtersPending() {
    const f = this.applied();
    return this.search.trim() !== f.search || this.status !== f.status || this.environment !== f.environment;
  }

  async inspect(id: string, focus = true) {
    this.error.set('');
    const generation = this.generation;
    const seq = ++this.sequence.detail;
    try {
      const detail = await this.request<Execution>('executions/' + encodeURIComponent(id));
      if (generation !== this.generation || seq !== this.sequence.detail) return;
      this.selected.set(detail);
      this.setSection('detail', { error: '', updatedAt: new Date() });
      if (focus) setTimeout(() => document.getElementById('investigation')?.focus());
    } catch (e) { if (generation === this.generation) this.reportError(e); }
  }
  closeDetails() { this.sequence.detail++; this.selected.set(null); this.setSection('detail', { error: '', updatedAt: null }); }

  async run() {
    const generation = this.generation;
    this.busy.set(true); this.error.set(''); this.notice.set('');
    try {
      const result = await this.request<{ id: string }>('executions', 'POST', {
        orderId: this.orderId, environment: this.runEnvironment, scenario: this.scenario,
        target: this.scenario === 'Validation' ? 'CRM' : this.scenario === 'Duplicate' ? 'ERP' : this.target,
        failuresBeforeSuccess: Number(this.failures)
      });
      if (generation !== this.generation) return;
      this.notice.set('Execution queued. Follow its stages in the investigation panel.');
      await this.inspect(result.id); await this.refresh();
    } catch (e) { if (generation === this.generation) this.reportError(e); }
    finally { if (generation === this.generation) this.busy.set(false); }
  }
  async retry() {
    const execution = this.selected(); if (!execution || execution.status !== 'Failed') return;
    const generation = this.generation;
    this.busy.set(true); this.error.set('');
    try {
      await this.request('executions/' + encodeURIComponent(execution.id) + '/retry', 'POST', {});
      if (generation !== this.generation) return;
      this.notice.set('Safe retry queued with the same order ID. Simulation cleared.');
      await this.inspect(execution.id, false); await this.refresh();
    } catch (e) { if (generation === this.generation) this.reportError(e); }
    finally { if (generation === this.generation) this.busy.set(false); }
  }
  async simulateJob(fail: boolean) {
    const generation = this.generation;
    this.busy.set(true); this.error.set('');
    try {
      const job = await this.request<Job>('jobs/simulate', 'POST', { environment: this.runEnvironment, fail });
      if (generation !== this.generation) return;
      this.job.set(job);
      await this.loadJobs();
    } catch (e) { if (generation === this.generation) this.reportError(e); }
    finally { if (generation === this.generation) this.busy.set(false); }
  }

  section(name: Section) { return this.sections()[name]; }
  distributionLabel() { return 'Execution status distribution: ' + this.statuses.map(s => s + ' ' + this.count(s)).join(', '); }
  duration(ms?: number) { return ms == null ? '—' : (ms / 1000).toFixed(2) + 's'; }
  count(status: string) { return this.metrics().statuses.find(s => s.status === status)?.count ?? 0; }
  percent(status: string) { return this.metrics().total ? this.count(status) / this.metrics().total * 100 : 0; }
  private reportError(e: unknown) { if (!(e instanceof SessionEnded)) this.error.set(this.message(e)); }
  /** Messages are shown inline after a label, so make each read as a sentence ("Mock CRM unavailable."). */
  private message(e: unknown) {
    const text = (e instanceof Error ? e.message : 'Unable to reach the simulator.').trim();
    return /[.!?)]$/.test(text) ? text : text + '.';
  }
}
