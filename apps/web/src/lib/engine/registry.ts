/**
 * The `@edc/chat-engine` kind registry — client-safe (no server imports).
 * Used by the `@`-mention composer + MessageContent pills AND by the server
 * engine config (which re-exports it). Labels in Spanish; kind ids in English
 * (house convention).
 *
 * Two kinds, because the domain has two: the ecosistema (one organization —
 * a group of people who build a corpus together), and the documents a user
 * uploads to a session.
 */

import type { KindRegistry } from '@edc/chat-engine/core';

export const CHAT_KIND_REGISTRY: KindRegistry = {
  descriptors: [
    {
      kind: 'org',
      // The domain word is "ecosistema"; the kind id stays `org` because that is
      // what the backend collection and the engine contract call it.
      label: 'Ecosistema',
      emoji: '🏢',
      aliases: ['org', 'ecosistema', 'organizacion', 'organización'],
    },
    {
      kind: 'document',
      label: 'Documento',
      emoji: '📄',
      aliases: ['documento', 'doc', 'document'],
    },
  ],
};
