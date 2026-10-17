// RAG errors that more than one service raises.
//
// `CorpusNotFoundError` used to be defined THREE times — in `corpus-crud.ts`,
// `document-validity.ts` and `retrieve.ts` — with the same name and three
// different class identities. Anything holding one of them and testing another
// with `instanceof` silently said "no": `services/context/fetch.ts` swallows
// this error to return an empty context, and it could only ever recognise the
// `retrieve.ts` copy. One definition, re-exported from each of those three
// modules so no import site had to move.

import { NestedEnvelopeError } from '../../errors/base.js';

/**
 * No `corpora` row for the caller's `(org, project, name)`.
 *
 * A corpus owned by ANOTHER tenant lands here too, and deliberately: every
 * lookup filters by scope, so "missing" and "not yours" are indistinguishable
 * by design and neither answer confirms the other tenant's corpus exists.
 *
 * Pass `org`/`project` only where the message already carried them — the
 * retrieve path does, the CRUD and document-validity paths do not, and the
 * text is what consumers see.
 */
export class CorpusNotFoundError extends NestedEnvelopeError {
  readonly code = 'ERR_CORPUS_NOT_FOUND';
  readonly status = 404;
  readonly corpus: string;
  readonly org: string | undefined;
  readonly project: string | undefined;

  constructor(opts: { corpus: string; org?: string; project?: string }) {
    super(
      opts.org !== undefined && opts.project !== undefined
        ? `corpus '${opts.corpus}' not found in (org=${opts.org}, project=${opts.project})`
        : `corpus '${opts.corpus}' not found`,
    );
    this.name = 'CorpusNotFoundError';
    this.corpus = opts.corpus;
    this.org = opts.org;
    this.project = opts.project;
  }
}
