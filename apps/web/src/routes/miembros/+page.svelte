<svelte:options runes={true} />

<script lang="ts">
  /**
   * `/miembros` — who is in the ecosistema, and adding people to it.
   *
   * Every rule is in the backend (`/api/miembros`); `+page.server.ts` picks the
   * ecosistema. This file lays it out. No explainer copy (owner rule).
   */
  import { enhance } from '$app/forms';
  import { assignableRoles, outranks, roleLabel } from '$lib/miembros';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const options = $derived(assignableRoles(data.myRole));
  const added = $derived(form && 'added' in form ? form.added : null);
  const failure = $derived(form && 'message' in form ? (form.message as string) : null);
</script>

<svelte:head><title>Miembros · Ecosistemas de Conocimiento</title></svelte:head>

<div class="page text-ink">
  <header class="head">
    <p class="kicker">Miembros</p>
    <h1>{data.selected?.name ?? 'Miembros'}</h1>
  </header>

  {#if data.notFound}
    <p class="notice">No encontramos ese ecosistema.</p>
  {/if}

  {#if data.ecosystems.length > 1 && data.selected}
    <nav class="switcher" aria-label="Elegir ecosistema">
      {#each data.ecosystems as eco (eco.id)}
        <a
          class="chip"
          class:current={eco.id === data.selected.id}
          href={`/miembros?eco=${encodeURIComponent(eco.id)}`}
          aria-current={eco.id === data.selected.id ? 'page' : undefined}
        >
          {eco.name}
        </a>
      {/each}
    </nav>
  {/if}

  {#if failure}
    <p class="error" role="alert" data-testid="miembros-error">{failure}</p>
  {/if}

  {#if added}
    <div class="done" role="status" data-testid="miembros-added">
      <p>Agregado: <strong>{added.email}</strong></p>
      {#if added.temporaryPassword}
        <p>
          Contraseña temporal, si es cuenta nueva (solo se muestra una vez):
          <code data-testid="miembros-password">{added.temporaryPassword}</code>
        </p>
      {/if}
    </div>
  {/if}

  {#if data.state === 'unavailable' || !data.selected}
    <p class="notice">No pudimos cargar los miembros. Intenta de nuevo.</p>
  {:else}
    <section aria-labelledby="agregar">
      <h2 id="agregar">Agregar miembro</h2>
      <form method="POST" action="?/add" class="add" use:enhance data-testid="miembros-add">
        <input type="hidden" name="organization" value={data.selected.id} />
        <label>
          <span>Correo</span>
          <input type="email" name="email" required autocomplete="off" />
        </label>
        <label>
          <span>Nombre</span>
          <input type="text" name="name" required maxlength="200" autocomplete="off" />
        </label>
        <label>
          <span>Rol</span>
          <select name="role">
            {#each options as o (o.value)}
              <option value={o.value}>{o.label}</option>
            {/each}
          </select>
        </label>
        <button type="submit" class="primary">Agregar</button>
      </form>
    </section>

    <section aria-labelledby="actuales">
      <h2 id="actuales">Miembros ({data.members.length})</h2>
      <ul class="list" data-testid="miembros-list">
        {#each data.members as member (member.id)}
          {@const locked = outranks(member.role, data.myRole)}
          <li class="row">
            <span class="who">
              <span class="name">{member.name ?? member.email}</span>
              {#if member.name}<span class="email">{member.email}</span>{/if}
            </span>
            {#if locked}
              <span class="role">{roleLabel(member.role)}</span>
            {:else}
              <form method="POST" action="?/role" class="inline" use:enhance>
                <input type="hidden" name="id" value={member.id} />
                <select name="role" aria-label={`Rol de ${member.name ?? member.email}`}>
                  {#if !options.some((o) => o.value === member.role)}
                    <option value={member.role} selected>{roleLabel(member.role)}</option>
                  {/if}
                  {#each options as o (o.value)}
                    <option value={o.value} selected={o.value === member.role}>{o.label}</option>
                  {/each}
                </select>
                <button type="submit">Guardar</button>
              </form>
              <form method="POST" action="?/remove" class="inline" use:enhance>
                <input type="hidden" name="id" value={member.id} />
                <button type="submit" class="danger">Quitar</button>
              </form>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</div>

<style>
  .page {
    width: min(52rem, 100%);
    margin: 0 auto;
    padding: 1.5rem 1rem 3rem;
  }
  .kicker {
    margin: 0;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--edc-color-ink-soft);
  }
  h1 {
    margin: 0.2rem 0 0;
    font-family: var(--edc-font-display);
    font-size: 1.6rem;
    line-height: 1.2;
  }
  h2 {
    margin: 1.5rem 0 0.6rem;
    font-size: 1.05rem;
  }
  .notice,
  .error,
  .done {
    margin: 1rem 0 0;
    padding: 0.8rem 1rem;
    border: 1px solid var(--edc-color-line);
    border-radius: var(--edc-radius-2);
    background: var(--edc-color-neutral-soft);
  }
  .done p {
    margin: 0.2rem 0;
  }
  code {
    font-size: 1rem;
    user-select: all;
    word-break: break-all;
  }
  .switcher {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin: 1rem 0 0;
  }
  .chip {
    padding: 0.3rem 0.7rem;
    border: 1px solid var(--edc-color-line);
    border-radius: 999px;
    text-decoration: none;
    color: inherit;
  }
  .chip.current {
    font-weight: 700;
  }
  .add {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    align-items: flex-end;
  }
  .add label {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.85rem;
    flex: 1 1 12rem;
  }
  input,
  select,
  button {
    font: inherit;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--edc-color-line);
    border-radius: var(--edc-radius-2);
    background: transparent;
    color: inherit;
  }
  button {
    cursor: pointer;
  }
  .primary {
    font-weight: 700;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
    padding: 0.6rem 0;
    border-bottom: 1px solid var(--edc-color-line);
  }
  .who {
    display: flex;
    flex-direction: column;
    flex: 1 1 14rem;
    min-width: 0;
  }
  .email {
    font-size: 0.85rem;
    color: var(--edc-color-ink-soft);
    overflow-wrap: anywhere;
  }
  .inline {
    display: flex;
    gap: 0.4rem;
  }
  .role {
    color: var(--edc-color-ink-soft);
  }
</style>
