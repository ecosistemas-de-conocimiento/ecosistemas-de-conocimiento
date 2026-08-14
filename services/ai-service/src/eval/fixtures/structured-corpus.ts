// ⚠ SYNTHETIC TEST FIXTURES — INVENTED CONTENT. DO NOT INGEST INTO A REAL CORPUS.
//
// Every document below is made up. It deliberately belongs to NO product's
// domain: ai-service ships machinery, and a fixture that encodes one consumer's
// subject matter would smuggle that consumer's domain into the shared service
// (ADR-0001). What is faithful here is the SHAPE, because shape is the only
// thing the retriever is being tested on:
//
//   - numbered sections as the addressable unit, with suffixed identifiers
//     (`12 Bis`, `12-A`) that make numbering non-contiguous;
//   - roman-numeral sub-clauses inside an oversize section;
//   - a superseded edition sitting beside its replacement, same subject matter,
//     same wording, one distinguishing name;
//   - hyphenated codes and decimal identifiers, which dense embeddings cannot
//     tell apart.
//
// THE TRAP THIS FIXTURE IS BUILT AROUND
// -------------------------------------
// `handbook-2010` and `handbook-2025` cover the SAME subject matter in the SAME
// words, and the older edition names a supervising body that no longer exists.
// Any purely topical retriever returns both, ranks them indistinguishably, and
// hands the generator a superseded passage to cite — with no signal that
// anything is wrong. That failure is invisible to relevance metrics, and it is
// what the `asOf` filter exists to make impossible.
//
// THE CHUNKING PATTERNS ARE PART OF THE FIXTURE, NOT PART OF THE SERVICE.
// `FIXTURE_CHUNK_CONFIG` below is exactly the shape a consumer puts in
// `corpora.chunk_config`. The structural chunker ships no presets and knows no
// document conventions; whoever owns the documents owns the patterns.

import type { FixtureDoc } from '../types.js';

export const FIXTURE_CORPUS = 'eval-structured';

/** The instant the golden set treats as "now". After the 2025 replacement. */
export const NOW = '2026-01-15T00:00:00Z';
/** An instant while the older edition was still in force. */
export const BEFORE_SUPERSESSION = '2020-06-01T00:00:00Z';

const SUPERSESSION_DATE = '2025-03-21T00:00:00Z';

/**
 * Postgres text search configuration matching the fixture language. Passed to
 * the harness explicitly — the service has no per-language default of its own
 * to assume here.
 */
export const FIXTURE_TEXT_SEARCH_CONFIG = 'english';

/**
 * `corpora.chunk_config` for `chunk_strategy: 'structural'`, supplied BY THE
 * FIXTURE. Splits on `Section N`, tolerating the spelling variance an
 * invented-but-realistic document set has (`SECTION 3.-`, `Sec. 4`) and the
 * suffixes that make numbering non-contiguous (`12 Bis`, `12 Ter`, `12-A`).
 * Sub-clauses (`I.`, `II.`, …) are a SECOND level, used only to break up a
 * section that exceeds the size ceiling.
 */
export const FIXTURE_CHUNK_CONFIG = {
  sections: [
    {
      key: 'section',
      pattern: String.raw`^[ \t]*(?:section|sec\.)[ \t]+(\d+(?:[ \t]*(?:bis|ter|quater))?(?:[ \t]*[-–][ \t]*[a-z])?)\b`,
      flags: 'i',
    },
  ],
  subSections: [
    {
      // Roman numeral at the start of a line followed by enumeration
      // punctuation. Anchored + punctuated so it does not fire on an ordinary
      // sentence beginning with "I".
      key: 'clause',
      pattern: String.raw`^[ \t]*([IVXLCDM]{1,7})[ \t]*[.)\-–][ \t]`,
      flags: '',
    },
  ],
} as const;

// ---------------------------------------------------------------------------
// Superseded edition — in force 2010-07-06 → 2025-03-21.
// ---------------------------------------------------------------------------
const HANDBOOK_2010 = `SYNTHETIC FIELD OPERATIONS HANDBOOK (2010 EDITION, SUPERSEDED)

Section 1. This synthetic handbook sets out how an operating unit handles personal records held by private organisations, so that processing stays lawful, controlled and documented.

Section 6. A record subject may ask for access, correction, deletion or objection from the responsible operator, by written request or through electronic channels.

Section 12. The disclosure notice must state the identity and address of the responsible operator, the purposes of processing, the options for limiting use or sharing of the records, and the means for exercising access, correction, deletion and objection. The Northgate Review Board supervises compliance.

Section 12 Bis. Where processing involves sensitive records, the responsible operator must obtain express written consent from the record subject, by handwritten signature, electronic signature or any other authentication mechanism.

Section 19. The Northgate Review Board is the competent authority for personal records, holds technical and budgetary independence, and decides rights-protection proceedings.

Section 31. Transfers of personal records to domestic or foreign third parties need the consent of the record subject, except in the cases this synthetic handbook lists expressly.

Section 58. Failing to publish a disclosure notice, processing records without consent, and obstructing an inspection by the competent authority are violations of this synthetic handbook.
`;

// ---------------------------------------------------------------------------
// Current edition — in force from 2025-03-21. Same subject matter, different
// supervising body, renumbered obligations.
// ---------------------------------------------------------------------------
const HANDBOOK_2025 = `SYNTHETIC FIELD OPERATIONS HANDBOOK (2025 EDITION, CURRENT)

Section 1. This synthetic handbook sets out how an operating unit handles personal records held by private organisations, and states the principles of lawfulness, consent, information, quality, purpose, fairness, proportionality and accountability.

Section 6. A record subject may ask for access, correction, deletion or objection from the responsible operator. The responsible operator must answer within twenty working days counted from receipt of the request.

Section 12. The disclosure notice must state the identity and address of the responsible operator, the purposes of processing, the mechanisms through which a record subject may refuse, the means for exercising access, correction, deletion and objection, and the procedure for announcing changes to the notice itself. The Ridgeway Standards Office supervises compliance.

Section 12 Bis. Where sensitive personal records are involved, the responsible operator must obtain express consent from the record subject and complete a records impact assessment before processing begins.

Section 12-A. The responsible operator must retain evidence of the consent obtained for as long as processing continues, and for a further two years counted from its conclusion.

Section 19. The Ridgeway Standards Office is the competent authority for personal records held by private organisations, and coordinates its work with the regional supervising bodies.

Section 31. Transfers of personal records to domestic or foreign third parties need the consent of the record subject, except where the transfer is necessary to satisfy a legal obligation or to exercise a right in judicial proceedings.

Section 44. The responsible operator must notify the record subject and the competent authority of any security breach arising at any stage of processing that significantly affects the property or moral rights of the record subject, within seventy two hours of becoming aware of it.

Section 58. Failing to publish a disclosure notice, processing records without consent, omitting to notify a security breach, and obstructing an inspection are violations.

Section 66. Penalties are imposed independently of any civil, criminal or administrative liability that may apply, and are graded by weighing the nature of the record, whether the conduct was intentional, and the economic capacity of the responsible operator.
`;

// ---------------------------------------------------------------------------
// Access policy — one edition only, no supersession. Topical distractor: it
// covers adjacent vocabulary (requests, deadlines, covered bodies).
// ---------------------------------------------------------------------------
const ACCESS_POLICY = `SYNTHETIC PUBLIC RECORDS AND ACCESS POLICY

Section 3. Any person has a right of access to information held by covered bodies, without needing to show a legal interest or to justify the intended use.

Section 9. Covered bodies must document every act arising from the exercise of their powers, duties or functions, and must presume that information exists whenever it relates to those powers.

Section 12. Covered bodies publish and keep current the information covered by their disclosure duties on the corresponding electronic channels, in a clear, accessible and understandable form.

Section 40. An answer to an access request must be issued within a period that may not exceed twenty working days, extendable by ten further days where there are stated and substantiated reasons.

Section 62. Covered bodies make available to the public the information describing their organisational structure, the directory of public officers, gross and net remuneration, the assigned budget, and the reports on its execution.

Section 101. Information is treated as restricted where disclosure would compromise public safety, obstruct inspection activities, or undermine the conduct of judicial files that have not yet become final.
`;

// ---------------------------------------------------------------------------
// A standard with a hyphenated code — the archetypal exact-identifier query.
// Dense embeddings are near-useless on `SPEC-035`; lexical search is exact.
// ---------------------------------------------------------------------------
const RISK_STANDARD = `SYNTHETIC STANDARD SPEC-035-QA-2018 — WORKPLACE PSYCHOSOCIAL RISK FACTORS

Section 1. This synthetic standard sets out the elements for identifying, analysing and preventing psychosocial risk factors at work sites, and for promoting a favourable organisational environment.

Section 4. The employer must set out in writing a prevention policy for psychosocial risk covering the prevention of workplace violence and the circulation of information among staff.

Section 6. Work sites with more than fifty workers must apply the organisational environment assessment and keep the corresponding records for at least one year.

Section 8. The employer must arrange clinical examinations for staff exposed to severe traumatic events, and refer them to medical care where appropriate.
`;

// ---------------------------------------------------------------------------
// A reference table with decimal identifiers (`7.2`, `8.4`) which dense
// retrieval also cannot distinguish. Structurally a table of entries rather
// than a body of provisions, so it exercises the chunker on a second layout.
// ---------------------------------------------------------------------------
const METRICS_TABLE = `SYNTHETIC REFERENCE TABLE OF OPERATING METRICS

Section 1. This synthetic reference table groups operating metrics into thematic quadrants for review and follow-up.

Section 10. Metric 7.2 — Solid waste handling. Threshold: the operating unit publishes an integrated handling programme with annual targets and a verifiable quarterly progress report.

Section 11. Metric 8.4 — Protection of personal records. Threshold: the operating unit keeps an inventory of processing systems, publishes a disclosure notice per procedure, and names a responsible operator, with documentary evidence of all three elements.

Section 12. Metric 9.1 — Budget openness. Threshold: the operating unit publishes the approved budget, its amendments and the quarterly execution reports in open and reusable formats.

Section 13. Metric 3.6 — Public participation in planning. Threshold: a standing participation council exists, with minutes of its sessions for the past twelve months and evidence that its recommendations were addressed or answered in writing.
`;

export const FIXTURE_DOCS: FixtureDoc[] = [
  {
    externalId: 'handbook-2010',
    title: 'Synthetic field operations handbook (2010 edition, superseded)',
    text: HANDBOOK_2010,
    metadata: { series: 'handbook', edition: '2010', source: 'fixture' },
    validFrom: '2010-07-06T00:00:00Z',
    // The supersession. Everything hinges on this bound being SET.
    validTo: SUPERSESSION_DATE,
  },
  {
    externalId: 'handbook-2025',
    title: 'Synthetic field operations handbook (2025 edition, current)',
    text: HANDBOOK_2025,
    metadata: { series: 'handbook', edition: '2025', source: 'fixture' },
    validFrom: SUPERSESSION_DATE,
  },
  {
    externalId: 'access-policy',
    title: 'Synthetic public records and access policy',
    text: ACCESS_POLICY,
    metadata: { series: 'access-policy', source: 'fixture' },
  },
  {
    externalId: 'risk-standard',
    title: 'Synthetic standard SPEC-035-QA-2018',
    text: RISK_STANDARD,
    metadata: { series: 'spec-035-qa', source: 'fixture' },
  },
  {
    externalId: 'metrics-table',
    title: 'Synthetic reference table of operating metrics',
    text: METRICS_TABLE,
    metadata: { series: 'metrics-table', source: 'fixture' },
  },
];
