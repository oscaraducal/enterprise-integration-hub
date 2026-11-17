import { test, expect, Page } from '@playwright/test';
import { loginToMonitoring as login, nav, appNav } from './helpers';
// Portfolio lab scenarios through the real UI and the real Legacy CRM, middleware and Modern ERP. Synthetic data only.
// Uses C-300 (seeded, not yet in ERP), plus C-610 / ORD-610 created here. Expects a fresh demo database.

const investigation = (page: Page) => page.getByRole('region', { name: 'Execution investigation' });
const dialog = (page: Page, name: string) => page.getByRole('dialog', { name });
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
/** Imports are initiated by the middleware: start one from the Integration Hub run console. */
async function runFromConsole(page: Page, kind: 'customer' | 'order', id: string) {
  if (await page.getByRole('dialog').count()) await page.keyboard.press('Escape');
  await nav(page, 'Executions');
  const console = page.getByRole('region', { name: 'Run an integration' });
  await console.getByLabel('Integration', { exact: true }).selectOption(kind === 'customer' ? 'CustomerSync' : 'SalesOrder');
  await console.getByLabel(kind === 'customer' ? 'Source customer' : 'Source order').selectOption(id);
  await console.getByRole('button', { name: 'Run integration' }).click();
}

test.describe.configure({ mode: 'serial' });

test('SCN-001: a CRM customer is created in the ERP and reconciles field by field', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await nav(page, 'Source System');
  await expect(page.getByRole('region', { name: 'Legacy CRM summary' })).toBeVisible(); // dashboard is the default screen
  await appNav(page, 'Legacy CRM', 'Customers');
  await page.getByRole('button', { name: 'Open customer C-300' }).click();
  const crm = dialog(page, 'Legacy CRM customer details');
  await expect(crm).toContainText('Original record.');
  await expect(crm.getByRole('button', { name: /Sync|Preview mapping|Run integration/ })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/readme-source-system.png' });
  await runFromConsole(page, 'customer', 'C-300');
  const panel = investigation(page);
  await expect(panel.locator('h2 .pill')).toHaveText('Completed', { timeout: 20000 });
  await expect(panel).toContainText('Modern ERP created customer C-300 from source version 1.');
  await expect(panel.getByLabel('Source record snapshot')).toContainText('"customerId": "C-300"');
  await expect(panel.getByLabel('Mapped ERP payload')).toContainText('"displayName": "Bluefin Fictional Outfitters"');
  await panel.screenshot({ path: 'test-results/readme-customer-sync.png' });
  await panel.getByRole('button', { name: 'Open imported record' }).click();
  const erp = dialog(page, 'Modern ERP customer details');
  await expect(erp).toContainText('Imported by the integration');
  await expect(erp).toContainText('buyer@bluefin-outfitters.example');
  await erp.getByRole('button', { name: 'Compare with source' }).click();
  await expect(erp.getByRole('region', { name: 'Reconciliation', exact: true })).toContainText('All fields match');
  await page.screenshot({ path: 'test-results/readme-target-system.png', fullPage: false });
  await erp.screenshot({ path: 'test-results/readme-reconciliation.png' });
});

test('SCN-002: an order for an unsynchronized customer fails clearly, then succeeds after SCN-001 and a safe retry', async ({ page }) => {
  await login(page);
  await nav(page, 'Source System');
  // Create a new source customer and an order for it through the CRM forms.
  await appNav(page, 'Legacy CRM', 'Customers');
  await page.getByRole('button', { name: '+ New customer' }).click();
  const form = dialog(page, 'Customer form');
  await form.getByLabel('Customer ID').fill('C-610');
  await form.getByLabel('Customer name').fill('Juniper Demo Imports');
  await form.getByLabel('Email').fill('Orders@Juniper-Demo.example');
  await form.getByLabel('Phone').fill('+63 (2) 8555-0610');
  await form.getByRole('button', { name: 'Create customer' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Customer C-610 created' })).toBeVisible();
  await expect(dialog(page, 'Legacy CRM customer details')).toContainText('Juniper Demo Imports');
  await page.keyboard.press('Escape');
  await appNav(page, 'Legacy CRM', 'Sales Orders');
  await page.getByRole('button', { name: '+ New order' }).click();
  const orderForm = dialog(page, 'Order form');
  await orderForm.getByLabel('Order ID').fill('ORD-610');
  await orderForm.getByLabel('Customer', { exact: true }).selectOption('C-610');
  await orderForm.getByLabel('Currency').fill('PHP');
  await orderForm.getByLabel('Amount').fill('2500.75');
  await orderForm.getByRole('button', { name: 'Create order' }).click();
  await expect(dialog(page, 'Legacy CRM order details')).toContainText('ORD-610');
  await runFromConsole(page, 'order', 'ORD-610');
  const panel = investigation(page);
  await expect(panel.locator('h2 .pill')).toHaveText('Failed', { timeout: 20000 });
  await expect(panel.locator('.alert.error')).toContainText('MissingCustomer');
  await expect(panel.locator('.alert.error')).toContainText('failed at: Target delivery');
  await expect(panel.locator('.alert.error')).toContainText('SCN-001');
  await panel.screenshot({ path: 'test-results/readme-missing-customer.png' });
  const failedId = await panel.locator('.execution-id').innerText();
  await panel.getByRole('button', { name: 'Open source record' }).click();
  await expect(dialog(page, 'Legacy CRM order details')).toContainText('C-610');
  // Prerequisite: synchronize the customer, then retry the same execution.
  await runFromConsole(page, 'customer', 'C-610');
  await expect(investigation(page).locator('h2 .pill')).toHaveText('Completed', { timeout: 20000 });
  await page.getByLabel('Search execution ID').fill('ORD-610');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: 'Inspect ORD-610' }).click();
  await expect(investigation(page).locator('.execution-id')).toHaveText(failedId);
  await investigation(page).getByRole('button', { name: 'Safely retry execution' }).click();
  await expect(investigation(page).locator('h2 .pill')).toHaveText('Completed', { timeout: 20000 });
  await investigation(page).getByRole('button', { name: 'Open imported record' }).click();
  const erpOrder = dialog(page, 'Modern ERP imported order details');
  await expect(erpOrder).toContainText('250075');
  await expect(erpOrder).toContainText('C-610');
  await erpOrder.getByRole('button', { name: 'Compare with source' }).click();
  await expect(erpOrder.getByRole('region', { name: 'Reconciliation', exact: true })).toContainText('All fields match');
});

test('SCN-003: editing a CRM customer creates a revision and an audited ERP update; re-sync is Unchanged', async ({ page }) => {
  await login(page);
  await nav(page, 'Source System');
  await appNav(page, 'Legacy CRM', 'Customers');
  await page.getByRole('button', { name: 'Open customer C-300' }).click();
  await dialog(page, 'Legacy CRM customer details').getByRole('button', { name: 'Edit', exact: true }).click();
  const form = dialog(page, 'Customer form');
  await form.getByLabel('Email').fill('accounts@bluefin-outfitters.example');
  await form.getByLabel('Status').selectOption('OnHold');
  await form.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'now version 2' })).toBeVisible();
  await expect(dialog(page, 'Legacy CRM customer details').locator('table.diff')).toContainText('accounts@bluefin-outfitters.example');
  await runFromConsole(page, 'customer', 'C-300');
  await expect(investigation(page).locator('h2 .pill')).toHaveText('Completed', { timeout: 20000 });
  await expect(investigation(page)).toContainText('updated C-300 from source version 2: emailAddress, accountStatus');
  await investigation(page).getByRole('button', { name: 'Open imported record' }).click();
  const erp = dialog(page, 'Modern ERP customer details');
  await expect(erp.locator('.timeline li').first()).toContainText('Updated');
  await expect(erp.locator('.timeline li').first().locator('table.diff')).toContainText('BLOCKED');
  await erp.screenshot({ path: 'test-results/readme-update-history.png' });
  // Same version again: no change, no duplicate.
  await runFromConsole(page, 'customer', 'C-300');
  await expect(investigation(page)).toContainText('already held identical data for C-300', { timeout: 20000 });
});

test('Legacy CRM and Modern ERP are dashboard-based applications with tables, schemas and API explorers', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await nav(page, 'Source System');
  const summary = page.getByRole('region', { name: 'Legacy CRM summary' });
  await expect(summary).toContainText('Customers');
  await page.screenshot({ path: 'test-results/readme-crm-dashboard.png' });
  // No integration controls anywhere in the source application.
  for (const screen of ['Dashboard', 'Customers', 'Sales Orders']) {
    await appNav(page, 'Legacy CRM', screen);
    await expect(page.getByRole('button', { name: /Sync to Modern ERP|Preview mapping|Run integration/ })).toHaveCount(0);
  }
  // Searchable, paginated orders.
  await page.getByLabel('Search Sales orders').fill('ORD-013');
  await expect(page.getByRole('button', { name: /^Open order / })).toHaveCount(1);
  await page.getByLabel('Search Sales orders').fill('');
  await expect(page.getByRole('navigation', { name: 'Sales orders pages' })).toContainText('Page 1 of 2');
  await page.getByRole('navigation', { name: 'Sales orders pages' }).getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('navigation', { name: 'Sales orders pages' })).toContainText('Page 2 of 2');
  // Schema catalog and record browser.
  await appNav(page, 'Legacy CRM', 'Data Tables');
  await expect(page.getByRole('region', { name: 'Schema of customers' })).toContainText('customerId');
  await page.getByRole('button', { name: 'Open customers record C-100' }).click();
  await expect(dialog(page, 'Record C-100')).toContainText('customerName');
  await page.keyboard.press('Escape');
  // API Explorer calls the gateway, read-only.
  await appNav(page, 'Legacy CRM', 'API Explorer');
  await page.getByRole('button', { name: /GET\s*\/api\/orders\/\{id\}/ }).click();
  await page.getByLabel('id', { exact: true }).fill('ORD-013');
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByLabel('Response body')).toContainText('"customerId": "C-300"');
  await page.screenshot({ path: 'test-results/readme-crm-api-explorer.png' });

  await nav(page, 'Target System');
  await expect(page.getByRole('region', { name: 'Modern ERP summary' })).toContainText('Imported orders');
  await page.screenshot({ path: 'test-results/readme-erp-dashboard.png' });
  await appNav(page, 'Modern ERP', 'Imported Data');
  await page.getByLabel('Search Imported records').fill('C-300');
  await page.getByRole('button', { name: 'Open imported customer C-300' }).click();
  await expect(dialog(page, 'Modern ERP customer details')).toContainText('Imported by the integration');
  await page.keyboard.press('Escape');
  await appNav(page, 'Modern ERP', 'Import History');
  await page.getByLabel('Search Import history').fill('C-300');
  await page.getByRole('button', { name: /^Open history entry / }).first().click();
  await expect(dialog(page, 'Import history entry')).toContainText('C-300');
  await page.keyboard.press('Escape');
  await appNav(page, 'Modern ERP', 'Data Tables');
  await page.getByRole('button', { name: /imported_orders/ }).click();
  await expect(page.getByRole('region', { name: 'Schema of imported_orders' })).toContainText('totalMinorUnits');
});

test('Mapping Studio previews without side effects and explains validation errors', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await nav(page, 'Mapping Studio');
  await page.getByLabel('Source record', { exact: true }).selectOption('C-400');
  await page.getByRole('button', { name: 'Preview mapping' }).click();
  await expect(page.locator('.map-error')).toContainText('Email is required');
  await expect(page.getByLabel('Mapped target JSON')).toContainText('Not produced');
  await expect(page.getByRole('button', { name: 'Run this integration' })).toHaveCount(0);
  await page.getByLabel('Mapping', { exact: true }).selectOption('sales-order');
  await page.getByLabel('Source record', { exact: true }).selectOption('ORD-013');
  await page.getByRole('button', { name: 'Preview mapping' }).click();
  await expect(page.getByLabel('Mapped target JSON')).toContainText('"totalMinorUnits": 41025');
  await page.screenshot({ path: 'test-results/readme-mapping-studio.png', fullPage: true });
  // Preview created nothing: ORD-013 has no execution.
  await nav(page, 'Executions');
  await page.getByLabel('Search execution ID').fill('ORD-013');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText('No matching executions')).toBeVisible();
});

test('Viewer can explore every lab page but cannot change data', async ({ page }) => {
  await login(page, 'viewer');
  await nav(page, 'Source System');
  await appNav(page, 'Legacy CRM', 'Customers');
  await expect(page.getByRole('button', { name: '+ New customer' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open customer C-100' }).click();
  await expect(dialog(page, 'Legacy CRM customer details')).toContainText('Revision history');
  await expect(dialog(page, 'Legacy CRM customer details').getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await nav(page, 'Target System');
  await appNav(page, 'Modern ERP', 'Customer Master');
  await page.getByRole('button', { name: 'Open ERP account C-100' }).click();
  await expect(dialog(page, 'Modern ERP customer details')).toContainText('Migrated fixture');
  await expect(page.getByRole('button', { name: 'Edit fixture' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await nav(page, 'Executions');
  await expect(page.getByRole('region', { name: 'Run an integration' })).toHaveCount(0);
  await nav(page, 'Mapping Studio');
  await page.getByRole('button', { name: 'Preview mapping' }).click();
  await expect(page.getByRole('button', { name: 'Run this integration' })).toHaveCount(0);
});

test('Scenario catalog and guides link straight to the right records', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await nav(page, 'Scenarios');
  await expect(page.getByRole('article', { name: 'SCN-004 Retail Item Master Integration' })).toContainText('Planned');
  await expect(page.getByRole('article', { name: 'SCN-002 Sales Order Integration' })).toContainText('Implemented');
  await page.screenshot({ path: 'test-results/readme-scenarios.png' });
  await page.getByRole('article', { name: 'SCN-002 Sales Order Integration' }).getByRole('button', { name: 'Open guide' }).click();
  await expect(page.getByRole('heading', { name: 'Sales Order Integration' })).toBeVisible();
  await page.getByRole('button', { name: 'Open ORD-013 →' }).click();
  await expect(dialog(page, 'Legacy CRM order details')).toContainText('ORD-013');
  await page.keyboard.press('Escape');
  await nav(page, 'Guides');
  await page.getByRole('tab', { name: 'SCN-002' }).click();
  await page.getByRole('button', { name: 'Run ORD-014 →' }).click();
  const console = page.getByRole('region', { name: 'Run an integration' });
  await expect(console.getByLabel('Integration', { exact: true })).toHaveValue('SalesOrder');
  await expect(console.getByLabel('Source order')).toHaveValue('ORD-014');
});

test('Lab pages fit a 390px phone without page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  for (const name of ['Source System', 'Scenarios', 'Mapping Studio', 'Target System', 'Guides']) {
    await nav(page, name);
    await page.waitForTimeout(400);
    expect(await noOverflow(page), name).toBe(true);
  }
  for (const [view, app, screens] of [['Source System', 'Legacy CRM', ['Customers', 'Sales Orders', 'Data Tables', 'API Explorer']],
    ['Target System', 'Modern ERP', ['Customer Master', 'Sales Orders', 'Imported Data', 'Import History', 'Data Tables', 'API Explorer']]] as const) {
    await nav(page, view);
    for (const screen of screens) {
      await appNav(page, app, screen);
      await page.waitForTimeout(250);
      expect(await noOverflow(page), `${app} ${screen}`).toBe(true);
    }
  }
  await appNav(page, 'Modern ERP', 'Customer Master');
  await page.getByRole('button', { name: 'Open ERP account C-100' }).click();
  await expect(dialog(page, 'Modern ERP customer details')).toBeVisible();
  expect(await noOverflow(page)).toBe(true);
  await page.keyboard.press('Escape');
  await nav(page, 'Mapping Studio');
  await page.getByRole('button', { name: 'Preview mapping' }).click();
  await expect(page.getByLabel('Mapped target JSON')).not.toContainText('Click Preview');
  expect(await noOverflow(page)).toBe(true);
  await page.screenshot({ path: 'test-results/readme-mobile-mapping.png', fullPage: true });
});
