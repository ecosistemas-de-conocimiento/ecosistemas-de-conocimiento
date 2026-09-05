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

🔴 **The one thing worth deciding before writing any of it: where the keys live.**
If connections are administered from the Payload admin UI, the keys sit in the
database, and a key in a Payload collection is readable by anything that can read
that collection. It needs field-level access control at minimum, and encryption
at rest is the honest version. That is the whole security surface of this feature
and it is worth settling before the schema, not after.

⚠ Second thing, smaller: `getAppAIClient()` is memoised per process. A registry
that can change at runtime means cache invalidation when an admin edits a
connection. Easy, but it is the kind of thing that gets found in production.

## Not needed

- per-ecosistema keys
- per-ecosistema budgets
- a key handoff or provisioning system
- an ai-service admin frontend
