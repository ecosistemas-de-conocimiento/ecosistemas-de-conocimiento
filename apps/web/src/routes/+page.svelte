<script lang="ts">
  import Sidebar from '$lib/components/Sidebar.svelte';
  import Chat from '$lib/components/Chat.svelte';
  import DocsPanel from '$lib/components/DocsPanel.svelte';
  import DegradedBanner from '$lib/components/DegradedBanner.svelte';
  import { app } from '$lib/stores/app.svelte';

  // If hydration finishes and the user has zero sessions, create one
  // immediately so the chat pane has a target. Logged-in dev users start
  // with an empty backend; this avoids a blank "no chat selected" screen.
  //
  // Skip the auto-create when the read degraded due to a transient backend
  // failure ('unavailable') — the session-create would likely fail too, and
  // we don't want to hammer a down backend. A 'forbidden' degrade (empty
  // tenant) is the legitimate first-run case, so we still create there.
  $effect(() => {
    if (app.ready && app.sessions.length === 0 && app.degraded?.reason !== 'unavailable') {
      void app.newSession();
    }
  });
</script>

<div class="h-screen w-full flex flex-col text-ink">
  <DegradedBanner />
  <div class="flex flex-1 min-h-0">
    <Sidebar />
    <Chat />
    <DocsPanel />
  </div>
</div>
