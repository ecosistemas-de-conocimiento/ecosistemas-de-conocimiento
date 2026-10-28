import { test } from '@playwright/test';
import { soloV3 } from './v3';

soloV3();

/**
 * V3 (5) — STUB until the redesigned /ajustes lands on main. 🔴 No testids
 * are guessed here.
 *
 * Expected flow: the redesigned /ajustes, shown and never saved (F3.1,
 * 'pantalla': no switch saved, no style saved). On main today the page has
 * `ajustes-funciones`, `ajustes-estilo` / `ajustes-estilo-<kind>` (answer style,
 * editable by a platform admin only) and `ajustes-plataforma`
 * (routes/ajustes/+page.svelte); the redesign may rename them.
 * Role: platform admin (the only one who sees every section); confirm with the
 * coordinator when the lane lands. New story ids, if any, go in historias.ts F3.
 */
test.fixme('admin', async () => {
  // TODO(V3-5): implement once the redesigned /ajustes is on main.
});
