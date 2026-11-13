import { expect, test, type Page, type Request } from '@playwright/test';
import { adminCredentials } from './env';
import { consentInPanel } from './consent';

/**
 * 🔴 The per-resource upload consent (Etapa 1 correction, 2026-11-12):
 * subir en Mis documentos, adjuntar en el chat y crear una nota, each with the
 * checkbox. Unticked, nothing goes up; ticked, the request carries
 * `uploadConsentVersion` and the backend answers with the document.
 *
 * Needs the live stack WITH the backend side of the contract (lane B:
 * `consent-receipts`, the 400/409 refusals). Small generated Markdown files,
 * no corpus fixtures.
 */

test.use({ launchOptions: { slowMo: 350 } });

const RUN = `consent-${Date.now()}`;

function markdown(name: string): { name: string; mimeType: string; buffer: Buffer } {
  return { name, mimeType: 'text/markdown', buffer: Buffer.from(`# ${name}\n\nTexto de prueba ${RUN}.\n`) };
}

function carriesConsent(req: Request): boolean {
  const body = req.postDataBuffer();
  if (!body) return false;
  const text = body.toString('utf8');
  // Multipart: the `uploadConsentVersion` field; JSON: the property.
  return /name="uploadConsentVersion"\r\n\r\n\d+/.test(text) || /"uploadConsentVersion":\d+/.test(text);
}

async function signIn(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page
    .locator('input[name="password"]')
    .evaluate((el) => ((el as HTMLInputElement).value = ''))
    .catch(() => {});
  await page.waitForURL('**/');
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test('Mis documentos: "Subir" asks for the checkbox before it sends', async ({ page }) => {
  await page.goto('/documentos');
  await page.getByTestId('owned-upload').click();
  const sheet = page.getByTestId('upload-sheet');
  const chooser = page.waitForEvent('filechooser');
  await sheet.getByTestId('upload-choose').click();
  await (await chooser).setFiles(markdown(`${RUN}-subida.md`));

  // Always a confirmation step, unticked.
  await expect(sheet.getByTestId('upload-consent')).not.toBeChecked();
  await expect(sheet.getByTestId('upload-send')).toBeDisabled();
  await expect(sheet.getByRole('link', { name: 'aviso de privacidad' })).toHaveAttribute('href', '/privacidad');

  await sheet.getByTestId('upload-consent').check();
  const sent = page.waitForResponse((r) => r.url().endsWith('/api/documentos') && r.request().method() === 'POST');
  await sheet.getByTestId('upload-send').click();
  const res = await sent;
  expect(carriesConsent(res.request())).toBe(true);
  expect(res.ok(), `subida: HTTP ${res.status()}`).toBe(true);
  await expect(sheet.getByTestId('upload-done')).toBeVisible();

  const id = String(((await res.json()) as { doc: { id: string | number } }).doc.id);
  await sheet.getByTestId('upload-close').click();
  await expect(page.getByTestId(`constancia-${id}`)).toHaveAttribute('href', `/documentos/${id}/constancia`);
});

test('Mis documentos: "Nueva nota" keeps Guardar off until the checkbox', async ({ page }) => {
  await page.goto('/documentos');
  await page.getByTestId('owned-new-note').click();
  await page.getByTestId('note-title').fill(`${RUN}-nota`);
  await page.getByTestId('note-body').fill(`Nota de prueba ${RUN}.`);
  await expect(page.getByTestId('note-save')).toBeDisabled();

  await page.getByTestId('note-consent').check();
  const sent = page.waitForResponse(
    (r) => /\/api\/sessions\/[^/]+\/documents$/.test(r.url()) && r.request().method() === 'POST',
  );
  await page.getByTestId('note-save').click();
  const res = await sent;
  expect(carriesConsent(res.request())).toBe(true);
  expect(res.ok(), `nota: HTTP ${res.status()}`).toBe(true);
});

test('chat: "Subir" opens the checkbox before the file picker', async ({ page }) => {
  await page.goto('/');
  const open = page.getByRole('button', { name: 'Abrir documentos' });
  if (await open.isVisible().catch(() => false)) await open.click();
  const panel = page.locator('aside').filter({ has: page.getByRole('heading', { name: 'Documentos' }) });

  await panel.getByTestId('panel-upload').click();
  await expect(panel.getByTestId('panel-consent-check')).not.toBeChecked();
  await expect(panel.getByTestId('panel-consent-go')).toBeDisabled();

  const sent = page.waitForResponse(
    (r) => /\/api\/sessions\/[^/]+\/documents$/.test(r.url()) && r.request().method() === 'POST',
  );
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), consentInPanel(panel)]);
  await chooser.setFiles(markdown(`${RUN}-chat.md`));
  const res = await sent;
  expect(carriesConsent(res.request())).toBe(true);
  expect(res.ok(), `adjuntar: HTTP ${res.status()}`).toBe(true);
});
