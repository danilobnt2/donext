import { defineConfig, devices } from '@playwright/test';
import { LOCAL_PORT, localWebServer } from './web-server';

// Set E2E_BASE_URL to test a deployed environment instead of a local `wrangler dev`.
const externalBaseUrl = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: 'tests',
  // Every test runs against the one shared board, so tests run one at a time.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: externalBaseUrl ?? `http://localhost:${LOCAL_PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: externalBaseUrl ? [] : localWebServer,
});
