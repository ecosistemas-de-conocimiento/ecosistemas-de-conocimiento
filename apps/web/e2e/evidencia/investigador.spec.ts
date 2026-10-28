import { test } from '@playwright/test';
import { biblioteca, conexiones, conversar, cuidar, elegirEcosistema, limpiar, misDocumentos, seguimiento } from './comun';
import { cerrarSesion, iniciarSesion, instalarSubtitulos } from './escena';
import { nuncaEnV3 } from './v3';

// V1/V2 walk-through; `EVID_VIDEO=v3` records `investigador.v3.spec.ts` instead.
nuncaEnV3();

const ECO = process.env.EVID_ECOSISTEMA_INVESTIGADOR ?? 'Semiosis práctica';

/** Investigador: conversa y aporta, acompaña estudiantes y cuida su ecosistema. */
test('investigador', async ({ page }) => {
  await instalarSubtitulos(page, 'Investigador');
  await iniciarSesion(page, 'investigador');
  try {
    await elegirEcosistema(page, ECO);
    await conversar(
      page,
      '¿Qué temas se repiten en los trabajos de los estudiantes?',
      'En el seminario notamos que los estudiantes eligen temas de su propia comunidad.',
    );
    await misDocumentos(page);
    await biblioteca(page, 'signo');
    await seguimiento(page);
    await cuidar(page);
    // Last: the graph is the slowest screen on dev while backfills run.
    await conexiones(page, 'signo');
  } catch (error) {
    // What failed, and what the screen looked like, before cleanup paints over
    // both (an error thrown in `finally` would replace this one in the report).
    console.error('Falló el recorrido:', error);
    await page.screenshot({ path: test.info().outputPath('antes-de-limpiar.png') });
    throw error;
  } finally {
    // Cleanup runs even when a story fails: what the run made must not stay on dev.
    await limpiar(page);
  }
  await cerrarSesion(page);
});
