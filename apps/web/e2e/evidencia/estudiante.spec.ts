import { test } from '@playwright/test';
import { biblioteca, conexiones, conversar, elegirEcosistema, limpiar, misDocumentos, miInvestigacion } from './comun';
import { cerrarSesion, escena, iniciarSesion, instalarSubtitulos } from './escena';
import { nuncaEnV3 } from './v3';

// V1/V2 walk-through; `EVID_VIDEO=v3` records `estudiante.v3.spec.ts` instead.
nuncaEnV3();

const ECO = process.env.EVID_ECOSISTEMA_ESTUDIANTE ?? 'Semiosis práctica';

/** Estudiante: lo del participante, más el alcance de búsqueda y Mi investigación. */
test('estudiante', async ({ page }) => {
  await instalarSubtitulos(page, 'Estudiante');
  await iniciarSesion(page, 'estudiante');
  try {
    await elegirEcosistema(page, ECO);
    await escena(page, 'B1.7', async () => {
      await page.getByTestId('chat-alcance').selectOption({ index: 1 });
      await page.waitForTimeout(800);
      await page.getByTestId('chat-alcance').selectOption({ index: 0 });
    });
    await conversar(
      page,
      '¿Qué autores hablan de semiosis en la vida cotidiana?',
      'En mi barrio los letreros de las tiendas mezclan español y zapoteco.',
    );
    await miInvestigacion(page);
    await misDocumentos(page);
    await biblioteca(page, 'signo');
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
