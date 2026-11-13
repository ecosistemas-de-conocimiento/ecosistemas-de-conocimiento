<script lang="ts">
  /**
   * The printable constancia. «Descargar» is `window.print()`: the browser's
   * «Guardar como PDF», no PDF library (plan §2.2). `@media print` below hides
   * the app's chrome.
   */
  import { PRIVACY_PATH, uploadConsentText } from '$lib/uploadConsent';
  import type { Constancia } from './+page.server';

  let { data }: { data: { constancia: Constancia } } = $props();

  const c = $derived(data.constancia);
  const r = $derived(c.receipt);
  const d = $derived(c.document);

  const CONTENT_KIND_LABELS: Record<string, string> = {
    documento: 'Documento',
    testimonio: 'Testimonio',
    conversacion: 'Conversación',
  };
  const FILE_KIND_LABELS: Record<string, string> = {
    pdf: 'PDF',
    docx: 'Word',
    markdown: 'Texto',
    text: 'Texto',
    audio: 'Audio',
  };

  const fecha = (iso: string): string => {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return '—';
    return new Intl.DateTimeFormat('es-MX', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: 'America/Mexico_City',
    }).format(t);
  };

  const contentKind = $derived(r?.contentKind ?? d?.contentKind ?? 'documento');
  const tipo = $derived(
    [CONTENT_KIND_LABELS[contentKind], d?.kind ? (FILE_KIND_LABELS[d.kind] ?? d.kind) : null].filter(Boolean).join(' · '),
  );
  // 🔴 A null title (testimonio the reader may not open) is «Testimonio», never a filename.
  const titulo = $derived(d ? (d.title ?? 'Testimonio') : 'Borrado');
  const texto = $derived(r ? uploadConsentText(r.contentKind, r.consentVersion) : null);
</script>

<svelte:head>
  <title>Constancia · Documento {c.documentId}</title>
</svelte:head>

<article class="constancia" data-testid="constancia">
  <h1>Constancia de consentimiento</h1>

  {#if r}
    <dl>
      <dt>Folio</dt>
      <dd data-testid="constancia-folio">{r.folio}</dd>
      <dt>Fecha</dt>
      <dd>{fecha(r.acceptedAt)}</dd>
      <dt>Versión</dt>
      <dd>{r.consentVersion}</dd>
      <dt>Ecosistema</dt>
      <dd>{r.ecosystem?.name || '—'}</dd>
      <dt>Tipo</dt>
      <dd>{tipo}</dd>
      <dt>Documento n.º</dt>
      <dd>{c.documentId}</dd>
      <dt>Título</dt>
      <dd data-testid="constancia-title">{titulo}</dd>
    </dl>

    <blockquote data-testid="constancia-text">
      {texto ?? `Texto de la versión ${r.consentVersion} no disponible.`}
    </blockquote>
    {#if r.contentKind === 'testimonio'}
      <p class="note">Lo declara quien subió el material; no sustituye el consentimiento escrito de la persona que habla.</p>
    {/if}
    <p class="note">Aviso de privacidad: <a href={PRIVACY_PATH}>{PRIVACY_PATH}</a></p>
  {:else}
    <p data-testid="constancia-none">Sin registro de consentimiento</p>
    <dl>
      <dt>Documento n.º</dt>
      <dd>{c.documentId}</dd>
      <dt>Tipo</dt>
      <dd>{tipo}</dd>
      <dt>Título</dt>
      <dd data-testid="constancia-title">{titulo}</dd>
    </dl>
  {/if}

  <div class="actions no-print">
    <a href="/documentos">Volver</a>
    <button type="button" onclick={() => window.print()}>Descargar</button>
  </div>
</article>

<style>
  .constancia {
    width: 100%;
    min-width: 0;
    max-width: 40rem;
    margin: 0 auto;
    padding: var(--edc-space-6) var(--edc-space-5) var(--edc-space-8);
    color: var(--edc-color-ink);
  }
  h1 {
    font-family: var(--edc-font-display);
    font-size: 1.3rem;
    font-weight: 700;
    margin: 0 0 1rem;
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.35rem 1rem;
    margin: 0 0 1rem;
  }
  dt {
    color: var(--edc-color-ink-soft);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  blockquote {
    margin: 0 0 0.75rem;
    padding: 0.75rem 1rem;
    border-left: 3px solid var(--edc-color-line-strong);
  }
  .note {
    font-size: 0.85rem;
    color: var(--edc-color-ink-soft);
    margin: 0 0 0.5rem;
  }
  a {
    color: var(--edc-color-brand-strong);
    text-decoration: underline;
  }
  .actions {
    display: flex;
    gap: 1rem;
    align-items: center;
    margin-top: 1.5rem;
  }
  button {
    padding: 0.5rem 0.9rem;
    border-radius: var(--edc-radius-2);
    background: var(--edc-color-brand);
    color: var(--edc-color-on-brand);
    border: 1px solid var(--edc-color-brand-outline);
    font-weight: 600;
    cursor: pointer;
  }

  /* Print: only the constancia. The app shell (`+layout.svelte`) scrolls
     inside a fixed-height column, which would clip the page on paper. */
  @media print {
    :global(.primary-nav),
    :global(a.skip),
    :global(.no-print) {
      display: none !important;
    }
    :global(.app-shell),
    :global(.app-main) {
      display: block !important;
      height: auto !important;
      overflow: visible !important;
    }
    .constancia {
      max-width: none;
      padding: 0;
      color: #000;
    }
  }
</style>
