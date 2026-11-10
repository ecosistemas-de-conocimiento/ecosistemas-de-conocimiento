/**
 * 🔴 THE ONE PLACE A DOCUMENT'S GATE INPUT IS BUILT (audit 2026-11-10, I-06).
 *
 * `/admin/evals` claimed to run "exactly the calls `anonymiseDocumentText`
 * makes" and had drifted: it dropped `authors` and `keepCitedAuthors`, so the
 * privacy eval could not see the restores added on 2026-11-07. Both callers
 * build the input here, so a new switch reaches the eval the day it reaches
 * production.
 *
 * `options` is `documentoGateOptions`' result (or the same fields passed
 * through `anonymiseDocumentText`'s args). `keepDocumentAuthor` travels as
 * `authors`: they are non-empty only when it is on.
 */

import type { GateContentKind, GateInput } from './types'

export interface GateSwitchOptions {
  roster?: readonly string[]
  keepPublicFigures?: boolean
  authors?: readonly string[]
  keepCitedAuthors?: boolean
}

/**
 * ⚠ `testimonio` IS THE DEFAULT ARM, and the direction matters. The kind only
 * picks which sentence describes the material to the model; the rules are
 * identical. But the `conversacion` prompt tells the model it is reading
 * members of a community talking to each other, and an unrecognised kind is
 * not evidence of that. `testimonio` assumes nothing and holds no roster.
 */
export function gateContentKind(contentKind: unknown): GateContentKind {
  return contentKind === 'conversacion' || contentKind === 'documento' ? contentKind : 'testimonio'
}

export function documentGateInput(contentKind: unknown, text: string, options: GateSwitchOptions): GateInput {
  return {
    contentKind: gateContentKind(contentKind),
    text,
    roster: options.roster ?? [],
    // The gate itself ignores these where they do not apply (`gate.ts`).
    keepPublicFigures: options.keepPublicFigures === true,
    authors: options.authors ?? [],
    keepCitedAuthors: options.keepCitedAuthors === true,
  }
}
