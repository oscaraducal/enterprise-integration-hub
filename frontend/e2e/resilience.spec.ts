import { test, expect, Page, Route } from '@playwright/test';
// Regression tests for partial outages, stale responses, filters, pagination, sign-out and responsive layout.
// Upstream failures are injected with page.route so each scenario is deterministic; all data is synthetic.

async function login(page: Page, user = 'operator') {
  await page.goto('/');
  await page.getByLabel('Demo account').selectOption(user);
  await page.getByLabel('Password', { exact: true }).fill(process.env['DEMO_PASSWORD']!);
  await page.getByRole('button', { name: 'Sign in to console' }).click();
  await expect(page.getByRole('heading', { name: 'Operations overview' })).toBeVisible();
}
const crmDown = (route: Route) => route.fulfill({ status: 502, contentType: 'application/problem+json',
  body: JSON.stringify({ title: 'Mock CRM unavailable', status: 502 }) });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function executionPage(status: string, total: number, page: number) {
  const count = Math.max(0, Math.min(20, total - (page - 1) * 20));
  return { total, page, pageSize: 20, items: Array.from({ length: count }, (_, i) => ({
    id: `${status.toLowerCase()}${String(page).padStart(2, '0')}${String(i).padStart(2, '0')}`.padEnd(32, '0'),
    orderId: `ORD-SYN-${page}-${i}`, status, environment: 'DEV', createdAt: new Date().toISOString(),
    durationMs: 120, attempts: 1, retryCount: 0, logs: [] })) };
}

test.describe('partial upstream outage', () => {
  test('CRM outage keeps history and metrics live, preserves orders and warns without blocking', async ({ page }) => {
    await login(page);
    const source = page.getByLabel('Source order');
    await expect(source.locator('option').first()).toHaveText(/ORD-001/);
    await page.route('**/api/orders', crmDown);
    const history = page.waitForResponse(r => r.url().includes('/api/executions?') && r.status() === 200);
    const metrics = page.waitForResponse(r => r.url().endsWith('/api/metrics') && r.status() === 200);
    await page.getByRole('button', { name: 'Refresh' }).click();
    await Promise.all([history, metrics]);
    const warning = page.getByRole('status', { name: 'Partial outage' });
    await expect(warning).toContainText('Mock CRM source orders');
    await expect(warning).toContainText('Mock CRM unavailable');
    await expect(warning).toContainText('Showing data from');
    await expect(page.getByText('Mock CRM is unavailable, so the source order list may be out of date')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0); // non-blocking: no error banner
    await expect(source.locator('option').first()).toHaveText(/ORD-001/); // last good data preserved
    await expect(page.getByRole('heading', { name: 'Recent executions' })).toBeVisible();
    await expect(page.getByRole('region', { name: /Execution history table/ })).toBeVisible();
    await page.screenshot({ path: 'test-results/crm-outage-warning.png' });
    await page.unroute('**/api/orders');
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(warning).toHaveCount(0);
  });

  test('CRM down from first load still shows execution history and investigation', async ({ page }) => {
    await page.route('**/api/orders', crmDown);
    await login(page);
    await expect(page.getByRole('status', { name: 'Partial outage' })).toContainText('No data loaded yet');
    await expect(page.getByLabel('Source order')).toContainText('No source orders available');
    await expect(page.getByRole('button', { name: 'Run integration' })).toBeDisabled();
    await expect(page.getByRole('region', { name: 'Execution metrics' })).toBeVisible();
    const inspect = page.getByRole('button', { name: /^Inspect / }).first();
    if (await inspect.count()) {
      await inspect.click();
      await expect(page.getByRole('region', { name: 'Execution investigation' })).toBeVisible();
    }
  });

  test('history outage is reported for that section only', async ({ page }) => {
    await login(page);
    await page.route('**/api/executions?*', route => route.fulfill({ status: 500, body: '{}' }));
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByRole('status', { name: 'Partial outage' })).toContainText('Execution history');
    await expect(page.getByRole('status', { name: 'Partial outage' })).not.toContainText('Mock CRM');
  });
});

test.describe('filters, pagination and stale responses', () => {
  test('a slow unfiltered response cannot overwrite a newer filtered result', async ({ page }) => {
    await page.route('**/api/executions?*', async route => {
      const url = new URL(route.request().url());
      const status = url.searchParams.get('status');
      if (!status) { await delay(1500); return route.fulfill({ json: executionPage('Running', 3, 1) }); }
      return route.fulfill({ json: executionPage(status, 2, 1) });
    });
    await login(page);
    await page.getByRole('button', { name: 'Refresh' }).click(); // slow, unfiltered
    await page.getByLabel('Status filter').selectOption('Completed'); // fast, filtered
    await delay(2000); // let the stale response arrive
    const rows = page.locator('.execution-panel tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(page.locator('.execution-panel tbody .pill')).toHaveText(['Completed', 'Completed']);
    await expect(page.getByText('2 results · filtered')).toBeVisible();
  });

  test('changing filters resets pagination and an emptied page clamps to the last valid page', async ({ page }) => {
    let shrink = false;
    await page.route('**/api/executions?*', route => {
      const url = new URL(route.request().url());
      const status = url.searchParams.get('status'), requested = Number(url.searchParams.get('page'));
      const total = status ? 3 : shrink ? 25 : 45;
      return route.fulfill({ json: executionPage(status ?? 'Completed', total, requested) });
    });
    await login(page);
    const pager = page.getByRole('navigation', { name: 'Execution history pages' });
    await expect(pager).toContainText('Page 1 of 3');
    await pager.getByRole('button', { name: 'Next' }).click();
    await pager.getByRole('button', { name: 'Next' }).click();
    await expect(pager).toContainText('Page 3 of 3');
    await expect(pager.getByRole('button', { name: 'Next' })).toBeDisabled();
    await page.getByLabel('Status filter').selectOption('Failed');
    await expect(pager).toContainText('Page 1 of 1');
    await expect(page.locator('.execution-panel tbody tr')).toHaveCount(3);
    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(page.getByLabel('Status filter')).toHaveValue('');
    await pager.getByRole('button', { name: 'Next' }).click();
    await pager.getByRole('button', { name: 'Next' }).click();
    await expect(pager).toContainText('Page 3 of 3');
    shrink = true; // items left the result set while the user was on page 3
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(pager).toContainText('Page 2 of 2');
    await expect(page.locator('.execution-panel tbody tr')).toHaveCount(5);
  });

  test('typed search is applied only when submitted', async ({ page }) => {
    await login(page);
    await page.getByLabel('Search execution ID').fill('no-such-execution');
    await expect(page.getByText('Press Search to apply the new search text.')).toBeVisible();
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByText('No matching executions')).toBeVisible();
    await expect(page.getByText('0 results · filtered')).toBeVisible();
  });
});

test.describe('session handling', () => {
  test('sign-out clears protected data and in-flight responses do not repopulate it', async ({ page }) => {
    await login(page);
    await page.getByLabel('Search execution ID').fill('abc');
    await page.route('**/api/executions?*', async route => { await delay(1500); await route.continue().catch(() => {}); });
    await page.route('**/api/metrics', async route => { await delay(1500); await route.continue().catch(() => {}); });
    await page.getByRole('button', { name: 'Refresh' }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await delay(2000);
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await expect(page.locator('.app-shell')).toHaveCount(0);
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await login(page, 'viewer');
    await expect(page.getByLabel('Search execution ID')).toHaveValue('');
    await expect(page.locator('.topbar .role')).toHaveText('Viewer');
  });

  test('an expired session returns to sign-in with an actionable message', async ({ page }) => {
    await login(page);
    await page.route('**/api/metrics', route => route.fulfill({ status: 401, body: '' }));
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('session expired');
    await expect(page.locator('.app-shell')).toHaveCount(0);
  });
});

test.describe('responsive layout and accessibility', () => {
  for (const [name, width, height] of [['mobile', 390, 844], ['tablet', 768, 1024], ['desktop', 1440, 900]] as const) {
    test(`${name} layout has no horizontal page overflow and consistent controls`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await login(page);
      const refresh = page.getByRole('button', { name: 'Refresh' });
      const box = (await refresh.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(width <= 800 ? 44 : 32);
      expect(box.height).toBeLessThan(56); // single line, no wrapping
      for (const button of [refresh, page.getByRole('button', { name: 'Sign out' }), page.getByRole('button', { name: 'Run integration' })]) {
        const font = await button.evaluate(el => getComputedStyle(el).fontFamily);
        expect(font).toMatch(/^Inter/);
        expect(font).toContain('sans-serif'); // never the browser's default serif face
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/layout-${name}.png`, fullPage: true });
      await page.getByRole('button', { name: 'Executions', exact: true }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }

  test('scrollable tables are keyboard reachable, labelled and visibly focused', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route('**/api/executions?*', route => route.fulfill({ json: executionPage('Completed', 3, 1) }));
    await login(page, 'viewer');
    const table = page.getByRole('region', { name: /Execution history table/ });
    await page.getByRole('button', { name: 'Search', exact: true }).focus();
    for (let i = 0; i < 6 && !(await table.evaluate(el => el === document.activeElement)); i++) await page.keyboard.press('Tab');
    await expect(table).toBeFocused();
    expect(await table.evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe('none');
    const overflow = await table.evaluate(el => el.scrollWidth > el.clientWidth);
    expect(overflow).toBe(true);
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('End');
    await expect.poll(() => table.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
  });

  test('dark theme investigation view renders on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await page.getByRole('button', { name: 'Toggle theme' }).click();
    // Self-contained: run an order with a transient failure so the timeline shows retry stages.
    await page.getByLabel('Source order').selectOption('ORD-011');
    await page.getByLabel('Scenario', { exact: true }).selectOption('ServerError');
    await page.getByRole('button', { name: 'Run integration' }).click();
    const panel = page.getByRole('region', { name: 'Execution investigation' });
    if (await page.getByRole('alert').filter({ hasText: 'already tracked' }).count())
      await page.getByRole('button', { name: 'Inspect ORD-011' }).click();
    await expect(panel).toBeVisible();
    await expect(panel).toBeFocused();
    await expect(panel.locator('.pill')).toHaveText('Completed', { timeout: 25000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results/investigation-mobile-dark.png', fullPage: true });
  });
});
