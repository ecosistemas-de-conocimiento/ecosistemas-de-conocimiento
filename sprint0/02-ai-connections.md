# 02 — One key now; plan for several AI servers later

**Status:** ✅ **DECIDED 2026-09-04.** Not a task. A short note so the next person
does not re-open it.

⚠ **This file replaces an earlier one about per-tenant API keys.** That was the
wrong problem. It was written assuming EDC needed to isolate its ecosistemas
from each other at the ai-service level. It does not. The earlier version is in
git history if anyone wants the fleet-level reasoning; it does not apply here.

## What EDC actually is

- **One operator.** A single admin profile administers everything.
- **Ecosistemas are content scoping, not customers.** They decide who sees which
  documents. They are not separate accounts with separate bills or quotas.
- **One AI key**, and that is correct for the size of this.

So: no per-tenant keys, no per-tenant budgets, no key provisioning system, no
`API_KEYS` fan-out. None of it.

## What is actually coming

> *"Plan for having connections to multiple servers with separate auth / keys in
> the near future, administered from the project's admin UI."*

That is a **different axis** from anything discussed before. Not one key per
customer — one key per **upstream server** EDC talks to. Several AI backends,
each with its own base URL and its own credential, chosen per use.

## What that implies, when it is built

Today `apps/backend/src/lib/aiClient.ts` memoises **one** client from
`AI_SERVICE_URL` + `AI_SERVICE_API_KEY`. Two singletons, app and admin.

The change is a small registry: resolve a connection by name, rather than read
two env vars. The call sites already go through `getAppAIClient()`, so the seam
exists — it just returns a fixed answer today.

### 🔴 Where the keys live — DECIDED

If connections are administered from the Payload admin UI, the keys sit in the
database, and a key in a Payload collection is readable by anything that can read
that collection. That is the whole security surface of this feature.

✅ **Field-level access control on the key field. Approved by the owner
2026-09-04.** Build it that way from the first migration — retrofitting access
control onto a field that has already been readable means assuming every key
written before the fix is compromised.

What that means concretely, following the pattern already in this repo
(`platformAdminFieldAccess` in `src/access/index.ts` gates `users.isPlatformAdmin`
the same way):

- `read` on the key field returns false for everyone. Not "admins only" — the
  server reads it through `overrideAccess`, and nothing else ever needs it.
- `update` gated to the admin profile. `create` likewise.
- ⚠ The admin UI must show a masked placeholder, never the stored value. A field
  that is unreadable by the API but rendered in a form is not protected.
- ⚠ Check what Payload puts in `payload_locked_documents` and in any audit or
  version row for this collection. Field access does not always follow a value
  into the places Payload copies it.

🟡 **Encryption at rest is NOT decided** and was not part of this approval. Field
access stops the API handing the key out; it does not stop anyone with database
access reading it. Whether that matters depends on who can reach Postgres in
production — worth answering before launch, not before the schema.

### 🔴 Cache invalidation — a requirement, not a footnote

Today the connection is an env var, so "it never changes" is a safe assumption
and the code makes it in **four** places. An admin UI breaks that assumption
everywhere at once.

| Where | What is held |
| --- | --- |
| `lib/aiClient.ts:39-40` | `appClient`, `adminClient` — module-level, built once |
| `lib/graph/client.ts:79` | `cached` — the extraction client, its own 660s timeout |
| `lib/capabilityCheck.ts:44` | `alreadyChecked` — the boot negotiation, runs once per process |

An admin edits a connection and every one of these keeps serving the old URL and
the old key until the process restarts. The failure is silent: requests keep
succeeding against the previous server, so the symptom is "my change did nothing"
rather than an error.

**What the design must include:**

1. **One invalidation seam, not four.** A single `resetAIClients()` the connection
   collection's `afterChange` hook calls. `graph/client.ts` already exports
   `__resetGraphClientForTests()` and `capabilityCheck.ts` exports
   `_resetCapabilityCheckForTests()` — the mechanism exists, it is just named as
   test-only and wired to nothing.
2. **Re-run the capability check** after a connection changes. A new server may
   not publish the capabilities this backend requires, and `alreadyChecked`
   means it is currently asked exactly once, at boot, against the old server.
3. 🔴 **Decide what happens across replicas.** Module-level state is per process.
   With one container an in-process reset is correct and complete. With two, an
   admin's edit reaches one of them and the other keeps using the old key until
   it restarts — and nothing surfaces the disagreement. `lib/rateLimit.ts` already
   carries this exact warning for its counters ("N replicas allow N× every
   limit"); the same constraint applies here and it is worth answering in the
   same breath rather than discovering twice.

⚠ Do not solve 3 by removing the memoisation. The clients are cached because
constructing one negotiates capabilities; rebuilding per request would put a
network round trip in front of every call.

## Not needed

- per-ecosistema keys
- per-ecosistema budgets
- a key handoff or provisioning system
- an ai-service admin frontend
