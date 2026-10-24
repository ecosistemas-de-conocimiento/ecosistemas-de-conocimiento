/**
 * 🔴 ai-service masks addresses, phones, emails, CURP, RFC (and names, when its
 * NER runs) in every outgoing prompt. The detector's model then sees
 * "[DIRECCION]" where the text says "calle Hidalgo 45", reports the token, and
 * the token is not in the text. Dropping that finding shipped the street
 * (measured 3/3 runs). It must HOLD instead.
 */

import { describe, expect, it } from 'vitest'

import { aiServiceDetector, DetectorFailure, parseFindings, type SyncGenerator } from './detector'
import { runAnonymisationGate } from './gate'

const TEXT = 'Vivíamos en calle Hidalgo 45 con mi tía Eustolia.'

/** A model that answers `raw` for stage 3 and `verifyRaw` (default: nothing) after. */
function fakeModel(raw: string, verifyRaw = '{"hallazgos":[]}'): SyncGenerator {
  let n = 0
  return {
    generate: {
      sync: async () => ({ text: n++ === 0 ? raw : verifyRaw }),
    },
  }
}

const answer = (...textos: string[]) =>
  JSON.stringify({ hallazgos: textos.map((texto) => ({ texto, tipo: 'persona' })) })

function thrown(fn: () => unknown): unknown {
  try {
    fn()
  } catch (err) {
    return err
  }
  return undefined
}

describe('parseFindings — ai-service mask tokens', () => {
  it.each(['[DIRECCION]', 'la [DIRECCION]', '[TELEFONO]', '[EMAIL]', '[CURP]', '[RFC]', '[NOMBRE]'])(
    '🔴 %s not in the text throws dato-enmascarado, not retryable',
    (token) => {
      const err = thrown(() => parseFindings(answer('Eustolia', token), TEXT))
      expect(err).toBeInstanceOf(DetectorFailure)
      const failure = err as DetectorFailure
      expect(failure.failureClass).toBe('dato-enmascarado')
      expect(failure.infrastructure).toBe(false)
      // Plain Spanish, and never the document text.
      expect(failure.message).toMatch(/enmascar/)
      expect(failure.message).not.toContain('Hidalgo')
    },
  )

  it('🔴 a lower-case or accented spelling of the token counts too', () => {
    for (const token of ['[direccion]', '[Dirección]', 'su [teléfono]']) {
      const err = thrown(() => parseFindings(answer(token), TEXT))
      expect((err as DetectorFailure).failureClass).toBe('dato-enmascarado')
    }
  })

  it('a real finding is still returned', () => {
    expect(parseFindings(answer('Eustolia'), TEXT)).toEqual([{ text: 'Eustolia', type: 'persona' }])
  })

  it("EDC's own placeholders are not mask tokens: a [Domicilio A] finding is not a hold", () => {
    const redacted = 'Vivíamos en [Domicilio A] con mi tía [Persona A].'
    expect(parseFindings(answer('[Domicilio A]', '[Persona A]'), redacted)).toEqual([])
  })

  it('a text that really contains "[DIRECCION]" is located like any other span', () => {
    // An earlier tool's placeholder style. The finding occurs in the text, so it
    // is a redaction we can perform, not evidence of masking.
    const text = 'Vivíamos en [DIRECCION] con mi tía Eustolia.'
    expect(parseFindings(answer('[DIRECCION]'), text)).toEqual([
      { text: '[DIRECCION]', type: 'persona' },
    ])
  })

  it('🔴 …but a masked finding that cannot be located still holds, even then', () => {
    // The text holds the literal token AND a real street the prompt masked;
    // "la [DIRECCION]" is not in the text, so it is the masked street.
    const text = 'Antes: [DIRECCION]. Vivíamos en la calle Hidalgo 45.'
    const err = thrown(() => parseFindings(answer('la [DIRECCION]'), text))
    expect((err as DetectorFailure).failureClass).toBe('dato-enmascarado')
  })
})

describe('🔴 through the gate', () => {
  it('stage 3 answering "[DIRECCION]" holds the document with that reason', async () => {
    const result = await runAnonymisationGate(
      { contentKind: 'testimonio', text: TEXT },
      { detector: aiServiceDetector({ client: fakeModel(answer('Eustolia', '[DIRECCION]')) }) },
    )
    expect(result.status).toBe('hold')
    if (result.status !== 'hold') return
    expect(result.stage).toBe('content')
    expect(result.reason).toContain('(dato-enmascarado)')
    expect(result.retryable).toBeUndefined()
  })

  it('stage 4 answering "la [DIRECCION]" holds at verify', async () => {
    const result = await runAnonymisationGate(
      { contentKind: 'testimonio', text: TEXT },
      {
        detector: aiServiceDetector({
          client: fakeModel(answer('Eustolia'), answer('la [DIRECCION]')),
        }),
      },
    )
    expect(result.status).toBe('hold')
    if (result.status !== 'hold') return
    expect(result.stage).toBe('verify')
    expect(result.reason).toContain('(dato-enmascarado)')
    expect(result.retryable).toBeUndefined()
  })

  it('a real finding is still redacted and the document is ready', async () => {
    const result = await runAnonymisationGate(
      { contentKind: 'testimonio', text: TEXT },
      { detector: aiServiceDetector({ client: fakeModel(answer('Eustolia')) }) },
    )
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).not.toContain('Eustolia')
  })
})
