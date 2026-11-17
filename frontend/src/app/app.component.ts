import { Component, OnDestroy, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { Execution, ExecutionPage, Job, Metrics, Order } from './models';

@Component({
  selector: 'app-root', standalone: true, imports: [CommonModule, FormsModule, MatButtonModule],
  templateUrl: './app.component.html'
})
export class AppComponent implements OnDestroy {
  token = ''; username = 'operator'; password = ''; role = signal('');
  signedIn = signal(false); busy = signal(false); refreshing = signal(false);
  error = signal(''); notice = signal(''); view = signal('Overview');
  dark = signal(localStorage.getItem('hub-theme') === 'dark');
  metrics = signal<Metrics>({ total: 0, completed: 0, failed: 0, successRate: 0, averageDurationMs: 0, statuses: [] });
  executions = signal<Execution[]>([]); total = signal(0); selected = signal<Execution | null>(null);
  orders = signal<Order[]>([]); jobs = signal<Job[]>([]); job = signal<Job | null>(null);
  search = ''; status = ''; environment = ''; page = 1;
  orderId = ''; runEnvironment = 'DEV'; scenario = 'None'; target = 'ERP'; failures = 1;
  scenarios = ['None','BadRequest','Unauthorized','NotFound','RateLimit','ServerError','Unavailable','Timeout','Validation','Duplicate'];
  statuses = ['Pending','Running','Completed','Failed','Retrying'];
  pages = computed(() => Math.max(1, Math.ceil(this.total() / 20)));
  private timer = setInterval(() => { if (this.signedIn()) void this.refresh(); }, 2500);
  private generation = 0;
  constructor() { this.applyTheme(); }
  ngOnDestroy() { clearInterval(this.timer); }
  private applyTheme() { document.documentElement.dataset['theme'] = this.dark() ? 'dark' : 'light'; }
  toggleTheme() { this.dark.update(v => !v); localStorage.setItem('hub-theme', this.dark() ? 'dark' : 'light'); this.applyTheme(); }
  async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch('/api/' + path, {
      method, headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!response.ok) {
      if (response.status === 401 && path !== 'auth/login') { this.logout(); throw new Error('Session expired. Sign in again.'); }
      const content = await response.json().catch(() => ({}));
      throw new Error(content.error || content.title || (response.status === 401 ? 'Incorrect demo credentials.' : 'Request failed (' + response.status + ').'));
    }
    return response.json() as Promise<T>;
  }
  async login() {
    this.busy.set(true); this.error.set('');
    try {
      const auth = await this.request<{token: string; role: string}>('auth/login', 'POST', { username: this.username, password: this.password });
      this.token = auth.token; this.role.set(auth.role); this.password = ''; this.signedIn.set(true);
      await this.refresh();
    } catch (e) { this.error.set(this.message(e)); } finally { this.busy.set(false); }
  }
  logout() {
    this.generation++; this.token = ''; this.signedIn.set(false); this.selected.set(null);
    this.executions.set([]); this.jobs.set([]); this.orders.set([]); this.role.set(''); this.notice.set('');
  }
  async refresh() {
    if (this.refreshing()) return;
    const generation = this.generation;
    this.refreshing.set(true);
    try {
      const params = new URLSearchParams({ page: String(this.page) });
      if (this.search.trim()) params.set('search', this.search.trim());
      if (this.status) params.set('status', this.status);
      if (this.environment) params.set('environment', this.environment);
      const [metrics, executions, orders, jobs] = await Promise.all([
        this.request<Metrics>('metrics'), this.request<ExecutionPage>('executions?' + params),
        this.request<Order[]>('orders'), this.request<Job[]>('jobs' + (this.environment ? '?environment=' + this.environment : ''))
      ]);
      if (generation !== this.generation) return;
      this.metrics.set(metrics); this.executions.set(executions.items); this.total.set(executions.total);
      this.orders.set(orders); this.jobs.set(jobs);
      if (!this.orderId) this.orderId = orders[0]?.id ?? '';
      if (this.selected()) {
        const detail = await this.request<Execution>('executions/' + this.selected()!.id);
        if (generation === this.generation && this.selected()?.id === detail.id) this.selected.set(detail);
      }
    } catch (e) { this.error.set(this.message(e)); } finally { this.refreshing.set(false); }
  }
  async filter() { this.page = 1; await this.refresh(); }
  async navigatePage(delta: number) { this.page += delta; await this.refresh(); }
  async inspect(id: string) {
    this.error.set('');
    try { this.selected.set(await this.request<Execution>('executions/' + id)); }
    catch (e) { this.error.set(this.message(e)); }
  }
  async run() {
    this.busy.set(true); this.error.set(''); this.notice.set('');
    try {
      const result = await this.request<{id: string}>('executions', 'POST', {
        orderId: this.orderId, environment: this.runEnvironment, scenario: this.scenario,
        target: this.scenario === 'Validation' ? 'CRM' : this.scenario === 'Duplicate' ? 'ERP' : this.target,
        failuresBeforeSuccess: Number(this.failures)
      });
      this.notice.set('Execution queued. Follow its stages in the investigation panel.');
      await this.inspect(result.id); await this.refresh();
    } catch (e) { this.error.set(this.message(e)); } finally { this.busy.set(false); }
  }
  async retry() {
    const execution = this.selected(); if (!execution || execution.status !== 'Failed') return;
    this.busy.set(true); this.error.set('');
    try {
      await this.request('executions/' + execution.id + '/retry', 'POST', {});
      this.notice.set('Safe retry queued with the same order ID. Simulation cleared.');
      await this.inspect(execution.id); await this.refresh();
    } catch (e) { this.error.set(this.message(e)); } finally { this.busy.set(false); }
  }
  async simulateJob(fail: boolean) {
    this.busy.set(true); this.error.set('');
    try {
      this.job.set(await this.request<Job>('jobs/simulate', 'POST', { environment: this.runEnvironment, fail }));
      await this.refresh();
    } catch (e) { this.error.set(this.message(e)); } finally { this.busy.set(false); }
  }
  duration(ms?: number) { return ms == null ? '—' : (ms / 1000).toFixed(2) + 's'; }
  count(status: string) { return this.metrics().statuses.find(s => s.status === status)?.count ?? 0; }
  percent(status: string) { return this.metrics().total ? this.count(status) / this.metrics().total * 100 : 0; }
  private message(e: unknown) { return e instanceof Error ? e.message : 'Unable to reach the simulator.'; }
}
