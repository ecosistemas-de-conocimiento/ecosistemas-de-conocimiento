import { test } from '@playwright/test';
import { ECOSISTEMA, biblioteca, conversar, cuidar, elegirEcosistema, limpiar, misDocumentos } from './comun';
import { cerrarSesion, iniciarSesion, instalarSubtitulos } from './escena';


/** Administrador de la plataforma, responsable de varios ecosistemas: todo, más cambiar de ecosistema en Administración. */
test('admin', async ({ page }) => {
  await instalarSubtitulos(page, 'Administración');
  await iniciarSesion(page, 'admin');
  try {
    await elegirEcosistema(page, process.env.EVID_ECOSISTEMA_ADMIN ?? ECOSISTEMA);
    await conversar(
      page,
      '¿Qué iniciativas comunitarias aparecen en los testimonios?',
      'Coordino un grupo de madres que revisa las tareas por WhatsApp.',
    );
    await misDocumentos(page);
    await biblioteca(page);
    await cuidar(page, { cambiarEcosistema: 'dengue', colasDeRevision: ['Discapacidad'] });
    // ⚠ No Conexiones here: on dev 9597969, /grafo renders a blank page for the
    // platform admin in org 6 even after three reloads (measured 2026-10-28),
    // while it loads for the participant and the student. Shown in their videos.
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
