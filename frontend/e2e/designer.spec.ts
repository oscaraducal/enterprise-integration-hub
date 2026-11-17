import { test, expect, Page } from '@playwright/test';
// Milestone C: Integration Designer through the real UI and API. Creates only new flow designs; nothing executes.

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
const status = (page: Page) => page.getByRole('toolbar', { name: 'Designer toolbar' });
const problems = (page: Page) => page.getByRole('region', { name: 'Designer panel' });
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test.describe.configure({ mode: 'serial' });

test('Create a flow from a template, edit it with undo/redo, drag actions in, validate, save and publish', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await login(page);
  await nav(page, 'Integration Designer');
  await page.getByRole('button', { name: 'Create your first flow' }).click();
  const dialog = page.getByRole('dialog', { name: 'New flow' });
  await expect(dialog.getByLabel('Start from')).toHaveValue('customer-sync');
  await dialog.getByRole('button', { name: 'Create flow' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'created as a draft' })).toBeVisible();
  for (const name of ['Trigger start', 'Invoke readCustomer', 'Switch checkEmail', 'Throw New Fault missingEmail', 'Map mapCustomer', 'Invoke upsertCustomer', 'Return done', 'Fault Return failed'])
    await expect(node(page, name)).toBeVisible();
  await expect(status(page).getByRole('status').filter({ hasText: /^Valid$/ })).toBeVisible();
  await page.screenshot({ path: 'test-results/readme-designer.png' });

  // Edit a property, then undo and redo it.
  await node(page, 'Logger logResult').click();
  await props(page).getByLabel('Action name').fill('logDelivery');
  await expect(node(page, 'Logger logDelivery')).toBeVisible();
  await expect(status(page)).toContainText('Unsaved changes');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(node(page, 'Logger logResult')).toBeVisible();
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect(node(page, 'Logger logDelivery')).toBeVisible();

  // Drag a Wait from the palette into the main flow; an invalid value is reported on the action and in Problems.
  await page.getByRole('button', { name: 'Add Wait' }).dragTo(page.locator('[data-slot="root@1"]'));
  await expect(node(page, 'Wait pause')).toBeVisible();
  await props(page).getByLabel('Seconds').fill('0');
  await expect(node(page, 'Wait pause')).toHaveAccessibleName(/1 error/);
  await problems(page).getByRole('tab', { name: /Problems/ }).click();
  await expect(problems(page)).toContainText('Wait 1 to 60 seconds');
  await props(page).getByLabel('Seconds').fill('3');
  await expect(status(page).getByRole('status').filter({ hasText: /^Valid$/ })).toBeVisible();

  // Copy, paste, move and delete.
  await page.getByRole('button', { name: 'Copy action' }).click();
  await page.getByRole('button', { name: 'Paste action' }).click();
  await expect(node(page, 'Wait pauseCopy')).toBeVisible();
  await page.getByRole('button', { name: 'Move action up' }).click();
  await page.getByRole('button', { name: 'Delete action' }).click();
  await expect(node(page, 'Wait pauseCopy')).toHaveCount(0);

  // Click-to-insert: a Logger after the selected action, then a planned action is not available.
  await node(page, 'Wait pause').click();
  await page.getByRole('button', { name: 'Add Logger' }).click();
  await expect(node(page, 'Logger logMessage')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Planned: B2B' })).toBeDisabled();

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Draft saved (revision 2)' })).toBeVisible();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Published version 1' })).toBeVisible();
  await expect(problems(page)).toContainText('v1');
});

test('Field mapper: drag a source field onto a target field, preview and apply', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await login(page);
  await nav(page, 'Integration Designer');
  await node(page, 'Map mapCustomer').click();
  await props(page).getByRole('button', { name: 'Open field mapper' }).click();
  const mapper = page.getByRole('dialog', { name: 'Field mapper' });
  await expect(mapper).toContainText('crm.customers');
  await mapper.getByRole('button', { name: 'Remove mapping for contactNumber' }).click();
  await expect(mapper.getByRole('button', { name: /Target field contactNumber.*not mapped/ })).toBeVisible();
  await mapper.getByRole('button', { name: /^Source field phone/ }).dragTo(mapper.locator('[data-target="contactNumber"]'));
  await expect(mapper.getByRole('button', { name: /Target field contactNumber.*mapped from Trim\(phone\)/ })).toBeVisible();
  // Keyboard/click alternative: pick a source, then a target.
  await mapper.getByRole('button', { name: 'Remove mapping for displayName' }).click();
  await mapper.getByRole('button', { name: /^Source field customerName/ }).click();
  await mapper.getByRole('button', { name: /^Target field displayName/ }).click();
  await expect(mapper.getByRole('button', { name: /Target field displayName.*mapped from Trim\(customerName\)/ })).toBeVisible();
  await mapper.getByRole('button', { name: 'Validate' }).click();
  await expect(mapper.getByRole('status')).toContainText('Valid');
  await mapper.getByRole('button', { name: 'Preview' }).click();
  await expect(mapper.locator('[data-target="accountStatus"]')).toContainText('→ "ACTIVE"');
  await expect(mapper.locator('svg.mapper-lines path')).toHaveCount(5);
  await page.screenshot({ path: 'test-results/readme-field-mapper.png' });
  await mapper.getByRole('button', { name: 'Apply to action' }).click();
  await expect(mapper).toHaveCount(0);
  await expect(props(page)).toContainText('5 field rule(s)');
  await expect(status(page)).toContainText('Unsaved changes');
});

test('Nested logic, search, collapse, zoom, expression builder and export', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await login(page);
  await nav(page, 'Integration Designer');
  await page.getByRole('button', { name: '+ New flow' }).click();
  const dialog = page.getByRole('dialog', { name: 'New flow' });
  await dialog.getByLabel('Name (URL-safe)').fill('order-review');
  await dialog.getByLabel('Title').fill('Order review');
  await dialog.getByLabel('Start from').selectOption('order-review');
  await dialog.getByRole('button', { name: 'Create flow' }).click();
  await expect(node(page, 'For Each eachOrder')).toBeVisible();
  await expect(node(page, 'Logger logReady')).toBeVisible();
  await page.getByLabel('Search actions').fill('logUnsupported');
  await expect(page.getByRole('toolbar', { name: 'Designer toolbar' })).toContainText('1 match');
  await page.getByRole('button', { name: 'Collapse eachOrder' }).click();
  await expect(node(page, 'Logger logReady')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Expand eachOrder' })).toContainText('3 inside');
  await page.getByRole('button', { name: 'Expand eachOrder' }).click();
  await page.getByRole('button', { name: 'Zoom out' }).click();
  await expect(page.getByRole('button', { name: 'Reset zoom' })).toHaveText('90%');
  await page.getByRole('button', { name: 'Fit to screen' }).click();

  // Expression builder: insert a variable field and check the syntax on the server.
  await node(page, 'Logger logReady').click();
  await props(page).getByRole('button', { name: 'Expression builder for Message' }).click();
  await props(page).getByLabel('Message', { exact: true }).fill('');
  await props(page).getByRole('button', { name: '.currency' }).click();
  await expect(props(page).getByLabel('Message', { exact: true })).toHaveValue('$order.currency');
  await props(page).getByRole('button', { name: 'Check syntax' }).click();
  await expect(props(page).getByRole('status').filter({ hasText: 'Syntax OK' })).toBeVisible();
  // A variable from outside its scope is reported.
  await node(page, 'Logger logSummary').click();
  await props(page).getByLabel('Message', { exact: true }).fill('$order.id');
  await expect(problems(page)).toContainText('unknown variable $order');
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'It is valid and can be published' })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export' }).click();
  expect((await download).suggestedFilename()).toBe('order-review-draft.eih-flow.json');
  await page.screenshot({ path: 'test-results/readme-designer-logic.png' });
});

test('Viewers can open designs but not change them, and the designer fits a phone', async ({ page }) => {
  await login(page, 'viewer');
  await nav(page, 'Integration Designer');
  await expect(node(page, 'Trigger start')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save draft' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '+ New flow' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add Logger' })).toBeDisabled();
  await node(page, 'Invoke readCustomer').click();
  await expect(props(page).getByLabel('Action name')).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  expect(await noOverflow(page)).toBe(true);
});

test('Designer guides are listed as Design only and open the Integration Designer', async ({ page }) => {
  await login(page);
  await nav(page, 'Scenarios');
  const card = page.getByRole('article', { name: 'DSN-001 Design the customer master flow' });
  await expect(card).toContainText('Design only');
  await card.getByRole('button', { name: 'Open guide' }).click();
  await expect(page.getByRole('heading', { name: 'Design the customer master flow' })).toBeVisible();
  for (const id of ['DSN-002', 'DSN-003']) await expect(page.getByRole('tab', { name: id })).toBeVisible();
  await page.getByRole('button', { name: 'Open Designer →' }).first().click();
  await expect(page.getByRole('heading', { name: 'Integration Designer', exact: true })).toBeVisible();
});
