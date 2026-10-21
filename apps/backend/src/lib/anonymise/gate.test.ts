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

import { DETECT_SYSTEM_PROMPT, staticDetector } from './detector'
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

  it('keeps a hold REPORT free of the text too', async () => {
    /**
     * ⚠ THIS ASSERTS ON `result.report`, NOT ON THE WHOLE RESULT, AND THE
     * NARROWING IS DELIBERATE — it used to stringify the entire object.
     *
     * A hold now also carries `redactedText`: the gate's best-effort output at
     * the point of refusal, which by definition still contains whatever verify
     * found. That is not a leak, it is the ONLY thing a human reviewer can act
     * on — the alternative is handing them `extractedText`, the raw original.
     * It is stored in its own `documents.heldText` column that no corpus path
     * reads (see `lib/anonymiseDocument.ts`), and `lib/holdReview.ts` gates who
     * may see it.
     *
     * The rule the counts-only invariant actually protects is unchanged and is
     * what this asserts: THE REPORT is stored, shown in the admin panel and
     * copied into the audit trail, and it must never quote a name.
     */
    const result = await runAnonymisationGate(input(), { detector: throwingDetector(1) })
    if (result.status !== 'hold') throw new Error('expected hold')

    const serialised = JSON.stringify({ report: result.report, reason: result.reason, stage: result.stage })
    expect(serialised).not.toContain('Lucía')
    expect(serialised).not.toContain('Ricardo')
  })

  it('🔴 the survivor spans are OFFSETS, never the strings they point at', async () => {
    // The one new thing a hold carries besides the text. If these were strings
    // they would be a re-identification map with a friendlier field name — and
    // they are stored on the row, where the report's rule would then apply.
    const result = await runAnonymisationGate(
      { contentKind: 'testimonio', text: 'Hablé con Ana Beltrán.' },
      {
        detector: staticDetector((text) =>
          text.includes('[Persona ') ? [] : [{ text: 'Ana Beltrán', type: 'persona' as const }],
        ),
      },
    )
    // Nothing survived here, so assert the shape on a case where something does.
    const held = await runAnonymisationGate(
      { contentKind: 'testimonio', text: 'Hablé con Ana Beltrán.' },
      {
        detector: {
          name: 'misses-then-finds',
          detect: (() => {
            let calls = 0
            return async () => {
              calls += 1
              return calls === 1 ? [] : [{ text: 'Ana Beltrán', type: 'persona' as const }]
            }
          })(),
        },
      },
    )

    expect(result.status).toBe('ready')
    if (held.status !== 'hold') throw new Error('expected hold')
    expect(held.survivors).toEqual([{ start: 10, end: 21, type: 'persona' }])
    expect(JSON.stringify(held.survivors)).not.toContain('Beltrán')
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

describe('runAnonymisationGate — 🔴 a title before a name is part of the name', () => {
  // Measured 2026-10-17 on the local stack: the content stage redacted the name
  // and left the title, and verify held on "Don [Persona F]" and
  // "La maestra [Persona J]". Rodrigo's rule: the title goes with the name.
  const TITLED = [
    'Don Fernando Vázquez nos prestaba su camioneta.',
    'La maestra Imelda nos daba clases los sábados.',
    'Después Fernando Vázquez se fue al norte.',
  ].join('\n')

  /** Stage 3 finds the bare names; stage 4 reports any title still glued to a placeholder. */
  function titleBlindDetector(): PersonDetector {
    let calls = 0
    return {
      name: 'title-blind',
      async detect({ text }) {
        calls += 1
        if (calls === 1) {
          return [
            { text: 'Fernando Vázquez', type: 'persona' },
            { text: 'Imelda', type: 'persona' },
          ]
        }
        return [...text.matchAll(/(?:Don|La maestra) \[Persona [A-Z]+\]/g)].map((m) => ({
          text: m[0],
          type: 'persona' as const,
        }))
      },
    }
  }

  it('verify can no longer see "Don [Persona F]": redaction absorbed the title', async () => {
    const result = await runAnonymisationGate(input({ text: TITLED }), {
      detector: titleBlindDetector(),
    })
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).toBe(
      [
        '[Persona A] nos prestaba su camioneta.',
        '[Persona B] nos daba clases los sábados.',
        'Después [Persona A] se fue al norte.',
      ].join('\n'),
    )
  })

  it('a titled span from the model gets the SAME label as the bare name', async () => {
    const result = await runAnonymisationGate(input({ text: TITLED }), {
      detector: staticDetector([
        { text: 'Don Fernando Vázquez', type: 'persona' },
        { text: 'Fernando Vázquez', type: 'persona' },
        { text: 'La maestra Imelda', type: 'persona' },
      ]),
    })
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.report.pseudonyms).toBe(2)
    expect(result.redactedText).not.toMatch(/Don|maestra/)
  })

  it('a roster name keeps its title out too', async () => {
    const result = await runAnonymisationGate(
      input({
        contentKind: 'conversacion',
        text: 'Le pregunté a doña Ana López.',
        roster: ['Ana López'],
      }),
      {
        detector: staticDetector((text) =>
          /doña \[/i.test(text) ? [{ text: 'doña', type: 'persona' }] : [],
        ),
      },
    )
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).toBe('Le pregunté a [Persona A].')
  })

  it('🔴 "[Persona A] López" still HOLDS: a surname after the placeholder is a leak', async () => {
    let calls = 0
    const result = await runAnonymisationGate(input({ text: 'Don Fernando López nos ayudó.' }), {
      detector: {
        name: 'half',
        async detect({ text }) {
          calls += 1
          if (calls === 1) return [{ text: 'Fernando', type: 'persona' }]
          return text.includes('[Persona A] López')
            ? [{ text: '[Persona A] López', type: 'persona' }]
            : []
        },
      },
    })
    expect(result.status).toBe('hold')
    if (result.status !== 'hold') return
    expect(result.stage).toBe('verify')
    expect(result.redactedText).toBe('[Persona A] López nos ayudó.')
  })

  it('🔴 a bare surname still HOLDS', async () => {
    let calls = 0
    const result = await runAnonymisationGate(
      input({ text: 'La maestra Imelda llegó. Ya conocíamos a Ortiz.' }),
      {
        detector: {
          name: 'half',
          async detect({ text }) {
            calls += 1
            if (calls === 1) return [{ text: 'Imelda', type: 'persona' }]
            return text.includes('Ortiz') ? [{ text: 'Ortiz', type: 'persona' }] : []
          },
        },
      },
    )
    expect(result.status).toBe('hold')
    if (result.status !== 'hold') return
    expect(result.stage).toBe('verify')
  })

  it('a finding that is only placeholders and punctuation is not a leftover', async () => {
    // Measured 2026-10-17: verify reported "[Domicilio AP], [Domicilio AQ]".
    let calls = 0
    const result = await runAnonymisationGate(input({ text: 'Nací en Tlapa, Guerrero.' }), {
      detector: {
        name: 'pairs',
        async detect({ text }) {
          calls += 1
          if (calls === 1) {
            return [
              { text: 'Tlapa', type: 'lugar' },
              { text: 'Guerrero', type: 'lugar' },
            ]
          }
          const m = text.match(/\[Domicilio [A-Z]+\], \[Domicilio [A-Z]+\]/)
          return m ? [{ text: m[0], type: 'lugar' }] : []
        },
      },
    })
    expect(result.status).toBe('ready')
  })

  it('🔴 a title-only finding with no placeholder still HOLDS', async () => {
    let calls = 0
    const result = await runAnonymisationGate(input({ text: 'Llegó Don y se sentó.' }), {
      detector: {
        name: 'title-only',
        async detect() {
          calls += 1
          return calls === 1 ? [] : [{ text: 'Don', type: 'persona' }]
        },
      },
    })
    expect(result.status).toBe('hold')
  })
})

describe('runAnonymisationGate — 🔴 a finding never rewrites inside a placeholder', () => {
  // Measured 2026-10-17, 9,454 words: stage 2 had written "[Domicilio E]", the
  // model then returned part of that placeholder as a finding, and split/join
  // turned every one into "[[Domicilio AH]E]", which verify held on 13 times.
  it('leaves earlier placeholders intact when the model echoes part of one', async () => {
    let calls = 0
    const result = await runAnonymisationGate(
      input({ text: 'Vivo en Tlapa y trabajo con Ana. Tlapa es bonito.' }),
      {
        detector: {
          name: 'echo',
          async detect({ text }) {
            calls += 1
            if (calls === 1) {
              return [
                { text: 'Tlapa', type: 'lugar' },
                { text: 'Ana', type: 'persona' },
              ]
            }
            return []
          },
        },
      },
    )
    expect(result.status).toBe('ready')

    // Now the echo itself: a second content finding that sits inside "[Domicilio A]".
    let n = 0
    const echoed = await runAnonymisationGate(
      input({ text: 'Vivo en Tlapa y trabajo con Ana.' }),
      {
        detector: {
          name: 'echo2',
          async detect() {
            n += 1
            if (n === 1) {
              return [
                { text: 'Tlapa', type: 'lugar' },
                { text: 'Ana', type: 'persona' },
                { text: 'Domicilio', type: 'lugar' },
                { text: 'Persona', type: 'persona' },
              ]
            }
            return []
          },
        },
      },
    )
    expect(echoed.status).toBe('ready')
    if (echoed.status !== 'ready') return
    expect(echoed.redactedText).toBe('Vivo en [Domicilio A] y trabajo con [Persona A].')
  })

  it('still replaces a finding that occurs both inside and outside a placeholder', async () => {
    let n = 0
    const result = await runAnonymisationGate(
      input({ text: 'Vivo en Tlapa. Mi perro se llama Domicilio.' }),
      {
        detector: {
          name: 'both',
          async detect() {
            n += 1
            return n === 1
              ? [
                  { text: 'Tlapa', type: 'lugar' },
                  { text: 'Domicilio', type: 'persona' },
                ]
              : []
          },
        },
      },
    )
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).toBe('Vivo en [Domicilio A]. Mi perro se llama [Persona A].')
  })
})

describe('runAnonymisationGate — common place nouns do not hold a document', () => {
  // The opening of the testimony on dev (2026-10-21, `/revision`, screenshot 81),
  // as it stood after stage 3. Verify flagged "la escuela", "la colonia" and
  // "la barranca" as `lugar` and held it with 7 highlights.
  const SEEN = [
    'Conserje de la escuela, 60 años · Papantla · febrero de 2026',
    'Llegué a la colonia hace 32 años, la que da a la barranca que corre detrás.',
    'La escuela fue lo primero que nos organizó como vecinos.',
  ].join('\n')

  it('is ready when verify flags only common nouns', async () => {
    let calls = 0
    const result = await runAnonymisationGate(
      { contentKind: 'testimonio', text: SEEN },
      {
        detector: {
          name: 'seen-on-dev',
          async detect() {
            calls += 1
            // Stage 3 marks nothing: Papantla is a town, and towns are shown (#12).
            return calls === 1
              ? []
              : [
                  { text: 'la escuela', type: 'lugar' },
                  { text: 'la colonia', type: 'lugar' },
                  { text: 'La escuela', type: 'lugar' },
                ]
          },
        },
      },
    )
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    // The town and the common nouns stay readable.
    expect(result.redactedText).toContain('Papantla')
    expect(result.redactedText).toContain('la colonia')
  })

  it('does not redact a common noun in stage 3 either', async () => {
    const result = await runAnonymisationGate(
      { contentKind: 'testimonio', text: SEEN },
      { detector: staticDetector([{ text: 'la escuela', type: 'lugar' }]) },
    )
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).toContain('Conserje de la escuela')
  })

  it.each([
    ['a named colonia', 'Vivo en la colonia Portales desde niña.', 'la colonia Portales'],
    ['a proper name written like a noun', 'Vivo en La Barranca desde niña.', 'La Barranca'],
    ['a barrio with a name', 'Vivo en el barrio de San Juan.', 'el barrio de San Juan'],
    ['a free-form reference', 'Vivo en la casa de la reja verde.', 'la casa de la reja verde'],
    // ⚠ Off the list since the 2026-10-21 audit: also the name of colonias.
    ['"la barranca" from the dev screenshot', SEEN, 'la barranca'],
    ['"la presa"', 'Ahora vivo en la presa con mis hijos.', 'la presa'],
  ])('🔴 still HOLDS on %s that survives', async (_case, text, finding) => {
    let calls = 0
    const missesThenFinds: PersonDetector = {
      name: 'misses-then-finds',
      async detect() {
        calls += 1
        return calls === 1 ? [] : [{ text: finding, type: 'lugar' }]
      },
    }
    const result = await runAnonymisationGate(
      { contentKind: 'testimonio', text },
      { detector: missesThenFinds },
    )
    expect(result.status).toBe('hold')
    if (result.status !== 'hold') return
    expect(result.stage).toBe('verify')
  })

  it('🔴 still REDACTS a surname spelled like a place noun', async () => {
    const result = await runAnonymisationGate(
      { contentKind: 'testimonio', text: 'Me ayudó la familia de los barrios.' },
      { detector: staticDetector([{ text: 'los barrios', type: 'persona' }]) },
    )
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).not.toContain('barrios')
  })

  it('🔴 a persona finding spelled like a generic noun still HOLDS in verify', async () => {
    let calls = 0
    const result = await runAnonymisationGate(
      { contentKind: 'testimonio', text: 'Me ayudó la familia de la escuela.' },
      {
        detector: {
          name: 'late',
          async detect() {
            calls += 1
            return calls === 1 ? [] : [{ text: 'la escuela', type: 'persona' }]
          },
        },
      },
    )
    expect(result.status).toBe('hold')
  })

  it('🔴 still REDACTS a named place in stage 3', async () => {
    const result = await runAnonymisationGate(
      { contentKind: 'testimonio', text: 'Vivo en la colonia Portales desde niña.' },
      { detector: staticDetector([{ text: 'la colonia Portales', type: 'lugar' }]) },
    )
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).not.toContain('Portales')
  })

  it('🔴 a street address is still gone, even when the model flags only "la calle"', async () => {
    const result = await runAnonymisationGate(
      { contentKind: 'testimonio', text: 'Vivo en calle Morelos No. 45. La calle es tranquila.' },
      { detector: staticDetector([{ text: 'La calle', type: 'lugar' }]) },
    )
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).not.toContain('Morelos')
    expect(result.redactedText).toContain('La calle es tranquila')
  })
})

describe('runAnonymisationGate — 🔴 towns are shown, addresses are not (owner, 2026-10-21, #12)', () => {
  it('the detector prompt says never to mark a town, municipality, city or state', () => {
    expect(DETECT_SYSTEM_PROMPT).toContain('NUNCA marques estados, municipios, alcaldías, ciudades, pueblos')
    expect(DETECT_SYSTEM_PROMPT).toContain('En "vivo en Xoxocotla, Morelos" no hay hallazgo.')
    // A town rule must not narrow the address list or spare a person's name.
    expect(DETECT_SYSTEM_PROMPT).toContain('Marca todo lo de la lista Domicilios aunque esté en una ciudad o pueblo.')
    expect(DETECT_SYSTEM_PROMPT).not.toContain('Marca solo lo que queda dentro')
    expect(DETECT_SYSTEM_PROMPT).toContain('El nombre de una persona SIEMPRE se marca como "persona"')
    expect(DETECT_SYSTEM_PROMPT).toContain('en "mi tía Soledad" el hallazgo es "Soledad"')
    expect(DETECT_SYSTEM_PROMPT).toContain('dijo" el hallazgo es "Dolores".')
    // The old rule — mark a town when it says where someone lives — is gone.
    expect(DETECT_SYSTEM_PROMPT).not.toContain('Márcalo cuando ubique')
    expect(DETECT_SYSTEM_PROMPT).not.toMatch(/municipios cuando ubican un domicilio/)
  })

  it('the detector prompt still asks for streets, colonias, ranchos, parajes, C.P. and house references', () => {
    for (const kept of [
      'Calles, avenidas',
      'Colonias, barrios, fraccionamientos',
      'Ranchos y parajes',
      'Códigos postales',
      'la casa de la reja verde',
    ]) {
      expect(DETECT_SYSTEM_PROMPT, kept).toContain(kept)
    }
  })

  it('keeps "vivo en Xoxocotla, Morelos" when the detector follows the prompt', async () => {
    const text = 'Vivo en Xoxocotla, Morelos, y trabajo en la Alcaldía Iztapalapa.'
    const result = await runAnonymisationGate(
      { contentKind: 'testimonio', text },
      { detector: staticDetector([]) },
    )
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).toBe(text)
    expect(result.report.addresses ?? 0).toBe(0)
  })

  it.each([
    ['calle Morelos 45', 'Vivo en calle Morelos 45, Xoxocotla, Morelos.', 'calle Morelos 45'],
    ['colonia Portales', 'Vivo en la colonia Portales, en la Ciudad de México.', 'colonia Portales'],
    ['the rancho', 'Vivimos en el rancho Los Pinos, en Tlaquiltenango.', 'rancho Los Pinos'],
  ])('🔴 still redacts %s and keeps the town beside it', async (_case, text, finding) => {
    const result = await runAnonymisationGate(
      { contentKind: 'testimonio', text },
      { detector: staticDetector([{ text: finding, type: 'lugar' }]) },
    )
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).not.toContain(finding)
    expect(result.redactedText).toContain('[Domicilio A]')
    for (const town of ['Xoxocotla', 'Ciudad de México', 'Tlaquiltenango']) {
      if (text.includes(town)) expect(result.redactedText).toContain(town)
    }
  })

  it('🔴 C.P. 06700 is redacted in code, with no help from the model', async () => {
    const result = await runAnonymisationGate(
      { contentKind: 'testimonio', text: 'Vivo en Xoxocotla, Morelos, C.P. 06700.' },
      { detector: staticDetector([]) },
    )
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).toBe('Vivo en Xoxocotla, Morelos, [Domicilio A].')
  })
})

describe('runAnonymisationGate — one count on the whole review screen', () => {
  function lateDetector(name: string): PersonDetector {
    let calls = 0
    return {
      name: 'late',
      async detect() {
        calls += 1
        return calls === 1 ? [] : [{ text: name, type: 'persona' }]
      },
    }
  }

  it('the reason counts every highlighted occurrence, like the badge', async () => {
    // One name, three times: the badge and the chips show 3 highlights, so the
    // reason must say 3, not "1 finding". Dev showed 7 next to 4 (2026-10-21).
    const result = await runAnonymisationGate(
      { contentKind: 'testimonio', text: 'Rosa llegó. Rosa habló. Luego Rosa se fue.' },
      { detector: lateDetector('Rosa') },
    )
    expect(result.status).toBe('hold')
    if (result.status !== 'hold') return
    expect(result.survivors).toHaveLength(3)
    expect(result.reason).toBe(
      'Quedaron 3 datos que podrían identificar a alguien. Todavía no se agregó a la búsqueda.',
    )
    expect(result.reason).not.toContain('Rosa')
    expect(result.reason).not.toMatch(/ingiri|ingerir|\(s\)|\(es\)/)
  })

  it('says 1 dato in the singular', async () => {
    const result = await runAnonymisationGate(
      { contentKind: 'testimonio', text: 'Habló Rosa.' },
      { detector: lateDetector('Rosa') },
    )
    if (result.status !== 'hold') throw new Error('expected hold')
    expect(result.reason).toBe(
      'Quedó 1 dato que podría identificar a alguien. Todavía no se agregó a la búsqueda.',
    )
  })
})
