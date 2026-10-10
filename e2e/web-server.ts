import type { PlaywrightTestConfig } from '@playwright/test';

export const LOCAL_PORT = 8788;

/** Builds the web app, then serves it and the API with `wrangler dev` from a fresh local state. */
export const localWebServer: NonNullable<PlaywrightTestConfig['webServer']> = {
  command: `pnpm --filter @donext/web build && pnpm --filter @donext/worker exec wrangler dev --port ${LOCAL_PORT} --persist-to .wrangler-e2e`,
  cwd: '..',
  url: `http://localhost:${LOCAL_PORT}/api/health`,
  reuseExistingServer: !process.env.CI,
  timeout: 120_000,
};
