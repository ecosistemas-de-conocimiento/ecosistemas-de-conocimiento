/**
 * Environment gate for DEMO / FIXTURE seeding — TWO TIERS.
 *
 * 🔴 WHY THIS EXISTS
 *
 * `src/seed/demo.ts` invents an entire organization — a tenant, its teams and
 * its projects — and re-fires whenever `organizations` is empty, so it survives
 * redeploys and database wipes.
 *
 * That content is not inert. The knowledgebase reads those rows to build chat
 * context, and `@`-mention resolution answers FROM them. On a production
 * deployment the assistant would describe teams and projects that do not exist,
 * with total confidence, to a real user. The database would be lying and the
 * product would be repeating the lie.
 *
 * (The demo seed writes no `users` rows beyond linking the bootstrap admin, so
 * this is not the committed-password class of bug — no demo login is minted
 * here. The risk is the truthfulness of the content.)
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 * Only dev and local get seeded. A demo environment optionally, by hand only.
 *
 *   tier   | environments          | fires
 *   -------|-----------------------|---------------------------------------------
 *   BOOT   | local, dev            | AUTOMATICALLY, in `onInit`
 *   MANUAL | local, dev, demo-0    | ONLY on an explicit invocation (CLI script,
 *          |                       | authenticated route). NEVER on boot.
 *   —      | stage, prod           | never, by either path
 *
 * A demo environment is a curated showcase. Whoever curates it decides WHEN it
 * gets fixture content — a redeploy must not silently re-invent an organization
 * underneath a demo that has been hand-tuned. Hence: reachable by hand, never
 * by boot.
 *
 * ── 🔴 TWO INDEPENDENT LISTS, ON PURPOSE ─────────────────────────────────────
 * `BOOT_SEED_ENVS` and `MANUAL_SEED_ENVS` are written out as separate literals.
 * They are NOT derived from one another (`MANUAL = [...BOOT, 'demo']`) and there
 * is NO single list plus a widening flag. That shape is precisely the bug this
 * file was created to kill: the original gate was one condition that
 * `SEED_DOMAIN=1` could WIDEN, which put "seed fiction into production" one
 * mistyped environment variable away. Redundancy between the two lists is the
 * price of never being able to widen one by editing the other.
 *
 * Two invariants are asserted in `env-gate.test.ts` and keep the split honest:
 *   1. BOOT_SEED_ENVS ⊆ MANUAL_SEED_ENVS  (nothing boot-seeds that a human may
 *      not also seed by hand)
 *   2. neither list contains `stage` or `prod`
 *
 * Both lists are `Object.freeze`d. `as const` is a TYPE-level guarantee only —
 * it does not stop `BOOT_SEED_ENVS.push('prod')` at runtime, which would open
 * production while every test stayed green. Freezing makes the "no widening
 * mechanism" claim above true at runtime too, not just at compile time.
 *
 * ── What these gates do NOT cover ────────────────────────────────────────────
 * The ADMIN / service account is deliberately OUTSIDE both tiers. Stage and prod
 * must still get one — see `./admin.ts`. An environment with no admin is a WORSE
 * outcome than one with demo content.
 *
 * ── Why EDC_ENV and not NODE_ENV ─────────────────────────────────────────────
 * ⚠ `EDC_ENV` holds the environment's NAME (`local`, `dev`, `demo-0`, `stage`,
 * `prod`). `NODE_ENV` carries BUILD semantics only — `development` |
 * `production` — and cannot say WHICH environment this is, because every
 * deployed environment, deployed dev included, runs `NODE_ENV=production`.
 * Nothing in either tier reads `NODE_ENV`, and tests pin that in both
 * directions.
 *
 * ⚠ Matching is EXACT, never a prefix or a regex. `demo-*` and `^demo-\d+$`
 * were considered and rejected: a pattern is a second way to be allowed
 * alongside the list, it lets an environment self-authorize by naming
 * convention instead of by human review, and a list can be printed in the
 * refusal message while a regex cannot be enumerated.
 *
 * ── Fail CLOSED ──────────────────────────────────────────────────────────────
 * Unset / blank / unknown ⇒ NOT allowed, by EITHER tier. A misconfigured
 * environment must get an empty database, never demo content. The cost of a
 * false negative is "someone sees an empty local DB and reads one log line";
 * the cost of a false positive is a deployed assistant describing an
 * organization that does not exist.
 *
 * ⚠ THAT MEANS A FRESH DEPLOY SEEDS NOTHING UNTIL `EDC_ENV` IS SET. If a local
 * database comes up empty, that is this gate working — set `EDC_ENV=local`.
 *
 * Adding an environment is a ONE-LINE change to the relevant list below — never
 * a new condition, and never a flag.
 *
 * Pure functions, no Payload imports, so the gates are unit-testable without
 * booting anything.
 */

/**
 * Environments seeded AUTOMATICALLY on boot (`onInit`).
 *
 * 🔴 Never includes `demo`. Written as its own literal — do NOT derive it from
 * `MANUAL_SEED_ENVS`.
 */
export const BOOT_SEED_ENVS = Object.freeze(['local', 'dev'] as const)

/**
 * Environments an EXPLICIT, manually-invoked seed may target (CLI script,
 * authenticated route). Never consulted on boot.
 *
 * 🔴 Written as its own literal — do NOT derive it from `BOOT_SEED_ENVS`, and
 * never add `stage` or `prod`.
 *
 * ── Why `demo-0` and not `demo` ──────────────────────────────────────────────
 * `EDC_ENV` carries an environment's NAME, not its TYPE. The demo
 * box is named `demo-0` and there
 * may one day be a `demo-1`, `demo-2`. Bare `demo` is not an environment and is denied
 * by both tiers.
 *
 * ── 🔴 EXPLICIT LIST, NOT A PREFIX OR REGEX ──────────────────────────────────
 * `demo-*` / `^demo-\d+$` was considered and REJECTED:
 *   1. A pattern is a SECOND way to be allowed, alongside the list. That is the
 *      same "one list plus a widening mechanism" shape that let `SEED_DOMAIN=1`
 *      open production — the bug this file exists to kill. The suite already
 *      asserts near-miss denials (`devil` must not match `dev`) for the same
 *      reason.
 *   2. Default-deny means a HUMAN reviews each new environment. A pattern lets an
 *      environment self-authorize purely by how someone named it.
 *   3. A list can be printed in the log message, the docs and the tests. A regex
 *      cannot be enumerated, so the refusal message stops being actionable.
 * Cost of the explicit list: one reviewed line per new demo environment.
 * `demo-1` and `demo-99` are therefore DENIED until someone adds them here.
 */
export const MANUAL_SEED_ENVS = Object.freeze(['local', 'dev', 'demo-0'] as const)

export type BootSeedEnv = (typeof BOOT_SEED_ENVS)[number]
export type ManualSeedEnv = (typeof MANUAL_SEED_ENVS)[number]

/** Minimal env shape — keeps callers/tests from needing a full ProcessEnv. */
type GateEnv = Record<string, string | undefined>

/**
 * Read an env var as an OWN property only.
 *
 * A plain `env.FOO` walks the prototype chain, so a dependency that pollutes
 * `Object.prototype.EDC_ENV = 'dev'` would hand these gates a permission
 * they were never given — the one input that defeats default-deny. `Object.hasOwn`
 * closes it. Also guards against a non-string value arriving from a polluted or
 * hand-built env object.
 */
function readOwn(env: GateEnv, key: string): string | undefined {
  if (!Object.hasOwn(env, key)) return undefined
  const value = env[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Normalised `EDC_ENV`, or `undefined` when unset/blank.
 *
 * `toLowerCase()` (NOT `toLocaleLowerCase()`) is deliberate: it is
 * locale-independent by spec, so a Turkish locale cannot fold a dotted İ into an
 * `i` and manufacture an allowed value.
 */
export function currentAppEnv(env: GateEnv = process.env): string | undefined {
  const raw = readOwn(env, 'EDC_ENV')?.trim().toLowerCase()
  return raw && raw.length > 0 ? raw : undefined
}

/**
 * May this process seed demo content AUTOMATICALLY, on boot?
 *
 * TRUE only for `EDC_ENV` in {local, dev}. `demo-0`, `stage`, `prod`, an
 * unknown label, blank, or UNSET ⇒ false.
 *
 * ⚠ This function is the whole boot permission. No other variable may widen it.
 */
export function bootSeedAllowed(env: GateEnv = process.env): boolean {
  const current = currentAppEnv(env)
  if (!current) return false
  return (BOOT_SEED_ENVS as readonly string[]).includes(current)
}

/**
 * May an EXPLICIT, deliberately-invoked seed run here?
 *
 * TRUE only for `EDC_ENV` in {local, dev, demo-0}. `stage`, `prod`, an
 * unknown label, blank, or UNSET ⇒ false.
 *
 * ⚠ Being true is NECESSARY, not SUFFICIENT. A caller on this tier must also be
 * genuinely deliberate: a CLI entry point a human typed, or an AUTHENTICATED
 * request carrying an explicit opt-in parameter. Mere reachability — a bare GET,
 * a crawler, a health probe — must never seed. This function cannot enforce that
 * for you; it only says "this environment is not stage/prod".
 *
 * ⚠ This function is the whole manual permission. No other variable may widen it.
 */
export function manualSeedAllowed(env: GateEnv = process.env): boolean {
  const current = currentAppEnv(env)
  if (!current) return false
  return (MANUAL_SEED_ENVS as readonly string[]).includes(current)
}

/**
 * One-line, actionable explanation for a log when the BOOT gate says no. Names
 * the variable and its observed value so an empty local DB is self-diagnosing
 * rather than a mystery.
 *
 * On an environment that the MANUAL tier would accept (`demo-0`), it says so —
 * otherwise the reader concludes demo content is impossible there and goes
 * hunting for a broken flag.
 */
export function bootSeedGateReason(env: GateEnv = process.env): string {
  const current = currentAppEnv(env)
  const base =
    `demo seed SKIPPED: EDC_ENV=${current ?? '<unset>'} is not one of ` +
    `${BOOT_SEED_ENVS.join('|')}, the environments seeded automatically on boot. `

  if (manualSeedAllowed(env)) {
    return (
      base +
      `This environment IS in the manual tier (${MANUAL_SEED_ENVS.join('|')}), so demo ` +
      'content can still be seeded here by running the seed CLI by hand — it just never ' +
      'happens on a redeploy.'
    )
  }

  return (
    base +
    'Demo content (the demo organization, its teams and its projects) is never ' +
    'seeded here by any path; stage/prod stay empty apart from the admin/service account. ' +
    'If this is a local database, set EDC_ENV=local (see .env.example).'
  )
}

/**
 * One-line, actionable explanation for a log when the MANUAL gate says no.
 * Names the variable and its observed value so a refused CLI run is
 * self-diagnosing.
 */
export function manualSeedGateReason(env: GateEnv = process.env): string {
  const current = currentAppEnv(env)
  return (
    `demo seed REFUSED: EDC_ENV=${current ?? '<unset>'} is not one of ` +
    `${MANUAL_SEED_ENVS.join('|')}. Demo content (the demo organization, its teams ` +
    'and its projects) may be seeded on those environments ONLY, and stage/prod never ' +
    '— by any path, including this one. If this is a local database, set EDC_ENV=local ' +
    '(see .env.example). If you are pointing a CLI at a hosted DATABASE_URI, stop.'
  )
}

/** A composed seed decision, with everything a log line needs. */
export interface SeedDecision {
  /** Seed demo content in this process? */
  seed: boolean
  /** Human-readable reason, for the log, either way. */
  reason: string
  /**
   * A `SEED_DOMAIN` value was set while `EDC_ENV` sits OUTSIDE the tier's
   * allowlist, so it was ignored. Callers should WARN — this is the
   * misconfiguration people actually hit, and silence would hide it.
   */
  overrideIgnored: boolean
}

/**
 * Which allowlist a decision is being resolved against.
 *
 * Exported so `seedDomain` can take it as a REQUIRED argument: a caller must
 * state whether it is an automatic boot path or a deliberate human one, and
 * TypeScript will not let a new caller skip the question.
 */
export type SeedTier = 'boot' | 'manual'

/**
 * Shared resolution of the `SEED_DOMAIN` override against ONE tier.
 *
 * 🔴 PRIVATE, and takes a tier NAME — never a list. It dispatches to the tier's
 * own predicate, so there is no code path in which a caller supplies the set of
 * allowed environments. That is the whole reason this is not exported: an
 * exported `resolveDecision(env, allowedList)` would be a widening flag wearing
 * a different hat.
 */
function resolveDecision(env: GateEnv, tier: SeedTier): SeedDecision {
  const raw = (readOwn(env, 'SEED_DOMAIN') ?? '').trim().toLowerCase()
  const explicitlyOff = raw === '0' || raw === 'false'

  // ⚠ Every dispatch below tests for the WIDER tier and falls through to the
  // NARROWER one (`tier === 'manual' ? manual… : boot…`), never the reverse. If
  // a third tier is ever added and one of these is missed, the miss fails
  // NARROW — an environment that should have been seedable isn't, which someone
  // notices and fixes. The reverse default would silently widen.
  const allowed = tier === 'manual' ? manualSeedAllowed(env) : bootSeedAllowed(env)

  if (!allowed) {
    // Fail closed. The override is read ONLY to report that it was ignored.
    return {
      seed: false,
      reason: tier === 'manual' ? manualSeedGateReason(env) : bootSeedGateReason(env),
      overrideIgnored: raw.length > 0 && !explicitlyOff,
    }
  }

  const current = currentAppEnv(env)
  const list = tier === 'manual' ? MANUAL_SEED_ENVS : BOOT_SEED_ENVS

  if (explicitlyOff) {
    return {
      seed: false,
      reason:
        `demo seed SKIPPED: EDC_ENV=${current} permits demo content, but ` +
        `SEED_DOMAIN=${raw} explicitly turns it off.`,
      overrideIgnored: false,
    }
  }

  return {
    seed: true,
    reason:
      `demo seed ALLOWED: EDC_ENV=${current} is one of ` +
      `${list.join('|')}. Set SEED_DOMAIN=0 to turn it off here.`,
    overrideIgnored: false,
  }
}

/**
 * The full BOOT decision: the boot allowlist, plus the `SEED_DOMAIN` override
 * which may only ever NARROW.
 *
 *   - `EDC_ENV` outside {local, dev} ⇒ NO SEED, whatever `SEED_DOMAIN`
 *     says. A truthy `SEED_DOMAIN` CANNOT turn seeding on. This is the bug.
 *   - `demo-0` is outside this tier: it never boot-seeds, and `SEED_DOMAIN=1`
 *     cannot promote it into the boot tier.
 *   - Inside the allowlist, `SEED_DOMAIN=0` / `false` turns it OFF.
 *   - Inside the allowlist, unset or anything else leaves it ON.
 */
export function resolveBootSeedDecision(env: GateEnv = process.env): SeedDecision {
  return resolveDecision(env, 'boot')
}

/**
 * The full MANUAL decision: the manual allowlist, plus the same NARROWING-only
 * `SEED_DOMAIN` override.
 *
 *   - `EDC_ENV` outside {local, dev, demo-0} ⇒ REFUSED, whatever
 *     `SEED_DOMAIN` says.
 *   - Inside the allowlist, `SEED_DOMAIN=0` / `false` turns it OFF. An operator
 *     who has declared "no demo content in this environment" should not have it
 *     re-appear because someone ran the CLI; the narrowing is honoured on both
 *     tiers, and narrowing can never open anything.
 */
export function resolveManualSeedDecision(env: GateEnv = process.env): SeedDecision {
  return resolveDecision(env, 'manual')
}

/**
 * WARN text for a `SEED_DOMAIN` that the BOOT path did not act on. Says what was
 * ignored and what would actually be required, so the reader does not go looking
 * for a broken flag.
 *
 * ⚠ Two distinct cases, and conflating them produces a self-contradicting boot
 * log — which is exactly what the first draft of this did on `demo-0`:
 *   - stage/prod/unknown: the flag is genuinely dead. Nothing reads it.
 *   - demo-0: the flag is NOT ignored — the MANUAL tier reads it. Only the boot
 *     path skipped it. Telling that operator to "set EDC_ENV instead" would
 *     be advice to lie about which environment this is, which defeats the tier
 *     split and corrupts every other consumer of the variable.
 */
export function bootIgnoredOverrideWarning(env: GateEnv = process.env): string {
  const raw = (readOwn(env, 'SEED_DOMAIN') ?? '').trim()
  const observed = currentAppEnv(env) ?? '<unset>'

  if (manualSeedAllowed(env)) {
    return (
      `SEED_DOMAIN=${raw} did not trigger a BOOT seed: EDC_ENV=${observed} is in the ` +
      `manual tier (${MANUAL_SEED_ENVS.join('|')}) but not the boot tier ` +
      `(${BOOT_SEED_ENVS.join('|')}), and SEED_DOMAIN cannot move an environment between ` +
      'tiers. This is intentional: a redeploy must not re-invent demo content here. To seed ' +
      'this environment, run the seed CLI by hand (npm run seed:domain). Do NOT change ' +
      'EDC_ENV to work around this — it names the environment.'
    )
  }

  return (
    `SEED_DOMAIN=${raw} was IGNORED: EDC_ENV=${observed} ` +
    `is not one of ${BOOT_SEED_ENVS.join('|')}, and SEED_DOMAIN can only turn demo ` +
    'seeding OFF inside those environments — never ON outside them, and never to move an ' +
    'environment into the boot tier. If this environment really should boot-seed demo ' +
    'content, set EDC_ENV, not SEED_DOMAIN.'
  )
}

/**
 * WARN text for a `SEED_DOMAIN` that was ignored because the environment is
 * outside the MANUAL allowlist.
 */
export function manualIgnoredOverrideWarning(env: GateEnv = process.env): string {
  const raw = (readOwn(env, 'SEED_DOMAIN') ?? '').trim()
  return (
    `SEED_DOMAIN=${raw} was IGNORED: EDC_ENV=${currentAppEnv(env) ?? '<unset>'} ` +
    `is not one of ${MANUAL_SEED_ENVS.join('|')}, and SEED_DOMAIN can only turn demo ` +
    'seeding OFF inside those environments — never ON outside them. If this environment ' +
    'really should hold demo content, set EDC_ENV, not SEED_DOMAIN.'
  )
}
