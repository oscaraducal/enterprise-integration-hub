import { test, expect, Page } from '@playwright/test';
// Portfolio lab scenarios through the real UI and the real Legacy CRM, middleware and Modern ERP. Synthetic data only.
// Uses C-300 (seeded, not yet in ERP), plus C-610 / ORD-610 created here. Expects a fresh demo database.

async function login(page: Page, user = 'operator') {
  await page.goto('/');
  await page.getByLabel('Demo account').selectOption(user);
  await page.getByLabel('Password', { exact: true }).fill(process.env['DEMO_PASSWORD']!);
  await page.getByRole('button', { name: 'Sign in to console' }).click();
  await expect(page.getByRole('heading', { name: 'Operations overview' })).toBeVisible();
}
const nav = (page: Page, name: string) => page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name, exact: true }).click();
const investigation = (page: Page) => page.getByRole('region', { name: 'Execution investigation' });
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test.describe.configure({ mode: 'serial' });

test('SCN-001: a CRM customer is created in the ERP and reconciles field by field', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await nav(page, 'Source System');
  await expect(page.getByRole('heading', { name: 'Legacy CRM', exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Open customer C-300' }).click();
  const crm = page.getByRole('region', { name: 'Legacy CRM customer details' });
  await expect(crm).toContainText('Original record.');
  await page.screenshot({ path: 'test-results/readme-source-system.png' });
  await crm.getByRole('button', { name: 'Sync to Modern ERP' }).click();
  const panel = investigation(page);
  await expect(panel.locator('h2 .pill')).toHaveText('Completed', { timeout: 20000 });
  await expect(panel).toContainText('Modern ERP created customer C-300 from source version 1.');
  await expect(panel.getByLabel('Source record snapshot')).toContainText('"customerId": "C-300"');
  await expect(panel.getByLabel('Mapped ERP payload')).toContainText('"displayName": "Bluefin Fictional Outfitters"');
  await panel.screenshot({ path: 'test-results/readme-customer-sync.png' });
  await panel.getByRole('button', { name: 'Open imported record' }).click();
  const erp = page.getByRole('region', { name: 'Modern ERP customer details' });
  await expect(erp).toContainText('Imported by the integration');
  await expect(erp).toContainText('buyer@bluefin-outfitters.example');
  await erp.getByRole('button', { name: 'Compare with source' }).click();
  await expect(erp.getByRole('region', { name: 'Reconciliation', exact: true })).toContainText('All fields match');
  await erp.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/readme-target-system.png', fullPage: false });
  await erp.screenshot({ path: 'test-results/readme-reconciliation.png' });
});

test('SCN-002: an order for an unsynchronized customer fails clearly, then succeeds after SCN-001 and a safe retry', async ({ page }) => {
  await login(page);
  await nav(page, 'Source System');
  // Create a new source customer and an order for it through the CRM UI.
  await page.getByRole('button', { name: '+ New customer' }).click();
  const form = page.getByRole('region', { name: 'Customer form' });
  await form.getByLabel('Customer ID').fill('C-610');
  await form.getByLabel('Customer name').fill('Juniper Demo Imports');
  await form.getByLabel('Email').fill('Orders@Juniper-Demo.example');
  await form.getByLabel('Phone').fill('+63 (2) 8555-0610');
  await form.getByRole('button', { name: 'Create customer' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Customer C-610 created' })).toBeVisible();
  await page.getByRole('tab', { name: 'Sales orders' }).click();
  await page.getByRole('button', { name: '+ New order' }).click();
  const orderForm = page.getByRole('region', { name: 'Order form' });
  await orderForm.getByLabel('Order ID').fill('ORD-610');
  await orderForm.getByLabel('Customer', { exact: true }).selectOption('C-610');
  await orderForm.getByLabel('Currency').fill('PHP');
  await orderForm.getByLabel('Amount').fill('2500.75');
  await orderForm.getByRole('button', { name: 'Create order' }).click();
  const crmOrder = page.getByRole('region', { name: 'Legacy CRM order details' });
  await expect(crmOrder).toContainText('ORD-610');
  await crmOrder.getByRole('button', { name: 'Run integration', exact: true }).click();
  const panel = investigation(page);
  await expect(panel.locator('h2 .pill')).toHaveText('Failed', { timeout: 20000 });
  await expect(panel.locator('.alert.error')).toContainText('MissingCustomer');
  await expect(panel.locator('.alert.error')).toContainText('failed at: Target delivery');
  await expect(panel.locator('.alert.error')).toContainText('SCN-001');
  await panel.screenshot({ path: 'test-results/readme-missing-customer.png' });
  const failedUrl = await panel.locator('.execution-id').innerText();
  // Prerequisite: synchronize the customer, then retry the same execution.
  await panel.getByRole('button', { name: 'Open source record' }).click();
  await page.getByRole('tab', { name: 'Customers' }).click();
  await page.getByRole('button', { name: 'Open customer C-610' }).click();
  await page.getByRole('region', { name: 'Legacy CRM customer details' }).getByRole('button', { name: 'Sync to Modern ERP' }).click();
  await expect(investigation(page).locator('h2 .pill')).toHaveText('Completed', { timeout: 20000 });
  await page.getByLabel('Search execution ID').fill('ORD-610');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: 'Inspect ORD-610' }).click();
  await expect(investigation(page).locator('.execution-id')).toHaveText(failedUrl);
  await investigation(page).getByRole('button', { name: 'Safely retry execution' }).click();
  await expect(investigation(page).locator('h2 .pill')).toHaveText('Completed', { timeout: 20000 });
  await investigation(page).getByRole('button', { name: 'Open imported record' }).click();
  const erpOrder = page.getByRole('region', { name: 'Modern ERP imported order details' });
  await expect(erpOrder).toContainText('250075');
  await expect(erpOrder).toContainText('C-610');
  await erpOrder.getByRole('button', { name: 'Compare with source' }).click();
  await expect(erpOrder.getByRole('region', { name: 'Reconciliation', exact: true })).toContainText('All fields match');
});

test('SCN-003: editing a CRM customer creates a revision and an audited ERP update; re-sync is Unchanged', async ({ page }) => {
  await login(page);
  await nav(page, 'Source System');
  await page.getByRole('button', { name: 'Open customer C-300' }).click();
  const crm = page.getByRole('region', { name: 'Legacy CRM customer details' });
  await crm.getByRole('button', { name: 'Edit', exact: true }).click();
  const form = page.getByRole('region', { name: 'Customer form' });
  await form.getByLabel('Email').fill('accounts@bluefin-outfitters.example');
  await form.getByLabel('Status').selectOption('OnHold');
  await form.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'now version 2' })).toBeVisible();
  await expect(crm.locator('table.diff')).toContainText('accounts@bluefin-outfitters.example');
  await crm.getByRole('button', { name: 'Sync to Modern ERP' }).click();
  await expect(investigation(page).locator('h2 .pill')).toHaveText('Completed', { timeout: 20000 });
  await expect(investigation(page)).toContainText('updated C-300 from source version 2: emailAddress, accountStatus');
  await investigation(page).getByRole('button', { name: 'Open imported record' }).click();
  const erp = page.getByRole('region', { name: 'Modern ERP customer details' });
  await expect(erp.locator('.timeline li').first()).toContainText('Updated');
  await expect(erp.locator('.timeline li').first().locator('table.diff')).toContainText('BLOCKED');
  await erp.screenshot({ path: 'test-results/readme-update-history.png' });
  // Same version again: no change, no duplicate.
  await erp.getByRole('button', { name: 'Open source record' }).click();
  await page.getByRole('region', { name: 'Legacy CRM customer details' }).getByRole('button', { name: 'Sync to Modern ERP' }).click();
  await expect(investigation(page)).toContainText('already held identical data for C-300', { timeout: 20000 });
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
  await page.getByRole('button', { name: 'Open customer C-100' }).click();
  await expect(page.getByRole('button', { name: '+ New customer' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sync to Modern ERP' })).toHaveCount(0);
  await nav(page, 'Target System');
  await page.getByRole('button', { name: 'Open ERP account C-100' }).click();
  await expect(page.getByRole('region', { name: 'Modern ERP customer details' })).toContainText('Migrated fixture');
  await expect(page.getByRole('button', { name: 'Edit fixture' })).toHaveCount(0);
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
  await expect(page.getByRole('region', { name: 'Legacy CRM order details' })).toContainText('ORD-013');
});

test('Lab pages fit a 390px phone without page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  for (const name of ['Source System', 'Scenarios', 'Mapping Studio', 'Target System', 'Guides']) {
    await nav(page, name);
    await page.waitForTimeout(400);
    expect(await noOverflow(page), name).toBe(true);
  }
  await nav(page, 'Mapping Studio');
  await page.getByRole('button', { name: 'Preview mapping' }).click();
  await expect(page.getByLabel('Mapped target JSON')).not.toContainText('Click Preview');
  expect(await noOverflow(page)).toBe(true);
  await page.screenshot({ path: 'test-results/readme-mobile-mapping.png', fullPage: true });
});
