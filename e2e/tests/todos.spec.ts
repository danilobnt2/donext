import { expect, test } from '@playwright/test';

test.beforeEach(async ({ request, page }) => {
  // Start every test from an empty board.
  expect((await request.delete('/api/todos')).ok()).toBe(true);
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
  for (const title of ['Cut the lawn', 'Fix the bike brakes']) {
    expect((await request.post('/api/todos', { data: { title } })).ok()).toBe(true);
  }
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
