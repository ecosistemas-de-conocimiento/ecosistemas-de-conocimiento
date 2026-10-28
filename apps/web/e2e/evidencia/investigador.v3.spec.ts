import { test } from '@playwright/test';
import { elegirEcosistema, limpiar } from './comun';
import { cerrarSesion, iniciarSesion, instalarSubtitulos } from './escena';
import { conexionesV3, panoramaDelCorpus, soloV3 } from './v3';

soloV3();

const ECO = process.env.EVID_ECOSISTEMA_INVESTIGADOR ?? 'Semiosis práctica';

/**
 * V3 (1): Semiosis práctica (org 8) after the new readings. Conexiones with its
 * count line, a topic's panel and a connection a note's `[[enlace]]` made
 * (pin the pair with EVID_V3_TEMA / EVID_V3_VECINO, see `v3.ts`), then a
 * question about the corpus as a whole. One chat turn (~$0.004, quoted).
 */
test('investigador', async ({ page }) => {
  await instalarSubtitulos(page, 'Investigador');
  await iniciarSesion(page, 'investigador');
  try {
    // One ecosistema: no picker, no story (`elegirEcosistema`).
    await elegirEcosistema(page, ECO);
    await conexionesV3(page);
    // 🔴 Worded to match the overview detector (apps/web `lib/server/engine/overview.ts`
    // isCorpusOverview): "…el corpus de Semiosis práctica?" does NOT match
    // (a name after the noun reads as a topic; checked 2026-10-28), "…de este ecosistema?" does.
    await panoramaDelCorpus(page, '¿Qué temas recorre el corpus de este ecosistema?');
  } catch (error) {
    console.error('Falló el recorrido:', error);
    await page.screenshot({ path: test.info().outputPath('antes-de-limpiar.png') });
    throw error;
  } finally {
    await limpiar(page, { documentos: false });
  }
  await cerrarSesion(page);
});
