import { test, expect, Page, Locator } from '@playwright/test';
import { login, nav, appNav, switchWorkspace } from './helpers';
// Milestone C.2: three application workspaces, the Integration Workbench (overview, Integrations, Connections), the
// full-screen Designer with back navigation and kept drafts, and the anchored Add action popup. Runs after
// workbench.spec.ts, which creates the connections and the "Account Sync" integration. Nothing here executes a flow.

const node = (page: Page, label: string) => page.getByRole('button', { name: new RegExp('^' + label) });
const slot = (page: Page, where: string) => page.getByRole('button', { name: 'Insert action at ' + where, exact: true });
const picker = (page: Page) => page.getByRole('dialog', { name: 'Add action' });
const header = (page: Page) => page.getByRole('region', { name: 'Integration header' });
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const COPY = 'Account Sync (copy)';

/** Records every request that could run an integration or change ERP/CRM data. */
function watchWrites(page: Page) {
  const writes: string[] = [];
  page.on('request', r => {
    const url = new URL(r.url()).pathname;
    if (r.method() !== 'GET' && /^\/api\/(executions|jobs|target|source|erp|crm)\b/.test(url)) writes.push(`${r.method()} ${url}`);
  });
  return writes;
}
async function openIntegration(page: Page, title: string) {
  await nav(page, 'Integrations');
  await page.getByRole('button', { name: 'Open designer for ' + title, exact: true }).click();
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
}
/** Bounding boxes of every action card on the canvas, to prove the popup never moves the flow. */
const boxes = (page: Page) => page.locator('.canvas .node-head').evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; }));
const canvasSize = (page: Page) => page.locator('.canvas').evaluate(e => [e.scrollWidth, e.scrollHeight]);
async function box(l: Locator) { const b = await l.boundingBox(); expect(b).not.toBeNull(); return b!; }

test.describe.configure({ mode: 'serial' });

test('Three workspaces: switcher, dedicated navigation, meaningful URLs and back/forward', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await expect(page).toHaveURL(/\/workbench$/);
  const switcher = page.getByRole('navigation', { name: 'Workspaces' });
  await expect(switcher.getByRole('button', { name: 'Integration Workbench' })).toHaveAttribute('aria-current', 'page');
  const wb = page.getByRole('navigation', { name: 'Integration Workbench navigation' });
  for (const item of ['Overview', 'Integrations', 'Connections', 'Mappings', 'Monitoring', 'Guides']) await expect(wb.getByRole('button', { name: item, exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/readme-workbench-overview.png' });

  // Legacy CRM shows only source-system screens: no integration authoring.
  await switchWorkspace(page, 'Legacy CRM');
  await expect(page).toHaveURL(/\/crm$/);
  await expect(switcher.getByRole('button', { name: 'Legacy CRM' })).toHaveAttribute('aria-current', 'page');
  await expect(wb).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Action palette' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '+ Create connection' })).toHaveCount(0);
  await appNav(page, 'Legacy CRM', 'Customers');
  await expect(page).toHaveURL(/\/crm\/customers$/);
  await expect(page.getByRole('navigation', { name: 'Legacy CRM navigation' }).getByRole('button', { name: 'Customers' })).toHaveAttribute('aria-current', 'page');

  // Modern ERP likewise.
  await switchWorkspace(page, 'Modern ERP');
  await expect(page).toHaveURL(/\/erp$/);
  await expect(page.getByRole('navigation', { name: 'Modern ERP navigation' }).getByRole('button', { name: 'Customer Master' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Legacy CRM navigation' })).toHaveCount(0);

  // Browser back and forward restore workspace and screen.
  await page.goBack();
  await expect(page).toHaveURL(/\/crm\/customers$/);
  await expect(page.getByRole('heading', { name: 'Legacy CRM', level: 1 })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Legacy CRM navigation' }).getByRole('button', { name: 'Customers' })).toHaveAttribute('aria-current', 'page');
  await page.goForward();
  await expect(page).toHaveURL(/\/erp$/);
  await expect(page.getByRole('heading', { name: 'Modern ERP', level: 1 })).toBeVisible();

  // Workbench pages have their own URLs.
  await nav(page, 'Connections'); await expect(page).toHaveURL(/\/workbench\/connections$/);
  await nav(page, 'Mappings'); await expect(page).toHaveURL(/\/workbench\/mappings$/);
  await nav(page, 'Monitoring'); await expect(page).toHaveURL(/\/workbench\/monitoring$/);
  await page.getByRole('navigation', { name: 'Monitoring sections' }).getByRole('button', { name: 'Workloads' }).click();
  await expect(page).toHaveURL(/\/workbench\/monitoring\/workloads$/);
  await expect(wb.getByRole('button', { name: 'Monitoring' })).toHaveAttribute('aria-current', 'page');
});

test('Workbench overview: integration-focused summary and actions, no invented runtime data', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  const summary = page.getByRole('region', { name: 'Integration development summary' });
  await expect(summary).toContainText('Integrations');
  await expect(summary).toContainText('Connections');
  await expect(page.getByRole('region', { name: 'Recent integration designs' })).toContainText('Account Sync');
  await expect(page.getByRole('region', { name: 'Connection health' })).toContainText('LEGACY_CRM_REST');
  await expect(page.getByRole('region', { name: 'Validation problems' })).toContainText('Account Sync');
  await expect(page.getByRole('region', { name: 'Recent executions' })).toContainText('not executed until Milestone D');
  await expect(page.getByRole('region', { name: 'What works in this release' })).toContainText('Planned');
  // Quick actions open the right page and wizard.
  await page.getByRole('region', { name: 'Quick actions' }).getByRole('button', { name: /Create connection/ }).click();
  await expect(page).toHaveURL(/\/workbench\/connections\?new=1$/);
  await expect(page.getByRole('dialog', { name: 'Create connection' })).toBeVisible();
  await page.keyboard.press('Escape');
  await nav(page, 'Overview');
  await page.getByRole('region', { name: 'Recent integration designs' }).getByRole('button', { name: 'Open Account Sync in the Designer' }).click();
  await expect(page).toHaveURL(/\/workbench\/integrations\/account-sync$/);
  await expect(page.getByRole('heading', { name: 'Account Sync', level: 1 })).toBeVisible();
});

test('Integrations list: search, filters, details and versions, duplicate, open and back', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await nav(page, 'Integrations');
  const table = page.getByRole('region', { name: 'Integrations table, scrolls horizontally' });
  await expect(table).toContainText('Customer Sync');
  await expect(table).toContainText('ACCOUNT_SYNC');
  await page.getByLabel('Search integrations').fill('account');
  await expect(table.getByRole('row')).toHaveCount(2); // header + Account Sync
  await page.getByLabel('Search integrations').fill('');
  await page.getByLabel('Status filter').selectOption('published');
  await expect(table).toContainText('Customer Sync');
  await expect(table).not.toContainText('ACCOUNT_SYNC');
  await page.getByLabel('Status filter').selectOption('');
  await page.getByLabel('Validation filter').selectOption('invalid');
  await expect(table).toContainText('ACCOUNT_SYNC');
  await expect(table).not.toContainText('CUSTOMER_SYNC');
  await page.getByLabel('Validation filter').selectOption('');
  await page.screenshot({ path: 'test-results/readme-integrations.png' });

  await page.getByRole('button', { name: 'Details of Customer Sync' }).click();
  const details = page.getByRole('dialog', { name: 'Integration details' });
  await expect(details.getByRole('list', { name: 'Version history' })).toContainText('v1');
  await details.getByRole('button', { name: 'Close', exact: true }).click();

  await page.getByRole('button', { name: 'Duplicate Account Sync', exact: true }).click();
  const dup = page.getByRole('dialog', { name: 'Duplicate integration' });
  await expect(dup.getByLabel('Duplicate identifier')).toHaveValue('ACCOUNT_SYNC_COPY');
  await dup.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'The original is unchanged' })).toBeVisible();
  await expect(table).toContainText('ACCOUNT_SYNC_COPY');

  await page.getByRole('button', { name: 'Open designer for ' + COPY, exact: true }).click();
  await expect(page).toHaveURL(/\/workbench\/integrations\/account-sync-copy$/);
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(COPY);
  await expect(page.getByRole('navigation', { name: 'Integration Workbench navigation' })).toHaveCount(0); // full-screen Designer
  await page.getByRole('button', { name: 'Back to Integrations' }).click();
  await expect(page).toHaveURL(/\/workbench\/integrations$/);
});

test('Add action popup floats over the canvas without moving nodes, in nested lanes and both layouts', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const writes = watchWrites(page);
  await login(page);
  await openIntegration(page, COPY);
  await page.getByRole('radiogroup', { name: 'Layout' }).getByRole('radio', { name: 'Vertical' }).click();

  // Vertical: the popup opens beside the +, outside the canvas, and nothing on the canvas moves or resizes.
  const before = await boxes(page), size = await canvasSize(page);
  const plus = slot(page, 'main flow, position 1');
  await plus.click();
  await expect(picker(page)).toBeVisible();
  await expect(page.locator('.canvas .picker')).toHaveCount(0);
  expect(await boxes(page)).toEqual(before);
  expect(await canvasSize(page)).toEqual(size);
  const p = await box(picker(page)), a = await box(plus);
  expect(p.width).toBeGreaterThanOrEqual(320); expect(p.width).toBeLessThanOrEqual(380);
  expect(p.x).toBeGreaterThanOrEqual(a.x + a.width - 1);          // to the right of the +
  expect(p.x + p.width).toBeLessThanOrEqual(1600); expect(p.y + p.height).toBeLessThanOrEqual(1000);
  for (const t of ['Suggestions', 'Invokes', 'Actions']) await expect(picker(page).getByRole('tab', { name: t })).toBeVisible();
  await expect(picker(page).getByLabel('Search actions and connections')).toBeFocused();
  await page.screenshot({ path: 'test-results/readme-workbench-popup.png' });

  // Escape closes it and returns focus to the +.
  await page.keyboard.press('Escape');
  await expect(picker(page)).toHaveCount(0);
  await expect(plus).toBeFocused();

  // One popup at a time; clicking outside closes it.
  await plus.click();
  await slot(page, 'main flow, position 2').click();
  await expect(picker(page)).toHaveCount(1);
  await expect(picker(page)).toContainText('main flow, position 2');
  await page.getByRole('heading', { name: COPY, level: 1 }).click();
  await expect(picker(page)).toHaveCount(0);

  // Keyboard: open with Enter, search, arrow to the result and insert exactly one action at that slot.
  await plus.focus(); await page.keyboard.press('Enter');
  await expect(picker(page).getByLabel('Search actions and connections')).toBeFocused();
  await page.keyboard.type('logger');
  await expect(picker(page).getByRole('tab', { name: 'Suggestions' })).toHaveCount(0); // searching spans every category
  await page.keyboard.press('ArrowDown');
  await expect(picker(page).getByRole('button', { name: 'Logger', exact: true })).toBeFocused();
  const count = await page.locator('.canvas .node').count();
  await page.keyboard.press('Enter');
  await expect(picker(page)).toHaveCount(0);
  await expect(page.locator('.canvas .node')).toHaveCount(count + 1);
  await expect(node(page, 'Logger logMessage')).toBeFocused();
  await expect(page.getByRole('complementary', { name: 'Properties' }).getByRole('heading', { name: 'logMessage' })).toBeVisible();
  const order = await page.locator('.canvas .flow-line > ol.seq > li > .node .node-head b').allInnerTexts();
  expect(order.slice(0, 2)).toEqual(['logMessage', 'callApi']); // inserted first, before the existing Invoke

  // Nested lane: an Assign goes inside the Scope body, not after it.
  await slot(page, 'Scope, position 1').click();
  await picker(page).getByRole('tab', { name: 'Actions' }).click();
  await picker(page).getByRole('button', { name: 'Assign', exact: true }).click();
  await expect(page.locator('.node.type-scope').getByRole('button', { name: /^Assign / })).toHaveCount(1);
  // Unavailable actions say why.
  await slot(page, 'main flow, position 1').click();
  await picker(page).getByLabel('Search actions and connections').fill('return');
  await expect(picker(page).getByRole('button', { name: 'Return (unavailable)', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');

  // Horizontal: the popup opens below the +, still without moving anything; it also stays anchored when zoomed.
  await page.getByRole('radiogroup', { name: 'Layout' }).getByRole('radio', { name: 'Horizontal' }).click();
  await page.getByRole('button', { name: 'Zoom out' }).click();
  const hPlus = slot(page, 'main flow, position 2');
  await hPlus.scrollIntoViewIfNeeded();                          // clicking would otherwise scroll the canvas itself
  await page.waitForTimeout(300);                                // let the zoom transition settle before measuring
  const hBefore = await boxes(page);
  await hPlus.click();
  const hp = await box(picker(page)), ha = await box(hPlus);
  expect(hp.y).toBeGreaterThanOrEqual(ha.y + ha.height - 1);
  expect(Math.abs((hp.x + hp.width / 2) - (ha.x + ha.width / 2))).toBeLessThan(hp.width / 2 + 1);
  expect(await boxes(page)).toEqual(hBefore);
  await page.screenshot({ path: 'test-results/readme-workbench-popup-horizontal.png' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Reset zoom' }).click();

  // Outline lists every action with type, connection, operation, schema, mapping and validation.
  await page.getByRole('radiogroup', { name: 'Layout' }).getByRole('radio', { name: 'Outline' }).click();
  const outline = page.getByRole('tree', { name: 'Flow outline' });
  await expect(outline).toContainText('logMessage');
  await expect(outline).toContainText('LEGACY_CRM_REST · GET /customers/{customerId}');
  await page.getByRole('radiogroup', { name: 'Layout' }).getByRole('radio', { name: 'Vertical' }).click();
  await expect(header(page)).toContainText('Unsaved changes');
  expect(writes).toEqual([]);
});

test('Unsaved changes: leaving asks first, kept changes survive a visit to Connections, then save', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const writes = watchWrites(page);
  await login(page);
  await openIntegration(page, COPY);
  await slot(page, 'main flow, position 1').click();
  await picker(page).getByLabel('Search actions and connections').fill('note');
  await picker(page).getByRole('button', { name: 'Note', exact: true }).click();
  await expect(header(page)).toContainText('Unsaved changes');

  // Switching workspace asks; Stay keeps the Designer open.
  await switchWorkspace(page, 'Legacy CRM');
  const leave = page.getByRole('dialog', { name: 'Leave the Designer' });
  await leave.getByRole('button', { name: 'Stay' }).click();
  await expect(page).toHaveURL(/\/workbench\/integrations\/account-sync-copy$/);
  await expect(node(page, 'Note note')).toBeVisible();

  // Keep the changes, configure connections, come back: they are restored.
  await page.getByRole('button', { name: 'Back to Integrations' }).click();
  await leave.getByRole('button', { name: 'Keep changes for later' }).click();
  await expect(page).toHaveURL(/\/workbench\/integrations$/);
  await nav(page, 'Connections');
  await expect(page.getByRole('region', { name: 'Connections table, scrolls horizontally' })).toContainText('LEGACY_CRM_REST');
  await openIntegration(page, COPY);
  await expect(page.getByRole('status').filter({ hasText: 'Restored the unsaved changes' })).toBeVisible();
  await expect(node(page, 'Note note')).toBeVisible();
  await expect(header(page)).toContainText('Unsaved changes');

  // Save and leave stores a new draft revision.
  await page.getByRole('button', { name: 'Back to Integrations' }).click();
  await leave.getByRole('button', { name: 'Save draft and leave' }).click();
  await expect(page).toHaveURL(/\/workbench\/integrations$/);
  await openIntegration(page, COPY);
  await expect(node(page, 'Note note')).toBeVisible();
  await expect(header(page)).toContainText('Saved · rev 2');
  // Saved designs leave without a question.
  await page.getByRole('button', { name: 'Back to Integrations' }).click();
  await expect(page).toHaveURL(/\/workbench\/integrations$/);
  expect(writes).toEqual([]);
});

test('Phones: workspace switcher, navigation drawer, Integrations and a bottom-sheet Add action popup', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  expect(await noOverflow(page)).toBe(true);
  await page.screenshot({ path: 'test-results/readme-mobile-workbench.png', fullPage: true });
  await nav(page, 'Integrations');
  await expect(page.getByRole('region', { name: 'Integrations table, scrolls horizontally' })).toContainText('ACCOUNT_SYNC');
  expect(await noOverflow(page)).toBe(true);
  await nav(page, 'Connections');
  expect(await noOverflow(page)).toBe(true);
  await openIntegration(page, COPY);
  expect(await noOverflow(page)).toBe(true);
  await slot(page, 'main flow, position 1').click();
  const sheet = await box(picker(page));
  expect(Math.round(sheet.y + sheet.height)).toBeGreaterThanOrEqual(843);
  expect(sheet.width).toBeGreaterThanOrEqual(388);
  await page.screenshot({ path: 'test-results/readme-mobile-popup.png' });
  await page.keyboard.press('Escape');
  await expect(picker(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to Integrations' }).click();
  await switchWorkspace(page, 'Legacy CRM');
  await appNav(page, 'Legacy CRM', 'Sales Orders');
  await expect(page).toHaveURL(/\/crm\/sales-orders$/);
  expect(await noOverflow(page)).toBe(true);
});
