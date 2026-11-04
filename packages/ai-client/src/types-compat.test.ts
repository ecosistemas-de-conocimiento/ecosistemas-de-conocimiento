// PROOF that 0.18.0's contract-generated request types did not break a consumer
// already on 0.17.0.
//
// 0.18.0 deleted every hand-written wire type and derived them from ai-service's
// Zod schemas instead (`src/contract/wire-manifest.ts`). That is a rewrite of the
// package's most-imported declarations, and "it still compiles here" says nothing
// about a consumer's code — a consumer both PASSES these shapes in (needs the new
// type to accept a 0.17.0-shaped value) and HOLDS them in its own declarations
// (needs the old type to accept a new value). So both directions are checked.
//
// The baseline is a FROZEN copy of the 0.17.0 declarations,
// `./types-0.17.0.snapshot.ts`.
//
// ── Where the gate actually runs ──────────────────────────────────────────
// The compatibility check is TYPE-level, so `npm run typecheck` at the REPO
// ROOT is what enforces it (the root tsconfig includes `packages/*/src/**/*`;
// the client's own tsconfig excludes tests). A one-way break makes the offending
// entry in `Compatibility` resolve to `false`, and `CompatibilityProof`'s
// `Record<string, true>` constraint then fails BY PROPERTY NAME.
//
// 🔴 Do NOT write these as `true as Mutual<A, B>`. `as` is an assertion, `never`
// is assignable from anything, and the whole file silently proves nothing — the
// first draft of it did exactly that and passed a deliberate narrowing sabotage.
// The false branch is `false`, not `never`, for the same reason: `never extends
// true` is TRUE, so a `never` would slip through the constraint too.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type * as New from './types.js';
import type * as Old from './types-0.17.0.snapshot.js';

/**
 * `true` only when `A` and `B` accept each other. Tuple-wrapped so a union on
 * either side is compared whole instead of distributing member by member.
 */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** One entry per request type 0.17.0 published that 0.18.0 still publishes. */
type Compatibility = {
  EffortLevel: Mutual<Old.EffortLevel, New.EffortLevel>;
  Validator: Mutual<Old.Validator, New.Validator>;
  InlineSpecOverride: Mutual<Old.InlineSpecOverride, New.InlineSpecOverride>;
  IncludeContextItem: Mutual<Old.IncludeContextItem, New.IncludeContextItem>;
  Unit: Mutual<Old.Unit, New.Unit>;
  GenerateRequest: Mutual<Old.GenerateRequest, New.GenerateRequest>;
  GenerateSyncRequest: Mutual<Old.GenerateSyncRequest, New.GenerateSyncRequest>;
  ProjectConfigPatch: Mutual<Old.ProjectConfigPatch, New.ProjectConfigPatch>;
  RegistryEntryCreate: Mutual<Old.RegistryEntryCreate, New.RegistryEntryCreate>;
  ProvisionUnitType: Mutual<Old.ProvisionUnitType, New.ProvisionUnitType>;
  ProvisionTenantRequest: Mutual<Old.ProvisionTenantRequest, New.ProvisionTenantRequest>;
  IngestDocument: Mutual<Old.IngestDocument, New.IngestDocument>;
  IngestRequest: Mutual<Old.IngestRequest, New.IngestRequest>;
  CorpusCreateRequest: Mutual<Old.CorpusCreateRequest, New.CorpusCreateRequest>;
  CorpusUpdateRequest: Mutual<Old.CorpusUpdateRequest, New.CorpusUpdateRequest>;
  ChatTurn: Mutual<Old.ChatTurn, New.ChatTurn>;
  RetrieveRewrite: Mutual<Old.RetrieveRewrite, New.RetrieveRewrite>;
  RetrieveRequest: Mutual<Old.RetrieveRequest, New.RetrieveRequest>;
  RetrieveMultiRequest: Mutual<Old.RetrieveMultiRequest, New.RetrieveMultiRequest>;
  EmbedRequest: Mutual<Old.EmbedRequest, New.EmbedRequest>;
  RouteChatMessage: Mutual<Old.RouteChatMessage, New.RouteChatMessage>;
  RouteCandidate: Mutual<Old.RouteCandidate, New.RouteCandidate>;
  RouteRequest: Mutual<Old.RouteRequest, New.RouteRequest>;
};

/**
 * THE GATE. A CONSTRAINT, deliberately — `Compatibility extends Record<string,
 * true> ? … : never` compiles fine whatever `Compatibility` contains, because a
 * conditional type resolves rather than errors. Only a constraint violation is
 * a compile error, and it names the offending property. Exported so the alias is
 * never an "unused declaration".
 */
type AllTrue<T extends Record<string, true>> = T;
export type CompatibilityProof = AllTrue<Compatibility>;

/** Names asserted above — kept in step with `Compatibility` by the test below. */
const PROVEN = Object.keys({
  EffortLevel: 0,
  Validator: 0,
  InlineSpecOverride: 0,
  IncludeContextItem: 0,
  Unit: 0,
  GenerateRequest: 0,
  GenerateSyncRequest: 0,
  ProjectConfigPatch: 0,
  RegistryEntryCreate: 0,
  ProvisionUnitType: 0,
  ProvisionTenantRequest: 0,
  IngestDocument: 0,
  IngestRequest: 0,
  CorpusCreateRequest: 0,
  CorpusUpdateRequest: 0,
  ChatTurn: 0,
  RetrieveRewrite: 0,
  RetrieveRequest: 0,
  RetrieveMultiRequest: 0,
  EmbedRequest: 0,
  RouteChatMessage: 0,
  RouteCandidate: 0,
  RouteRequest: 0,
} satisfies Record<keyof Compatibility, 0>);

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const exportedNames = (source: string): string[] => [
  ...new Set(
    [...source.matchAll(/^export (?:type|interface) ([A-Za-z0-9_$]+)\b/gm)].map(
      (m) => m[1] as string,
    ),
  ),
];

describe('0.17.0 → 0.18.0 wire-type compatibility', () => {
  it('proves every name the two versions share', () => {
    // The type-level assertions cannot enumerate themselves at runtime, so this
    // is what stops one being forgotten: a NEW generated type that collides
    // with a 0.17.0 name and has no entry in `Compatibility` fails here.
    const old = new Set(exportedNames(read('./types-0.17.0.snapshot.ts')));
    const shared = exportedNames(read('./generated/wire.ts')).filter((n) => old.has(n));
    expect(
      shared.slice().sort(),
      'a request type published by BOTH 0.17.0 and today has no compatibility proof',
    ).toEqual(PROVEN.slice().sort());
  });

  it('keeps the 0.17.0 snapshot frozen', () => {
    // The snapshot is evidence, not a source file. If it ever gets "updated to
    // match", the proof above becomes a tautology.
    const snapshot = read('./types-0.17.0.snapshot.ts');
    expect(exportedNames(snapshot)).toHaveLength(62);
    expect(snapshot).not.toContain("from './generated/wire.js'");
  });
});
