import { test } from '@playwright/test';
import { audio, biblioteca, conexiones, conversar, elegirEcosistema, limpiar, misDocumentos } from './comun';
import { cerrarSesion, iniciarSesion, instalarSubtitulos } from './escena';
import { nuncaEnV3 } from './v3';

// V1/V2 walk-through; `EVID_VIDEO=v3` records `participante.v3.spec.ts` instead.
nuncaEnV3();

/** Participante (`member`): conversa, aporta y explora. Ve cuatro secciones. */
test('participante', async ({ page }) => {
  await instalarSubtitulos(page, 'Participante');
  await iniciarSesion(page, 'participante');
  try {
    await elegirEcosistema(page);
    await conversar(
      page,
      '¿Qué hacen los vecinos para eliminar criaderos de mosquitos?',
      'En mi colonia los sábados revisamos los patios y tapamos los tambos de agua.',
    );
    await audio(page);
    await misDocumentos(page);
    await biblioteca(page, 'dengue');
    await conexiones(page, 'mosquito');
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
