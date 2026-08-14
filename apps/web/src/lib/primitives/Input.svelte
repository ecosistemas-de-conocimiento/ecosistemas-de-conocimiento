<svelte:options runes={true} />

<script lang="ts">
  import type { Snippet } from "svelte";

  type InputType = "text" | "search" | "email" | "number" | "password";

  type Props = {
    id?: string;
    label?: string;
    type?: InputType;
    value?: string;
    placeholder?: string;
    disabled?: boolean;
    hint?: string;
    error?: string;
    dataTestId?: string;
    leading?: Snippet;
    trailing?: Snippet;
    onInput?: (value: string) => void;
  };

  let {
    id,
    label,
    type = "text",
    value = $bindable(""),
    placeholder = "",
    disabled = false,
    hint,
    error,
    dataTestId,
    leading,
    trailing,
    onInput
  }: Props = $props();
</script>

<label class="field" for={id}>
  {#if label}
    <span class="field-label">{label}</span>
  {/if}

  <span class={`field-frame ${error ? "has-error" : ""} ${disabled ? "is-disabled" : ""}`}>
    {@render leading?.()}
    <input
      data-testid={dataTestId}
      {id}
      {type}
      bind:value
      {placeholder}
      {disabled}
      aria-invalid={Boolean(error)}
      oninput={() => onInput?.(value)}
    />
    {@render trailing?.()}
  </span>

  {#if error}
    <span class="field-message error">{error}</span>
  {:else if hint}
    <span class="field-message">{hint}</span>
  {/if}
</label>

<style>
  .field {
    display: grid;
    gap: 0.45rem;
    font-family: var(--edc-font-body);
  }

  .field-label {
    font-size: 0.76rem;
    font-weight: 700;
    color: var(--edc-color-ink-soft);
  }

  .field-frame {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 2.7rem;
    padding: 0.55rem 0.8rem;
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-line);
    background: var(--edc-color-surface-glass-strong);
    transition:
      transform var(--edc-motion-fast) var(--edc-ease-standard),
      border-color var(--edc-motion-fast) var(--edc-ease-standard),
      box-shadow var(--edc-motion-fast) var(--edc-ease-standard);
  }

  .field:hover .field-frame:not(.is-disabled) {
    transform: translateY(-1px);
    border-color: var(--edc-color-line-strong);
    box-shadow: var(--edc-shadow-1);
  }

  .field-frame:focus-within {
    border-color: var(--edc-color-brand-outline);
    box-shadow: 0 0 0 4px var(--edc-focus-ring), var(--edc-shadow-1);
  }

  .field-frame.has-error {
    border-color: var(--edc-color-danger-outline);
  }

  .field-frame.is-disabled {
    opacity: 0.6;
    transform: none;
  }

  input {
    width: 100%;
    min-width: 0;
    border: 0;
    background: transparent;
    color: var(--edc-color-ink);
    outline: none;
  }

  input::placeholder {
    color: color-mix(in srgb, var(--edc-color-ink-soft) 82%, transparent);
  }

  .field-message {
    font-size: 0.72rem;
    color: var(--edc-color-ink-soft);
  }

  .field-message.error {
    color: var(--edc-color-danger);
  }
</style>
