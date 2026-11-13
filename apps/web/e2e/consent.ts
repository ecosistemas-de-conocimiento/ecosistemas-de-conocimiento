import type { Locator, Page } from '@playwright/test';

/**
 * 🔴 The per-resource upload consent (`src/lib/uploadConsent.ts`): every entry
 * point now asks first. These tick it and go on, so a flow that only wants the
 * upload reads as before.
 */

/** Chat panel: "Subir" / "Nota" open the checkbox; this ticks it and clicks
 *  "Elegir archivo" / "Crear nota" (which opens the picker / creates the note). */
export async function consentInPanel(scope: Page | Locator): Promise<void> {
  await scope.getByTestId('panel-consent-check').check();
  await scope.getByTestId('panel-consent-go').click();
}

/** Mic: the first tap on "Grabar" opens the checkbox; this ticks it and starts. */
export async function startRecordingWithConsent(page: Page): Promise<void> {
  await page.getByTestId('mic-start').click();
  await page.getByTestId('mic-consent-check').check();
  await page.getByTestId('mic-consent-go').click();
}
