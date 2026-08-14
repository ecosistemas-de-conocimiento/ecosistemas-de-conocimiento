// ai-service's own retrieval golden set — `gs-ai-2026-07`.
//
// 43 items over the synthetic corpus in `structured-corpus.ts`. This is the
// regression gate for THIS repo's retrieval machinery, and nothing more.
//
// IT ENCODES NO PRODUCT'S DOMAIN, deliberately (ADR-0001). Every query, every
// document and every identifier below is invented, and the subject matter is
// chosen to belong to no consumer. What the items exercise is document SHAPE —
// suffixed numbering, superseded editions, exact-identifier recall — which is
// what the retrieval machinery is actually responsible for. A consumer's own
// golden set, encoding its own domain, stays with that consumer and maps onto
// `GoldenItem` field-for-field; see `src/eval/types.ts` for the seam.
//
// TAGS — every item carries at least one, because the aggregate number is not
// the interesting part. A config that raises overall pass rate while dropping
// `validity` from 100% is a config that must not ship, and only the per-tag
// breakdown shows that.
//
//   exact-identifier — the query names a section number, standard code, or
//                      metric id. THE reason rung 1 exists: dense embeddings
//                      carry almost no signal for these tokens.
//   topical          — ordinary semantic query. Should already work; here to
//                      catch a hybrid config that REGRESSES the easy cases,
//                      which is the standard way fusion goes wrong.
//   validity         — a point-in-time query where the superseded edition must
//                      not appear. Correctness floor, not a quality metric.
//   structural       — asserts the chunker put the boundary at the right
//                      section, so a citation resolves to one addressable unit.
//   distractor       — a near-miss document exists with overlapping vocabulary.

import type { GoldenItem } from '../types.js';
import { BEFORE_SUPERSESSION, FIXTURE_CORPUS as C, NOW } from './structured-corpus.js';

export const GOLDEN_SET_VERSION = 'gs-ai-2026-07';

const OLD = 'handbook-2010';
const NEW = 'handbook-2025';
const ACCESS = 'access-policy';
const SPEC = 'risk-standard';
const METRICS = 'metrics-table';

/** Markers that only ever appear in the superseded edition. */
const SUPERSEDED_MARKERS = ['Northgate Review Board', '2010 EDITION'];

export const GOLDEN_SET: GoldenItem[] = [
  // ── validity: the superseded-edition trap ────────────────────────────────
  // These are the highest-severity items in the set. Each asks a question both
  // editions answer, at an instant where only one is in force.
  {
    id: 'vig-01',
    kind: 'citation_groundedness',
    corpus: C,
    query: 'what must the disclosure notice contain',
    asOf: NOW,
    relevantDocs: [NEW],
    mustContain: ['disclosure notice'],
    mustNotContain: SUPERSEDED_MARKERS,
    tags: ['validity', 'topical', 'distractor'],
    note: 'Both editions have a section 12 about disclosure notices. Only the 2025 one is in force.',
  },
  {
    id: 'vig-02',
    kind: 'citation_groundedness',
    corpus: C,
    query: 'which is the competent authority for personal records',
    asOf: NOW,
    relevantDocs: [NEW],
    mustContain: ['Ridgeway Standards Office'],
    mustNotContain: SUPERSEDED_MARKERS,
    tags: ['validity', 'topical'],
    note: 'The retired supervising body must never be returned as current. This is the citation that would embarrass us.',
  },
  {
    id: 'vig-03',
    kind: 'retrieval_relevance',
    corpus: C,
    query: 'express consent for sensitive personal records',
    asOf: NOW,
    relevantDocs: [NEW],
    mustNotContain: SUPERSEDED_MARKERS,
    tags: ['validity', 'topical', 'distractor'],
  },
  {
    id: 'vig-04',
    kind: 'retrieval_relevance',
    corpus: C,
    query: 'transfers of personal records to third parties',
    asOf: NOW,
    relevantDocs: [NEW],
    mustNotContain: SUPERSEDED_MARKERS,
    tags: ['validity', 'topical', 'distractor'],
  },
  {
    id: 'vig-05',
    kind: 'retrieval_relevance',
    corpus: C,
    query: 'violations and penalties concerning personal records',
    asOf: NOW,
    relevantDocs: [NEW],
    mustNotContain: SUPERSEDED_MARKERS,
    tags: ['validity', 'topical', 'distractor'],
  },
  {
    id: 'vig-06',
    kind: 'retrieval_relevance',
    corpus: C,
    query: 'rights of access correction deletion and objection',
    asOf: NOW,
    relevantDocs: [NEW],
    mustNotContain: SUPERSEDED_MARKERS,
    tags: ['validity', 'topical', 'distractor'],
  },
  {
    id: 'vig-07',
    kind: 'retrieval_relevance',
    corpus: C,
    query: 'purpose of the handbook on personal records',
    asOf: NOW,
    relevantDocs: [NEW],
    mustNotContain: SUPERSEDED_MARKERS,
    tags: ['validity', 'topical', 'distractor'],
  },
  {
    id: 'vig-08',
    kind: 'retrieval_relevance',
    corpus: C,
    query: 'section 12 disclosure notice',
    asOf: NOW,
    relevantDocs: [NEW],
    relevantSections: [{ section: '12' }],
    mustNotContain: SUPERSEDED_MARKERS,
    tags: ['validity', 'exact-identifier', 'distractor'],
  },
  {
    id: 'vig-09',
    kind: 'retrieval_relevance',
    corpus: C,
    query: 'section 19 competent authority',
    asOf: NOW,
    relevantDocs: [NEW],
    relevantSections: [{ section: '19' }],
    mustNotContain: SUPERSEDED_MARKERS,
    tags: ['validity', 'exact-identifier', 'distractor'],
  },
  // The mirror image: retrieving AS OF a date when the old edition WAS in
  // force must return the old edition. A filter that just hides everything old
  // would pass every item above and fail these — which is why they exist.
  {
    id: 'vig-10',
    kind: 'citation_groundedness',
    corpus: C,
    query: 'which is the competent authority for personal records',
    asOf: BEFORE_SUPERSESSION,
    relevantDocs: [OLD],
    mustContain: ['Northgate Review Board'],
    tags: ['validity', 'point-in-time'],
    note: 'Historical query. The superseded edition is the CORRECT answer as of 2020.',
  },
  {
    id: 'vig-11',
    kind: 'retrieval_relevance',
    corpus: C,
    query: 'disclosure notice minimum content',
    asOf: BEFORE_SUPERSESSION,
    relevantDocs: [OLD],
    tags: ['validity', 'point-in-time'],
  },
  {
    id: 'vig-12',
    kind: 'retrieval_relevance',
    corpus: C,
    query: 'violations of the handbook on personal records',
    asOf: BEFORE_SUPERSESSION,
    relevantDocs: [OLD],
    tags: ['validity', 'point-in-time'],
  },

  // ── exact-identifier: what rung 1 exists to fix ──────────────────────────
  {
    id: 'id-01',
    kind: 'retrieval_relevance',
    corpus: C,
    query: 'section 44',
    asOf: NOW,
    relevantDocs: [NEW],
    relevantSections: [{ section: '44' }],
    tags: ['exact-identifier'],
    note: 'Bare section number, no topical words at all. Dense retrieval has literally nothing to go on.',
  },
  {
    id: 'id-02',
    kind: 'retrieval_relevance',
    corpus: C,
    query: 'section 66',
    asOf: NOW,
    relevantDocs: [NEW],
    relevantSections: [{ section: '66' }],
    tags: ['exact-identifier'],
  },
  {
    id: 'id-03',
    kind: 'retrieval_relevance',
    corpus: C,
    query: 'section 12 Bis',
    asOf: NOW,
    relevantDocs: [NEW],
    relevantSections: [{ section: '12 bis' }],
    tags: ['exact-identifier', 'structural'],
    note: 'Bis suffix. A chunker that folds 12 Bis into 12 makes this unanswerable.',
  },
  {
    id: 'id-04',
    kind: 'retrieval_relevance',
    corpus: C,
    query: 'section 12-A retention of consent evidence',
    asOf: NOW,
    relevantDocs: [NEW],
    relevantSections: [{ section: '12-a' }],
    tags: ['exact-identifier', 'structural'],
  },
  {
    id: 'id-05',
    kind: 'citation_groundedness',
    corpus: C,
    query: 'SPEC-035',
    asOf: NOW,
    relevantDocs: [SPEC],
    mustContain: ['SPEC-035'],
    tags: ['exact-identifier'],
    note: 'Hyphenated code — the canonical dense-retrieval blind spot.',
  },
  {
    id: 'id-06',
    kind: 'retrieval_relevance',
    corpus: C,
    query: 'SPEC-035-QA-2018 psychosocial risk factors',
    asOf: NOW,
    relevantDocs: [SPEC],
    tags: ['exact-identifier', 'topical'],
  },
  {
    id: 'id-07',
    kind: 'citation_groundedness',
    corpus: C,
    query: 'metric 8.4',
    asOf: NOW,
    relevantDocs: [METRICS],
    mustContain: ['8.4'],
    tags: ['exact-identifier'],
    note: 'Decimal id. "8" and "4" are sub-word noise to an embedding model.',
  },
  {
    id: 'id-08',
    kind: 'citation_groundedness',
    corpus: C,
    query: 'metric 9.1',
    asOf: NOW,
    relevantDocs: [METRICS],
    mustContain: ['9.1'],
    tags: ['exact-identifier'],
  },
  {
    id: 'id-09',
    kind: 'citation_groundedness',
    corpus: C,
    query: 'metric 3.6 public participation',
    asOf: NOW,
    relevantDocs: [METRICS],
    mustContain: ['3.6'],
    tags: ['exact-identifier', 'topical'],
  },
  {
    id: 'id-10',
    kind: 'retrieval_relevance',
    corpus: C,
    query: 'section 101 restricted information',
    asOf: NOW,
    relevantDocs: [ACCESS],
    relevantSections: [{ section: '101' }],
    tags: ['exact-identifier'],
  },
  {
    id: 'id-11',
    kind: 'retrieval_relevance',
    corpus: C,
    query: 'section 62 disclosure duties',
    asOf: NOW,
    relevantDocs: [ACCESS],
    relevantSections: [{ section: '62' }],
    tags: ['exact-identifier'],
  },
  {
    id: 'id-12',
    kind: 'retrieval_relevance',
    corpus: C,
    query: 'section 40 answer deadline',
    asOf: NOW,
    relevantDocs: [ACCESS],
    relevantSections: [{ section: '40' }],
    tags: ['exact-identifier', 'topical'],
  },
  {
    id: 'id-13',
    kind: 'retrieval_relevance',
    corpus: C,
    query: 'section 8 clinical examinations',
    asOf: NOW,
    relevantDocs: [SPEC],
    relevantSections: [{ section: '8' }],
    tags: ['exact-identifier', 'distractor'],
    note: 'Section 8 exists only in the standard here, but low section numbers collide across documents — a real hazard.',
  },
  {
    id: 'id-14',
    kind: 'retrieval_relevance',
    corpus: C,
    query: 'section 6 work sites fifty workers',
    asOf: NOW,
    relevantDocs: [SPEC],
    relevantSections: [{ section: '6' }],
    tags: ['exact-identifier', 'topical'],
  },
  {
    id: 'id-15',
    kind: 'retrieval_relevance',
    corpus: C,
    query: 'section 9 document acts covered bodies',
    asOf: NOW,
    relevantDocs: [ACCESS],
    relevantSections: [{ section: '9' }],
    tags: ['exact-identifier', 'topical'],
  },

  // ── topical: must not regress ────────────────────────────────────────────
  {
    id: 'top-01',
    kind: 'qa_faithfulness',
    corpus: C,
    query: 'deadline to notify a security breach',
    asOf: NOW,
    relevantDocs: [NEW],
    mustContain: ['seventy two hours'],
    tags: ['topical'],
  },
  {
    id: 'top-02',
    kind: 'qa_faithfulness',
    corpus: C,
    query: 'deadline to answer an access to information request',
    asOf: NOW,
    relevantDocs: [ACCESS],
    mustContain: ['twenty working days'],
    tags: ['topical', 'distractor'],
    note: 'Both the handbook and the access policy say "twenty working days". The right document must win.',
  },
  {
    id: 'top-03',
    kind: 'retrieval_relevance',
    corpus: C,
    query: 'prevention policy for workplace violence',
    asOf: NOW,
    relevantDocs: [SPEC],
    tags: ['topical'],
  },
  {
    id: 'top-04',
    kind: 'retrieval_relevance',
    corpus: C,
    query: 'records impact assessment before processing begins',
    asOf: NOW,
    relevantDocs: [NEW],
    tags: ['topical'],
  },
  {
    id: 'top-05',
    kind: 'retrieval_relevance',
    corpus: C,
    query: 'integrated solid waste handling programme',
    asOf: NOW,
    relevantDocs: [METRICS],
    tags: ['topical'],
  },
  {
    id: 'top-06',
    kind: 'retrieval_relevance',
    corpus: C,
    query: 'approved budget quarterly execution reports reusable formats',
    asOf: NOW,
    relevantDocs: [METRICS],
    tags: ['topical', 'distractor'],
    note: 'The access policy covers budget publication too — genuine ambiguity, the metrics table is the tighter match.',
  },
  {
    id: 'top-07',
    kind: 'retrieval_relevance',
    corpus: C,
    query: 'standing participation council minutes of sessions',
    asOf: NOW,
    relevantDocs: [METRICS],
    tags: ['topical'],
  },
  {
    id: 'top-08',
    kind: 'qa_faithfulness',
    corpus: C,
    query: 'restricted information public safety judicial files',
    asOf: NOW,
    relevantDocs: [ACCESS],
    mustContain: ['restricted'],
    tags: ['topical'],
  },
  {
    id: 'top-09',
    kind: 'retrieval_relevance',
    corpus: C,
    query: 'favourable organisational environment at the work site',
    asOf: NOW,
    relevantDocs: [SPEC],
    tags: ['topical'],
  },
  {
    id: 'top-10',
    kind: 'qa_faithfulness',
    corpus: C,
    query: 'inventory of processing systems and named responsible operator',
    asOf: NOW,
    relevantDocs: [METRICS],
    mustContain: ['inventory'],
    tags: ['topical', 'distractor'],
  },
  {
    id: 'top-11',
    kind: 'retrieval_relevance',
    corpus: C,
    query: 'remuneration of public officers and organisational structure',
    asOf: NOW,
    relevantDocs: [ACCESS],
    tags: ['topical'],
  },
  {
    id: 'top-12',
    kind: 'retrieval_relevance',
    corpus: C,
    query: 'grading penalties by economic capacity of the operator',
    asOf: NOW,
    relevantDocs: [NEW],
    tags: ['topical'],
  },

  // ── structural: did the chunker cut in the right place? ──────────────────
  {
    id: 'str-01',
    kind: 'citation_groundedness',
    corpus: C,
    query: 'section 12 Bis sensitive records impact assessment',
    asOf: NOW,
    relevantSections: [{ section: '12 bis' }],
    mustContain: ['impact assessment'],
    mustNotContain: SUPERSEDED_MARKERS,
    tags: ['structural', 'exact-identifier'],
    note: 'Top-1 must be 12 Bis itself, not a window spanning 12 and 12 Bis.',
  },
  {
    id: 'str-02',
    kind: 'citation_groundedness',
    corpus: C,
    query: 'section 44 security breach notification',
    asOf: NOW,
    relevantSections: [{ section: '44' }],
    mustContain: ['seventy two hours'],
    tags: ['structural', 'exact-identifier'],
  },
  {
    id: 'str-03',
    kind: 'citation_groundedness',
    corpus: C,
    query: 'section 3 right of access without showing a legal interest',
    asOf: NOW,
    relevantSections: [{ section: '3' }],
    mustContain: ['legal interest'],
    tags: ['structural', 'exact-identifier'],
  },
  {
    id: 'str-04',
    kind: 'citation_groundedness',
    corpus: C,
    query: 'section 6 twenty working days to answer the record subject',
    asOf: NOW,
    relevantDocs: [NEW],
    relevantSections: [{ section: '6' }],
    mustContain: ['twenty working days'],
    mustNotContain: SUPERSEDED_MARKERS,
    tags: ['structural', 'exact-identifier', 'validity', 'distractor'],
  },
];
