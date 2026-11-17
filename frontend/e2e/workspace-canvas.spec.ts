import { test, expect, Page, Locator, APIRequestContext } from '@playwright/test';
import { login, nav } from './helpers';
// Milestone C.3: a movable canvas for long flows (drag-pan, Space + drag, middle button, Ctrl + wheel zoom at the
// pointer, fit, find, center, previous view, overview map), panning that never selects or drags actions, the +
// popup after panning, and the redesigned Invoke wizard. The long flow is synthetic and created only in this test stack.
// Runs after workbench.spec.ts (connections exist) and designer.spec.ts (which needs an empty integration list).

const TITLE = 'Long Flow Practice';
const node = (page: Page, label: string) => page.getByRole('button', { name: new RegExp('^' + label) });
const slot = (page: Page, where: string) => page.getByRole('button', { name: 'Insert action at ' + where, exact: true });
const picker = (page: Page) => page.getByRole('dialog', { name: 'Add action' });
const wrap = (page: Page) => page.getByRole('region', { name: 'Flow canvas' });
const header = (page: Page) => page.getByRole('region', { name: 'Integration header' });
const scroll = (page: Page) => wrap(page).evaluate(e => ({ left: e.scrollLeft, top: e.scrollTop, w: e.scrollWidth, h: e.scrollHeight, cw: e.clientWidth, ch: e.clientHeight }));
const zoomLabel = (page: Page) => page.getByRole('button', { name: 'Reset zoom' });
async function box(l: Locator) { const b = await l.boundingBox(); expect(b).not.toBeNull(); return b!; }
/** The popup is positioned right after it renders; wait until its box is placed and stable before measuring. */
async function settled(l: Locator) {
  let last = '';
  await expect.poll(async () => { const b = await l.boundingBox(); const k = b ? [b.x, b.y, b.width, b.height].map(Math.round).join(',') : ''; const same = !!b && k === last && (b.x > 0 || b.y > 0); last = k; return same; }).toBe(true);
  return box(l);
}
function watchWrites(page: Page) {
  const writes: string[] = [];
  page.on('request', r => { const u = new URL(r.url()).pathname; if (r.method() !== 'GET' && /^\/api\/(executions|jobs|target|source)\b/.test(u)) writes.push(`${r.method()} ${u}`); });
  return writes;
}
/** 61 actions: 24 Loggers, a Scope (Switch with two branches + 2 Loggers), a For Each (2 Loggers), 24 more Loggers. */
function longFlow(trigger: unknown) {
  let n = 0;
  const logger = (name: string) => ({ id: 'L' + (++n), type: 'logger', name, description: null, config: { level: 'info', message: `'${name} reached'` }, branches: [] });
  const many = (from: number, count: number) => Array.from({ length: count }, (_, i) => logger('step' + String(from + i).padStart(2, '0')));
  const sw = { id: 'SW1', type: 'switch', name: 'route', description: null, config: {}, branches: [
    { id: 'B1', kind: 'case', label: 'Fast path', condition: "'a' == 'a'", steps: many(60, 3) },
    { id: 'B2', kind: 'otherwise', label: 'Otherwise', condition: null, steps: many(70, 3) }] };
  const loop = { id: 'FE1', type: 'forEach', name: 'eachItem', description: null, config: { collection: '$trigger.items', itemVariable: 'item', maxItems: 10 },
    branches: [{ id: 'B3', kind: 'body', label: 'For each item', condition: null, steps: many(80, 2) }] };
  const scope = { id: 'SC1', type: 'scope', name: 'scope', description: null, config: {}, branches: [
    { id: 'B4', kind: 'body', label: 'Scope', condition: null, steps: [sw, ...many(90, 2)] },
    { id: 'B5', kind: 'faultHandler', label: 'Fault handler', condition: null, steps: [] }] };
  return { schemaVersion: 1, trigger, steps: [...many(1, 24), scope, loop, ...many(25, 24)], globalFaultHandler: [] };
}
async function createLongFlow(request: APIRequestContext) {
  const auth = await (await request.post('/api/auth/login', { data: { username: 'operator', password: process.env['DEMO_PASSWORD'] } })).json();
  const headers = { Authorization: 'Bearer ' + auth.token };
  const created = await request.post('/api/flows', { headers, data: { title: TITLE, identifier: 'LONG_FLOW_PRACTICE', style: 'manual', template: 'blank' } });
  expect(created.status()).toBe(201);
  const flow = await (await request.get('/api/flows/long-flow-practice', { headers })).json();
  const trigger = { ...flow.definition.trigger, config: { mode: 'manual', parameters: [{ name: 'items', type: 'string', required: false, sample: '' }] } };
  const saved = await request.put('/api/flows/long-flow-practice/draft', { headers, data: { definition: longFlow(trigger), revision: flow.revision } });
  expect(saved.status()).toBe(200);
}
async function openLongFlow(page: Page) {
  await nav(page, 'Integrations');
  await page.getByRole('button', { name: 'Open designer for ' + TITLE, exact: true }).click();
  await expect(page.getByRole('heading', { name: TITLE, level: 1 })).toBeVisible();
  await page.getByRole('radiogroup', { name: 'Layout' }).getByRole('radio', { name: 'Vertical' }).click();
}
/** A point on the empty canvas background, left of the centred flow. */
async function background(page: Page) { const b = await box(wrap(page)); return { x: b.x + 40, y: b.y + b.height / 2 }; }

test.describe.configure({ mode: 'serial' });

test('Long flow: drag, Space and middle-button panning in both directions, without selecting or moving actions', async ({ page, request }) => {
  await createLongFlow(request);
  await page.setViewportSize({ width: 1600, height: 1000 });
  const writes = watchWrites(page);
  await login(page);
  await openLongFlow(page);
  expect(await page.locator('.canvas .node').count()).toBe(62); // trigger + 61 actions, every one rendered
  const s0 = await scroll(page);
  expect(s0.h).toBeGreaterThan(s0.ch * 2);                      // much longer than the viewport

  // Select an action, then drag the empty background up: the canvas pans and the selection is unchanged.
  await node(page, 'Logger step02').click();
  const p = await background(page);
  await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(p.x + 5, p.y - 200, { steps: 8 }); await page.mouse.move(p.x + 5, p.y - 400, { steps: 8 }); await page.mouse.up();
  const s1 = await scroll(page);
  expect(s1.top - s0.top).toBeGreaterThan(350);
  await expect(node(page, 'Logger step02')).toHaveAttribute('aria-pressed', 'true');

  // Space + drag over an action pans and neither selects nor drags it.
  const target = node(page, 'Logger step10'); await target.scrollIntoViewIfNeeded();
  const t = await box(target); const before = await scroll(page);
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2);
  await page.keyboard.down('Space');
  await page.mouse.down(); await page.mouse.move(t.x + t.width / 2, t.y - 250, { steps: 10 }); await page.mouse.up();
  await page.keyboard.up('Space');
  expect((await scroll(page)).top - before.top).toBeGreaterThan(200);
  await expect(target).toHaveAttribute('aria-pressed', 'false');
  await expect(header(page)).toContainText('Saved');             // nothing moved in the flow

  // Middle button drag pans too.
  const m = await scroll(page); const q = await background(page);
  await page.mouse.move(q.x, q.y); await page.mouse.down({ button: 'middle' }); await page.mouse.move(q.x, q.y - 300, { steps: 10 }); await page.mouse.up({ button: 'middle' });
  expect((await scroll(page)).top - m.top).toBeGreaterThan(250);

  // Hand mode: drag anywhere, even over an action card.
  await page.getByRole('button', { name: 'Hand mode' }).click();
  await node(page, 'Logger step20').evaluate(e => e.scrollIntoView({ block: 'center' }));
  const h = await scroll(page); const card = await box(node(page, 'Logger step20'));
  await page.mouse.move(card.x + 20, card.y + 10); await page.mouse.down(); await page.mouse.move(card.x + 20, card.y - 200, { steps: 8 }); await page.mouse.up();
  expect((await scroll(page)).top - h.top).toBeGreaterThan(150);
  await page.getByRole('button', { name: 'Hand mode' }).click();

  // Horizontal layout: the flow is far wider than the viewport; drag left to move right.
  await page.getByRole('radiogroup', { name: 'Layout' }).getByRole('radio', { name: 'Horizontal' }).click();
  await wrap(page).evaluate(e => e.scrollTo(0, 0));
  const hz = await scroll(page);
  expect(hz.w).toBeGreaterThan(hz.cw * 2);
  const wb = await box(wrap(page));
  await page.mouse.move(wb.x + wb.width - 60, wb.y + wb.height - 40); await page.mouse.down();
  await page.mouse.move(wb.x + wb.width - 560, wb.y + wb.height - 40, { steps: 12 }); await page.mouse.up();
  expect((await scroll(page)).left - hz.left).toBeGreaterThan(400);
  await page.screenshot({ path: 'test-results/readme-canvas-horizontal.png' });
  await page.getByRole('radiogroup', { name: 'Layout' }).getByRole('radio', { name: 'Vertical' }).click();
  expect(writes).toEqual([]);
});

test('Long flow: Ctrl + wheel zooms at the pointer, fit, find, center and previous view, overview map', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await login(page);
  await openLongFlow(page);
  const minimap = page.getByRole('group', { name: 'Overview map' });
  await expect(minimap).toBeVisible();

  // Ctrl + wheel over an action in mid-flow (room to scroll on every side) zooms out and keeps it under the pointer.
  const anchor = node(page, 'Logger step20'); await anchor.evaluate(e => e.scrollIntoView({ block: 'center', inline: 'center' }));
  const a0 = await box(anchor);
  const cx = a0.x + a0.width / 2, cy = a0.y + a0.height / 2;
  await page.mouse.move(cx, cy);
  await page.keyboard.down('Control'); await page.mouse.wheel(0, 120); await page.mouse.wheel(0, 120); await page.keyboard.up('Control');
  await expect(zoomLabel(page)).not.toHaveText('100%');
  const a1 = await box(anchor);
  expect(Math.abs(a1.x + a1.width / 2 - cx)).toBeLessThan(30);
  expect(Math.abs(a1.y + a1.height / 2 - cy)).toBeLessThan(30);

  // Fit shows the whole flow (or the smallest zoom), then reset.
  await page.getByRole('button', { name: 'Fit to screen' }).click();
  await expect.poll(async () => Number((await zoomLabel(page).innerText()).replace('%', ''))).toBeLessThan(60);
  const fit = await scroll(page);
  // The whole flow fits vertically, or the zoom stopped at its 10% floor.
  expect(fit.h <= fit.ch + 2 || (await zoomLabel(page).innerText()) === '10%').toBe(true);
  await page.screenshot({ path: 'test-results/readme-canvas-fit.png' });
  await zoomLabel(page).click();
  await expect(zoomLabel(page)).toHaveText('100%');

  // Find an action far down the flow: it is selected and centred in the viewport.
  await wrap(page).evaluate(e => e.scrollTo(0, 0));
  await page.getByLabel('Search actions').fill('step45');
  await page.getByLabel('Search actions').press('Enter');
  const found = node(page, 'Logger step45');
  await expect(found).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => { const w = await box(wrap(page)), f = await box(found); return Math.abs((f.y + f.height / 2) - (w.y + w.height / 2)); }).toBeLessThan(60);

  // Edit its properties; Previous view returns to where we were before the search (top of the flow).
  await page.getByRole('complementary', { name: 'Properties' }).getByLabel('Message', { exact: true }).fill("'step45 edited'");
  await page.getByRole('button', { name: 'Previous view' }).click();
  await expect.poll(async () => (await scroll(page)).top).toBeLessThan(5);
  // Center selected brings it back.
  await page.getByRole('button', { name: 'Center selected action' }).click();
  await expect.poll(async () => { const w = await box(wrap(page)), f = await box(found); return Math.abs((f.y + f.height / 2) - (w.y + w.height / 2)); }).toBeLessThan(60);
  await page.screenshot({ path: 'test-results/readme-canvas-long-flow.png' });

  // The overview map moves the viewport.
  const mm = await box(minimap); const topBefore = (await scroll(page)).top;
  await page.mouse.click(mm.x + mm.width / 2, mm.y + 4);
  await expect.poll(async () => (await scroll(page)).top).toBeLessThan(topBefore);

  // Collapsing a container keeps it where it was on screen.
  const scope = page.getByRole('button', { name: 'Collapse scope' }); await scope.scrollIntoViewIfNeeded();
  const sb = await box(node(page, 'Scope scope'));
  await scope.click();
  const sa = await box(node(page, 'Scope scope'));
  expect(Math.abs(sa.y - sb.y)).toBeLessThan(3);
  await page.getByRole('button', { name: 'Expand scope' }).click();

  // Save: every action, branch and edit survives.
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Draft saved' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to Integrations' }).click();
  await openLongFlow(page);
  expect(await page.locator('.canvas .node').count()).toBe(62);
  await node(page, 'Logger step45').click();
  await expect(page.getByRole('complementary', { name: 'Properties' }).getByLabel('Message', { exact: true })).toHaveValue("'step45 edited'");
});

test('After panning, + opens beside its button inside nested branches; dragging an action moves it without panning', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await login(page);
  await openLongFlow(page);
  // Pan to the Switch inside the Scope, then open + in its "Fast path" branch.
  const p = await background(page);
  await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(p.x, p.y - 600, { steps: 10 }); await page.mouse.up();
  expect((await scroll(page)).top).toBeGreaterThan(500);
  const plus = slot(page, 'Fast path, position 1');
  await plus.evaluate(e => e.scrollIntoView({ block: 'center' }));
  const before = await scroll(page);
  await plus.click();
  const pk = await settled(picker(page)), a = await box(plus);
  expect(pk.x).toBeGreaterThanOrEqual(a.x + a.width - 1);
  expect(Math.abs((pk.y + pk.height / 2) - (a.y + a.height / 2))).toBeLessThan(pk.height / 2 + 1);
  expect(await scroll(page)).toEqual(before);                     // opening + never moves the canvas
  await picker(page).getByLabel('Search actions and connections').fill('assign');
  await picker(page).getByRole('button', { name: 'Assign', exact: true }).click();
  await expect(page.locator('.branch.kind-case').getByRole('button', { name: /^Assign / })).toHaveCount(1);

  // Drag an action by its header onto another +: it moves, and the canvas did not pan.
  await page.getByRole('button', { name: 'Undo' }).click();
  await wrap(page).evaluate(e => e.scrollTo(0, 0));
  const s0 = await scroll(page);
  await node(page, 'Logger step03').dragTo(page.locator('[data-slot="root@0"]'));
  const order = await page.locator('.canvas .flow-line > ol.seq > li > .node .node-head b').allInnerTexts();
  expect(order.slice(0, 3)).toEqual(['step03', 'step01', 'step02']);
  expect((await scroll(page)).top).toBe(s0.top);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(header(page)).toContainText('Unsaved changes');      // undo keeps the draft dirty; leave without saving
  await page.getByRole('button', { name: 'Back to Integrations' }).click();
  await page.getByRole('dialog', { name: 'Leave the Designer' }).getByRole('button', { name: 'Discard changes' }).click();
});

test('Invoke wizard: content-sized, only applicable steps, Back/Next keeps every value, phone layout', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await login(page);
  await openLongFlow(page);
  await slot(page, 'main flow, position 1').click();
  await picker(page).getByRole('tab', { name: 'Invokes' }).click();
  await picker(page).getByRole('button', { name: 'Invoke Legacy CRM REST' }).click();
  const w = page.getByRole('dialog', { name: 'Invoke endpoint wizard' });
  const wb = await box(w);
  expect(wb.width).toBeLessThanOrEqual(870); expect(wb.width).toBeGreaterThanOrEqual(600);  // not the old 1100 px panel
  await expect(w.getByRole('radio', { name: 'Legacy CRM REST' })).toHaveAttribute('aria-checked', 'true');
  await expect(w).toContainText('Selected: Legacy CRM REST');
  await page.screenshot({ path: 'test-results/readme-invoke-wizard.png' });
  await w.getByRole('button', { name: 'Next' }).click();
  await w.getByRole('radio', { name: /^GET/ }).click();
  await w.getByRole('button', { name: 'Next' }).click();
  await w.getByRole('radio', { name: 'GET /customers/{customerId}' }).click();
  const steps = w.getByRole('list', { name: 'Wizard steps' });
  await expect(steps).toHaveText(/Connection.*Operation.*Business object.*Response.*Parameters.*Summary/);
  await expect(steps).not.toContainText('Request');
  await w.getByRole('button', { name: 'Next' }).click();          // → Response
  await w.getByRole('button', { name: 'Next' }).click();          // → Parameters
  await expect(w.getByRole('status').filter({ hasText: 'Not set yet' })).toBeVisible(); // hint next to the field
  await w.getByLabel('Path parameter {customerId}', { exact: true }).fill("'C-100'");
  await expect(w.getByRole('status').filter({ hasText: 'Not set yet' })).toHaveCount(0);
  // Back to Business object and forward again: the operation and the key are still there.
  for (let i = 0; i < 2; i++) await w.getByRole('button', { name: 'Back' }).click();
  await expect(w.getByRole('radio', { name: 'GET /customers/{customerId}' })).toHaveAttribute('aria-checked', 'true');
  for (let i = 0; i < 2; i++) await w.getByRole('button', { name: 'Next' }).click();
  await expect(w.getByLabel('Path parameter {customerId}', { exact: true })).toHaveValue("'C-100'");
  await w.getByRole('button', { name: 'Next' }).click();          // → Summary
  await expect(w).toContainText("'C-100'");
  await expect(w).toContainText('No request mapping needed.');
  await w.getByRole('button', { name: 'Finish' }).click();
  await expect(node(page, 'Invoke callApi')).toBeVisible();
  await expect(node(page, 'Invoke callApi')).toContainText('LEGACY_CRM_REST'); // connection shown on the card

  // Phone: the wizard is a bottom sheet with its footer in view.
  await page.setViewportSize({ width: 390, height: 844 });
  await node(page, 'Invoke callApi').click();
  await page.getByRole('complementary', { name: 'Properties' }).getByRole('button', { name: 'Edit endpoint…' }).click();
  const sheet = await box(w);
  expect(sheet.width).toBeGreaterThanOrEqual(388);
  const next = await box(w.getByRole('button', { name: 'Next' }));
  expect(next.y + next.height).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/readme-invoke-wizard-mobile.png' });
  await w.getByRole('button', { name: 'Cancel' }).click();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole('button', { name: 'Back to Integrations' }).click();
  await page.getByRole('dialog', { name: 'Leave the Designer' }).getByRole('button', { name: 'Discard changes' }).click();
});
