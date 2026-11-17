import { test, expect, Page } from '@playwright/test';
// Milestone B: Dynamic Data Catalog and schema mapper through the real UI, middleware gateway and CRM/ERP catalogs.
// Creates only new logical tables (crm_contacts, erp_vendor_accounts) and mapping definitions; built-in demo data is untouched.

async function login(page: Page, user = 'operator') {
  await page.goto('/');
  await page.getByLabel('Demo account').selectOption(user);
  await page.getByLabel('Password', { exact: true }).fill(process.env['DEMO_PASSWORD']!);
  await page.getByRole('button', { name: 'Sign in to console' }).click();
  await expect(page.getByRole('heading', { name: 'Operations overview' })).toBeVisible();
}
const nav = (page: Page, name: string) => page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name, exact: true }).click();
const appNav = (page: Page, app: 'Legacy CRM' | 'Modern ERP', name: string) =>
  page.getByRole('navigation', { name: app + ' navigation' }).getByRole('button', { name, exact: true }).click();
const dialog = (page: Page, name: string) => page.getByRole('dialog', { name });
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const mappingRow = (page: Page, target: string) => page.getByRole('row', { name: 'Mapping for ' + target });

test.describe.configure({ mode: 'serial' });

test('Operators create a logical table, manage validated records and apply safe schema changes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await nav(page, 'Source System');
  await appNav(page, 'Legacy CRM', 'Data Tables');
  await expect(page.getByRole('region', { name: 'Schema of customers' })).toContainText('customerId');
  await page.getByRole('button', { name: 'Use sample schema' }).click();
  const create = dialog(page, 'New table form');
  await expect(create.getByLabel('Table name')).toHaveValue('crm_contacts');
  await create.getByRole('button', { name: 'Create table' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Logical table crm_contacts created' })).toBeVisible();
  const schema = page.getByRole('region', { name: 'Schema of crm_contacts' });
  await expect(schema).toContainText('LOGICAL TABLE · SCHEMA VERSION 1');

  // A record that breaks the schema is refused field by field, then fixed.
  await page.getByRole('button', { name: '+ New record' }).click();
  const form = dialog(page, 'Record form');
  await form.getByLabel('contactId *').fill('P-001');
  await form.getByLabel('customerId *').fill('C-300');
  await form.getByRole('button', { name: 'Create record' }).click();
  await expect(form.locator('.field-error')).toContainText(['fullName: This field is required.']);
  await form.getByLabel('fullName *').fill('Mara Bluefin');
  await form.getByLabel('role *').selectOption('Buyer');
  await form.getByLabel('email').fill('mara@bluefin-outfitters.example');
  await form.getByRole('button', { name: 'Create record' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Record P-001 saved' })).toBeVisible();
  const records = page.getByRole('region', { name: 'Records in crm_contacts' });
  await expect(records).toContainText('Mara Bluefin');
  await records.getByRole('button', { name: 'Edit crm_contacts record P-001' }).click();
  await dialog(page, 'Record form').getByLabel('role *').selectOption('Finance');
  await dialog(page, 'Record form').getByRole('button', { name: 'Save record' }).click();
  await expect(records).toContainText('Finance');

  // Approved schema operations; data in use is protected.
  await schema.getByLabel('New column').fill('region');
  await schema.getByRole('button', { name: 'Add column' }).click();
  await expect(schema).toContainText('SCHEMA VERSION 2');
  await schema.getByRole('button', { name: 'Remove column email' }).click();
  await expect(page.getByRole('alert')).toContainText('have a value for \'email\'');
  await page.getByRole('button', { name: 'Dismiss error' }).click();
  await schema.getByRole('button', { name: 'Remove column region' }).click();
  await expect(schema).toContainText('SCHEMA VERSION 3');
  await schema.getByRole('tab', { name: 'History' }).click();
  await expect(schema).toContainText('Removed unused column region');
  await schema.getByRole('tab', { name: 'REST contract' }).click();
  await expect(schema.getByLabel('Generated REST contract')).toContainText('/api/catalog/tables/crm_contacts/records/{key}');
  await page.screenshot({ path: 'test-results/readme-data-catalog.png' });

  // Generated routes are discoverable in the API Explorer.
  await appNav(page, 'Legacy CRM', 'API Explorer');
  await page.getByRole('button', { name: /GET\s*\/api\/catalog\/tables\/crm_contacts\/records\{?/ }).first().click();
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByLabel('Response body')).toContainText('"contactId": "P-001"');

  // The ERP has its own catalog.
  await nav(page, 'Target System');
  await appNav(page, 'Modern ERP', 'Data Tables');
  await page.getByRole('button', { name: 'Use sample schema' }).click();
  await dialog(page, 'New table form').getByRole('button', { name: 'Create table' }).click();
  await expect(page.getByRole('region', { name: 'Schema of erp_vendor_accounts' })).toContainText('paymentTermsDays');
});

test('Schema mapper suggests, validates, previews and saves versioned mappings without executing them', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await nav(page, 'Mapping Studio');
  await page.getByRole('tab', { name: 'Schema mapper (Data Catalog)' }).click();
  await expect(page.getByLabel('Source table')).toHaveValue('sales_orders');
  await expect(page.getByLabel('Target table')).toHaveValue('imported_orders');
  await page.getByRole('button', { name: 'Load fields & suggest mappings' }).click();
  await expect(page.getByLabel('Transformation for totalMinorUnits')).toHaveValue('Multiply');
  await expect(page.getByLabel('Factor for totalMinorUnits')).toHaveValue('100');
  await expect(page.getByLabel('Source for accountCode')).toHaveValue('customerId');

  // Unreviewed suggestions are not part of the mapping until accepted.
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByRole('status').filter({ hasText: /error/ })).toBeVisible();
  await page.getByRole('button', { name: 'Mark all reviewed' }).click();
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Valid/ })).toBeVisible();
  await page.getByLabel('Sample record').selectOption({ label: 'ORD-013' });
  await page.getByRole('button', { name: 'Preview mapped output' }).click();
  await expect(page.getByLabel('Mapped output JSON')).toContainText('"totalMinorUnits": 41025');
  await page.screenshot({ path: 'test-results/readme-schema-mapper.png', fullPage: true });

  await page.getByLabel('Mapping name').fill('CRM order to ERP import');
  await page.getByRole('button', { name: 'Save new version' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'version 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Save new version' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'version 2' })).toBeVisible();
  const saved = page.getByRole('region', { name: 'Saved mapping definitions', exact: true });
  await expect(saved).toContainText('v2');
  await expect(saved).toContainText('Version 1');

  // Customer status lookup: unmatched values are flagged for review, then fixed by the reviewer.
  await page.getByLabel('Source table').selectOption('customers');
  await page.getByLabel('Target table').selectOption('customer_master');
  await page.getByRole('button', { name: 'Load fields & suggest mappings' }).click();
  await expect(page.getByLabel('Transformation for accountStatus')).toHaveValue('Lookup');
  await expect(page.getByLabel('Lookup for accountStatus')).toHaveValue(/Active=ACTIVE/);
  await expect(mappingRow(page, 'accountStatus')).toContainText('OnHold');
  await page.getByRole('button', { name: 'Mark all reviewed' }).click();
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.locator('.field-warning').filter({ hasText: 'OnHold' })).toBeVisible();
  await page.getByLabel('Lookup for accountStatus').fill('Active=ACTIVE\nInactive=INACTIVE\nOnHold=BLOCKED');
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.locator('.field-warning').filter({ hasText: 'OnHold' })).toHaveCount(0);

  // Saving and previewing never runs an integration.
  await nav(page, 'Executions');
  await page.getByLabel('Search execution ID').fill('ORD-013');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('region', { name: /Execution history table/ })).not.toContainText('ORD-013');
});

test('Viewers can discover schemas and mappings but cannot change them', async ({ page }) => {
  await login(page, 'viewer');
  await nav(page, 'Source System');
  await appNav(page, 'Legacy CRM', 'Data Tables');
  await page.getByRole('button', { name: /crm_contacts/ }).click();
  await expect(page.getByRole('region', { name: 'Records in crm_contacts' })).toContainText('P-001');
  await expect(page.getByRole('button', { name: '+ New table' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '+ New record' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Remove column/ })).toHaveCount(0);
  await nav(page, 'Mapping Studio');
  await page.getByRole('tab', { name: 'Schema mapper (Data Catalog)' }).click();
  await page.getByRole('button', { name: 'Load fields & suggest mappings' }).click();
  await expect(page.getByLabel('Transformation for totalMinorUnits')).toHaveValue('Multiply');
  await expect(page.getByRole('button', { name: 'Save new version' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Saved mapping definitions', exact: true })).toContainText('CRM order to ERP import');
});

test('Catalog and schema mapper fit a 390px phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await nav(page, 'Source System');
  await appNav(page, 'Legacy CRM', 'Data Tables');
  await page.getByRole('button', { name: /crm_contacts/ }).click();
  await expect(page.getByRole('region', { name: 'Records in crm_contacts' })).toContainText('P-001');
  expect(await noOverflow(page), 'Data Tables').toBe(true);
  await nav(page, 'Mapping Studio');
  await page.getByRole('tab', { name: 'Schema mapper (Data Catalog)' }).click();
  await page.getByRole('button', { name: 'Load fields & suggest mappings' }).click();
  await expect(page.getByLabel('Transformation for totalMinorUnits')).toHaveValue('Multiply');
  expect(await noOverflow(page), 'Schema mapper').toBe(true);
});
