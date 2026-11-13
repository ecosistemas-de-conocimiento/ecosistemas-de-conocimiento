<svelte:options runes={true} />

<script lang="ts">
  /**
   * 🔴 The per-resource upload consent checkbox (`$lib/uploadConsent.ts`), the
   * same in the five entry points. Unchecked on every mount: the commitment is
   * "each resource", so it is never remembered. The caller sends
   * `UPLOAD_CONSENT_VERSION` only while `checked`.
   */
  import { PRIVACY_PATH, uploadConsentLine, type UploadConsentKind } from '$lib/uploadConsent';

  let {
    checked = $bindable(false),
    kind,
    disabled = false,
    testId = 'upload-consent',
  }: { checked?: boolean; kind: UploadConsentKind; disabled?: boolean; testId?: string } = $props();

  const line = $derived(uploadConsentLine(kind));
</script>

{#if line}
  <label class="consent">
    <input type="checkbox" bind:checked {disabled} required data-testid={testId} />
    <span>{line.before}<a href={PRIVACY_PATH} target="_blank" rel="noopener">{line.link}</a>{line.after}</span>
  </label>
{/if}

<style>
  .consent {
    display: flex;
    align-items: flex-start;
    gap: var(--edc-space-2);
    font-size: var(--edc-text-sm);
    line-height: 1.4;
    color: var(--edc-color-ink-body);
    cursor: pointer;
  }
  .consent input {
    flex: none;
    width: 1.1rem;
    height: 1.1rem;
    margin: 0.1rem 0 0;
    accent-color: var(--edc-color-brand);
    cursor: pointer;
  }
  .consent a {
    color: var(--edc-color-brand-strong);
    font-weight: 600;
  }
</style>
