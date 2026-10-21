<svelte:options runes={true} />

<script lang="ts">
  /**
   * `/revision/[id]` — read one held document and decide about it.
   *
   * ── 🔴 THE FOUR THINGS THIS SCREEN OWES THE PERSON READING IT ─────────────
   *
   *  1. THAT THEY ARE READING THE REDACTED VERSION. They never see the
   *     original. ⚠ The notice paragraph that said so was removed by owner
   *     ruling (UX backlog #33, 2026-10-21); the placeholders now carry it.
   *  2. WHERE THE GATE FOUND SOMETHING. Highlighted, so nobody hunts through
   *     forty minutes of transcript — and NOT highlighted once they have typed,
   *     because the offsets stop being true the moment the text moves.
   *  3. WHAT APPROVING ACTUALLY DOES. It overrides a fail-closed safety gate,
   *     the text enters the corpus, and their name goes on the record.
   *  4. THAT THE NOTE IS NOT PRIVATE, in the same words the rating box uses.
   *
   * ⚠ AND NOTHING ON THIS PAGE NAMES THE SPEAKER OR THE UPLOADER. Nothing is
   * fetched about them, there is no "compartido por" line, and there must never
   * be one — see `apps/backend/src/lib/holdReview.ts`.
   */
  import { enhance } from '$app/forms';
  import {
    APPROVE_CONFIRM,
    APPROVE_CONSEQUENCE,
    APPROVE_LABEL,
    APPROVE_RECORDED,
    CANCEL_LABEL,
    DETAIL_UNAVAILABLE,
    formatHoldDate,
    highlightsAreStale,
    MAX_NOTE_LENGTH,
    NO_SURVIVORS,
    NO_TEXT_NOTICE,
    NOTE_LABEL,
    NOTE_NOT_PRIVATE,
    NOTE_PLACEHOLDER,
    REJECT_CONFIRM,
    REJECT_CONSEQUENCE,
    REJECT_LABEL,
    segmentHeldText,
    STALE_HIGHLIGHTS_NOTICE,
    survivorBreakdown,
    SURVIVORS_TITLE,
    survivorLabel,
  } from '$lib/holds';
  import { holdSummary } from '../holdSummary';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const hold = $derived(data.hold);
  /** The gate's own refused output, exactly as it arrived. Never rewritten. */
  const original = $derived(hold?.heldText ?? null);

  /**
   * What is in the editor.
   *
   * ⚠ Seeded ONCE per document, not on every render — a `$derived` here would
   * throw away the reviewer's corrections the moment anything else on the page
   * changed.
   */
  let text = $state('');
  let seeded = $state('');
  $effect(() => {
    const id = hold?.id ?? '';
    if (id && seeded !== id) {
      seeded = id;
      text = original ?? '';
    }
  });

  let editing = $state(false);
  let note = $state('');
  /** Which decision the person has asked to confirm. Null ⇒ nothing pending. */
  let pending = $state<'approve' | 'reject' | null>(null);
  let submitting = $state(false);

  /** 🔴 See `highlightsAreStale`: edited text means the offsets point elsewhere. */
  const stale = $derived(highlightsAreStale(original, text));
  const segments = $derived(original === null ? [] : segmentHeldText(text, hold?.survivors ?? []));
  const breakdown = $derived(survivorBreakdown(hold?.survivors ?? []));
  /** ⚠ Counted from the same highlights as the chips below, so the numbers agree. */
  const summary = $derived(
    hold ? holdSummary({ ...hold, survivorCount: hold.survivors.length }) : null,
  );
</script>

<svelte:head><title>Documento retenido · Ecosistemas de Conocimiento</title></svelte:head>

<div class="page text-ink">
  <p class="back"><a href="/revision">← Volver a la lista</a></p>

  {#if data.state === 'unavailable' || !hold}
    <p class="notice">{DETAIL_UNAVAILABLE}</p>
  {:else}
    <header class="head">
      <!-- 🔴 The gate's NEUTRAL title, as sent. -->
      <h1 data-testid="hold-title">{hold.title}</h1>
      <p class="sub">
        {summary?.why}
        {#if formatHoldDate(hold.updatedAt)}
          <span class="date">{formatHoldDate(hold.updatedAt)}</span>
        {/if}
      </p>
      {#if summary}
        <p class="reason">{summary.detail}</p>
      {/if}
    </header>

    <!-- ── What the gate found ────────────────────────────────────────── -->
    <section class="block" aria-labelledby="survivors-title">
      <h2 id="survivors-title">{SURVIVORS_TITLE}</h2>
      {#if breakdown.length === 0}
        <p class="hint">{NO_SURVIVORS}</p>
      {:else}
        <ul class="chips" data-testid="hold-survivors">
          {#each breakdown as row (row.type)}
            <li class="chip">{row.label} · {row.count}</li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- ── The text ───────────────────────────────────────────────────── -->
    {#if original === null}
      <!-- A `structural` hold produced nothing. Do not draw an empty editor and
           let somebody think they can approve it. -->
      <p class="notice" data-testid="hold-no-text">{NO_TEXT_NOTICE}</p>
    {:else}
      <section class="block" aria-labelledby="text-title">
        <h2 id="text-title">El texto retenido</h2>
        <!-- ⚠ The "you are reading the redacted version" notice and the edit
             hint were removed by owner ruling (UX backlog #33, 2026-10-21): no
             explainer paragraphs. The placeholders in the text show it. -->

        {#if stale}
          <p class="warn" data-testid="hold-stale">{STALE_HIGHLIGHTS_NOTICE}</p>
        {/if}

        {#if editing}
          <label class="sr-only" for="hold-text">Texto tachado del documento</label>
          <textarea
            id="hold-text"
            class="editor"
            rows="18"
            bind:value={text}
            form="hold-decision"
            name="text"
            data-testid="hold-editor"
          ></textarea>
        {:else}
          <!-- ⚠ Highlights only exist here, where the text is exactly what the
               server sent. -->
          <pre class="reader" data-testid="hold-text">{#each segments as seg, i (i)}{#if seg.type}<mark
                  class="hit"
                  title={survivorLabel(seg.type)}>{seg.text}</mark>{:else}{seg.text}{/if}{/each}</pre>
          <button class="secondary" type="button" onclick={() => (editing = true)}>
            Corregir el texto
          </button>
        {/if}
      </section>
    {/if}

    <!-- ── The decision ───────────────────────────────────────────────── -->
    <form
      id="hold-decision"
      class="block"
      method="POST"
      action="?/decide"
      use:enhance={() => {
        submitting = true;
        return async ({ update }) => {
          submitting = false;
          pending = null;
          await update({ reset: false });
        };
      }}
    >
      <!-- ⚠ What the server sent, echoed back so the action can tell an edit
           from an approval as-is. It is not the source of the decision — it is
           the yardstick for `textEdited` on the audit row. -->
      {#if original !== null}
        <input type="hidden" name="original" value={original} />
        {#if !editing}<input type="hidden" name="text" value={text} />{/if}
      {/if}

      <div class="note-field">
        <!-- ⚠ ABOVE the box, word for word the sentence the rating box uses. -->
        <p class="hint" data-testid="hold-note-notice">{NOTE_NOT_PRIVATE}</p>
        <label for="hold-note">{NOTE_LABEL}</label>
        <textarea
          id="hold-note"
          class="note"
          name="note"
          rows="3"
          maxlength={MAX_NOTE_LENGTH}
          placeholder={NOTE_PLACEHOLDER}
          bind:value={note}
        ></textarea>
      </div>

      {#if form?.message}
        <p class="warn" role="alert" data-testid="hold-error">{form.message}</p>
      {/if}

      {#if pending === null}
        <div class="actions">
          {#if original !== null}
            <button
              class="primary"
              type="button"
              onclick={() => (pending = 'approve')}
              data-testid="hold-approve">{APPROVE_LABEL}</button>
          {/if}
          <button
            class="danger"
            type="button"
            onclick={() => (pending = 'reject')}
            data-testid="hold-reject">{REJECT_LABEL}</button>
        </div>
      {:else if pending === 'approve'}
        <!-- 🔴 The consequence is stated where the click happens, not in a
             tooltip and not on the previous screen. -->
        <div class="confirm" data-testid="hold-confirm-approve">
          <p>{APPROVE_CONSEQUENCE}</p>
          <p>{APPROVE_RECORDED}</p>
          <p class="question">{APPROVE_CONFIRM}</p>
          <div class="actions">
            <button class="primary" type="submit" name="decision" value="approve" disabled={submitting}>
              {APPROVE_LABEL}
            </button>
            <button class="secondary" type="button" onclick={() => (pending = null)}>
              {CANCEL_LABEL}
            </button>
          </div>
        </div>
      {:else}
        <div class="confirm" data-testid="hold-confirm-reject">
          <p>{REJECT_CONSEQUENCE}</p>
          <p class="question">{REJECT_CONFIRM}</p>
          <div class="actions">
            <button class="danger" type="submit" name="decision" value="reject" disabled={submitting}>
              {REJECT_LABEL}
            </button>
            <button class="secondary" type="button" onclick={() => (pending = null)}>
              {CANCEL_LABEL}
            </button>
          </div>
        </div>
      {/if}
    </form>
  {/if}
</div>

<style>
  .page {
    width: min(52rem, 100%);
    margin: 0 auto;
    padding: 1.5rem 1rem 3rem;
  }
  .back {
    margin: 0 0 1rem;
    font-size: 0.9rem;
  }
  h1 {
    margin: 0;
    font-family: var(--edc-font-display);
    font-size: 1.5rem;
    line-height: 1.25;
  }
  h2 {
    margin: 0 0 0.5rem;
    font-family: var(--edc-font-display);
    font-size: 1.05rem;
  }
  .sub,
  .reason,
  .hint {
    margin: 0.4rem 0 0;
  }
  .reason,
  .hint {
    font-size: 0.85rem;
    color: var(--edc-color-ink-soft);
  }
  .date {
    color: var(--edc-color-ink-soft);
  }

  .block {
    margin-top: 1.5rem;
    padding-top: 1.25rem;
    border-top: 1px solid var(--edc-color-line);
  }

  .notice,
  .warn {
    margin: 0.6rem 0 0;
    padding: 0.8rem 1rem;
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-line);
    background: var(--edc-color-neutral-soft);
    line-height: 1.45;
  }
  /* ⚠ Not colour alone — the border is heavier too, so the warning survives a
     colour-blind reader and a cheap screen in daylight. */
  .warn {
    border-width: 2px;
    border-color: var(--edc-color-brand);
    background: var(--edc-color-brand-soft);
    color: var(--edc-color-brand-strong);
    font-weight: 700;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .chip {
    padding: 0.25rem 0.6rem;
    border-radius: var(--edc-radius-1);
    background: var(--edc-color-neutral-soft);
    font-size: 0.85rem;
    font-weight: 700;
  }

  .reader,
  .editor {
    width: 100%;
    margin: 0.75rem 0 0;
    padding: 0.9rem;
    border: 1px solid var(--edc-color-line);
    border-radius: var(--edc-radius-2);
    background: var(--edc-color-surface);
    font: inherit;
    line-height: 1.6;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .reader {
    max-height: 32rem;
    overflow-y: auto;
  }
  /* 🔴 Marked twice — background AND underline. A survivor a reviewer does not
     notice is the whole failure this screen exists to prevent, and colour alone
     is exactly what a colour-blind reader misses. */
  .hit {
    background: var(--edc-color-brand-soft);
    color: var(--edc-color-brand-strong);
    border-bottom: 2px solid var(--edc-color-brand);
    font-weight: 700;
  }

  .note-field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .note {
    width: 100%;
    padding: 0.6rem;
    border: 1px solid var(--edc-color-line);
    border-radius: var(--edc-radius-2);
    background: var(--edc-color-surface);
    font: inherit;
  }

  .confirm {
    margin-top: 1rem;
    padding: 1rem;
    border: 2px solid var(--edc-color-line);
    border-radius: var(--edc-radius-2);
    background: var(--edc-color-neutral-soft);
    line-height: 1.45;
  }
  .confirm p {
    margin: 0 0 0.6rem;
  }
  .question {
    font-weight: 700;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    margin-top: 1rem;
  }
  /* ⚠ Every control is a full sentence in a button, never an icon. And every
     one is a comfortable target on a phone. */
  .primary,
  .secondary,
  .danger {
    min-height: 2.9rem;
    padding: 0.6rem 1rem;
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-line);
    background: var(--edc-color-surface);
    font: inherit;
    font-weight: 700;
    cursor: pointer;
  }
  .primary {
    border-color: var(--edc-color-brand);
    background: var(--edc-color-brand);
    color: var(--edc-color-surface);
  }
  .danger {
    border-color: var(--edc-color-brand-strong);
    color: var(--edc-color-brand-strong);
  }
  .primary:disabled,
  .danger:disabled {
    opacity: 0.6;
    cursor: progress;
  }
</style>
