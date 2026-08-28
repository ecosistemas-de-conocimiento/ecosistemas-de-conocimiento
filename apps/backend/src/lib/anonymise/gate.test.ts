/**
 * THE GATE. Every test here uses {@link staticDetector} — no real inference, no
 * network, no spend. That is a hard rule for this file: a suite that quietly
 * bills a model per run is a suite people stop running.
 *
 * The properties under test are the ones that make a `ready` trustworthy:
 *
 *   · the names are actually gone;
 *   · every uncertain outcome is a `hold`, never a `ready`;
 *   · 🔴 the REPORT contains no name — it is the artefact that gets stored, so a
 *     report that quoted the matches would put them back in the database.
 */

import { describe, expect, it } from 'vitest'

import { staticDetector } from './detector'
import { runAnonymisationGate } from './gate'
import type { DetectorFinding, GateInput, PersonDetector } from './types'

const TESTIMONY = [
  'Mi hermana Lucía me acompañó a la clínica el 15 de agosto de 2026.',
  'Ahí nos atendió Ricardo Peña, que trabaja en la Clínica del Valle.',
  'Después le escribí a lucia.mendez@correo.mx desde el 5512345678.',
].join('\n')

/** What a well-behaved detector would return for {@link TESTIMONY}. */
const TESTIMONY_FINDINGS: DetectorFinding[] = [
  { text: 'Lucía', type: 'persona' },
  { text: 'Ricardo Peña', type: 'persona' },
  { text: 'Clínica del Valle', type: 'lugar' },
]

function input(over: Partial<GateInput> = {}): GateInput {
  return { contentKind: 'testimonio', text: TESTIMONY, ...over }
}

/** A detector whose `detect` always throws — the "we do not know" case. */
function throwingDetector(onCall: 1 | 2): PersonDetector {
  let calls = 0
  return {
    name: 'throwing',
    async detect() {
      calls += 1
      if (calls === onCall) throw Object.assign(new Error('boom'), { failureClass: 'transporte' })
      return []
    },
  }
}

describe('runAnonymisationGate — the happy path', () => {
  it('returns ready with the names gone', async () => {
    const result = await runAnonymisationGate(input(), {
      detector: staticDetector(TESTIMONY_FINDINGS),
    })

    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return

    expect(result.redactedText).not.toContain('Lucía')
    expect(result.redactedText).not.toContain('Ricardo Peña')
    expect(result.redactedText).not.toContain('Clínica del Valle')
    expect(result.redactedText).toContain('[Persona A]')
    expect(result.redactedText).toContain('[Dato omitido]')
    expect(result.report.pseudonyms).toBe(2)
  })

  it('coarsens the date and removes the email and phone on the way through', async () => {
    const result = await runAnonymisationGate(input(), {
      detector: staticDetector(TESTIMONY_FINDINGS),
    })
    if (result.status !== 'ready') throw new Error('expected ready')

    expect(result.redactedText).toContain('agosto de 2026')
    expect(result.redactedText).not.toContain('15 de agosto')
    expect(result.redactedText).not.toContain('lucia.mendez@correo.mx')
    expect(result.redactedText).not.toContain('5512345678')
  })

  it('🔴 redacts a testimony with NO roster at all', async () => {
    // The whole point of stage 3: the people in a Voz are not users of this
    // system, so no roster contains them. Dictionary matching cannot be the
    // mechanism here, and this asserts the gate does not depend on it.
    const result = await runAnonymisationGate(input({ roster: [] }), {
      detector: staticDetector(TESTIMONY_FINDINGS),
    })
    if (result.status !== 'ready') throw new Error('expected ready')
    expect(result.redactedText).not.toContain('Ricardo')
    expect(result.report.pseudonyms).toBeGreaterThan(0)
  })

  it('replaces the LONGEST finding first so a full name is not half-eaten', async () => {
    // A model that returns both "Ricardo" and "Ricardo Peña" must not leave
    // "[Persona A] Peña" behind — a surname glued to a pseudonym, in a document
    // that now looks redacted.
    const result = await runAnonymisationGate(input(), {
      detector: staticDetector([
        { text: 'Ricardo', type: 'persona' },
        { text: 'Ricardo Peña', type: 'persona' },
        { text: 'Lucía', type: 'persona' },
      ]),
    })
    if (result.status !== 'ready') throw new Error('expected ready')
    expect(result.redactedText).not.toContain('Peña')
  })

  it('gives the same person one label across stage 2 and stage 3', async () => {
    // One allocator threads the whole pipeline. Two would restart at A and merge
    // two different people into one pseudonym.
    const result = await runAnonymisationGate(
      input({ contentKind: 'conversacion', roster: ['Ana López'] }),
      {
        detector: staticDetector((text) =>
          text.includes('Ana López') ? [{ text: 'Ana López', type: 'persona' }] : [],
        ),
      },
    )
    if (result.status !== 'ready') throw new Error('expected ready')
    expect(result.report.pseudonyms).toBe(1)
  })
})

describe('runAnonymisationGate — 🔴 every uncertain outcome is a hold', () => {
  it('holds at `content` when the detector throws in stage 3', async () => {
    const result = await runAnonymisationGate(input(), { detector: throwingDetector(1) })
    expect(result.status).toBe('hold')
    if (result.status !== 'hold') return
    expect(result.stage).toBe('content')
    expect(result.reason).toContain('transporte')
    // ⚠ The reason names the failure class only.
    expect(result.reason).not.toContain('Lucía')
  })

  it('holds at `verify` when the detector throws in stage 4', async () => {
    const result = await runAnonymisationGate(input(), { detector: throwingDetector(2) })
    expect(result.status).toBe('hold')
    if (result.status !== 'hold') return
    expect(result.stage).toBe('verify')
  })

  it('holds at `verify` when a name survives the scrub', async () => {
    // A detector that misses Ricardo on the first pass and catches him on the
    // second — the exact case stage 4 exists for.
    let calls = 0
    const lateWaker: PersonDetector = {
      name: 'late-waker',
      async detect({ text }) {
        calls += 1
        if (calls === 1) return [{ text: 'Lucía', type: 'persona' }]
        return text.includes('Ricardo Peña') ? [{ text: 'Ricardo Peña', type: 'persona' }] : []
      },
    }

    const result = await runAnonymisationGate(input(), { detector: lateWaker })
    expect(result.status).toBe('hold')
    if (result.status !== 'hold') return
    expect(result.stage).toBe('verify')
    expect(result.reason).toContain('1')
    // 🔴 The count, never the string.
    expect(result.reason).not.toContain('Ricardo')
  })

  it('holds when the text is empty after the structural pass', async () => {
    const result = await runAnonymisationGate(
      input({ text: '   3f2504e0-4f89-11d3-9a0c-0305e82c3301   ' }),
      { detector: staticDetector([]) },
    )
    // The uuid becomes a placeholder, so the body is not literally empty; use a
    // genuinely empty one for the stage assertion.
    expect(result.status).toBe('ready')

    const blank = await runAnonymisationGate(input({ text: '   \n  ' }), {
      detector: staticDetector([]),
    })
    expect(blank.status).toBe('hold')
    if (blank.status !== 'hold') return
    expect(blank.stage).toBe('structural')
  })

  it('does NOT hold on the placeholders it inserted itself', async () => {
    // Stage 4 sees `[Persona A]` and reports "Persona A" as a name. If that
    // counted, the gate would hold on every document it successfully redacted —
    // the safest possible failure, and a completely useless product.
    let calls = 0
    const confused: PersonDetector = {
      name: 'placeholder-confused',
      async detect({ text }) {
        calls += 1
        if (calls === 1) return TESTIMONY_FINDINGS
        return text.includes('[Persona A]') ? [{ text: 'Persona A', type: 'persona' }] : []
      },
    }

    const result = await runAnonymisationGate(input(), { detector: confused })
    expect(result.status).toBe('ready')
  })
})

describe('runAnonymisationGate — 🔴 the report is not a re-identification map', () => {
  it('contains no original name, email, phone or day-precise date', async () => {
    const result = await runAnonymisationGate(input({ roster: ['Ricardo Peña'] }), {
      detector: staticDetector(TESTIMONY_FINDINGS),
    })
    if (result.status !== 'ready') throw new Error('expected ready')

    const serialised = JSON.stringify(result.report)
    for (const secret of [
      'Lucía',
      'Lucia',
      'Ricardo',
      'Peña',
      'Clínica del Valle',
      'lucia.mendez@correo.mx',
      '5512345678',
      '15 de agosto',
    ]) {
      expect(serialised, secret).not.toContain(secret)
    }
  })

  it('carries counts, rule labels and the pseudonym total, and nothing else', async () => {
    const result = await runAnonymisationGate(input(), {
      detector: staticDetector(TESTIMONY_FINDINGS),
    })
    if (result.status !== 'ready') throw new Error('expected ready')

    expect(result.report.stages.map((s) => s.stage)).toEqual([
      'structural',
      'deterministic',
      'content',
      'verify',
    ])
    for (const stage of result.report.stages) {
      for (const row of stage.removed) {
        expect(typeof row.label).toBe('string')
        expect(typeof row.count).toBe('number')
      }
    }
    expect(result.report.model).toBe('static')
  })

  it('keeps a hold report free of the text too', async () => {
    const result = await runAnonymisationGate(input(), { detector: throwingDetector(1) })
    if (result.status !== 'hold') throw new Error('expected hold')
    const serialised = JSON.stringify(result)
    expect(serialised).not.toContain('Lucía')
    expect(serialised).not.toContain('Ricardo')
  })
})

// ---------------------------------------------------------------------------
// DOMICILIOS, END TO END
// ---------------------------------------------------------------------------

describe('runAnonymisationGate — domicilios', () => {
  /** A testimony with an address in it, of the shape that HELD in the live test. */
  const CON_DOMICILIO = [
    'Vivo en Calle Morelos No. 45, Col. Portales, C.P. 03300.',
    'Mi hermana Lucía se quedó en calle morelos no. 45, col. portales, c.p. 03300.',
  ].join('\n')

  /**
   * ⚠ A KNOWN LIMIT, WRITTEN DOWN RATHER THAN HIDDEN. The two lines above are
   * the SAME address spelled two ways, so they fold to one key and share one
   * label. A PARTIAL repeat — "Calle Morelos No. 45" on its own, without the
   * colonia and the postal code — folds to a different key and gets its own
   * label. That over-counts places, which is the safe direction: it never merges
   * two real addresses into one, it only fails to notice that one address was
   * written twice at different lengths.
   */

  it('🔴 removes the address in stage 2 and still returns ready', async () => {
    // The measured failure this closes: the model missed a street address, and
    // stage 4 held the document. Correct, and useless — the address should have
    // been removed. Now it never reaches the model at all.
    const result = await runAnonymisationGate(
      { contentKind: 'testimonio', text: CON_DOMICILIO },
      { detector: staticDetector([{ text: 'Lucía', type: 'persona' }]) },
    )

    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return

    expect(result.redactedText).not.toContain('Morelos')
    expect(result.redactedText).not.toContain('Portales')
    expect(result.redactedText).not.toContain('03300')
    expect(result.redactedText).toContain('[Domicilio A]')
  })

  it('🔴 the same address in two sentences gets the SAME label', async () => {
    const result = await runAnonymisationGate(
      { contentKind: 'testimonio', text: CON_DOMICILIO },
      { detector: staticDetector([{ text: 'Lucía', type: 'persona' }]) },
    )
    if (result.status !== 'ready') throw new Error('expected ready')

    // One house, said twice. Two `[Dato omitido]`s would erase that it was the
    // same house; `[Domicilio B]` would claim it was a different one.
    expect(result.redactedText).not.toContain('[Domicilio B]')
    expect(result.report.addresses).toBe(1)
  })

  it('🔴 stage 4 does not HOLD on our own [Domicilio X] placeholder', async () => {
    /**
     * THE FAILURE THIS PINS IS TOTAL AND SILENT. The verify stage tells "a name
     * the model missed" from "the word `Persona` inside our own placeholder" by
     * matching a fixed placeholder set. Adding a placeholder shape without
     * adding it to that set makes every successfully-redacted document HOLD —
     * the safest possible failure, and a completely useless product.
     *
     * The detector below hands the placeholder itself back as a finding, which
     * is exactly what a real detector does when it reads `[Domicilio A]` and
     * decides it looks like a place.
     */
    const result = await runAnonymisationGate(
      { contentKind: 'testimonio', text: 'Vivo en Calle Morelos No. 45.' },
      { detector: staticDetector([{ text: '[Domicilio A]', type: 'lugar' }]) },
    )

    expect(result.status).toBe('ready')
  })

  it('a `lugar` finding from the model shares the address namespace', async () => {
    // One allocator, two stages — same rule as people. A place the regexes
    // caught and a place the model caught must not both be `[Domicilio A]`
    // unless they are the same place.
    const result = await runAnonymisationGate(
      {
        contentKind: 'testimonio',
        text: 'Vivo en Calle Morelos No. 45 y trabajo en la Clínica del Valle.',
      },
      { detector: staticDetector([{ text: 'Clínica del Valle', type: 'lugar' }]) },
    )

    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return

    expect(result.redactedText).toContain('[Domicilio A]')
    expect(result.redactedText).toContain('[Domicilio B]')
    expect(result.redactedText).not.toContain('Clínica del Valle')
    expect(result.report.addresses).toBe(2)
  })

  it('⚠ the report counts addresses and never quotes one', async () => {
    const result = await runAnonymisationGate(
      { contentKind: 'testimonio', text: CON_DOMICILIO },
      { detector: staticDetector([{ text: 'Lucía', type: 'persona' }]) },
    )
    if (result.status !== 'ready') throw new Error('expected ready')

    const serialized = JSON.stringify(result.report)
    for (const leak of ['Morelos', 'Portales', '03300', 'Lucía']) {
      expect(serialized, leak).not.toContain(leak)
    }
    expect(result.report.addresses).toBe(1)
  })

  it('⚠ an address the gate could not remove still HOLDS — verify is not weakened', async () => {
    /**
     * The owner's instruction was to REMOVE addresses, not to stop holding on
     * them. A free-form address ("enfrente de la tienda de doña Mari") has no
     * shape for stage 2 and can be missed by stage 3; when stage 4 then finds it
     * standing in the output, holding is still the right answer.
     *
     * The detector here finds it only on the SECOND pass — a model that missed
     * it going in and caught it coming out, which is the exact shape of the live
     * failure.
     */
    const text = 'Vivo enfrente de la tienda de doña Mari.'
    let calls = 0
    const missesThenFinds: PersonDetector = {
      name: 'misses-then-finds',
      async detect() {
        calls += 1
        return calls === 1 ? [] : [{ text: 'enfrente de la tienda de doña Mari', type: 'lugar' }]
      },
    }

    const result = await runAnonymisationGate(
      { contentKind: 'testimonio', text },
      { detector: missesThenFinds },
    )

    expect(result.status).toBe('hold')
    if (result.status !== 'hold') return
    expect(result.stage).toBe('verify')
    // ⚠ Counts only. The reason is stored on the row and shown to a reviewer.
    expect(result.reason).not.toContain('Mari')
  })
})
