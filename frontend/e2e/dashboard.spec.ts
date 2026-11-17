import { test, expect, Page } from '@playwright/test';
async function login(page: Page, user = 'operator') {
  await page.goto('/');
  await page.getByLabel('Demo account').selectOption(user);
  await page.getByLabel('Password', { exact: true }).fill(process.env['DEMO_PASSWORD']!);
  await page.getByRole('button', { name: 'Sign in to console' }).click();
  await expect(page.getByRole('heading', { name: 'Operations overview' })).toBeVisible();
}
test('order travels through real mock APIs and shows a receipt and timeline', async ({ page }) => {
  await login(page);
  await page.getByLabel('Source order').selectOption('ORD-001');
  await page.getByRole('button', { name: 'Run integration' }).click();
  const panel = page.getByRole('region', { name: 'Execution investigation' });
  await expect(panel).toBeVisible();
  await expect(panel.locator('.pill')).toHaveText('Completed', { timeout: 20000 });
  await expect(panel.getByText('Mock ERP accepted the order.')).toBeVisible();
  await expect(panel.locator('pre')).toContainText('12550');
  const id = await panel.locator('.execution-id').innerText();
  await page.getByLabel('Search execution ID').fill(id);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
});
test('transient failure retries then succeeds', async ({ page }) => {
  await login(page);
  await page.getByLabel('Source order').selectOption('ORD-002');
  await page.getByLabel('Scenario', { exact: true }).selectOption('Unavailable');
  await page.getByRole('button', { name: 'Run integration' }).click();
  const panel = page.getByRole('region', { name: 'Execution investigation' });
  await expect(panel.locator('.pill')).toHaveText('Completed', { timeout: 25000 });
  await expect(panel.getByText('RetryScheduled')).toBeVisible();
});
test('permanent failure can be safely retried and duplicate submission rejected', async ({ page }) => {
  await login(page);
  await page.getByLabel('Source order').selectOption('ORD-003');
  await page.getByLabel('Scenario', { exact: true }).selectOption('BadRequest');
  await page.getByRole('button', { name: 'Run integration' }).click();
  const panel = page.getByRole('region', { name: 'Execution investigation' });
  await expect(panel.locator('.pill')).toHaveText('Failed', { timeout: 20000 });
  await page.getByRole('button', { name: 'Safely retry execution' }).click();
  await expect(panel.locator('.pill')).toHaveText('Completed', { timeout: 20000 });
  await page.getByRole('button', { name: 'Run integration' }).click();
  await expect(page.getByRole('alert')).toContainText('already tracked');
});
test('viewer, theme and mobile layout', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'viewer');
  await expect(page.getByRole('button', { name: 'Run integration' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Toggle theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Workloads', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Simulated workload monitoring' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Simulate failure' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
test('failed workload exposes investigation details', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Workloads', exact: true }).click();
  await page.getByRole('button', { name: 'Simulate failure' }).click();
  await expect(page.getByRole('heading', { name: 'Job investigation' })).toBeVisible();
  await expect(page.getByText('Synthetic input schema mismatch.', { exact: false })).toBeVisible();
});
