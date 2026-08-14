> **Status — open.** Process question, not a code question.
> Follow-up to a model-pricing refresh.

# Pricing-refresh cadence

`ai-service` charges against pre-baked pricing tables that say "model X
costs $Y per million input tokens, $Z per million output tokens." Those
numbers come from OpenRouter's published catalog. Vendors change prices
without notice; if our table drifts from reality, the budget enforcer
either over-charges (we look stingy) or under-charges (we burn through
real money while believing we have headroom). The pricing was refreshed
and a script exists to print upstream diffs, but there's
no schedule for running it again. This open item is the decision: how
often, on what trigger, and by whom.

## Current mechanism

Two source files carry the pricing:

- `src/services/ai/router/task-profiles.ts` — `MODEL_PRICING` table
  used by `priceForUsage(model, in, out)`.
- `src/services/registry/resolve.ts` — `EFFORT_PROFILES`'s
  `estimatedCostUsdPerCall` figures used by the orchestrator for the
  pre-call estimate.

The refresh helper at `scripts/refresh-model-pricing.ts` (wired as
`pnpm run refresh-pricing`) hits OpenRouter's public `/api/v1/models`
endpoint, diffs the numbers against what's currently committed, and
prints a human-readable diff. **It does not auto-edit.** A human pastes
the new numbers in and bumps the inline `// last verified: YYYY-MM-DD`
comment.

The last refresh produced three material moves — see `m3-m4-decisions.md`
§9's "Pricing refresh note".

## Options

### Option A — pure manual, calendar-driven

Whoever notices the inline comment is overdue runs
`pnpm run refresh-pricing`, eyeballs the diff, commits. No automation,
no scheduled reminder.

- Pros: zero infra; trivial; matches current state.
- Cons: easy to forget; the inline comment becomes stale within months
  of any human's attention rotating elsewhere.

### Option B — quarterly cron job on Coolify (notify, don't apply)

A scheduled job runs `pnpm run refresh-pricing` against the deployed
service quarterly, posts the diff to a Slack channel or email,
*does not auto-commit*. Humans still vet before merging.

- Pros: removes the "did we forget" risk; keeps human review for the
  actual edit.
- Cons: small ops surface; needs a way to deliver the diff out of the
  service (Slack webhook env var, SMTP creds, or pushed to a GitHub
  issue via the gh API).

### Option C — quarterly cron + auto-PR

Same scheduled run, but the script auto-opens a PR with the proposed
diff. Humans review and merge.

- Pros: zero forget-risk; review-burden lives where reviews already
  live (GitHub).
- Cons: needs a service account with PR-write scope; needs the script
  to grow a "write the new numbers in" mode; needs CI to vet the
  resulting test diff (some EFFORT_PROFILES tests assert specific
  cost figures and will fail until updated alongside).

### Option D — runtime auto-fetch (rejected)

Have the service fetch live pricing on startup or per-call. Hard reject:
adds a network dependency to budget math, kills reproducibility of
tests, and would require provider auth to use a paid pricing endpoint.

## Recommendation

**Start with Option B, calendar-quarterly, sent to whoever owns the
`ai-service` notifications channel.** Reasoning:

- Quarterly matches the rate at which vendors actually re-price (one
  diff showed three movements in
  ~three weeks — not unusual for OpenRouter's frontier-model lineup,
  but for the workhorses we use, quarterly is sufficient).
- Auto-PR (Option C) is a fine destination; it's just more plumbing
  for what's still a "human reads numbers" workflow. Save until the
  manual cost-of-review feels painful.
- Pure manual (Option A) is what we have now and it failed: the
  numbers drifted by enough that a sweep
  caught it. Don't repeat.

## Acceptance criteria

- A Coolify scheduled job (or GitHub Actions cron, or any other
  reliable scheduler — pick one) runs `pnpm run refresh-pricing` on the
  first business day of February, May, August, and November.
- The output (or its diff vs current commit) lands somewhere a human
  reliably sees within 24h.
- If three quarters pass with no diff, no action needed; the inline
  comment date updates only when numbers move.
- A note in `README.md` (or `CONTRIBUTING.md`) tells future maintainers
  where the cadence is configured.

## Open questions for the user

- **Where do notifications go?** Slack channel? GitHub issue with a
  specific label? Email to the engineering distribution list? The
  decision determines the script's output mode.
- **Is "OpenRouter only" still true at the time this cron runs?** If
  a second provider has been added by then, the script needs to fetch
  from both.
- **Q3 2026 specifically — what month?** The inline comment says
  "Q3 2026"; pick a specific cron date so the first run isn't a
  judgment call.

## Estimated cost

Tiny. The script already exists; what's missing is the scheduler
hookup and the notification path. Maybe a couple hours including
testing that the cron actually fires.
