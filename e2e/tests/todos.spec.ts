import { expect, test } from '@playwright/test';

test.beforeEach(async ({ request, page }) => {
  expect((await request.delete('/api/v1/board')).ok()).toBe(true);
  await page.goto('/');
  await expect(page.getByText('Nothing yet. Add your first To-Do above.')).toBeVisible();
});

test('shows an empty board', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Do Next' })).toBeVisible();
  await expect(page.getByText('Nothing yet. Add your first To-Do above.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete all' })).toHaveCount(0);
});

test('creates To-Dos in state New, newest first, and keeps them after a reload', async ({
  page,
}) => {
  const input = page.getByLabel('New To-Do');
  await input.fill('Plan dad’s 70th birthday');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(input).toHaveValue('');
  await input.fill('Renew passport');
  await input.press('Enter');

  const items = page.getByRole('listitem');
  await expect(items).toHaveCount(2);
  await expect(items.first()).toContainText('Renew passport');
  await expect(items.first()).toContainText('New');

  await page.reload();
  await expect(items).toHaveText([/Renew passport/, /Plan dad’s 70th birthday/]);
});

test('rejects blank and over-long titles', async ({ page }) => {
  const input = page.getByLabel('New To-Do');
  const add = page.getByRole('button', { name: 'Add' });

  await input.fill('   ');
  await add.click();
  await expect(page.getByRole('alert')).toHaveText('Title is required.');

  await input.fill('x'.repeat(501));
  await add.click();
  await expect(page.getByRole('alert')).toHaveText('Title must be at most 500 characters.');
  await expect(input).toHaveAttribute('aria-invalid', 'true');

  await page.reload();
  await expect(page.getByText('Nothing yet. Add your first To-Do above.')).toBeVisible();
});

test('deletes every To-Do only after confirming', async ({ page }) => {
  const input = page.getByLabel('New To-Do');
  for (const title of ['Cut the lawn', 'Fix the bike brakes']) {
    await input.fill(title);
    await input.press('Enter');
  }
  await expect(page.getByRole('listitem')).toHaveCount(2);

  await page.getByRole('button', { name: 'Delete all' }).click();
  const confirm = page.getByRole('group', { name: /Delete all 2 To-Dos for everyone/ });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('listitem')).toHaveCount(2);

  await page.getByRole('button', { name: 'Delete all' }).click();
  await confirm.getByRole('button', { name: 'Delete all' }).click();
  await expect(page.getByText('Nothing yet. Add your first To-Do above.')).toBeVisible();

  await page.reload();
  await expect(page.getByRole('listitem')).toHaveCount(0);
});

test('keeps offline edits in IndexedDB across reloads and merges live across devices', async ({
  page,
  context,
  browser,
}) => {
  const peerContext = await browser.newContext();
  try {
    const peerPage = await peerContext.newPage();
    await peerPage.goto('/');
    await expect(peerPage.getByText('Nothing yet. Add your first To-Do above.')).toBeVisible();

    let blockSync = true;
    await context.routeWebSocket('**/api/v1/sync', (ws) => {
      if (blockSync) ws.close();
      else ws.connectToServer();
    });
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));

    await page.getByLabel('New To-Do').fill('Pack hiking boots');
    await page.getByRole('button', { name: 'Add' }).click();

    await page.reload();
    await expect(page.getByRole('listitem')).toHaveText([/Pack hiking boots/]);
    await expect(peerPage.getByRole('listitem')).toHaveCount(0);

    await peerPage.getByLabel('New To-Do').fill('Book train tickets');
    await peerPage.getByRole('button', { name: 'Add' }).click();

    blockSync = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));

    const merged = [/Book train tickets/, /Pack hiking boots/];
    await expect(page.getByRole('listitem')).toHaveText(merged);
    await expect(peerPage.getByRole('listitem')).toHaveText(merged);
  } finally {
    await peerContext.close();
  }
});
