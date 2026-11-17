/** Thin contract the feature pages use to talk to the middleware through the shell's authenticated request(). */
export interface Api {
  request<T>(path: string, method?: string, body?: unknown): Promise<T>;
  operator(): boolean;
}
/** Raised once a 401 has already ended the session, so callers do not show a second error. */
export class SessionEnded extends Error {}
/** HTTP failure with the parsed body, so pages can show field-level validation errors or open a conflicting execution. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: any) { super(message); }
  /** ASP.NET validation problem → { field: [messages] }. */
  get fieldErrors(): Record<string, string[]> { return this.body?.errors ?? {}; }
}
export type View = 'Overview' | 'Source System' | 'Scenarios' | 'Integration Designer' | 'Mapping Studio' | 'Target System' | 'Executions' | 'Workloads' | 'Guides';
export type RecordKind = 'customer' | 'order';
/** Cross-page navigation request, e.g. "open customer C-300 in the Mapping Studio". */
export interface Focus {
  view: View; kind?: RecordKind; id?: string; scenario?: string;
  /** Screen inside a business application, e.g. 'Sales Orders' in the Legacy CRM. */
  section?: string;
  /** Pre-fill the middleware's run console with kind/id instead of opening the record. */
  run?: boolean;
}
export function errorText(e: unknown): string {
  if (e instanceof ApiError && Object.keys(e.fieldErrors).length)
    return Object.entries(e.fieldErrors).map(([f, m]) => `${f}: ${m.join(' ')}`).join(' · ');
  return e instanceof Error ? e.message : 'Unable to reach the simulator.';
}
