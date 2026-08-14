/**
 * Server-side re-export of the canonical ai-service user-facing wording.
 *
 * The constants themselves live in `$lib/aiMessages` — NOT here — because
 * SvelteKit makes `$lib/server/*` a build error to import from any
 * client-reachable module, and the browser needs the identical bytes to render
 * the same sentence when the BFF tags a failure `ai_unavailable`. One
 * definition, two import paths: server code imports from the `aiService`
 * barrel, browser code from `$lib/aiMessages`.
 */

export { AI_UNAVAILABLE_MESSAGE, AI_UNAVAILABLE_CODE } from '$lib/aiMessages';
