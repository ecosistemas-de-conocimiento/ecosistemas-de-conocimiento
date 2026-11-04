/**
 * The phone fixes of 2026-10-28, at 390 × 844, pinned so they cannot regress
 * silently.
 *
 *   1. Picking a conversation in the conversations drawer closes the drawer and
 *      hands focus back to the "Conversaciones" toggle.
 *   2. Switching the Generales / Resonancias tab keeps the drawer open: the tab
 *      also changes the active conversation, and that must not close it.
 *   3. After a DIRECT load of /biblioteca, the primary nav still navigates
 *      client-side, with no page errors. 🔴 The audit blocker: with SSR off,
 *      SvelteKit 2.70 passes `from = { url: null }` to `afterNavigate` on the
 *      first client navigation; the layout's scroll reset read
 *      `from.url.pathname`, threw, and every later link became a full reload.
 *      A window marker that survives the click proves no reload happened. The
 *      decision itself is unit-tested in `src/lib/scrollReset.test.ts`.
 *
 * ⚠ `trace` and `video` are off: the sign-in types the seeded admin's password,
 * and a trace would keep it (handoff 10-21).
 */

import { expect, test, devices, type Page } from '@playwright/test';

import { adminCredentials } from './env';

test.use({
  ...devices['iPhone 13'],
  browserName: 'chromium',
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  video: 'off',
  trace: 'off',
});

test.describe.configure({ mode: 'serial' });

async function signIn(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/sign-in');
  await page.waitForLoadState('networkidle');
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  // ⚠ Blank the field before any failure artefact can snapshot it.
  await page
    .locator('input[name="password"]')
    .evaluate((el) => {
      (el as HTMLInputElement).value = '';
    })
    .catch(() => {});
  await page.waitForURL('**/');
}

function collectPageErrors(page: Page): Error[] {
  const errors: Error[] = [];
  page.on('pageerror', (e) => errors.push(e));
  return errors;
}

test('the conversations drawer closes on a pick and stays open on a tab switch', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await signIn(page);
  await page.goto('/?conversaciones');

  const toggle = page.getByTestId('panel-toggle-conversations');
  const drawer = page.getByTestId('panel-conversations');
  const rows = drawer.getByTestId('session-row');

  // ── 1. A pick closes it and returns focus to the toggle ─────────────────
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(drawer.getByRole('tab').first()).toBeVisible();

  // An empty account has nothing to pick; creating one goes through the same
  // `onPick`, so it proves the same rule.
  await page.waitForLoadState('networkidle');
  if ((await rows.count()) > 0) {
    await rows.first().locator('button').first().click();
  } else {
    await drawer.getByRole('button', { name: 'Nueva conversación' }).click();
  }
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();

  // ── 2. A tab switch keeps it open ──────────────────────────────────────
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const resonancias = drawer.getByTestId('session-tab-resonancias');
  const generales = drawer.getByTestId('session-tab-generales');
  await resonancias.click();
  await expect(resonancias).toHaveAttribute('aria-selected', 'true');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await generales.click();
  await expect(generales).toHaveAttribute('aria-selected', 'true');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  expect(errors.map((e) => e.message)).toEqual([]);
});

test('after a direct load of /biblioteca the nav still navigates client-side', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await signIn(page);

  // A DIRECT load: a fresh document, so the next click is the first client
  // navigation, the one that carried `from = { url: null }`.
  await page.goto('/biblioteca');
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => {
    (window as unknown as { __edcNoReload?: string }).__edcNoReload = 'still here';
  });

  await page.getByTestId('nav-grafo').click();
  await page.waitForURL('**/grafo**');

  // A full reload would have wiped the marker.
  const marker = await page.evaluate(
    () => (window as unknown as { __edcNoReload?: string }).__edcNoReload,
  );
  expect(marker).toBe('still here');
  expect(errors.map((e) => e.message)).toEqual([]);
});
