import { describe, it, expect } from 'vitest'
import {
  BOOT_SEED_ENVS,
  MANUAL_SEED_ENVS,
  bootIgnoredOverrideWarning,
  bootSeedAllowed,
  bootSeedGateReason,
  currentAppEnv,
  manualIgnoredOverrideWarning,
  manualSeedAllowed,
  manualSeedGateReason,
  resolveBootSeedDecision,
  resolveManualSeedDecision,
} from './env-gate'

/**
 * The two-tier gate that keeps the demo organization off stage + prod, and off
 * demo-0 EXCEPT when a human asks for it.
 *
 * ⚠ THE DENIALS ARE THE POINT. A happy-path test here is worthless: the failure
 * mode is seeding where it must NOT, and every such failure is silent — the
 * environment comes up looking fine, with an invented organization the assistant
 * will describe to real users as fact.
 */

type Env = Record<string, string | undefined>

// ──────────────────────────────────────────────────────────────────────────────
// The invariants that keep the two-tier split honest.
// ──────────────────────────────────────────────────────────────────────────────

describe('the two lists', () => {
  it('are exactly what the spec says', () => {
    // Adding an environment must be a one-line change to ONE list, reviewed.
    expect([...BOOT_SEED_ENVS]).toEqual(['local', 'dev'])
    expect([...MANUAL_SEED_ENVS]).toEqual(['local', 'dev', 'demo-0'])
  })

  it('INVARIANT: BOOT_SEED_ENVS ⊆ MANUAL_SEED_ENVS', () => {
    // Nothing may boot-seed that a human is not also allowed to seed by hand.
    // A boot-only environment would mean the automatic path is WIDER than the
    // deliberate one — the tiers inverted.
    for (const env of BOOT_SEED_ENVS) {
      expect(MANUAL_SEED_ENVS as readonly string[]).toContain(env)
    }
    // …and the same relation stated through the predicates, which is what
    // actually protects the `seedDomain` floor being the manual tier.
    for (const env of BOOT_SEED_ENVS) {
      expect(bootSeedAllowed({ EDC_ENV: env })).toBe(true)
      expect(manualSeedAllowed({ EDC_ENV: env })).toBe(true)
    }
  })

  it('INVARIANT: neither list contains stage or prod', () => {
    for (const forbidden of ['stage', 'prod', 'staging', 'production']) {
      expect(BOOT_SEED_ENVS as readonly string[]).not.toContain(forbidden)
      expect(MANUAL_SEED_ENVS as readonly string[]).not.toContain(forbidden)
    }
  })

  it('do not share array identity', () => {
    // Honest about its scope: this catches `MANUAL_SEED_ENVS = BOOT_SEED_ENVS`
    // and nothing more. It does NOT catch `MANUAL = [...BOOT, 'demo-0']` — that
    // produces a distinct object. The real protection against derivation is the
    // hardcoded-contents assertion above (which fails the moment either list
    // changes) plus code review; no runtime test can see how a literal was
    // written.
    expect(BOOT_SEED_ENVS as readonly string[]).not.toBe(
      MANUAL_SEED_ENVS as readonly string[],
    )
    expect(MANUAL_SEED_ENVS.length).toBeGreaterThan(BOOT_SEED_ENVS.length)
  })

  // 🔴 `as const` is TYPE-level only. Without Object.freeze, a single
  // `BOOT_SEED_ENVS.push('prod')` anywhere in the process opens production —
  // and the entire rest of this suite stays green while it does.
  it('are FROZEN at runtime, so no code can push an environment in', () => {
    expect(Object.isFrozen(BOOT_SEED_ENVS)).toBe(true)
    expect(Object.isFrozen(MANUAL_SEED_ENVS)).toBe(true)

    const mutable = BOOT_SEED_ENVS as unknown as string[]
    expect(() => mutable.push('prod')).toThrow()
    expect(bootSeedAllowed({ EDC_ENV: 'prod' })).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// The tier split itself.
// ──────────────────────────────────────────────────────────────────────────────

describe('demo-0 — the whole reason there are two tiers', () => {
  it('is DENIED by the boot tier: a redeploy must never re-invent an org there', () => {
    expect(bootSeedAllowed({ EDC_ENV: 'demo-0' })).toBe(false)
    expect(resolveBootSeedDecision({ EDC_ENV: 'demo-0' }).seed).toBe(false)
  })

  it('is ALLOWED by the manual tier: a human may seed it deliberately', () => {
    expect(manualSeedAllowed({ EDC_ENV: 'demo-0' })).toBe(true)
    expect(resolveManualSeedDecision({ EDC_ENV: 'demo-0' }).seed).toBe(true)
  })

  it('tolerates case + whitespace on demo-0, in the manual tier only', () => {
    expect(manualSeedAllowed({ EDC_ENV: '  DEMO-0  ' })).toBe(true)
    expect(bootSeedAllowed({ EDC_ENV: '  DEMO-0  ' })).toBe(false)
  })

  it('tells the reader, on boot, that the manual path still exists', () => {
    // Otherwise an operator reads "SKIPPED" on demo-0 and concludes demo content
    // is impossible there, then goes hunting for a broken flag.
    const reason = bootSeedGateReason({ EDC_ENV: 'demo-0' })
    expect(reason).toContain('EDC_ENV=demo-0')
    expect(reason).toContain('manual')
  })

  // 🔴 The boot log must not contradict itself. `.env.docker` ships
  // SEED_DOMAIN=1, so a demo-0 box hits this exact combination on every boot.
  it('does not tell a demo-0 operator to change EDC_ENV', () => {
    const warning = bootIgnoredOverrideWarning({ EDC_ENV: 'demo-0', SEED_DOMAIN: '1' })
    // It is NOT "ignored" on demo-0 — the manual tier reads it.
    expect(warning).not.toContain('IGNORED')
    expect(warning).toContain('demo-0')
    expect(warning).toContain('manual tier')
    // Advising EDC_ENV=dev here would be advice to lie about the
    // environment, which defeats the tier split.
    expect(warning).toContain('Do NOT change')
  })

  it('still says IGNORED on a genuinely dead override (prod)', () => {
    const warning = bootIgnoredOverrideWarning({ EDC_ENV: 'prod', SEED_DOMAIN: '1' })
    expect(warning).toContain('IGNORED')
    expect(warning).toContain('set EDC_ENV, not SEED_DOMAIN')
  })
})

describe('the manual list is an EXPLICIT list, not a prefix or regex', () => {
  // 🔴 This block is what proves no pattern matching crept in. A `demo-*` rule
  // would be a SECOND way to be allowed alongside the list — the same shape as
  // the `SEED_DOMAIN=1`-opens-prod bug — and would let an environment
  // self-authorize just by being named a certain way.
  const notOnTheList = [
    'demo', // bare type name, not an environment name
    'demo-1', // a real future environment — must be ADDED by hand first
    'demo-99',
    'demo-',
    'demo-0-old',
    'predemo-0',
    'demonstration',
  ]

  it.each(notOnTheList)('denies %s by BOTH tiers until explicitly added', (value) => {
    expect(bootSeedAllowed({ EDC_ENV: value })).toBe(false)
    expect(manualSeedAllowed({ EDC_ENV: value })).toBe(false)
    expect(resolveBootSeedDecision({ EDC_ENV: value }).seed).toBe(false)
    expect(resolveManualSeedDecision({ EDC_ENV: value }).seed).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Denials shared by both tiers.
// ──────────────────────────────────────────────────────────────────────────────

/** 🔴 THE POINT OF THE WHOLE CHANGE. Every one of these is false on BOTH tiers. */
const deniedByBoth: Array<[string, Env]> = [
  ['prod', { EDC_ENV: 'prod' }],
  ['production', { EDC_ENV: 'production' }],
  ['stage', { EDC_ENV: 'stage' }],
  ['staging', { EDC_ENV: 'staging' }],
  ['test', { EDC_ENV: 'test' }],
  ['unrecognised value (banana)', { EDC_ENV: 'banana' }],
  ['near-miss: localhost', { EDC_ENV: 'localhost' }],
  ['near-miss: devil', { EDC_ENV: 'devil' }],
  ['near-miss: development', { EDC_ENV: 'development' }],
  ['near-miss: demonstration', { EDC_ENV: 'demonstration' }],
  ['near-miss: local-2', { EDC_ENV: 'local-2' }],
  ['near-miss: predev', { EDC_ENV: 'predev' }],
  ['bare demo (not an environment name)', { EDC_ENV: 'demo' }],
  ['UNSET', {}],
  ['explicitly undefined', { EDC_ENV: undefined }],
  ['empty string', { EDC_ENV: '' }],
  ['whitespace only', { EDC_ENV: '   ' }],
  ['tab/newline only', { EDC_ENV: '\t\n' }],
]

describe('bootSeedAllowed', () => {
  it('allows exactly local + dev', () => {
    expect(bootSeedAllowed({ EDC_ENV: 'local' })).toBe(true)
    expect(bootSeedAllowed({ EDC_ENV: 'dev' })).toBe(true)
  })

  it('tolerates case + surrounding whitespace on an allowed value', () => {
    expect(bootSeedAllowed({ EDC_ENV: 'LOCAL' })).toBe(true)
    expect(bootSeedAllowed({ EDC_ENV: '  Dev  ' })).toBe(true)
    expect(bootSeedAllowed({ EDC_ENV: '\tDEV\n' })).toBe(true)
  })

  it.each(deniedByBoth)('refuses %s', (_label, env) => {
    expect(bootSeedAllowed(env)).toBe(false)
  })

  it('additionally refuses demo-0 (the tier split)', () => {
    expect(bootSeedAllowed({ EDC_ENV: 'demo-0' })).toBe(false)
  })
})

describe('manualSeedAllowed', () => {
  it('allows exactly local + dev + demo-0', () => {
    expect(manualSeedAllowed({ EDC_ENV: 'local' })).toBe(true)
    expect(manualSeedAllowed({ EDC_ENV: 'dev' })).toBe(true)
    expect(manualSeedAllowed({ EDC_ENV: 'demo-0' })).toBe(true)
  })

  it('tolerates case + surrounding whitespace on an allowed value', () => {
    expect(manualSeedAllowed({ EDC_ENV: 'LOCAL' })).toBe(true)
    expect(manualSeedAllowed({ EDC_ENV: '  Dev  ' })).toBe(true)
    expect(manualSeedAllowed({ EDC_ENV: '\tDemo-0\n' })).toBe(true)
  })

  it.each(deniedByBoth)('refuses %s', (_label, env) => {
    expect(manualSeedAllowed(env)).toBe(false)
  })
})

describe('NODE_ENV is inert for BOTH tiers, in BOTH directions', () => {
  // NODE_ENV carries BUILD semantics only. Every DEPLOYED environment —
  // including deployed dev — runs NODE_ENV=production, so it can never name a
  // deployment environment. It must not move either needle.
  it('cannot open a denied environment', () => {
    for (const nodeEnv of ['development', 'test', undefined]) {
      for (const appEnv of ['prod', 'stage', undefined]) {
        const env: Env = { NODE_ENV: nodeEnv, EDC_ENV: appEnv }
        expect(bootSeedAllowed(env)).toBe(false)
        expect(manualSeedAllowed(env)).toBe(false)
      }
    }
  })

  it('cannot close an allowed environment', () => {
    // A production BUILD on deployed dev must still boot-seed.
    expect(bootSeedAllowed({ NODE_ENV: 'production', EDC_ENV: 'dev' })).toBe(true)
    expect(bootSeedAllowed({ NODE_ENV: 'production', EDC_ENV: 'local' })).toBe(true)
    expect(manualSeedAllowed({ NODE_ENV: 'production', EDC_ENV: 'dev' })).toBe(true)
    expect(manualSeedAllowed({ NODE_ENV: 'production', EDC_ENV: 'demo-0' })).toBe(true)
  })

  it('cannot promote demo-0 into the boot tier', () => {
    for (const nodeEnv of ['development', 'test', 'production']) {
      expect(bootSeedAllowed({ NODE_ENV: nodeEnv, EDC_ENV: 'demo-0' })).toBe(false)
    }
  })
})

describe('the gates read OWN properties only', () => {
  // A polluted Object.prototype is the one input that can defeat a default-deny
  // gate: `env.EDC_ENV` would inherit a permission nobody granted.
  it('ignores an inherited EDC_ENV from the prototype chain', () => {
    const polluted = Object.create({ EDC_ENV: 'dev' }) as Env
    expect(bootSeedAllowed(polluted)).toBe(false)
    expect(manualSeedAllowed(polluted)).toBe(false)
    expect(currentAppEnv(polluted)).toBeUndefined()
    expect(resolveBootSeedDecision(polluted).seed).toBe(false)
    expect(resolveManualSeedDecision(polluted).seed).toBe(false)
  })

  it('ignores an inherited SEED_DOMAIN from the prototype chain', () => {
    const polluted = Object.create({ SEED_DOMAIN: '0' }) as Env
    polluted.EDC_ENV = 'dev'
    // The inherited '0' must not silently turn local/dev seeding off either.
    expect(resolveBootSeedDecision(polluted).seed).toBe(true)
    expect(resolveManualSeedDecision(polluted).seed).toBe(true)
  })

  it('still honours an OWN property that shadows a polluted prototype', () => {
    const shadowed = Object.create({ EDC_ENV: 'prod' }) as Env
    shadowed.EDC_ENV = 'dev'
    expect(bootSeedAllowed(shadowed)).toBe(true)
    expect(manualSeedAllowed(shadowed)).toBe(true)
  })

  it('denies prototype-derived keys used as values', () => {
    for (const key of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(bootSeedAllowed({ EDC_ENV: key })).toBe(false)
      expect(manualSeedAllowed({ EDC_ENV: key })).toBe(false)
    }
  })
})

describe('currentAppEnv', () => {
  it('normalises to lower case and trims', () => {
    expect(currentAppEnv({ EDC_ENV: '  PROD ' })).toBe('prod')
    expect(currentAppEnv({ EDC_ENV: 'Dev' })).toBe('dev')
    expect(currentAppEnv({ EDC_ENV: ' Demo-0 ' })).toBe('demo-0')
  })

  it('reports undefined for unset/blank', () => {
    expect(currentAppEnv({})).toBeUndefined()
    expect(currentAppEnv({ EDC_ENV: '  ' })).toBeUndefined()
    expect(currentAppEnv({ EDC_ENV: '' })).toBeUndefined()
  })
})

describe('gate reasons name the tier and the observed value', () => {
  it('bootSeedGateReason names EDC_ENV and the boot list', () => {
    const msg = bootSeedGateReason({ EDC_ENV: 'prod' })
    expect(msg).toContain('EDC_ENV=prod')
    expect(msg).toContain('local|dev')
  })

  it('manualSeedGateReason names EDC_ENV and the manual list', () => {
    const msg = manualSeedGateReason({ EDC_ENV: 'prod' })
    expect(msg).toContain('EDC_ENV=prod')
    expect(msg).toContain('local|dev|demo-0')
  })

  it('say <unset> rather than "undefined" when the variable is missing', () => {
    expect(bootSeedGateReason({})).toContain('EDC_ENV=<unset>')
    expect(manualSeedGateReason({})).toContain('EDC_ENV=<unset>')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// The SEED_DOMAIN override — may NARROW, never widen, on either tier.
// ──────────────────────────────────────────────────────────────────────────────

describe('SEED_DOMAIN may only NARROW — boot tier', () => {
  // 🔴 THE ACTUAL BUG BEING FIXED. The old gate treated SEED_DOMAIN=1 as
  // permission, so a single env var set on the wrong deployment would seed a
  // fictional organization into production. Test this hardest.
  const cannotWiden: Array<[string, Env]> = [
    ['prod + SEED_DOMAIN=1', { EDC_ENV: 'prod', SEED_DOMAIN: '1' }],
    ['prod + SEED_DOMAIN=true', { EDC_ENV: 'prod', SEED_DOMAIN: 'true' }],
    ['prod + SEED_DOMAIN=TRUE', { EDC_ENV: 'prod', SEED_DOMAIN: 'TRUE' }],
    ['prod + SEED_DOMAIN= 1 (padded)', { EDC_ENV: 'prod', SEED_DOMAIN: '  1  ' }],
    ['stage + SEED_DOMAIN=1', { EDC_ENV: 'stage', SEED_DOMAIN: '1' }],
    ['production + SEED_DOMAIN=yes', { EDC_ENV: 'production', SEED_DOMAIN: 'yes' }],
    ['unset env + SEED_DOMAIN=1', { SEED_DOMAIN: '1' }],
    ['blank env + SEED_DOMAIN=true', { EDC_ENV: '  ', SEED_DOMAIN: 'true' }],
    ['banana + SEED_DOMAIN=1', { EDC_ENV: 'banana', SEED_DOMAIN: '1' }],
    [
      'prod + SEED_DOMAIN=1 + NODE_ENV=development',
      { EDC_ENV: 'prod', SEED_DOMAIN: '1', NODE_ENV: 'development' },
    ],
  ]

  it.each(cannotWiden)('refuses to boot-seed: %s', (_label, env) => {
    expect(resolveBootSeedDecision(env).seed).toBe(false)
  })

  // 🔴 THE NEW WAY TO GET THIS WRONG. The override must not move an environment
  // BETWEEN tiers either — only stage/prod-widening was possible before, now a
  // demo-0 promotion is the tempting shortcut.
  it.each(['1', 'true', 'TRUE', 'yes', '  1  ', 'force', 'boot'])(
    'cannot promote demo-0 into the boot tier with SEED_DOMAIN=%s',
    (value) => {
      expect(resolveBootSeedDecision({ EDC_ENV: 'demo-0', SEED_DOMAIN: value }).seed).toBe(
        false,
      )
    },
  )

  it('WARNS that an ignored SEED_DOMAIN was ignored, rather than failing silently', () => {
    const decision = resolveBootSeedDecision({ EDC_ENV: 'prod', SEED_DOMAIN: '1' })
    expect(decision.seed).toBe(false)
    expect(decision.overrideIgnored).toBe(true)

    const warning = bootIgnoredOverrideWarning({ EDC_ENV: 'prod', SEED_DOMAIN: '1' })
    expect(warning).toContain('SEED_DOMAIN=1')
    expect(warning).toContain('IGNORED')
    expect(warning).toContain('EDC_ENV=prod')
  })

  it('does not cry "ignored override" when SEED_DOMAIN is absent or already off', () => {
    // Nothing was ignored — no warning noise on a correctly-configured prod.
    expect(resolveBootSeedDecision({ EDC_ENV: 'prod' }).overrideIgnored).toBe(false)
    expect(
      resolveBootSeedDecision({ EDC_ENV: 'prod', SEED_DOMAIN: '0' }).overrideIgnored,
    ).toBe(false)
    expect(
      resolveBootSeedDecision({ EDC_ENV: 'prod', SEED_DOMAIN: 'false' }).overrideIgnored,
    ).toBe(false)
  })

  it('CAN narrow: SEED_DOMAIN=0 / false turns boot seeding off inside the allowlist', () => {
    expect(resolveBootSeedDecision({ EDC_ENV: 'dev', SEED_DOMAIN: '0' }).seed).toBe(false)
    expect(resolveBootSeedDecision({ EDC_ENV: 'local', SEED_DOMAIN: '0' }).seed).toBe(false)
    expect(resolveBootSeedDecision({ EDC_ENV: 'dev', SEED_DOMAIN: 'false' }).seed).toBe(false)
    expect(resolveBootSeedDecision({ EDC_ENV: 'dev', SEED_DOMAIN: 'FALSE' }).seed).toBe(false)
    expect(resolveBootSeedDecision({ EDC_ENV: 'dev', SEED_DOMAIN: ' 0 ' }).seed).toBe(false)
  })

  it('boot-seeds inside the allowlist when SEED_DOMAIN is unset or anything else', () => {
    expect(resolveBootSeedDecision({ EDC_ENV: 'local' }).seed).toBe(true)
    expect(resolveBootSeedDecision({ EDC_ENV: 'dev' }).seed).toBe(true)
    expect(resolveBootSeedDecision({ EDC_ENV: 'dev', SEED_DOMAIN: '1' }).seed).toBe(true)
    expect(resolveBootSeedDecision({ EDC_ENV: 'dev', SEED_DOMAIN: 'true' }).seed).toBe(true)
    expect(resolveBootSeedDecision({ EDC_ENV: 'dev', SEED_DOMAIN: '' }).seed).toBe(true)
    expect(resolveBootSeedDecision({ EDC_ENV: '  LOCAL  ' }).seed).toBe(true)
  })

  it('always carries a reason naming the observed EDC_ENV, seeded or not', () => {
    // A boot log must answer "did this seed, and why / why not".
    const denied = resolveBootSeedDecision({ EDC_ENV: 'prod' })
    expect(denied.reason).toContain('EDC_ENV=prod')
    expect(denied.reason).toContain('SKIPPED')

    const allowed = resolveBootSeedDecision({ EDC_ENV: 'dev' })
    expect(allowed.reason).toContain('EDC_ENV=dev')
    expect(allowed.reason).toContain('ALLOWED')

    const narrowed = resolveBootSeedDecision({ EDC_ENV: 'dev', SEED_DOMAIN: '0' })
    expect(narrowed.reason).toContain('EDC_ENV=dev')
    expect(narrowed.reason).toContain('SEED_DOMAIN=0')
  })

  it('agrees with bootSeedAllowed whenever SEED_DOMAIN is not set', () => {
    // The allowlist stays the single source of permission.
    for (const value of ['local', 'dev', 'demo-0', 'prod', 'stage', 'banana', '', '   ']) {
      const env = { EDC_ENV: value }
      expect(resolveBootSeedDecision(env).seed).toBe(bootSeedAllowed(env))
    }
  })
})

describe('SEED_DOMAIN may only NARROW — manual tier', () => {
  const cannotWiden: Array<[string, Env]> = [
    ['prod + SEED_DOMAIN=1', { EDC_ENV: 'prod', SEED_DOMAIN: '1' }],
    ['prod + SEED_DOMAIN=true', { EDC_ENV: 'prod', SEED_DOMAIN: 'true' }],
    ['stage + SEED_DOMAIN=1', { EDC_ENV: 'stage', SEED_DOMAIN: '1' }],
    ['production + SEED_DOMAIN=yes', { EDC_ENV: 'production', SEED_DOMAIN: 'yes' }],
    ['unset env + SEED_DOMAIN=1', { SEED_DOMAIN: '1' }],
    ['blank env + SEED_DOMAIN=true', { EDC_ENV: '  ', SEED_DOMAIN: 'true' }],
    ['banana + SEED_DOMAIN=1', { EDC_ENV: 'banana', SEED_DOMAIN: '1' }],
    ['demo-1 + SEED_DOMAIN=1 (not on the list)', { EDC_ENV: 'demo-1', SEED_DOMAIN: '1' }],
    ['bare demo + SEED_DOMAIN=1', { EDC_ENV: 'demo', SEED_DOMAIN: '1' }],
    [
      'prod + SEED_DOMAIN=1 + NODE_ENV=development',
      { EDC_ENV: 'prod', SEED_DOMAIN: '1', NODE_ENV: 'development' },
    ],
  ]

  it.each(cannotWiden)('refuses a manual seed: %s', (_label, env) => {
    expect(resolveManualSeedDecision(env).seed).toBe(false)
  })

  it('WARNS that an ignored SEED_DOMAIN was ignored', () => {
    const decision = resolveManualSeedDecision({ EDC_ENV: 'prod', SEED_DOMAIN: '1' })
    expect(decision.seed).toBe(false)
    expect(decision.overrideIgnored).toBe(true)

    const warning = manualIgnoredOverrideWarning({ EDC_ENV: 'prod', SEED_DOMAIN: '1' })
    expect(warning).toContain('SEED_DOMAIN=1')
    expect(warning).toContain('IGNORED')
    expect(warning).toContain('EDC_ENV=prod')
  })

  it('CAN narrow: SEED_DOMAIN=0 turns a manual seed off inside the allowlist', () => {
    // An operator who declared "no demo content here" should not have it
    // re-appear because someone ran the CLI. Narrowing can never open anything.
    expect(resolveManualSeedDecision({ EDC_ENV: 'dev', SEED_DOMAIN: '0' }).seed).toBe(false)
    expect(resolveManualSeedDecision({ EDC_ENV: 'demo-0', SEED_DOMAIN: '0' }).seed).toBe(false)
    expect(resolveManualSeedDecision({ EDC_ENV: 'local', SEED_DOMAIN: 'false' }).seed).toBe(
      false,
    )
  })

  it('allows a manual seed inside the allowlist when SEED_DOMAIN is unset', () => {
    expect(resolveManualSeedDecision({ EDC_ENV: 'local' }).seed).toBe(true)
    expect(resolveManualSeedDecision({ EDC_ENV: 'dev' }).seed).toBe(true)
    expect(resolveManualSeedDecision({ EDC_ENV: 'demo-0' }).seed).toBe(true)
  })

  it('agrees with manualSeedAllowed whenever SEED_DOMAIN is not set', () => {
    for (const value of ['local', 'dev', 'demo-0', 'demo', 'prod', 'stage', 'banana', '', '   ']) {
      const env = { EDC_ENV: value }
      expect(resolveManualSeedDecision(env).seed).toBe(manualSeedAllowed(env))
    }
  })
})

describe('no override moves an environment between tiers', () => {
  // Exhaustive over the environments that matter and every override value we
  // can think of: the boot decision must NEVER exceed the boot allowlist, and
  // the manual decision must NEVER exceed the manual allowlist.
  const values = [undefined, '', '0', '1', 'true', 'false', 'yes', 'no', 'FORCE', ' 1 ']
  const environments = [
    undefined,
    '',
    'local',
    'dev',
    'demo',
    'demo-0',
    'demo-1',
    'stage',
    'prod',
    'banana',
  ]

  // ⚠ These two assert against HARDCODED sets, not against the constants under
  // test. Checking `resolveBootSeedDecision` against `BOOT_SEED_ENVS` would be
  // self-referential: adding 'prod' to the constant would keep the test green.
  // They also count the allowed cases and assert the count is non-zero, so a
  // gate broken SHUT cannot pass by never entering the branch.
  const BOOT_EXPECTED = ['local', 'dev']
  const MANUAL_EXPECTED = ['local', 'dev', 'demo-0']

  it('boot decision never exceeds {local, dev}', () => {
    let allowedCount = 0
    for (const appEnv of environments) {
      for (const seedDomain of values) {
        const env: Env = { EDC_ENV: appEnv, SEED_DOMAIN: seedDomain }
        if (resolveBootSeedDecision(env).seed) {
          allowedCount++
          expect(BOOT_EXPECTED).toContain(currentAppEnv(env))
        }
      }
    }
    // Non-vacuity: the loop must actually have exercised the allowed branch.
    expect(allowedCount).toBeGreaterThan(0)
  })

  it('manual decision never exceeds {local, dev, demo-0}', () => {
    let allowedCount = 0
    for (const appEnv of environments) {
      for (const seedDomain of values) {
        const env: Env = { EDC_ENV: appEnv, SEED_DOMAIN: seedDomain }
        if (resolveManualSeedDecision(env).seed) {
          allowedCount++
          expect(MANUAL_EXPECTED).toContain(currentAppEnv(env))
        }
      }
    }
    expect(allowedCount).toBeGreaterThan(0)
  })

  it('🔴 nothing can ever seed stage or prod, by either tier, under any override', () => {
    for (const appEnv of ['stage', 'prod', 'staging', 'production']) {
      for (const seedDomain of values) {
        const env: Env = { EDC_ENV: appEnv, SEED_DOMAIN: seedDomain }
        expect(bootSeedAllowed(env)).toBe(false)
        expect(manualSeedAllowed(env)).toBe(false)
        expect(resolveBootSeedDecision(env).seed).toBe(false)
        expect(resolveManualSeedDecision(env).seed).toBe(false)
      }
    }
  })
})
