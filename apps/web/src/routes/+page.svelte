<script lang="ts">
  import ChatWorkspace from '$lib/components/ChatWorkspace.svelte';
  import DegradedBanner from '$lib/components/DegradedBanner.svelte';
  import NoEcosystem from '$lib/components/NoEcosystem.svelte';
  import { app } from '$lib/stores/app.svelte';

  // If hydration finishes and the user has zero sessions, create one
  // immediately so the chat pane has a target. Logged-in dev users start
  // with an empty backend; this avoids a blank "no chat selected" screen.
  //
  // Skip the auto-create when the read degraded due to a transient backend
  // failure ('unavailable') — the session-create would likely fail too, and
  // we don't want to hammer a down backend. A 'forbidden' degrade (empty
  // tenant) is the legitimate first-run case, so we still create there.
  //
  // ⚠ Also skip it while an ecosistema switch is in flight, and when there is
  // no ecosistema at all. A session must name one; creating during the switch
  // would race the clear-and-reload, and creating with none is a guaranteed 409
  // on top of a screen that already explains the situation.
  $effect(() => {
    if (
      app.ready &&
      !app.switchingEcosystem &&
      app.ecosystems.length > 0 &&
      app.sessions.length === 0 &&
      app.degraded?.reason !== 'unavailable'
    ) {
      void app.newSession();
    }
  });
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
