<script lang="ts">
  import '../app.css';
  import { page } from '$app/stores';
  import { app } from '$lib/stores/app.svelte';
  import { hydrationAction } from '$lib/hydration';
  import Toasts from '$lib/components/Toasts.svelte';

  let { children } = $props();

  /**
   * 🔴 NOT `onMount`, AND NOT `$state`. Both matter — see `$lib/hydration.ts`
   * for the bug this shape exists to prevent.
   *
   * `onMount` fired once, on whichever route the app was entered through. Enter
   * through `/sign-in` and it fired there, decided "auth route, don't hydrate",
   * and the `goto('/')` that follows a successful sign-in never remounted this
   * layout — so the app never read itself from the server and sat on "Cargando…"
   * until the user reloaded by hand.
   *
   * This effect re-decides on every navigation instead, because `$page` is its
   * only reactive dependency. `hydrated` is a PLAIN `let` on purpose: it is a
   * latch, not something the UI renders, and keeping it non-reactive is what
   * stops the effect from re-triggering itself when it writes to it.
   */
  let hydrated = false;

  $effect(() => {
    const action = hydrationAction({ pathname: $page.url.pathname, hydrated });
    if (action === 'hydrate') {
      hydrated = true;
      void app.hydrateFromServer();
    } else if (action === 'reset') {
      hydrated = false;
      app.reset();
    }
  });
</script>

{@render children?.()}
<Toasts />
