import { defineConfig, devices } from '@playwright/test';

// End-to-end: a real gateway process holds an `ask` call while a real `sudowall ui` process
// serves this app; the test approves or denies in the browser. Needs `pnpm build` first.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env['CI'] !== undefined,
  reporter: process.env['CI'] !== undefined ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure' },
});
