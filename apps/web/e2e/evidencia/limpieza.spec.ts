import { test } from '@playwright/test';
import { elegirEcosistema, limpiar } from './comun';
import { cerrarSesion, iniciarSesion, instalarSubtitulos, type Cuenta } from './escena';

/**
 * Deletes what an interrupted run left behind (`evid-<timestamp>` documents and
 * conversations), for one account in one ecosistema:
 * `EVID_LIMPIAR=participante EVID_ECOSISTEMA='Prevención del dengue'`. Skipped otherwise.
 */
const cuenta = process.env.EVID_LIMPIAR as Cuenta | undefined;

test('limpieza', async ({ page }) => {
  test.skip(!cuenta, 'EVID_LIMPIAR no está definido');
  await instalarSubtitulos(page, 'Limpieza');
  await iniciarSesion(page, cuenta!);
  await elegirEcosistema(page);
  await limpiar(page);
  await cerrarSesion(page);
});
