<script lang="ts">
  import '../app.css';
  import { page } from '$app/stores';
  import { app } from '$lib/stores/app.svelte';
  import { hydrationAction } from '$lib/hydration';
  import Toasts from '$lib/components/Toasts.svelte';
  import PrimaryNav from '$lib/components/PrimaryNav.svelte';
  import { MAIN_CONTENT_ID, shouldShowNav } from '$lib/nav';

  let { children } = $props();

  /**
   * 🔴 THE MENU LIVES HERE, NOT IN EACH PAGE.
   *
   * Every section used to carry its own way out — a "Volver al chat" link on
   * `/admin`, a line in the document panel's footer pointing at `/biblioteca`,
   * an `/admin` row at the bottom of the conversation list. Three different
   * surfaces, each visible from one place, and no way at all to reach the
   * library from the library. Hoisting it to the root layout is what makes it
   * ONE menu, in the same spot, on every page — which is the only version of a
   * menu people can learn.
   *
   * ⚠ Read off `$page.data.user` — the root layout's server load, which gets it
   * from the verified session — and never off the chat's app store, which is
   * about conversations and knows nothing about roles.
   */
  const showNav = $derived(shouldShowNav($page.url.pathname, $page.data.user));

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

{#if showNav}
  <!-- ⚠ `height: 100dvh` on the shell, `min-height: 0` on the content: the chat
       is a fixed-height, three-column pane that scrolls internally, so the
       remaining space after the bar has to be a real number for it. `dvh`
       rather than `vh` because mobile browsers' address bar makes `vh` taller
       than the visible window, which hides the composer under it. -->
  <div class="app-shell">
    <PrimaryNav />
    <main id={MAIN_CONTENT_ID} class="app-main">
      {@render children?.()}
    </main>
  </div>
{:else}
  {@render children?.()}
{/if}
<Toasts />

<style>
  .app-shell {
    display: flex;
    flex-direction: column;
    height: 100dvh;
  }
  .app-main {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    /* A column, so a full-height page (the chat) can claim what is left with
       `flex-1` while an ordinary document page (Biblioteca, Administración)
       just grows and scrolls. */
    display: flex;
    flex-direction: column;
  }
</style>
