import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', timeout: 60000, workers: 1, retries: 0,
  use: { baseURL: 'http://127.0.0.1:4200', trace: 'retain-on-failure' },
  webServer: { command: 'npm start -- --port 4200', url: 'http://127.0.0.1:4200', timeout: 120000, reuseExistingServer: !process.env['CI'] },
  reporter: [['list'], ['html', { open: 'never' }]]
});
