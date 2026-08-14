import { Redis } from 'ioredis';

import { env } from '../config/env.js';

// Shared Redis connection for BullMQ. BullMQ requires maxRetriesPerRequest: null
// on the connection it uses for blocking commands.
export const redisConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

export async function closeRedis(): Promise<void> {
  await redisConnection.quit();
}

// Queue names are centralised here so workers and producers can't drift.
export const QUEUE_NAMES = {
  /** Single queue: one job per generation unit. Job `name` carries org+unitType. */
  generation: 'generation',
  /** One job per ingest document (chunk + embed + insert). Decisions §14. */
  ingest: 'ingest',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
