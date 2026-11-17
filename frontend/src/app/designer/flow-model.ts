import { ColumnDef, TableView } from '../systems';

/** Mirrors Hub.Application.Flows.FlowDefinition. The server validates; these helpers only edit the tree. */
export interface FlowNode { id: string; type: string; name: string; description?: string | null; config: Record<string, any>; branches: FlowBranch[] }
export interface FlowBranch { id: string; kind: 'case' | 'otherwise' | 'body' | 'faultHandler' | 'branch'; label: string; condition?: string | null; steps: FlowNode[] }
export interface FlowDefinition { schemaVersion: number; trigger: FlowNode | null; steps: FlowNode[]; globalFaultHandler: FlowNode[] }
export interface ActionDef {
  type: string; label: string; category: string; status: 'Designable' | 'Planned'; description: string;
  branches: { kind: FlowBranch['kind']; label: string }[]; planned?: string | null; operations?: string[] | null;
}
export interface FunctionDef { name: string; category: string; minArgs: number; maxArgs: number; signature: string; description: string }
export interface FlowIssue { nodeId: string | null; severity: 'error' | 'warning'; message: string; field?: string | null }
export interface FlowReport { valid: boolean; issues: FlowIssue[]; nodeCount: number; variables: string[] }
export interface Catalog { actions: ActionDef[]; functions: FunctionDef[]; dateFormats: string[]; templates: { id: string; title: string; description: string; scenario: string }[] }

/** A place in the tree where steps can be inserted: the main flow, the global fault handler, or a branch. */
export interface Lane { kind: 'root' | 'fault' | 'branch'; branchId?: string }
export const laneKey = (l: Lane) => l.kind === 'branch' ? 'b:' + l.branchId : l.kind;

export const CATEGORY_ORDER = ['Connectivity', 'Actions', 'Logic', 'Error Handling', 'End'];
export const ICONS: Record<string, string> = {
  trigger: '▶', invoke: '⇄', assign: '=', map: '⇆', logger: '✎', note: '✱', wait: '⏱', stageFile: '🗎', switch: '◇', forEach: '↻',
  while: '⟳', scope: '▣', parallel: '⫴', throwFault: '⚠', rethrowFault: '↯', return: '■', faultReturn: '✖', stop: '⏹'
};

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** Every step list in the flow with its lane, for lookups and moves. */
export function lanes(flow: FlowDefinition): { lane: Lane; steps: FlowNode[]; owner: FlowNode | null; branch: FlowBranch | null }[] {
  const out: { lane: Lane; steps: FlowNode[]; owner: FlowNode | null; branch: FlowBranch | null }[] = [];
  const walk = (steps: FlowNode[], lane: Lane, owner: FlowNode | null, branch: FlowBranch | null) => {
    out.push({ lane, steps, owner, branch });
    for (const n of steps) for (const b of n.branches ?? []) walk(b.steps, { kind: 'branch', branchId: b.id }, n, b);
  };
  walk(flow.steps, { kind: 'root' }, null, null);
  walk(flow.globalFaultHandler, { kind: 'fault' }, null, null);
  return out;
}
export function stepsOf(flow: FlowDefinition, lane: Lane): FlowNode[] | null {
  return lanes(flow).find(l => laneKey(l.lane) === laneKey(lane))?.steps ?? null;
}
export function allNodes(flow: FlowDefinition): FlowNode[] {
  return [...(flow.trigger ? [flow.trigger] : []), ...lanes(flow).flatMap(l => l.steps)];
}
export function findNode(flow: FlowDefinition, id: string): FlowNode | null { return allNodes(flow).find(n => n.id === id) ?? null; }
export function locate(flow: FlowDefinition, id: string): { steps: FlowNode[]; index: number; lane: Lane } | null {
  for (const l of lanes(flow)) { const i = l.steps.findIndex(n => n.id === id); if (i >= 0) return { steps: l.steps, index: i, lane: l.lane }; }
  return null;
}
export function descendants(node: FlowNode): FlowNode[] {
  return (node.branches ?? []).flatMap(b => b.steps.flatMap(s => [s, ...descendants(s)]));
}

/** Unique IDs and identifier-style names (names are also output variables). */
export function uniqueId(flow: FlowDefinition, prefix = 'n'): string {
  const ids = new Set([...allNodes(flow).map(n => n.id), ...lanes(flow).filter(l => l.branch).map(l => l.branch!.id)]);
  let i = ids.size + 1; while (ids.has(prefix + i)) i++; return prefix + i;
}
export function uniqueName(flow: FlowDefinition, base: string): string {
  const names = new Set(allNodes(flow).map(n => n.name));
  const stem = base.replace(/[^A-Za-z0-9_]/g, '') || 'action';
  if (!names.has(stem)) return stem;
  let i = 2; while (names.has(stem + i)) i++; return stem + i;
}

const DEFAULT_CONFIG: Record<string, () => Record<string, any>> = {
  trigger: () => ({ mode: 'manual', parameters: [] }),
  invoke: () => ({ system: 'crm', table: 'customers', operation: 'get', key: '' }),
  assign: () => ({ assignments: [{ variable: '', expression: '' }] }),
  map: () => ({ input: '', targetSystem: 'erp', targetTable: '', rules: [] }),
  logger: () => ({ level: 'info', message: "'Checkpoint reached'" }),
  note: () => ({ text: 'Describe the business purpose of the next steps.' }),
  wait: () => ({ seconds: 5 }),
  stageFile: () => ({ operation: 'writeFile', fileName: 'export.xml', format: 'xml', rootElement: 'Records', recordElement: 'Record', input: '' }),
  forEach: () => ({ collection: '', itemVariable: 'item', maxItems: 100 }),
  while: () => ({ condition: '', maxIterations: 10 }),
  throwFault: () => ({ code: 'BusinessError', message: "'Describe the fault'" }),
  faultReturn: () => ({ code: 'FlowFailed', message: "'The flow failed'" }),
  return: () => ({}),
};
const BASE_NAME: Record<string, string> = {
  invoke: 'callApi', assign: 'assignValues', map: 'mapRecords', logger: 'logMessage', note: 'note', wait: 'pause', stageFile: 'stageFile',
  switch: 'decide', forEach: 'eachItem', while: 'repeat', scope: 'scope', parallel: 'parallel', throwFault: 'raiseFault',
  rethrowFault: 'rethrow', return: 'done', faultReturn: 'failed', stop: 'stop'
};

export function createNode(flow: FlowDefinition, def: ActionDef): FlowNode {
  const node: FlowNode = { id: uniqueId(flow), type: def.type, name: uniqueName(flow, BASE_NAME[def.type] ?? def.type), description: null,
    config: (DEFAULT_CONFIG[def.type] ?? (() => ({})))(), branches: [] };
  node.branches = def.branches.map(b => ({ id: newBranchId(), kind: b.kind, label: b.label, condition: b.kind === 'case' ? '' : null, steps: [] }));
  return node;
}
/** Branch IDs only need to be unique within the flow; a short random suffix avoids collisions with existing ones. */
export const newBranchId = () => 'b' + Math.random().toString(36).slice(2, 10);

/** Deep copy with fresh IDs and names, for paste and duplicate. */
export function cloneWithNewIds(flow: FlowDefinition, node: FlowNode): FlowNode {
  const copy = clone(node);
  const ids = new Set([...allNodes(flow).map(n => n.id), ...lanes(flow).filter(l => l.branch).map(l => l.branch!.id)]);
  const names = new Set(allNodes(flow).map(n => n.name));
  let counter = ids.size + 1;
  const fresh = (prefix: string) => { while (ids.has(prefix + counter)) counter++; const id = prefix + counter++; ids.add(id); return id; };
  const visit = (n: FlowNode) => {
    n.id = fresh('n');
    let name = n.name + 'Copy', i = 2; while (names.has(name)) name = n.name + 'Copy' + i++; names.add(name); n.name = name;
    for (const b of n.branches ?? []) { b.id = newBranchId(); b.steps.forEach(visit); }
  };
  visit(copy);
  return copy;
}

// ---------------------------------------------------------------- client-side scope (mirrors the server's rules)
export interface ScopeVar { name: string; kind: 'scalar' | 'record' | 'collection'; table?: TableView | null; system?: string; fields?: string[]; source: string }
export type TableFinder = (system: string, table: string) => TableView | null;

/** Variables visible just before `targetId`: what the properties panel offers in pickers and the expression builder. */
export function variablesBefore(flow: FlowDefinition, targetId: string, tables: TableFinder): ScopeVar[] {
  const result: ScopeVar[] = [];
  let found: ScopeVar[] | null = null;
  const trigger = flow.trigger;
  const base: ScopeVar[] = trigger ? [{ name: 'trigger', kind: 'record', fields: (trigger.config['parameters'] ?? []).map((p: any) => p.name).filter((n: string) => n), source: trigger.name }] : [];
  if (trigger?.id === targetId) return [];
  const walk = (steps: FlowNode[], scope: ScopeVar[]): void => {
    const local = [...scope];
    for (const n of steps) {
      if (found) return;
      if (n.id === targetId) { found = [...local]; return; }
      const c = n.config ?? {};
      for (const b of n.branches ?? []) {
        const inner = [...local];
        if (n.type === 'forEach' && b.kind === 'body') {
          const coll = local.find(v => v.name === String(c['collection'] ?? '').replace(/^\$/, ''));
          if (c['itemVariable']) inner.push({ name: c['itemVariable'], kind: 'record', table: coll?.table ?? null, system: coll?.system, fields: coll?.fields, source: n.name });
        }
        if (b.kind === 'faultHandler') inner.push({ name: 'fault', kind: 'record', fields: ['code', 'message', 'nodeId'], source: 'fault' });
        walk(b.steps, inner);
        if (found) return;
      }
      const define = (v: ScopeVar) => { const i = local.findIndex(x => x.name === v.name); if (i >= 0) local.splice(i, 1); local.push(v); };
      if (n.type === 'assign') for (const a of c['assignments'] ?? []) if (a.variable) define({ name: a.variable, kind: 'scalar', source: n.name });
      if (n.type === 'invoke' && c['system'] && c['table'])
        define({ name: n.name, kind: c['operation'] === 'list' ? 'collection' : 'record', table: tables(c['system'], c['table']), system: c['system'], source: n.name });
      if (n.type === 'map') {
        const input = local.find(v => v.name === c['input']);
        define({ name: n.name, kind: input?.kind === 'collection' ? 'collection' : 'record', table: c['targetSystem'] && c['targetTable'] ? tables(c['targetSystem'], c['targetTable']) : null, system: c['targetSystem'], source: n.name });
      }
      if (n.type === 'stageFile') define({ name: n.name, kind: c['operation'] === 'writeFile' ? 'record' : 'collection',
        fields: c['operation'] === 'writeFile' ? ['fileName', 'format', 'sizeBytes', 'records'] : c['operation'] === 'listFiles' ? ['fileName', 'format', 'sizeBytes', 'createdAt'] : undefined, source: n.name });
    }
    result.splice(0, result.length, ...local);
  };
  walk(flow.steps, base);
  if (!found) walk(flow.globalFaultHandler, [...base, { name: 'fault', kind: 'record', fields: ['code', 'message', 'nodeId'], source: 'fault' }]);
  return found ?? result;
}
export const fieldsOf = (v: ScopeVar): string[] => v.table?.columns.map((c: ColumnDef) => c.name) ?? v.fields ?? [];

/** Operations the backend allows per table (kept in sync with FlowValidator.Operations). */
export function operationsFor(system: string, table: TableView | null): string[] {
  if (!table) return [];
  if (table.builtIn) {
    if (system === 'erp' && table.name === 'customer_master') return ['list', 'get', 'upsert'];
    if (system === 'erp' && table.name === 'imported_orders') return ['list', 'get', 'create'];
    return ['list', 'get'];
  }
  return ['list', 'get', 'create', 'update'];
}
