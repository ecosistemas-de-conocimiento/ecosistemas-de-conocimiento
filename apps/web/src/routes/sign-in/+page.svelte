<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { safeErrMessage } from '$lib/errorSummary';

  // Old `/sign-up` links land here (sign-up is closed, UX backlog #6). Say why
  // instead of silently showing a login form to someone with no account.
  const registrationClosed = $derived($page.url.searchParams.get('registro') === 'cerrado');

  // ⚠ The server already answers in Spanish (`$lib/server/auth.ts`
  // `AUTH_ERROR_COPY`), and it decides WHICH sentence — a wrong password, a
  // locked account and a backend that is down each get their own. This file
  // only prints what it is given. The two constants below are the client-side
  // cases the server never sees, kept as literals because `$lib/server/*` is
  // server-only by construction and cannot be imported here.
  const CANNOT_REACH =
    'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo en un momento.';
  const GENERIC = 'No pudimos iniciar tu sesión. Inténtalo de nuevo en un momento.';

  // `form` is the answer of the no-JS form action (`+page.server.ts`) — set
  // only when a submit before hydration failed.
  let { form }: { form?: { error?: string } | null } = $props();

  let email = $state('');
  let password = $state('');
  let error = $state<string | null>(null);
  // ⚠ NO HYDRATION WAIT on the button. Before the script runs (or with JS
  // off), a submit is a native POST to the form action in `+page.server.ts`.
  let submitting = $state(false);

  async function submit(e: Event) {
    e.preventDefault();
    error = null;
    submitting = true;
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        error = body.error ?? GENERIC;
        return;
      }
      await goto('/', { invalidateAll: true });
    } catch (err) {
      // 🔴 `err.message` is `fetch failed` / `Load failed` — our plumbing, not
      // something a person can act on. It goes to the console, not the screen.
      console.warn('[sign-in] la petición no salió:', safeErrMessage(err));
      error = CANNOT_REACH;
    } finally {
      submitting = false;
    }
  }
</script>

<div class="h-screen w-full flex items-center justify-center text-ink">
  <!-- 🔴 `method="post"`: a native submit lands on the default action in
       `+page.server.ts`, never a GET with the password in the URL. -->
  <form method="post" onsubmit={submit} class="w-full max-w-sm space-y-3 p-6" autocomplete="off">
    <!-- El nombre del producto: la primera pantalla tiene que decir dónde
         estás. No hay logotipo en el repo; cuando lo haya, va aquí. -->
    <p class="product-name font-display">Ecosistemas de Conocimiento</p>

    <h1 class="text-base font-display font-bold text-ink">Inicia sesión</h1>

    {#if registrationClosed}
      <p class="text-sm text-ink-soft closed-note" role="status">
        Pide tu cuenta a quien administra la plataforma.
      </p>
    {/if}

    <label class="block text-xs text-ink-soft">
      Correo electrónico
      <!-- svelte-ignore a11y_autofocus -->
      <input
        type="email"
        name="email"
        autocomplete="email"
        autofocus
        bind:value={email}
        disabled={submitting}
        required
        class="login-input mt-1"
      />
    </label>

    <label class="block text-xs text-ink-soft">
      Contraseña
      <input
        type="password"
        name="password"
        autocomplete="current-password"
        bind:value={password}
        disabled={submitting}
        required
        class="login-input mt-1"
      />
    </label>

    <!-- `role="alert"` so a screen reader reads the problem out loud instead of
         leaving it silently on screen. -->
    {#if error ?? form?.error}
      <p class="text-sm text-danger" role="alert">{error ?? form?.error}</p>
    {/if}

    <button type="submit" disabled={submitting} class="login-submit">
      {submitting ? 'Entrando…' : 'Entrar'}
    </button>
  </form>
</div>

<style>
  .product-name {
    margin: 0 0 1.25rem;
    font-size: 1.35rem;
    font-weight: 700;
    line-height: 1.2;
    color: var(--edc-color-brand-strong);
  }
  .closed-note {
    padding: 0.5rem 0.75rem;
    border-radius: var(--edc-radius-2);
    background: var(--edc-color-brand-soft);
  }
  .login-input {
    width: 100%;
    padding: 0.6rem 0.85rem;
    border-radius: var(--edc-radius-2);
    background: var(--edc-color-surface-glass-strong);
    border: 1px solid var(--edc-color-line);
    color: var(--edc-color-ink);
    font-family: var(--edc-font-body);
    outline: none;
    transition:
      border-color var(--edc-motion-fast) var(--edc-ease-standard),
      box-shadow var(--edc-motion-fast) var(--edc-ease-standard);
  }
  .login-input:focus {
    border-color: var(--edc-color-brand-outline);
    box-shadow: 0 0 0 4px var(--edc-focus-ring);
  }
  .login-input:disabled {
    opacity: 0.6;
  }
  .login-submit {
    width: 100%;
    padding: 0.6rem 0.85rem;
    border-radius: var(--edc-radius-2);
    background: var(--edc-color-brand);
    /* `--edc-color-*` fills pair with `--edc-color-on-*`. Plain `white` here
       measured 2.77:1 in dark mode. */
    color: var(--edc-color-on-brand);
    font-weight: 600;
    border: 1px solid var(--edc-color-brand-outline);
    cursor: pointer;
  }
  .login-submit:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
