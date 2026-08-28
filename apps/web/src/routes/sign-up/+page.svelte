<script lang="ts">
  import { goto } from '$app/navigation';

  // ⚠ Same rule as `/sign-in`: the server picks the Spanish sentence (see
  // `$lib/server/auth.ts` `AUTH_ERROR_COPY` — "ya hay una cuenta con ese
  // correo" reads very differently from "el servidor no responde"). This file
  // only prints it. These two literals cover what never reaches the server.
  const CANNOT_REACH =
    'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo en un momento.';
  const GENERIC = 'No pudimos crear tu cuenta. Inténtalo de nuevo en un momento.';

  let email = $state('');
  let password = $state('');
  let displayName = $state('');
  let error = $state<string | null>(null);
  let submitting = $state(false);

  async function submit(e: Event) {
    e.preventDefault();
    error = null;
    submitting = true;
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, displayName }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        error = body.error ?? GENERIC;
        return;
      }
      await goto('/', { invalidateAll: true });
    } catch (err) {
      // 🔴 `err.message` names our plumbing (`fetch failed`). Console, not screen.
      console.warn('[sign-up] la petición no salió:', (err as Error).message);
      error = CANNOT_REACH;
    } finally {
      submitting = false;
    }
  }
</script>

<div class="h-screen w-full flex items-center justify-center text-ink">
  <form onsubmit={submit} class="w-full max-w-sm space-y-3 p-6" autocomplete="off">
    <h1 class="text-base font-display font-bold text-ink">Crea tu cuenta</h1>

    <label class="block text-xs text-ink-soft">
      Tu nombre
      <input
        type="text"
        name="displayName"
        bind:value={displayName}
        disabled={submitting}
        placeholder="Opcional"
        title="Así te verán las demás personas de tu ecosistema."
        class="login-input mt-1"
      />
    </label>

    <label class="block text-xs text-ink-soft">
      Correo electrónico
      <input
        type="email"
        name="email"
        autocomplete="email"
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
        autocomplete="new-password"
        minlength="8"
        bind:value={password}
        disabled={submitting}
        required
        class="login-input mt-1"
      />
      <span class="text-[10px] text-ink-soft">Al menos 8 caracteres.</span>
    </label>

    <!-- `role="alert"` so un lector de pantalla anuncia el problema. -->
    {#if error}
      <p class="text-sm text-danger" role="alert">{error}</p>
    {/if}

    <button type="submit" disabled={submitting} class="login-submit">
      {submitting ? 'Creando…' : 'Crear cuenta'}
    </button>

    <p class="text-xs text-ink-soft pt-2">
      ¿Ya tienes cuenta?
      <a href="/sign-in" class="underline hover:text-ink">Inicia sesión</a>
    </p>
  </form>
</div>

<style>
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
