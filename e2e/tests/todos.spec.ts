import { expect, test, type Page } from '@playwright/test';

let userSeq = 0;

function nextUser(): string {
  return `e2e_${Date.now().toString(36)}_${++userSeq}`;
}

async function signIn(page: Page, user: string = nextUser()): Promise<string> {
  await page.goto(`/api/v1/auth/login?as=${user}`);
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  return user;
}

test('requires sign-in before showing the board and clears session on sign-out', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Do Next' })).toBeVisible();
  const signInLink = page.getByRole('link', { name: 'Continue with Google' });
  await expect(signInLink).toBeVisible();
  await expect(page.getByLabel('New To-Do')).toHaveCount(0);

  await signInLink.click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(page.getByLabel('New To-Do')).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible();
});

test('shows an empty board for a newly signed-in user', async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Do Next' })).toBeVisible();
  await expect(page.getByText('Nothing yet. Add your first To-Do above.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete all' })).toHaveCount(0);
});

test('creates To-Dos in state New, newest first, and keeps them after a reload', async ({
  page,
}) => {
  await signIn(page);
  await expect(page.getByText('Nothing yet. Add your first To-Do above.')).toBeVisible();

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
  await signIn(page);
  await expect(page.getByText('Nothing yet. Add your first To-Do above.')).toBeVisible();

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

test('isolates To-Do boards per user and deletes all only after confirming', async ({
  page,
  browser,
}) => {
  await signIn(page);
  await expect(page.getByText('Nothing yet. Add your first To-Do above.')).toBeVisible();

  const input = page.getByLabel('New To-Do');
  for (const title of ['Cut the lawn', 'Fix the bike brakes']) {
    await input.fill(title);
    await input.press('Enter');
  }
  await expect(page.getByRole('listitem')).toHaveCount(2);

  const otherContext = await browser.newContext();
  try {
    const otherPage = await otherContext.newPage();
    await signIn(otherPage);
    await expect(otherPage.getByText('Nothing yet. Add your first To-Do above.')).toBeVisible();

    await otherPage.getByLabel('New To-Do').fill('Book dentist');
    await otherPage.getByRole('button', { name: 'Add' }).click();
    await expect(otherPage.getByRole('listitem')).toHaveText([/Book dentist/]);

    await page.getByRole('button', { name: 'Delete all' }).click();
    const confirm = page.getByRole('group', { name: /Delete all 2 To-Dos/ });
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('listitem')).toHaveCount(2);

    await page.getByRole('button', { name: 'Delete all' }).click();
    await confirm.getByRole('button', { name: 'Delete all' }).click();
    await expect(page.getByText('Nothing yet. Add your first To-Do above.')).toBeVisible();
    await expect(otherPage.getByRole('listitem')).toHaveText([/Book dentist/]);
  } finally {
    await otherContext.close();
  }
});

test('keeps offline edits in IndexedDB across reloads and merges live across devices', async ({
  page,
  context,
  browser,
}) => {
  const user = await signIn(page);
  await expect(page.getByText('Nothing yet. Add your first To-Do above.')).toBeVisible();

  const peerContext = await browser.newContext();
  try {
    const peerPage = await peerContext.newPage();
    await signIn(peerPage, user);
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
