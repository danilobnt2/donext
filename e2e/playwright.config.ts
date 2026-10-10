import { defineConfig, devices } from '@playwright/test';

// Set E2E_BASE_URL to test a deployed environment instead of a local `wrangler dev`.
const externalBaseUrl = process.env.E2E_BASE_URL;
const port = 8788;

export default defineConfig({
  testDir: 'tests',
  // Every test runs against the one shared board, so tests run one at a time.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: externalBaseUrl ?? `http://localhost:${port}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: externalBaseUrl
    ? []
    : {
        // Builds the web app, then serves it and the API from a fresh local state.
        command: `pnpm --filter @donext/web build && pnpm --filter @donext/worker exec wrangler dev --port ${port} --persist-to .wrangler-e2e`,
        cwd: '..',
        url: `http://localhost:${port}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
