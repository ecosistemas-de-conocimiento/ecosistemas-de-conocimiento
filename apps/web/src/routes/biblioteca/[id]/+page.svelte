<svelte:options runes={true} />

<script lang="ts">
  /**
   * `/biblioteca/[id]` — read one published document or voz.
   *
   * 🔴 OPENING THIS IS NOT A NEW PERMISSION. "Publicado" already means "shared
   * with everyone in this ecosistema"; a member reading one is what publishing
   * was for. The check that it really is published, and really belongs to THIS
   * ecosistema, happens server-side on the row itself
   * (`isLibraryVisible`) — never here, and never by trusting the backend's own
   * access rule, which is more generous than this page.
   *
   * 🔴 A TESTIMONIO HAS NO AUTHOR LINE, AND NOT BECAUSE THIS FILE HIDES ONE.
   * The server does not send a name for one, so there is nothing here to
   * render. The page says so out loud instead: an unexplained absence reads as
   * missing data and sends people looking for the person.
   */
  import { page } from '$app/stores';
  import Markdown from '$lib/components/Markdown.svelte';
  import TestimonySource from '$lib/components/TestimonySource.svelte';
  import {
    formatLibraryDate,
    isMachineTranscript,
    isTestimony,
    kindLabel,
    LIBRARY_TRANSCRIPT_NOTE,
    TESTIMONY_ANONYMITY_NOTE,
    textStatsCopy,
    type LibraryDocument,
  } from '$lib/biblioteca';
  import { audioMetaChips } from '$lib/ingest';
  import { LENGUA_LABEL } from '$lib/lengua';
  import type { AudioMeta } from '$lib/types';
  import { app } from '$lib/stores/app.svelte';
  import { anonimizacionHref, LINK_LABEL as ANON_LINK_LABEL, mayOpenAnonimizacion } from '$lib/anonimizacion';

  let doc = $state<LibraryDocument | null>(null);
  let ecosystemName = $state<string | null>(null);
  let viewState = $state<'loading' | 'ready' | 'not-found' | 'unavailable'>('loading');

  const id = $derived($page.params.id ?? '');

  $effect(() => {
    const target = id;
    let cancelled = false;
    viewState = 'loading';
    fetch(`/api/biblioteca/${encodeURIComponent(target)}`, { credentials: 'same-origin' })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 404) {
          viewState = 'not-found';
          return;
        }
        if (!res.ok) {
          viewState = 'unavailable';
          return;
        }
        const body = (await res.json()) as {
          doc: LibraryDocument;
          ecosystem: { name: string } | null;
        };
        doc = body.doc;
        ecosystemName = body.ecosystem?.name ?? null;
        viewState = 'ready';
      })
      .catch(() => {
        if (!cancelled) viewState = 'unavailable';
      });
    return () => {
      cancelled = true;
    };
  });

  const label = $derived(doc ? kindLabel(doc.kind, { fromAudio: doc.fromAudio }) : null);
  const voice = $derived(doc ? isTestimony(doc.kind) : false);
  /** Machine-written only when the FILE was audio — a PDF Voz is not (backlog #12). */
  const machineWritten = $derived(doc ? isMachineTranscript(doc) : false);
  /** A courtesy: the backend refuses anyone else on that page. */
  const anonLink = $derived(
    mayOpenAnonimizacion({ holdsReview: $page.data?.holdsReview, slug: app.ecosystem?.slug }),
  );
</script>

<svelte:head><title>{doc?.title ?? 'Biblioteca'} · Ecosistemas de Conocimiento</title></svelte:head>

<div class="page text-ink">
  <header class="head">
    <a class="back" href="/biblioteca" data-interactive>← Biblioteca</a>
    {#if anonLink && doc}
      <a
        class="back"
        href={anonimizacionHref(doc.id, `/biblioteca/${encodeURIComponent(doc.id)}`)}
        data-interactive
        data-testid="anon-link">{ANON_LINK_LABEL}</a
      >
    {/if}
  </header>

  {#if viewState === 'loading'}
    <p class="notice">Cargando…</p>
  {:else if viewState === 'not-found'}
    <!-- ⚠ One message for three different situations — no such document, not
         published, not this ecosistema. Distinguishing them would confirm that
         an id exists somewhere the reader cannot go. -->
    <div class="empty">
      <p class="empty-title">No encontramos esta publicación.</p>
    </div>
  {:else if viewState === 'unavailable'}
    <p class="notice">No pudimos abrir esta publicación. Inténtalo más tarde.</p>
  {:else if doc && label}
    <article>
      <div class="card-top">
        <span class="kind kind-{label.tone}" title={label.description}>{label.label}</span>
        <span class="date">{formatLibraryDate(doc.createdAt)}</span>
      </div>
      <h1>{doc.title}</h1>
      {#if doc.subtitle != null}<p class="subtitle"><TestimonySource audio={doc.fromAudio} day={doc.subtitle} /></p>{/if}

      <div class="meta">
        {#if voice}
          <!-- 🔴 The anonymity is STATED. See the header. -->
          <span class="anon">{TESTIMONY_ANONYMITY_NOTE}</span>
        {:else if doc.contributor}
          <span>Compartido por {doc.contributor}</span>
        {/if}
        {#if ecosystemName}
          <span>Publicado en {ecosystemName}</span>
        {/if}
        {#if textStatsCopy(doc.text)}
          <span>{textStatsCopy(doc.text)}</span>
        {/if}
        <!-- Set server-side on a documento only (`toLibraryItem`). Links to the
             biblioteca filtered by it. -->
        {#if doc.lengua}
          <a
            class="chip"
            href={`/biblioteca?lengua=${encodeURIComponent(doc.lengua)}`}
            data-testid="library-document-lengua"
          >
            {LENGUA_LABEL}: {doc.lengua}
          </a>
        {/if}
      </div>

      {#if doc.kind === 'audio'}
        <div class="meta">
          {#each audioMetaChips(doc.audioMeta as AudioMeta | null) as chip (chip.label)}
            <span class="chip" title={chip.title}>{chip.label}</span>
          {/each}
        </div>
      {/if}

      {#if machineWritten}
        <!-- 🔴 THE ASR LABEL, ON THE PAGE AND NOT IN A TOOLTIP. This text is
             quoted as fact by the assistant to people who never heard the
             recording. Saying a machine wrote it is the agreed price of
             accepting transcripts as first-class sources — the same string the
             uploader saw before they published it. -->
        <p class="provenance">{LIBRARY_TRANSCRIPT_NOTE}</p>
      {/if}

      {#if doc.text.trim()}
        <!-- Rendered Markdown (owner, 2026-10-28: notes and documents showed
             raw `**` and `#`). `document`: `[[enlaces]]` read as text, no
             images, `[N]` stays text. A transcript has no markup, so it reads
             as it did. -->
        <div class="body">
          <Markdown document source={doc.text} testid="library-document-text" />
        </div>
      {:else}
        <p class="notice">Esta publicación no tiene texto para mostrar.</p>
      {/if}
    </article>
  {/if}
</div>

<style>
  .subtitle {
    margin: 0.1rem 0 0;
    font-size: 0.9rem;
    color: var(--edc-color-ink-soft);
  }
  /* 🔴 A flex item of `.app-main` with `margin: auto` is as wide as its
     content: short text drew a narrow column, a long line or a wide table a
     page wider than the phone, scrolling sideways. `width` fixes the first,
     `min-width: 0` and the `minmax(0, 1fr)` column the second. */
  .page {
    min-height: 100%;
    width: 100%;
    min-width: 0;
    max-width: 46rem;
    margin: 0 auto;
    padding: var(--edc-space-6) var(--edc-space-5) var(--edc-space-8);
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--edc-space-4);
    align-content: start;
  }
  article {
    min-width: 0;
  }
  .head {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .back {
    padding: 0.4rem 0.85rem;
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-neutral-outline);
    font-size: 0.78rem;
    font-weight: 700;
    text-decoration: none;
    color: var(--edc-color-ink-soft);
  }
  .back:hover {
    color: var(--edc-color-ink);
    background: var(--edc-color-neutral-soft);
  }
  .card-top {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  /* Was unstyled, so the date rendered larger than the kind badge beside it. */
  .date {
    font-size: 0.72rem;
    color: var(--edc-color-ink-soft);
  }
  h1 {
    margin: 0.4rem 0 0.2rem;
    font-family: var(--edc-font-display);
    font-size: 1.6rem;
    font-weight: 800;
    letter-spacing: -0.02em;
    color: var(--edc-color-ink);
  }
  .meta {
    margin: 0.6rem 0 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    font-size: 0.75rem;
    color: var(--edc-color-ink-soft);
  }
  .anon {
    font-style: italic;
  }
  .kind {
    padding: 0.1rem 0.45rem;
    border-radius: var(--edc-radius-pill);
    border: 1px solid var(--edc-color-elevated-border);
    font-size: 0.68rem;
    font-weight: 700;
  }
  .kind-voice {
    border-color: var(--edc-color-accent-outline);
    background: var(--edc-color-accent-soft);
    color: var(--edc-color-accent-strong);
  }
  .kind-document {
    background: var(--edc-color-surface-soft);
    color: var(--edc-color-ink-soft);
  }
  .chip {
    padding: 0.05rem 0.35rem;
    border-radius: var(--edc-radius-1);
    border: 1px solid var(--edc-color-elevated-border);
    background: var(--edc-color-surface-soft);
  }
  .provenance {
    margin: 0.9rem 0 0;
    padding: 0.5rem 0.7rem;
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-warning-outline);
    background: var(--edc-color-warning-soft);
    color: var(--edc-color-ink);
    font-size: 0.78rem;
    line-height: 1.5;
  }
  /* A reading column: ~70 characters a line. */
  .body {
    margin: 1.25rem 0 0;
    max-width: 70ch;
    overflow-wrap: anywhere;
    line-height: 1.7;
    font-size: 1rem;
    color: var(--edc-color-ink-body);
  }
  .body :global(.md-body p) {
    margin: 0 0 0.9em;
  }
  /* A wide table scrolls on its own, not the page. */
  .body :global(.md-body table) {
    display: block;
    overflow-x: auto;
  }
  .notice {
    margin: 0;
    padding: 0.7rem 0.85rem;
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-elevated-border);
    background: var(--edc-color-surface-soft);
    font-size: 0.82rem;
    line-height: 1.5;
    color: var(--edc-color-ink-body);
  }
  .empty {
    display: grid;
    gap: 0.5rem;
    text-align: center;
    padding: 1.5rem 0;
  }
  .empty-title {
    margin: 0;
    font-size: 1rem;
    font-weight: 700;
  }
</style>
