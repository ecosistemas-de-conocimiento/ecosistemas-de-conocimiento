<script lang="ts">
  import ChatWorkspace from '$lib/components/ChatWorkspace.svelte';
  import DegradedBanner from '$lib/components/DegradedBanner.svelte';
  import NoEcosystem from '$lib/components/NoEcosystem.svelte';
  import { app } from '$lib/stores/app.svelte';

  // ⚠ No session is created on load. A person with no conversations gets the
  // empty composer; the first send or upload creates one (`app.ensureSession`).
  // Creating on load added a blank "Nueva conversación" on every sign-in.
</script>

<div class="flex-1 min-h-0 w-full flex flex-col text-ink">
  <DegradedBanner />
  {#if app.hasNoEcosystem}
    <!-- Nothing below this point makes sense without a tenant to scope it. -->
    <NoEcosystem />
  {:else}
    <!-- ⚠ The three panes and how they collapse on a narrow screen live in
         ChatWorkspace — see $lib/layout.ts for the decision and why. -->
    <ChatWorkspace />
  {/if}
</div>
