import { expect, test } from '@playwright/test';

const OUT_DIR = new URL('./', import.meta.url).pathname;
const SCREENSHOT_USER = `readme_${Date.now().toString(36)}`;

const SAMPLE_TODOS = [
  'Cut the lawn',
  'Learn to make sourdough',
  'Renew passport',
  'Get hired to a new job',
  'Plan dad’s 70th birthday',
];

const VIEWPORTS = {
  mobile: { width: 390, height: 400, deviceScaleFactor: 2 },
  desktop: { width: 1000, height: 400, deviceScaleFactor: 2 },
};

test.beforeAll(async ({ browser }) => {
  const seedContext = await browser.newContext();
  const peerContext = await browser.newContext();
  const page = await seedContext.newPage();
  const peer = await peerContext.newPage();
  await page.goto(`/api/v1/auth/login?as=${SCREENSHOT_USER}`);
  await peer.goto(`/api/v1/auth/login?as=${SCREENSHOT_USER}`);
  await expect(page.getByText('Nothing yet. Add your first To-Do above.')).toBeVisible();
  const input = page.getByLabel('New To-Do');
  for (const title of SAMPLE_TODOS) {
    await input.fill(title);
    await input.press('Enter');
    await expect(input).toHaveValue('');
  }
  await expect(peer.getByRole('listitem')).toHaveCount(SAMPLE_TODOS.length);
  await seedContext.close();
  await peerContext.close();
});

for (const [name, { deviceScaleFactor, ...viewport }] of Object.entries(VIEWPORTS)) {
  test(name, async ({ browser }) => {
    const context = await browser.newContext({ viewport, deviceScaleFactor });
    const page = await context.newPage();
    await page.goto(`/api/v1/auth/login?as=${SCREENSHOT_USER}`);
    await expect(page.getByRole('listitem')).toHaveCount(SAMPLE_TODOS.length);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${OUT_DIR}${name}.png`, fullPage: true });
    await context.close();
  });
}
