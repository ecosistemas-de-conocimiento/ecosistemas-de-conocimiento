/**
 * `@edc/chat-engine/svelte` — the domain-agnostic SvelteKit component
 * library. Every component takes labels / glyphs / navigation as props/config;
 * none import app routes, stores, or i18n. Theming is via the shared
 * `--edc-*` CSS custom properties, which the consumer supplies (`apps/web`
 * defines them in `src/lib/design/tokens.css`). The `--edc-` prefix is
 * historical — treat it as the shared design-token namespace.
 */

export { default as ChatMentionMenu } from './ChatMentionMenu.svelte';
export { default as ContextChips } from './ContextChips.svelte';
export { default as MessageContent } from './MessageContent.svelte';
export { default as ContextHeader } from './ContextHeader.svelte';
export { default as CitationCard } from './CitationCard.svelte';
