import { expect, test } from '@playwright/test';

const OUT_DIR = new URL('./', import.meta.url).pathname;

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

test.beforeAll(async ({ request }) => {
  await request.delete('/api/todos');
  for (const title of SAMPLE_TODOS) await request.post('/api/todos', { data: { title } });
});

for (const [name, { deviceScaleFactor, ...viewport }] of Object.entries(VIEWPORTS)) {
  test(name, async ({ browser }) => {
    const context = await browser.newContext({ viewport, deviceScaleFactor });
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByRole('listitem')).toHaveCount(SAMPLE_TODOS.length);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${OUT_DIR}${name}.png`, fullPage: true });
    await context.close();
  });
}
