import { test, expect, Page } from '@playwright/test';
// Milestone C.1: Connections, blank integrations, endpoint wizards, context-aware mapping points, inline + insertion,
// Vertical/Horizontal/Outline layouts and schedule design. Designing never executes anything.

async function login(page: Page, user = 'operator') {
  await page.goto('/');
  await page.getByLabel('Demo account').selectOption(user);
  await page.getByLabel('Password', { exact: true }).fill(process.env['DEMO_PASSWORD']!);
  await page.getByRole('button', { name: 'Sign in to console' }).click();
  await expect(page.getByRole('heading', { name: 'Operations overview' })).toBeVisible();
}
const nav = (page: Page, name: string) => page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name, exact: true }).click();
const node = (page: Page, label: string) => page.getByRole('button', { name: new RegExp('^' + label) });
const props = (page: Page) => page.getByRole('complementary', { name: 'Properties' });
const problems = (page: Page) => page.getByRole('region', { name: 'Designer panel' });
const slot = (page: Page, where: string) => page.getByRole('button', { name: 'Insert action at ' + where, exact: true });
const picker = (page: Page) => page.getByRole('dialog', { name: /^Insert action at/ });

async function createConnection(page: Page, name: string, role: RegExp, app: string, test = true) {
  await page.getByRole('button', { name: '+ Create connection' }).click();
  const w = page.getByRole('dialog', { name: 'Create connection' });
  await w.getByLabel('Connection name').fill(name);
  await w.getByRole('button', { name: 'Next' }).click();                         // → Adapter (REST only)
  await expect(w.getByRole('radio', { name: /^SOAP/ })).toBeDisabled();
  await w.getByRole('button', { name: 'Next' }).click();                         // → Role
  await w.getByRole('radio', { name: role }).click();
  await w.getByRole('button', { name: 'Next' }).click();                         // → Application
  await w.getByRole('radio', { name: app, exact: true }).click();
  for (let i = 0; i < 4; i++) await w.getByRole('button', { name: 'Next' }).click(); // Operations, Schemas, Security → Test
  if (test) { await w.getByRole('button', { name: 'Test connection' }).click(); await expect(w.getByRole('status')).toContainText('Connection test passed'); }
  await w.getByRole('button', { name: 'Next' }).click();                         // → Save
  await w.getByRole('button', { name: 'Save connection' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'saved' })).toBeVisible();
}
async function newIntegration(page: Page, type: RegExp, name: string) {
  await page.getByRole('button', { name: /New integration|Create your first integration/ }).first().click();
  const w = page.getByRole('dialog', { name: 'New integration' });
  await w.getByRole('radio', { name: type }).click();
  await w.getByRole('button', { name: 'Next' }).click();
  await w.getByLabel('Integration name').fill(name);
  await w.getByRole('button', { name: 'Next' }).click();
  await w.getByRole('button', { name: 'Create', exact: true }).click();
}
async function wizardNext(page: Page, name: string, times = 1) {
  for (let i = 0; i < times; i++) await page.getByRole('dialog', { name }).getByRole('button', { name: 'Next' }).click();
}

test.describe.configure({ mode: 'serial' });

test('Connection Manager: wizard, safe test, operations and roles', async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 950 });
  await login(page);
  await nav(page, 'Connections');
  await createConnection(page, 'Legacy CRM REST', /^Invoke/, 'Legacy CRM');
  await createConnection(page, 'Modern ERP REST', /^Invoke/, 'Modern ERP');
  // A Trigger connection: applications that cannot start integrations are disabled with a reason.
  await page.getByRole('button', { name: '+ Create connection' }).click();
  const w = page.getByRole('dialog', { name: 'Create connection' });
  await w.getByLabel('Connection name').fill('Hub REST Trigger');
  await wizardNext(page, 'Create connection', 2);
  await w.getByRole('radio', { name: /^Trigger Starts/ }).click();
  await wizardNext(page, 'Create connection');
  await expect(w.getByRole('radio', { name: 'Legacy CRM (not available for this role)' })).toBeDisabled();
  await w.getByRole('radio', { name: 'Integration Hub REST trigger', exact: true }).click();
  await wizardNext(page, 'Create connection', 5);
  await w.getByRole('button', { name: 'Save connection' }).click();
  const table = page.getByRole('region', { name: 'Connections table, scrolls horizontally' });
  for (const id of ['LEGACY_CRM_REST', 'MODERN_ERP_REST', 'HUB_REST_TRIGGER']) await expect(table).toContainText(id);
  await expect(table).toContainText('Configured');
  await page.getByRole('button', { name: 'Open connection MODERN_ERP_REST' }).click();
  const detail = page.getByRole('dialog', { name: 'Connection details' });
  await expect(detail.getByRole('region', { name: /Operations table/ })).toContainText('/customer_master/{accountCode}');
  await expect(detail).not.toContainText('http://');
  await page.screenshot({ path: 'test-results/readme-connections.png' });
  await page.keyboard.press('Escape');
  await expect(detail).toHaveCount(0);
});

test('A new Application integration starts blank; configure the trigger and add invokes with +', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await login(page);
  await nav(page, 'Integration Designer');
  await newIntegration(page, /^Application/, 'Account Sync');
  await expect(page.getByRole('status').filter({ hasText: 'empty canvas' })).toBeVisible();
  // Only the Start trigger and one + insertion point: no generated business actions.
  await expect(page.locator('.canvas .node')).toHaveCount(1);
  await expect(slot(page, 'main flow, position 1')).toBeVisible();
  await expect(problems(page)).toContainText('Configure the Start trigger');
  await page.screenshot({ path: 'test-results/readme-blank-integration.png' });

  // Application trigger endpoint wizard.
  await page.getByRole('button', { name: 'Configure trigger…' }).first().click();
  const tw = page.getByRole('dialog', { name: 'Trigger endpoint wizard' });
  await tw.getByRole('radio', { name: 'Hub REST Trigger', exact: true }).click();
  await wizardNext(page, 'Trigger endpoint wizard');
  await tw.getByLabel('Endpoint name').fill('syncAccount');
  await wizardNext(page, 'Trigger endpoint wizard');
  await tw.getByLabel('Internal path').fill('/accounts/{customerId}');
  await expect(tw.getByLabel('Parameter 1 name')).toHaveValue('customerId');
  await wizardNext(page, 'Trigger endpoint wizard');
  await tw.getByLabel('Configure a request schema').check();
  await wizardNext(page, 'Trigger endpoint wizard');
  await tw.getByLabel('Configure a response schema').check();
  await tw.getByLabel('response application').selectOption('erp');
  await tw.getByLabel('response table').selectOption('customer_master');
  await wizardNext(page, 'Trigger endpoint wizard');
  await expect(tw).toContainText('POST /accounts/{customerId}');
  await tw.getByRole('button', { name: 'Finish' }).click();
  await expect(problems(page)).not.toContainText('Configure the Start trigger');

  // + → Connections / Invokes: a GET operation inserts an Invoke without a mapping.
  await slot(page, 'main flow, position 1').click();
  await picker(page).getByRole('tab', { name: 'Connections / Invokes' }).click();
  await picker(page).getByRole('button', { name: 'Invoke Legacy CRM REST' }).click();
  const iw = page.getByRole('dialog', { name: 'Invoke endpoint wizard' });
  await expect(iw.getByRole('radio', { name: 'Legacy CRM REST' })).toHaveAttribute('aria-checked', 'true');
  await wizardNext(page, 'Invoke endpoint wizard');
  // Built-in CRM tables are read-only; POST exists only if a logical CRM table was created (e.g. by the catalog tests).
  const post = iw.getByRole('radio', { name: /^POST/ });
  if (await post.isEnabled()) {
    await post.click(); await wizardNext(page, 'Invoke endpoint wizard');
    await expect(iw.getByRole('radio', { name: 'POST /customers' })).toHaveCount(0);
    await iw.getByRole('button', { name: 'Back' }).click();
  } else await expect(post).toBeDisabled();
  await iw.getByRole('radio', { name: /^GET/ }).click();
  await wizardNext(page, 'Invoke endpoint wizard');
  await iw.getByRole('radio', { name: 'GET /customers/{customerId}' }).click();
  await wizardNext(page, 'Invoke endpoint wizard', 3);
  await iw.getByLabel('Path parameter {customerId}', { exact: true }).fill('$trigger.customerId');
  await wizardNext(page, 'Invoke endpoint wizard');
  await expect(iw).toContainText('No request mapping needed.');
  await iw.getByRole('button', { name: 'Finish' }).click();
  await expect(node(page, 'Invoke callApi')).toBeVisible();
  await expect(page.locator('.canvas .node.type-map')).toHaveCount(0);

  // A body operation adds an unconfigured request mapping directly before the Invoke.
  await slot(page, 'main flow, position 2').click();
  await picker(page).getByRole('tab', { name: 'Connections / Invokes' }).click();
  await picker(page).getByRole('button', { name: 'Invoke Modern ERP REST' }).click();
  await wizardNext(page, 'Invoke endpoint wizard');
  await page.getByRole('dialog', { name: 'Invoke endpoint wizard' }).getByRole('radio', { name: /^PUT/ }).click();
  await wizardNext(page, 'Invoke endpoint wizard');
  await page.getByRole('dialog', { name: 'Invoke endpoint wizard' }).getByRole('radio', { name: 'PUT /customer_master/{accountCode}' }).click();
  await wizardNext(page, 'Invoke endpoint wizard', 4);
  await page.getByRole('dialog', { name: 'Invoke endpoint wizard' }).getByRole('button', { name: 'Finish' }).click();
  await expect(node(page, 'Map mapCallApi2Request')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'unconfigured request mapping' })).toBeVisible();
  await expect(problems(page)).toContainText('not configured yet');
  await node(page, 'Map mapCallApi2Request').click();
  await expect(props(page)).toContainText('Request mapping');
  await expect(props(page).getByLabel('Target table')).toBeDisabled();
  await expect(props(page).getByLabel('Target table')).toHaveValue('customer_master');

  // Changing the operation never deletes the mapping: confirm, keep it, and see it flagged.
  await node(page, 'Invoke callApi2').click();
  await props(page).getByRole('button', { name: 'Edit endpoint…' }).click();
  await wizardNext(page, 'Invoke endpoint wizard');
  await page.getByRole('dialog', { name: 'Invoke endpoint wizard' }).getByRole('radio', { name: /^GET/ }).click();
  await wizardNext(page, 'Invoke endpoint wizard');
  await page.getByRole('dialog', { name: 'Invoke endpoint wizard' }).getByRole('radio', { name: 'GET /customer_master/{accountCode}' }).click();
  await wizardNext(page, 'Invoke endpoint wizard', 4);
  await page.getByRole('dialog', { name: 'Invoke endpoint wizard' }).getByRole('button', { name: 'Finish' }).click();
  const impact = page.getByRole('dialog', { name: 'Mapping impact' });
  await expect(impact).toContainText('sends no request body');
  await impact.getByRole('button', { name: 'Apply and keep the mapping for review' }).click();
  await expect(node(page, 'Map mapCallApi2Request')).toBeVisible();
  await expect(problems(page)).toContainText('no longer sends a request body');
  await page.screenshot({ path: 'test-results/readme-mapping-points.png' });

  // Nested +: Scope, then Re-throw only inside its fault handler; End actions only at the end of a path.
  await slot(page, 'main flow, position 4').click();
  await picker(page).getByRole('tab', { name: 'Logic' }).click();
  await picker(page).getByRole('button', { name: 'Scope', exact: true }).click();
  await slot(page, 'main flow, position 1').click();
  await picker(page).getByRole('tab', { name: 'Error Handling' }).click();
  await expect(picker(page).getByRole('button', { name: 'Re-throw Fault (unavailable)' })).toBeDisabled();
  await picker(page).getByRole('tab', { name: 'End Actions' }).click();
  await expect(picker(page).getByRole('button', { name: 'Return (unavailable)', exact: true })).toBeDisabled();
  await picker(page).getByRole('button', { name: 'Close action picker' }).click();
  await slot(page, 'Fault handler, position 1').click();
  await picker(page).getByRole('tab', { name: 'Error Handling' }).click();
  await picker(page).getByRole('button', { name: 'Re-throw Fault', exact: true }).click();
  await expect(node(page, 'Re-throw Fault rethrow')).toBeVisible();
  await expect(problems(page)).not.toContainText('only valid inside a fault handler');

  // Incomplete drafts save; publishing waits for a valid graph.
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Draft saved' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
});

test('Vertical, Horizontal and Outline layouts present the same flow and the choice is remembered', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await login(page);
  await nav(page, 'Integration Designer');
  await page.getByLabel('Flow', { exact: true }).selectOption('account-sync');
  await problems(page).getByRole('tab', { name: 'JSON' }).click();
  const before = await problems(page).getByLabel('Flow JSON').innerText();
  const layout = page.getByRole('radiogroup', { name: 'Layout' });
  await layout.getByRole('radio', { name: 'Horizontal' }).click();
  await expect(page.locator('.canvas.horizontal')).toBeVisible();
  await page.screenshot({ path: 'test-results/readme-layout-horizontal.png' });
  await layout.getByRole('radio', { name: 'Outline' }).click();
  const outline = page.getByRole('tree', { name: 'Flow outline' });
  await expect(outline).toContainText('LEGACY_CRM_REST · GET /customers/{customerId}');
  await expect(outline).toContainText('Request mapping');
  await expect(outline).toContainText('Unconfigured');
  await outline.getByRole('button', { name: 'Collapse scope' }).click();
  await expect(outline.getByRole('button', { name: /^Outline Re-throw Fault/ })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/readme-layout-outline.png' });
  expect(await problems(page).getByLabel('Flow JSON').innerText()).toBe(before); // presentation never changes the definition
  await expect(page.getByRole('toolbar', { name: 'Designer toolbar' })).toContainText('Saved'); // and is not a draft change
  // The preference is per viewer and survives a new session.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await login(page);
  await nav(page, 'Integration Designer');
  await expect(page.getByRole('radiogroup', { name: 'Layout' }).getByRole('radio', { name: 'Outline' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('radiogroup', { name: 'Layout' }).getByRole('radio', { name: 'Vertical' }).click();
});

test('Scheduled integration: design-time schedule properties', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await login(page);
  await nav(page, 'Integration Designer');
  await newIntegration(page, /^Scheduled/, 'Nightly Review');
  await expect(page.locator('.canvas .node')).toHaveCount(1);
  await node(page, 'Trigger start').click();
  await expect(props(page)).toContainText('Scheduled');
  await props(page).getByLabel('Frequency').selectOption('weekly');
  await props(page).getByLabel('Run time').fill('06:30');
  await props(page).getByLabel('MON', { exact: true }).check();
  await props(page).getByLabel('Time zone').fill('Asia/Manila');
  await props(page).getByRole('button', { name: '+ Parameter' }).click();
  await props(page).getByLabel('Parameter 1 name').fill('batchSize');
  await props(page).getByLabel('Parameter 1 type').selectOption('integer');
  await problems(page).getByRole('tab', { name: /Problems/ }).click();
  await expect(problems(page)).toContainText('design-time only');
  await expect(problems(page)).not.toContainText('weekdays');
  await expect(problems(page)).not.toContainText('time zone');
});

test('Viewers can inspect connections and designs but not change them', async ({ page }) => {
  await login(page, 'viewer');
  await nav(page, 'Connections');
  await expect(page.getByRole('button', { name: '+ Create connection' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open connection LEGACY_CRM_REST' }).click();
  const details = page.getByRole('dialog', { name: 'Connection details' });
  await expect(details).toContainText('LEGACY_CRM_REST'); // wait until it has loaded before asserting absence or closing it
  await expect(details.getByRole('button', { name: 'Test' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(details).toHaveCount(0);
  await nav(page, 'Integration Designer');
  await page.getByLabel('Flow', { exact: true }).selectOption('account-sync');
  await expect(page.getByRole('button', { name: /^Insert action at/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Configure trigger…' })).toHaveCount(0);
});
