<script lang="ts">
  import { goto } from '$app/navigation';

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
        error = body.error ?? 'Sign-up failed';
        return;
      }
      await goto('/', { invalidateAll: true });
    } catch (err) {
      error = `Network: ${(err as Error).message}`;
    } finally {
      submitting = false;
    }
  }
</script>

<div class="h-screen w-full flex items-center justify-center text-ink">
  <form onsubmit={submit} class="w-full max-w-sm space-y-3 p-6" autocomplete="off">
    <h1 class="text-base font-display font-bold text-ink">Create account</h1>

    <label class="block text-xs text-ink-soft">
      Display name
      <input
        type="text"
        name="displayName"
        bind:value={displayName}
        disabled={submitting}
        placeholder="Optional"
        class="login-input mt-1"
      />
    </label>

    <label class="block text-xs text-ink-soft">
      Email
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
      Password
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
      <span class="text-[10px] text-ink-soft">At least 8 characters.</span>
    </label>

    {#if error}
      <p class="text-sm text-danger">{error}</p>
    {/if}

    <button type="submit" disabled={submitting} class="login-submit">
      {submitting ? 'Creating…' : 'Create account'}
    </button>

    <p class="text-xs text-ink-soft pt-2">
      Already have one?
      <a href="/sign-in" class="underline hover:text-ink">Sign in</a>
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
