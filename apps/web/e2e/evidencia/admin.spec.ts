import { test } from '@playwright/test';
import { ECOSISTEMA, biblioteca, conexiones, conversar, cuidar, elegirEcosistema, limpiar, misDocumentos } from './comun';
import { cerrarSesion, iniciarSesion, instalarSubtitulos } from './escena';
import { nuncaEnV3 } from './v3';

// V1/V2 walk-through; `EVID_VIDEO=v3` records `admin.v3.spec.ts` instead.
nuncaEnV3();


/** Administrador de la plataforma, responsable de varios ecosistemas: todo, más cambiar de ecosistema en Administración. */
test('admin', async ({ page }) => {
  await instalarSubtitulos(page, 'Administración');
  await iniciarSesion(page, 'admin');
  try {
    await elegirEcosistema(page, process.env.EVID_ECOSISTEMA_ADMIN ?? ECOSISTEMA);
    await conversar(
      page,
      '¿Cómo se organizó el comité contra el dengue?',
      'Coordino un grupo de vecinas que avisa por WhatsApp cuándo pasa la fumigación.',
    );
    await misDocumentos(page);
    await biblioteca(page, 'dengue');
    await cuidar(page, { cambiarEcosistema: 'dengue', colasDeRevision: ['Discapacidad'] });
    // Last: the graph is the slowest screen on dev. (It once rendered
    // blank for everyone in org 6 — a hung edges query, since fixed.)
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
