<script lang="ts">
  import { page } from '$app/stores';

  // Top-level error boundary. Renders for:
  //   - structured fatal throws from `$lib/server/deny.ts` (denyAccess / notFound)
  //   - SvelteKit-internal errors (unmatched route 404, uncaught 500 surfaced
  //     by `hooks.server.ts handleError`)
  // It ALWAYS offers an escape-hatch CTA so the user is never stranded on a
  // dead page.

  const status = $derived($page.status);
  const err = $derived($page.error as App.Error | null);

  // Branch on the structured `kind` when present; otherwise infer from status.
  const kind = $derived(
    err?.kind ?? (status === 404 ? 'not-found' : status === 403 ? 'access-denied' : 'generic'),
  );

  const title = $derived(
    kind === 'access-denied'
      ? 'No access'
      : kind === 'not-found'
        ? 'Not found'
        : 'Something went wrong',
  );

  const body = $derived(
    err?.message ??
      (kind === 'access-denied'
        ? "You don't have access to this."
        : kind === 'not-found'
          ? "We couldn't find that page."
          : 'An unexpected error occurred. Please try again.'),
  );

  // Escape hatch: honour an explicit CTA from the thrown body, else send the
  // user somewhere safe (the chat home).
  const cta = $derived(err?.cta ?? { label: 'Back to chat', href: '/' });
</script>

<div class="boundary text-ink">
  <div class="card">
    <p class="status" data-kind={kind}>{status}</p>
    <h1 class="title font-display">{title}</h1>
    <p class="body text-ink-soft">{body}</p>
    <a class="cta" data-interactive href={cta.href}>{cta.label}</a>
  </div>
</div>

<style>
  .boundary {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--edc-space-6);
  }
  .card {
    width: 100%;
    max-width: 26rem;
    text-align: center;
    padding: var(--edc-space-8) var(--edc-space-6);
    border-radius: var(--edc-radius-3);
    background: var(--edc-color-surface-glass-strong);
    border: 1px solid var(--edc-color-elevated-border);
    box-shadow: var(--edc-shadow-1);
  }
  .status {
    margin: 0;
    font-family: var(--edc-font-mono);
    font-size: 0.78rem;
    letter-spacing: 0.08em;
    color: var(--edc-color-ink-soft);
  }
  .status[data-kind='generic'] {
    color: var(--edc-color-danger);
  }
  .title {
    margin: var(--edc-space-2) 0 var(--edc-space-3);
    font-size: 1.4rem;
    font-weight: 800;
    color: var(--edc-color-ink);
  }
  .body {
    margin: 0 0 var(--edc-space-6);
    font-size: 0.92rem;
    line-height: 1.5;
  }
  .cta {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 2.4rem;
    padding: 0.5rem 1.2rem;
    border-radius: var(--edc-radius-2);
    background: var(--edc-gradient-brand);
    /* Gradient fill → white, same rule as Button. See its style block. */
    color: var(--edc-ramp-neutral-0);
    font-weight: 700;
    text-decoration: none;
    border: 1px solid var(--edc-color-brand-outline);
  }
</style>
