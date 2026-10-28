import { test } from '@playwright/test';
import { soloV3 } from './v3';

soloV3();

/**
 * V3 (2) — STUB until the student-note edit lane and the redesigned student
 * view land on main. 🔴 No testids are guessed here: fill this in from the
 * landed UI.
 *
 * Expected flow (owner plan via coordinator, 2026-10-28), estudiante1 in
 * Semiosis práctica (org 8):
 *   A1.1  Iniciar sesión.
 *   C1.2  Escribir una nota — in a conversation's documents panel, titled
 *         `${RUN_ID}-nota` so cleanup finds it; its text should carry one or
 *         two `[[enlaces]]` to topics the graph already has.
 *   C3.2  Publicar mi nota — the note's "Publicar" (on main since 9dc40b2:
 *         DocsPanel.svelte, Button `publish-<id>`, label "Publicar en mi
 *         ecosistema"; it may be relabelled by the lane). Wait for the gate,
 *         the ingest and the auto-publish (`seguirChip` in comun.ts).
 *   E1.1  Ver mis temas — /estudiante (redesigned view): the note's topics
 *         appear under Mis temas.
 *   C3.3  Publicar los cambios de mi nota — edit the note, press
 *         "Publicar cambios" (NOT on main yet), see Mis temas follow.
 *   C2.6 / B1.6  `limpiar(page)` in `finally`.
 * Cost (inferred from 9dc40b2's message): each Publicar on new text = 1 gate
 * run + 1 draft embed + graph windows + 1 publish re-embed, ~$0.002 each
 * (quoted per-document figure).
 */
test.fixme('estudiante', async () => {
  // TODO(V3-2): implement once "Publicar cambios" and the new /estudiante are on main.
});
