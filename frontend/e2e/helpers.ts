import { expect, Page } from '@playwright/test';
// Shared navigation for the three application workspaces (Legacy CRM, Integration Workbench, Modern ERP).

/** Signs in; the console opens on the Integration Workbench home (resource cards). */
export async function login(page: Page, user = 'operator') {
  await page.goto('/');
  await page.getByLabel('Demo account').selectOption(user);
  await page.getByLabel('Password', { exact: true }).fill(process.env['DEMO_PASSWORD']!);
  await page.getByRole('button', { name: 'Sign in to console' }).click();
  await expect(page.getByRole('heading', { name: 'Integration Workbench', level: 1 })).toBeVisible();
}
/** Signs in and opens Monitoring (execution metrics, run console and history). */
export async function loginToMonitoring(page: Page, user = 'operator') {
  await login(page, user);
  await nav(page, 'Executions');
  await expect(page.getByRole('heading', { name: 'Monitoring', level: 1 })).toBeVisible();
}

/** Page names used by the specs → workspace and Integration Workbench navigation item. */
const PAGES: Record<string, [workspace: string, item: string | null]> = {
  'Source System': ['Legacy CRM', null],
  'Target System': ['Modern ERP', null],
  'Overview': ['Integration Workbench', 'Home'],
  'Home': ['Integration Workbench', 'Home'],
  'Projects': ['Integration Workbench', 'Projects'],
  'Integrations': ['Integration Workbench', 'Integrations'],
  'Integration Designer': ['Integration Workbench', 'Integrations'],
  'Connections': ['Integration Workbench', 'Connections'],
  'Mapping Studio': ['Integration Workbench', 'Mappings'],
  'Mappings': ['Integration Workbench', 'Mappings'],
  'Executions': ['Integration Workbench', 'Monitoring'],
  'Monitoring': ['Integration Workbench', 'Monitoring'],
  'Scenarios': ['Integration Workbench', 'Guides'],
  'Guides': ['Integration Workbench', 'Guides'],
};
export const switchWorkspace = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name, exact: true }).click();
/** Opens the drawer on phones, where the workspace sidebar is hidden behind the menu button. */
async function sidebar(page: Page, label: string) {
  const nav = page.getByRole('navigation', { name: label });
  await nav.waitFor({ state: 'attached' });                       // the workspace has rendered (and its menu button, on phones)
  const toggle = page.getByRole('button', { name: 'Toggle workspace navigation' });
  if (await toggle.isVisible() && (await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  return nav;
}
export async function nav(page: Page, name: string) {
  const [workspace, item] = PAGES[name] ?? ['Integration Workbench', name];
  await switchWorkspace(page, workspace);
  if (item) await (await sidebar(page, 'Integration Workbench navigation')).getByRole('button', { name: item, exact: true }).click();
  if (name === 'Guides') await page.getByRole('navigation', { name: 'Guide sections' }).getByRole('button', { name: 'Step-by-step guides' }).click();
}
/** Screen inside the Legacy CRM or Modern ERP application (its workspace sidebar). */
export async function appNav(page: Page, app: 'Legacy CRM' | 'Modern ERP', name: string) {
  await (await sidebar(page, app + ' navigation')).getByRole('button', { name, exact: true }).click();
}
