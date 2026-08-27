<svelte:options runes={true} />

<script lang="ts">
  /**
   * "Quién ha aportado" — the contributions, per person.
   *
   * ⚠ People with zero documents are shown, greyed, at the bottom. That is the
   * point of the table: an ecosistema where 2 of 14 people have ever uploaded
   * anything is a different situation from one where 12 have, and a list of
   * contributors alone cannot tell them apart.
   */
  import { formatDay, type ContributorRow } from './summary';

  type Props = { rows: ContributorRow[] };
  let { rows }: Props = $props();

  const ROLE_LABELS: Record<string, string> = {
    owner: 'dueña/o',
    admin: 'administra',
    member: 'integrante',
  };
</script>

{#if rows.length === 0}
  <p class="empty">Todavía no hay personas registradas en este ecosistema.</p>
{:else}
  <div class="scroller">
    <table>
      <thead>
        <tr>
          <th scope="col">Persona</th>
          <th scope="col" class="num">Documentos</th>
          <th scope="col" class="num">Publicados</th>
          <th scope="col" class="num">Borradores</th>
          <th scope="col" class="num">Audio</th>
          <th scope="col">Último aporte</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.person.id)}
          <tr class:quiet={row.total === 0}>
            <th scope="row">
              <span class="name">{row.person.name}</span>
              <span class="sub">
                {#if row.person.email}{row.person.email}{/if}
                {#if row.person.role && ROLE_LABELS[row.person.role]}
                  <span class="role">· {ROLE_LABELS[row.person.role]}</span>
                {/if}
                {#if !row.person.isMember}
                  <span class="role">· ya no es del ecosistema</span>
                {/if}
              </span>
            </th>
            <td class="num strong">{row.total}</td>
            <td class="num">{row.published}</td>
            <td class="num">{row.drafts}</td>
            <td class="num">{row.audio}</td>
            <td>{row.lastAt ? formatDay(row.lastAt) : 'Nada todavía'}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .scroller {
    overflow-x: auto;
  }
  .empty {
    margin: 0;
    font-size: 0.8rem;
    color: var(--edc-color-ink-soft);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
  }
  th,
  td {
    text-align: left;
    padding: 0.5rem 0.6rem;
    border-bottom: 1px solid var(--edc-color-line);
    vertical-align: top;
  }
  thead th {
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--edc-color-ink-soft);
    white-space: nowrap;
  }
  tbody th {
    font-weight: 600;
    color: var(--edc-color-ink);
  }
  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .strong {
    font-weight: 700;
    color: var(--edc-color-ink);
  }
  .name {
    display: block;
  }
  .sub {
    display: block;
    font-weight: 400;
    font-size: 0.7rem;
    color: var(--edc-color-ink-soft);
  }
  .role {
    white-space: nowrap;
  }
  tr.quiet th,
  tr.quiet td {
    color: var(--edc-color-ink-soft);
  }
</style>
