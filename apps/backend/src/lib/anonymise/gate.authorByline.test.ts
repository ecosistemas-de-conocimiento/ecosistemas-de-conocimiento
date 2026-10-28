/**
 * A byline through the WHOLE gate. Stage 1 removes "Autor: Juan Pérez"; the
 * person it names must come out with the SAME `[Persona X]` the body gives
 * them, from the one allocator the gate threads through every stage. A
 * `[Dato omitido]` here would hide that the author and "Pérez" in the body are
 * one person; a fresh label would claim they are two.
 *
 * staticDetector only — no inference, no spend.
 */

import { describe, expect, it } from 'vitest'

import { staticDetector } from './detector'
import { runAnonymisationGate } from './gate'

describe('runAnonymisationGate — author bylines', () => {
  it('labels the byline author with the label the body gives them', async () => {
    const text = 'Autor: Juan Pérez\n\nJuan Pérez llegó tarde. Pérez no dijo nada.'
    const result = await runAnonymisationGate(
      { contentKind: 'documento', text },
      { detector: staticDetector([{ text: 'Juan Pérez', type: 'persona' }]) },
    )
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).not.toContain('Juan')
    expect(result.redactedText).not.toContain('Pérez')
    expect(result.redactedText).toBe(
      'Autor: [Persona A]\n\n[Persona A] llegó tarde. [Persona A] no dijo nada.',
    )
    expect(result.report.pseudonyms).toBe(1)
  })

  it('removes a byline surname the detector never reports anywhere', async () => {
    // Fail closed on stage 1 alone: the model finds nothing, the name still goes,
    // and its parts are spread so a bare "Pérez" in the body goes too.
    const text = 'Autores: Ana Ruiz y Luis Gómez\n\nGómez revisó el texto.'
    const result = await runAnonymisationGate(
      { contentKind: 'documento', text },
      { detector: staticDetector([]) },
    )
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    for (const w of ['Ana', 'Ruiz', 'Luis', 'Gómez']) expect(result.redactedText).not.toContain(w)
    expect(result.redactedText).toBe('Autores: [Persona A] y [Persona B]\n\n[Persona B] revisó el texto.')
  })
})
