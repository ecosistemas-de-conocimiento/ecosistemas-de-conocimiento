import { test } from '@playwright/test';
import { biblioteca, conexiones, conversar, elegirEcosistema, limpiar, misDocumentos } from './comun';
import { cerrarSesion, iniciarSesion, instalarSubtitulos } from './escena';

/** Participante (`member`): conversa, aporta y explora. Ve cuatro secciones. */
test('participante', async ({ page }) => {
  await instalarSubtitulos(page, 'Participante');
  await iniciarSesion(page, 'participante');
  try {
    await elegirEcosistema(page);
    await conversar(
      page,
      '¿Qué hacen las familias para acompañar las tareas escolares?',
      'En mi colonia hacemos un círculo de lectura los sábados en la biblioteca comunitaria.',
    );
    await misDocumentos(page);
    await biblioteca(page);
    await conexiones(page);
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
