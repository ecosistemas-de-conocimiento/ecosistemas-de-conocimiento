<svelte:options runes={true} />

<script lang="ts">
  /**
   * "Contribuciones" — what this ecosistema has accumulated, and who put it
   * there.
   *
   * The gate and the tenant scoping live in `+page.server.ts` and
   * `$lib/server/admin.ts`. By the time this file runs, `data.overview` is one
   * ecosistema's data or nothing at all.
   *
   * ⚠ The ecosistema's name is printed in the header on purpose. A page that
   * aggregates one tenant must SAY which tenant, or the first person to switch
   * ecosistemas will read yesterday's numbers as today's. Now that switching is
   * one click away — `EcosystemSwitcher` lists ALL of them — that stopped being
   * a nicety and became the thing that keeps the numbers meaning anything.
   *
   * 🔴 OVERSIGHT, NOT PARTICIPATION. Everything below is metadata: that a
   * document exists, who uploaded it, when, its kind and its state. No document
   * text reaches this page, drafts included — see `$lib/server/admin.ts`. An
   * admin reviews every ecosistema without joining one, and the backend makes
   * sure they cannot join one either (`refuseSelfAssignment`).
   */
  import { PanelCard } from '$lib/primitives';
  import AudioPanel from '$lib/components/admin/AudioPanel.svelte';
  import EcosystemSwitcher from '$lib/components/admin/EcosystemSwitcher.svelte';
  import ContributorsTable from '$lib/components/admin/ContributorsTable.svelte';
  import DocumentsTable from '$lib/components/admin/DocumentsTable.svelte';
  import RatingsPanel from '$lib/components/admin/RatingsPanel.svelte';
  import StatTile from '$lib/components/admin/StatTile.svelte';
  import UsagePanel from '$lib/components/admin/UsagePanel.svelte';
  import { formatCostUsd, plural, share } from '$lib/components/admin/summary';
  import { displayAverage } from '$lib/components/admin/metrics';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const overview = $derived(data.overview);
  const numbers = new Intl.NumberFormat('es-MX');

  /**
   * 🔴 Null means "we could not count", NOT zero. The tiles fed by this render
   * `—`, because "0 conversaciones" is a claim an owner would act on and a
   * failed read must never be able to make it.
   */
  const metrics = $derived(overview?.metrics.ok ? overview.metrics.metrics : null);
  const ratingsAverage = $derived(displayAverage(metrics?.ratings.average ?? null));

  /** uploader id → name, so the tables don't each re-derive it. */
  const nameById = $derived(
    Object.fromEntries((overview?.contributors.rows ?? []).map((c) => [c.person.id, c.person.name])),
  );

  const contributorHint = $derived.by(() => {
    if (!overview) return undefined;
    const { active, members } = overview.contributors;
    if (members === 0) return undefined;
    const pct = share(active, members);
    return `de ${plural(members, 'persona', 'personas')} en el ecosistema${pct != null ? ` · ${pct} %` : ''}`;
  });
</script>

<svelte:head><title>Contribuciones · Ecosistemas de Conocimiento</title></svelte:head>

<div class="page text-ink">
  <header class="head">
    <div>
      <p class="kicker">Administración</p>
      <h1>Contribuciones</h1>
    </div>
  </header>

  {#if data.state !== 'unavailable'}
    <!-- 🔴 The oversight surface. Lists every ecosistema, not the caller's
         memberships — that is the sidebar picker's job and it stays that way. -->
    <EcosystemSwitcher
      directory={data.directory}
      selected={data.selected}
      mine={data.mine}
      notFound={data.notFound}
    />
  {/if}

  {#if data.state === 'unavailable'}
    <p class="notice">
      No pudimos leer los datos en este momento. Vuelve a intentarlo en un rato.
    </p>
  {:else if data.state === 'no-ecosystem'}
    <!-- ⚠ NOT "no perteneces a ninguno" any more. An admin reviews every
         ecosistema without belonging to one, so the only honest reason for an
         empty page is that the installation genuinely has no tenants yet. -->
    <p class="notice">
      Todavía no hay ningún ecosistema en la plataforma, así que no hay contribuciones que
      mostrar.
    </p>
  {:else if overview}
    <section class="tiles">
      <StatTile
        label="Documentos"
        value={numbers.format(overview.documents.totalDocs)}
        hint={`${plural(overview.documents.summary.published, 'publicado', 'publicados')} · ${overview.documents.summary.drafts} en borrador`}
      />
      <StatTile
        label="Personas que han aportado"
        value={numbers.format(overview.contributors.active)}
        hint={contributorHint}
      />
      <StatTile
        label="Grabaciones de audio"
        value={numbers.format(overview.audio.total)}
        hint={overview.audio.durationLabel
          ? `${overview.audio.durationLabel} de audio · ${plural(overview.audio.transcribed, 'transcrita', 'transcritas')}`
          : plural(overview.audio.transcribed, 'transcrita', 'transcritas')}
      />
      <!-- 🔴 THE ONLY CORRECT SOURCE FOR THIS TILE. Counting conversations from
           the browser's side of the wire returns the SIGNED-IN ADMIN'S OWN
           chats, because sessions are private and Payload narrows the query
           instead of refusing it. `data.overview.metrics` comes from the
           backend's aggregate endpoint. See `$lib/server/admin.ts`. -->
      <StatTile
        label="Conversaciones"
        value={metrics ? numbers.format(metrics.conversations.sessions) : '—'}
        hint={metrics ? `${numbers.format(metrics.conversations.messages)} mensajes` : undefined}
      />
      <!-- ⚠ Cost, not tokens, and the panel below says why: ai-service records
           tokens under one deployment-wide tenant, so they cannot be split per
           ecosistema. Cost IS per message in our own rows. Ecosistema-wide,
           from the backend's `/api/metrics/usage`. -->
      <StatTile
        label="Costo del chat (solo respuestas)"
        value={overview.usage.ok ? formatCostUsd(overview.usage.summary.costUsd) : '—'}
        hint={overview.usage.ok && !overview.usage.summary.costIsComplete
          ? 'Mínimo: faltan respuestas sin dato de costo.'
          : overview.usage.summary.costPerTurn != null
            ? `${formatCostUsd(overview.usage.summary.costPerTurn)} por respuesta`
            : undefined}
      />
      <!-- ⚠ The count and the average come from the same aggregate endpoint,
           so they cover EVERY rating. The reason tables below are built from a
           capped sample of rating rows and say so when they are truncated —
           two different questions, two different sources, both labelled. -->
      <StatTile
        label="Calificaciones"
        value={metrics ? numbers.format(metrics.ratings.total) : '—'}
        hint={ratingsAverage ? `promedio ${ratingsAverage} de 5` : undefined}
      />
      {#if overview.documents.summary.failed > 0}
        <StatTile
          label="No se pudieron procesar"
          value={numbers.format(overview.documents.summary.failed)}
          tone="danger"
        />
      {:else if overview.documents.summary.inProgress > 0}
        <StatTile
          label="En proceso"
          value={numbers.format(overview.documents.summary.inProgress)}
          tone="warning"
          hint="Todavía se están procesando."
        />
      {/if}
    </section>

    {#if !overview.metrics.ok}
      <!-- ⚠ Said out loud. A tile showing `—` with no explanation reads as
           "cero" to most people, and that is the misreading this whole path
           exists to prevent. -->
      <p class="notice">
        No pudimos contar las conversaciones ni las calificaciones de este ecosistema en este
        momento. Los demás datos sí están al día.
      </p>
    {/if}

    <PanelCard title="Quién ha aportado">
      {#if !overview.contributors.ok}
        <p class="notice small">No pudimos leer la lista de personas del ecosistema.</p>
      {/if}
      <ContributorsTable rows={overview.contributors.rows} />
    </PanelCard>

    <PanelCard title="Audio y transcripciones">
      <AudioPanel
        summary={overview.audio}
        docs={overview.documents.rows}
        nameById={nameById}
      />
    </PanelCard>

    <!-- 🔴 Metadata only, computed by the backend over the WHOLE ecosistema and
         returned with no message text in it. See `apps/backend/src/lib/chatUsage.ts`. -->
    <PanelCard title="Uso del chat">
      <UsagePanel
        summary={overview.usage.summary}
        ok={overview.usage.ok}
        budget={data.state === 'ready' ? data.budget : null}
      />
    </PanelCard>

    <PanelCard title="Qué opinan de las respuestas">
      {#if !overview.ratings.ok}
        <p class="notice small">No pudimos leer todas las calificaciones.</p>
      {:else if overview.ratings.truncated}
        <p class="notice small">
          Contamos las {numbers.format(overview.ratings.summary.total)} calificaciones más recientes
          de {numbers.format(overview.ratings.totalDocs)}.
        </p>
      {/if}
      <RatingsPanel summary={overview.ratings.summary} />
    </PanelCard>

    <PanelCard title="Todos los documentos">
      {#if !overview.documents.ok}
        <p class="notice small">No pudimos leer todos los documentos. La lista puede estar incompleta.</p>
      {:else if overview.documents.truncated}
        <p class="notice small">
          Se muestran los {numbers.format(overview.documents.rows.length)} documentos más recientes
          de {numbers.format(overview.documents.totalDocs)}.
        </p>
      {/if}
      <DocumentsTable docs={overview.documents.rows} nameById={nameById} />
    </PanelCard>
  {/if}
</div>

<style>
  .page {
    min-height: 100%;
    max-width: 74rem;
    margin: 0 auto;
    padding: var(--edc-space-6) var(--edc-space-5) var(--edc-space-8);
    display: grid;
    gap: var(--edc-space-5);
    align-content: start;
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }
  .kicker {
    margin: 0;
    font-family: var(--edc-font-mono);
    font-size: 0.7rem;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--edc-color-ink-soft);
  }
  h1 {
    margin: 0.15rem 0 0.2rem;
    font-family: var(--edc-font-display);
    font-size: 1.7rem;
    font-weight: 800;
    letter-spacing: -0.02em;
    color: var(--edc-color-ink);
  }
  .tiles {
    display: grid;
    gap: 0.7rem;
    grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
  }
  .notice {
    margin: 0;
    padding: 0.7rem 0.85rem;
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-elevated-border);
    background: var(--edc-color-surface-soft);
    font-size: 0.85rem;
    line-height: 1.5;
    color: var(--edc-color-ink-body);
  }
  .notice.small {
    margin-bottom: 0.6rem;
    padding: 0.45rem 0.6rem;
    font-size: 0.74rem;
  }
</style>
