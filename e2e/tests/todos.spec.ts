import { expect, test } from '@playwright/test';
import { boardTitles, resetBoard, seedTodos } from '../board';

test.beforeEach(async ({ request, page }) => {
  // Start every test from an empty board.
  await resetBoard(request);
  await page.goto('/');
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

test('deletes every To-Do only after confirming', async ({ page, request }) => {
  await seedTodos(request, ['Cut the lawn', 'Fix the bike brakes']);
  await page.reload();
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

test('keeps working offline and syncs, in order, when the connection returns', async ({
  page,
  context,
  request,
}) => {
  const status = page.getByRole('status');
  await expect(status).toHaveText('Synced');

  await context.setOffline(true);
  const input = page.getByLabel('New To-Do');
  await input.fill('Written offline');
  await input.press('Enter');
  await input.fill('Also written offline');
  await input.press('Enter');

  await expect(page.getByRole('listitem')).toHaveText([/Also written offline/, /Written offline/]);
  await expect(status).toHaveText('Offline · 2 changes waiting');
  expect(await boardTitles(request)).toEqual([]);

  await context.setOffline(false);
  await expect(status).toHaveText('Synced', { timeout: 20_000 });
  expect(await boardTitles(request)).toEqual(['Also written offline', 'Written offline']);
});

test('shows To-Dos added from another device', async ({ page, request }) => {
  await expect(page.getByText('Nothing yet. Add your first To-Do above.')).toBeVisible();

  await seedTodos(request, ['Added elsewhere']);
  // A page coming back into view syncs at once; this stands in for that.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('listitem')).toHaveText([/Added elsewhere/]);
});

test('removes To-Dos deleted from another device', async ({ page, request }) => {
  await seedTodos(request, ['Deleted elsewhere']);
  await page.reload();
  await expect(page.getByRole('listitem')).toHaveText([/Deleted elsewhere/]);

  await resetBoard(request);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByText('Nothing yet. Add your first To-Do above.')).toBeVisible();
});
