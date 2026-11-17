import { Component, Injectable, inject, signal } from '@angular/core';
import { CanDeactivateFn, Routes } from '@angular/router';
import { Focus, View } from './api';
import { CRM_SECTIONS } from './source.component';
import { ERP_SECTIONS } from './target.component';

/**
 * Three logical application workspaces share one shell, one sign-in and the existing backend security boundaries:
 * the Legacy CRM (source business system), the Integration Workbench (integration development) and the Modern ERP
 * (target business system). URLs identify the workspace and page, so back/forward and reloads work.
 */
export type Workspace = 'crm' | 'workbench' | 'erp';
export interface WorkspaceDef { id: Workspace; name: string; role: string; home: View; icon: string }
export const WORKSPACES: WorkspaceDef[] = [
  { id: 'crm', name: 'Legacy CRM', role: 'Source system', home: 'Source System', icon: '◧' },
  { id: 'workbench', name: 'Integration Workbench', role: 'Integration development', home: 'Overview', icon: '⌬' },
  { id: 'erp', name: 'Modern ERP', role: 'Target system', home: 'Target System', icon: '◨' },
];

/** Integration Workbench resources, in navigation order (a compact top bar; the home page shows them as cards). */
export const WORKBENCH_NAV: { label: string; view: View; icon: string }[] = [
  { label: 'Home', view: 'Overview', icon: '⌂' },
  { label: 'Projects', view: 'Projects', icon: '▦' },
  { label: 'Integrations', view: 'Integrations', icon: '⌬' },
  { label: 'Connections', view: 'Connections', icon: '⚭' },
  { label: 'Mappings', view: 'Mapping Studio', icon: '⇆' },
  { label: 'Monitoring', view: 'Executions', icon: '⇄' },
  { label: 'Guides', view: 'Scenarios', icon: '☰' },
];

/**
 * The default practice project. It groups every integration and connection in this local workbench without moving,
 * renaming or re-owning them; there is no project persistence yet, so no asset can lose its references.
 */
export const PRACTICE_PROJECT = { id: 'practice', name: 'Practice Project', identifier: 'PRACTICE_PROJECT',
  description: 'Default practice project: every integration and connection in this local workbench, in one place.' };

export function workspaceOf(view: View): Workspace {
  return view === 'Source System' ? 'crm' : view === 'Target System' ? 'erp' : 'workbench';
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
export function sectionFromSlug(view: View, value?: string): string | undefined {
  const list: readonly string[] = view === 'Source System' ? CRM_SECTIONS : view === 'Target System' ? ERP_SECTIONS : [];
  return value ? list.find(s => slug(s) === value) : undefined;
}

/** URL for a navigation request. Record focus (kind/id) travels as query parameters so links can be shared and reloaded. */
export function urlFor(f: Focus): { path: string[]; query: Record<string, string> } {
  const query: Record<string, string> = {};
  if (f.kind) query['kind'] = f.kind;
  if (f.id) query['id'] = f.id;
  if (f.run) query['run'] = '1';
  if (f.create) query['new'] = '1';
  if (f.scenario && f.view !== 'Guides') query['scenario'] = f.scenario;
  if (f.from) query['from'] = f.from;
  // A record opens on its own screen, so the URL names that screen (and the page does not report a section change).
  if (f.id && !f.section && f.view === 'Source System') f = { ...f, section: f.kind === 'order' ? 'Sales Orders' : 'Customers' };
  if (f.id && !f.section && f.view === 'Target System') f = { ...f, section: f.kind === 'order' ? 'Sales Orders' : 'Customer Master' };
  switch (f.view) {
    case 'Source System': return { path: ['/crm', ...(f.section && f.section !== 'Dashboard' ? [slug(f.section)] : [])], query };
    case 'Target System': return { path: ['/erp', ...(f.section && f.section !== 'Dashboard' ? [slug(f.section)] : [])], query };
    case 'Projects': return { path: ['/workbench/projects'], query };
    case 'Project': return { path: ['/workbench/projects', f.project ?? PRACTICE_PROJECT.id], query };
    case 'Integrations': return { path: ['/workbench/integrations'], query };
    case 'Integration Designer': return { path: f.flow ? ['/workbench/integrations', f.flow] : ['/workbench/integrations'], query };
    case 'Connections': return { path: ['/workbench/connections'], query };
    case 'Mapping Studio': return { path: ['/workbench/mappings'], query };
    case 'Executions': return { path: ['/workbench/monitoring'], query };
    case 'Workloads': return { path: ['/workbench/monitoring/workloads'], query };
    case 'Scenarios': return { path: ['/workbench/guides'], query };
    case 'Guides': return { path: ['/workbench/guides', f.scenario ?? 'SCN-001'], query };
    default: return { path: ['/workbench'], query };
  }
}

/** The shell renders pages itself; routes only carry the page identity, so this outlet content is empty. */
@Component({ selector: 'app-route', standalone: true, template: '' })
export class RouteStub {}

/**
 * Lets the open Designer veto or confirm leaving its route. The Designer registers a handler while it has a draft open;
 * the handler asks the user (save, keep for later, discard or stay) and resolves to true when navigation may continue.
 */
@Injectable({ providedIn: 'root' })
export class DesignerSession {
  private handler: (() => Promise<boolean>) | null = null;
  /** Unsaved working copies kept in memory for this browser tab, per integration, so switching pages never loses them. */
  readonly kept = new Map<string, KeptDraft>();
  readonly keptCount = signal(0);
  /** One-time message for the Designer to show when it opens the next integration (e.g. "created from a template"). */
  notice = '';
  register(h: (() => Promise<boolean>) | null) { this.handler = h; }
  canLeave(): Promise<boolean> { return this.handler ? this.handler() : Promise.resolve(true); }
  keep(name: string, draft: KeptDraft) { this.kept.set(name, draft); this.keptCount.set(this.kept.size); }
  take(name: string) { const d = this.kept.get(name); this.kept.delete(name); this.keptCount.set(this.kept.size); return d; }
  /** Sign-out clears every kept draft with the rest of the session's data. */
  clear() { this.handler = null; this.kept.clear(); this.keptCount.set(0); }
}
export interface KeptDraft { baseRevision: number; title: string; definition: string; keptAt: Date }

export const leaveDesigner: CanDeactivateFn<unknown> = () => inject(DesignerSession).canLeave();

const page = (path: string, view: View, extra: Partial<Routes[number]> = {}) => ({ path, component: RouteStub, data: { view }, ...extra });
export const ROUTES: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'workbench' },
  page('workbench', 'Overview'),
  page('workbench/projects', 'Projects'),
  page('workbench/projects/:project', 'Project'),
  page('workbench/integrations', 'Integrations'),
  page('workbench/integrations/:flow', 'Integration Designer', { canDeactivate: [leaveDesigner] }),
  page('workbench/connections', 'Connections'),
  page('workbench/mappings', 'Mapping Studio'),
  page('workbench/monitoring', 'Executions'),
  page('workbench/monitoring/workloads', 'Workloads'),
  page('workbench/guides', 'Scenarios'),
  page('workbench/guides/:scenario', 'Guides'),
  page('crm', 'Source System'),
  page('crm/:section', 'Source System'),
  page('erp', 'Target System'),
  page('erp/:section', 'Target System'),
  { path: '**', redirectTo: 'workbench' },
];
