import { test } from '@playwright/test';
import { elegirEcosistema, limpiar } from './comun';
import { cerrarSesion, iniciarSesion, instalarSubtitulos } from './escena';
import { estiloDeRespuesta, soloV3 } from './v3';

soloV3();

const ECO = process.env.EVID_ECOSISTEMA_DISCAPACIDAD ?? 'Discapacidad';

/**
 * V3 (4): Discapacidad (org 7) answers in its own style: the social and
 * human-rights model of disability, the same text for Generales and Resonancias
 * (backend `seed/answerStyleDiscapacidad.ts`, seeded on dev 2026-10-28 per
 * infra/fleet/edc-1.md §4zx). Recorded as investigador-dengue, investigador of
 * 6 and 7, so the picker is shown. Two chat turns (~$0.008, quoted).
 */
test('discapacidad', async ({ page }) => {
  await instalarSubtitulos(page, 'Investigador');
  await iniciarSesion(page, 'investigador-dengue');
  try {
    await elegirEcosistema(page, ECO);
    // Both wordings answered from org 7's corpus on dev before (edc-1.md, the
    // interviewer run: 4 sources; the Resonancias run: one follow-up with [1, 2, 8]).
    await estiloDeRespuesta(
      page,
      '¿Qué dicen los documentos sobre la inscripción escolar?',
      'Mi hijo usa silla de ruedas y la escuela de mi colonia no tiene rampas.',
    );
  } catch (error) {
    console.error('Falló el recorrido:', error);
    await page.screenshot({ path: test.info().outputPath('antes-de-limpiar.png') });
    throw error;
  } finally {
    await limpiar(page, { documentos: false });
  }
  await cerrarSesion(page);
});
