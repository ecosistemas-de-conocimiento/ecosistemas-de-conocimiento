<script lang="ts">
  import { page } from '$app/stores';
  import { CONVERSACIONES_HREF } from '$lib/inicio';

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

  // ⚠ SPANISH, like the rest of the product. This page had shipped in English,
  // which is worst exactly here: it is the screen a person reaches when
  // something already went wrong, and reading it in another language turns a
  // recoverable moment into "the site is broken".
  //
  // The wording is borrowed from copy the app already uses rather than invented
  // — "Algo salió mal" and "Inténtalo de nuevo" from `$lib/stores/app.svelte.ts`,
  // "Volver al chat" from the admin page's own escape hatch — so the same
  // situation reads the same way wherever a user meets it.
  const title = $derived(
    kind === 'access-denied'
      ? 'Sin acceso'
      : kind === 'not-found'
        ? 'No encontramos esto'
        : 'Algo salió mal',
  );

  /**
   * ⚠ SvelteKit fills `error.message` itself for the errors IT raises — an
   * unmatched route gets the literal string `Not Found`, an uncaught throw gets
   * `Internal Error`. Those are framework defaults, not our copy, and they
   * appear on exactly the two most common error screens. Trusting
   * `err.message` blindly is how "No encontramos esto / Not Found" ends up on
   * the page: a Spanish heading over an English body.
   *
   * So a message is used only when it is OURS — `$lib/server/deny.ts` always
   * sets `kind`, SvelteKit never does. No `kind`, no borrowed message.
   *
   * ⚠ The last two entries are `$lib/server/deny.ts`'s OWN fallbacks, which are
   * still English. A caller that passes real copy (every caller in the app
   * today does) is unaffected; a caller that passes none now lands on the
   * Spanish default below instead of shipping English. The proper fix is in
   * `deny.ts` itself — this is the boundary refusing to render it either way.
   */
  const NOBODY_CHOSE_THIS = new Set([
    // SvelteKit's own.
    'Not Found',
    'Internal Error',
    // deny.ts's own fallbacks.
    "You don't have access to this.",
    "We couldn't find that page.",
  ]);
  const ownMessage = $derived(
    err?.kind && err.message && !NOBODY_CHOSE_THIS.has(err.message) ? err.message : null,
  );

  const body = $derived(
    ownMessage ??
      (kind === 'access-denied'
        ? 'No tienes acceso a esta sección.'
        : kind === 'not-found'
          ? 'No encontramos esa página.'
          : 'Ocurrió un error inesperado. Inténtalo de nuevo.'),
  );

  // Escape hatch: honour an explicit CTA from the thrown body, else send the
  // user somewhere safe (the chat home).
  const cta = $derived(err?.cta ?? { label: 'Volver al chat', href: CONVERSACIONES_HREF });
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
