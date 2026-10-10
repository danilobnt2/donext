import { defineConfig } from '@playwright/test';
import { LOCAL_PORT, localWebServer } from './web-server';

// Takes the README screenshots. Run with `pnpm screenshots`; images land in e2e/screenshots/.
export default defineConfig({
  testDir: 'screenshots',
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://localhost:${LOCAL_PORT}`, colorScheme: 'light' },
  webServer: localWebServer,
});
