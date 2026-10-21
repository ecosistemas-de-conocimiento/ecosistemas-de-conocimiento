<script lang="ts">
  /**
   * Zero memberships — a real state, not an error.
   *
   * The backend already refuses to create a session without an ecosistema
   * (`no_ecosystem`, 409), because every corpus a conversation searches is
   * derived from one. Left alone that is a dead end: a blank screen, or a toast
   * that disappears. This screen says what is true, what it means, and what the
   * one available action is — ask somebody to add you.
   *
   * ⚠ Shown only when we KNOW the list is empty. A failed read renders the
   * degraded banner instead: telling someone with perfectly good access to go
   * request access is worse than saying nothing.
   */
  import { page } from '$app/stores';

  // Naming the account matters here: "ask to be added" is unactionable if the
  // admin adds the wrong address, and people do keep two.
  const email = $derived($page.data.user?.email ?? '');

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    window.location.href = '/sign-in';
  }
</script>

<div class="flex-1 flex items-center justify-center p-6">
  <div class="max-w-md text-center">
    <div
      class="w-12 h-12 mx-auto rounded-xl bg-surface-soft flex items-center justify-center text-ink-soft"
      aria-hidden="true"
    >
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM2 12h20M12 2a15 15 0 0 1 0 20a15 15 0 0 1 0-20z" />
      </svg>
    </div>

    <h1 class="mt-4 text-lg font-bold text-ink font-display">
      Todavía no perteneces a ningún ecosistema
    </h1>

    <p class="mt-2 text-sm text-ink-soft leading-relaxed">
      Pide a quien administra el sistema que agregue tu cuenta{#if email}&nbsp;({email}){/if}.
    </p>

    <div class="mt-5 flex items-center justify-center gap-2">
      <button
        class="px-3 py-1.5 rounded-lg text-sm bg-surface-accent text-ink hover:bg-surface-soft"
        onclick={() => window.location.reload()}
      >
        Volver a intentar
      </button>
      <button
        class="px-3 py-1.5 rounded-lg text-sm text-ink-soft hover:bg-surface-soft hover:text-ink"
        onclick={logout}
      >
        Cerrar sesión
      </button>
    </div>
  </div>
</div>
