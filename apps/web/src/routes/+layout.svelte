<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { app } from '$lib/stores/app.svelte';
  import Toasts from '$lib/components/Toasts.svelte';

  let { children } = $props();

  const isAuthRoute = $derived(
    $page.url.pathname === '/sign-in' || $page.url.pathname === '/sign-up',
  );

  onMount(() => {
    // Only hydrate session/message state on authenticated routes; auth pages
    // are SSR'd and have no need for the store.
    if (!isAuthRoute) {
      void app.hydrateFromServer();
    }
  });
</script>

{@render children?.()}
<Toasts />
