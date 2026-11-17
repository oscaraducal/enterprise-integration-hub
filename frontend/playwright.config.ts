import { defineConfig } from '@playwright/test';
// E2E_BASE_URL points the suite at an already running stack (e.g. a separate Docker Compose project on other ports)
// so a local run never touches the demo data behind http://localhost:4200. Without it, Angular is started here.
const external = process.env['E2E_BASE_URL'];
export default defineConfig({
  testDir: './e2e', timeout: 60000, workers: 1, retries: 0,
  use: { baseURL: external ?? 'http://127.0.0.1:4200', trace: 'retain-on-failure' },
  webServer: external ? undefined : { command: 'npm start -- --port 4200', url: 'http://127.0.0.1:4200', timeout: 120000, reuseExistingServer: !process.env['CI'] },
  // In CI, the github reporter turns failures into annotations visible on the PR and run summary.
  reporter: process.env['CI'] ? [['list'], ['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]]
});
