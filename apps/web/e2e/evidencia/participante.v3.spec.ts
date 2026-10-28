import { test } from '@playwright/test';
import { elegirEcosistema, limpiar } from './comun';
import { cerrarSesion, iniciarSesion, instalarSubtitulos } from './escena';
import { hojaDeCalculo, soloV3 } from './v3';

soloV3();

/**
 * V3 (3), on the phone (`movil` project): the participante uploads a
 * spreadsheet into a conversation in Prevención del dengue (org 6) and asks
 * about its numbers. Fixture: `hoja.py` (invented cases by colonia and month).
 * One upload through the gate and the graph (~$0.002) and one chat turn
 * (~$0.004), both quoted.
 */
test('participante', async ({ page }) => {
  await instalarSubtitulos(page, 'Participante');
  await iniciarSesion(page, 'participante');
  try {
    await elegirEcosistema(page);
    // hoja.py: La Esperanza, 23 confirmed cases in September, is the answer.
    await hojaDeCalculo(page, '¿Qué colonia tuvo más casos confirmados de dengue en septiembre?');
  } catch (error) {
    console.error('Falló el recorrido:', error);
    await page.screenshot({ path: test.info().outputPath('antes-de-limpiar.png') });
    throw error;
  } finally {
    await limpiar(page);
  }
  await cerrarSesion(page);
});
