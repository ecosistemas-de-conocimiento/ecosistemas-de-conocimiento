// An empty provider answer ⇒ typed 502 / error frame, never a 200, never cached
// — end to end.
//
// Measured on dev (2026-11-10, ai-service request logs plus `edc_ai.traces`):
// 3 of 6 chat answers came back as a 200 with no content, model `unknown`,
// 0 tokens; the consumer could not save them, and a cache hit re-served one in
// 0 ms. See `services/ai/router/empty-completion.ts`.
//
// Real stack: router, streaming adapter, retry ladder, budget enforcer and
// trace writer on Postgres, over a real socket, against the TEST-ONLY fake
// provider. `[[FAKE_REPLY:]]` (empty base64) scripts the empty answer.

import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { startFakeProvider } from '../../test-support/fake-provider/server.mjs';

const ORG = 'tenant-b';
/** 1 + `DEFAULT_MAX_RETRY_ATTEMPTS` (2, `resilience.ts`). */
const ATTEMPTS = 3;

const fake = await startFakeProvider({ bodyTokens: 20 });
Object.assign(process.env, fake.env);
process.env.API_KEYS = JSON.stringify({
  'dev-key-tenant-b': { org: ORG, project: 'tenant-b', role: 'app' },
});

import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

describe('empty provider answer — EmptyCompletion, retried, not cached (integration)', () => {
  let app: FastifyInstance;
  let base: string;

  async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    const { db } = await import('../db/client.js');
    const res = await db.execute(query);
    return ((res as unknown as { rows?: T[] }).rows ?? (res as unknown as T[])) as T[];
  }

  async function seedOrgBudget(): Promise<void> {
    await q(sql`
      INSERT INTO "budget_state" ("org", "limit_usd", "remaining_usd")
      VALUES (${ORG}, 100::numeric, 100::numeric)
      ON CONFLICT ("org") DO UPDATE
        SET "limit_usd" = 100::numeric, "remaining_usd" = 100::numeric
    `);
  }

  async function traceStatus(traceId: string): Promise<string[]> {
    const rows = await q<{ status: string }>(sql`
      SELECT "status" FROM "traces" WHERE "metadata"->>'traceId' = ${traceId}
    `);
    return rows.map((r) => r.status);
  }

  async function post(path: string, body: unknown): Promise<Response> {
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev-key-tenant-b' },
      body: JSON.stringify(body),
    });
  }

  const unit = (key: string) => ({
    unitKey: key,
    input: {},
    specOverride: { promptTemplate: 'Responde algo. [[FAKE_REPLY:]]' },
  });

  const chatCalls = (): number => fake.requests.filter((r) => r.kind === 'chat').length;

  beforeAll(async () => {
    const { buildServer } = await import('../server.js');
    app = await buildServer();
    await app.ready();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('no ephemeral port');
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    if (app) await app.close();
    const { closeDb } = await import('../db/client.js');
    await closeDb().catch(() => undefined);
    await fake.close();
  });

  beforeEach(async () => {
    await seedOrgBudget();
  });

  it('/v1/generate/sync → 502 EmptyCompletion after the bounded retries; the repeat is not a cache hit', async () => {
    const before = chatCalls();
    const res = await post('/v1/generate/sync', { unit: unit(`empty-sync-${Date.now()}`) });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(502);
    expect(body).toMatchObject({
      error: 'EmptyCompletion',
      code: 'ERR_EMPTY_COMPLETION',
      message: 'The LLM provider returned an empty answer.',
    });
    expect(body.text).toBeUndefined();
    expect(typeof body.traceId).toBe('string');
    expect(chatCalls() - before).toBe(ATTEMPTS);
    expect(await traceStatus(body.traceId as string)).toEqual(['failed']);

    // Same prompt again: dialled again, not served from the cache.
    const again = await post('/v1/generate/sync', { unit: unit(`empty-sync-b-${Date.now()}`) });
    expect(again.status).toBe(502);
    expect(chatCalls() - before).toBe(2 * ATTEMPTS);
  }, 60_000);

  it('/v1/generate/stream → terminal EmptyCompletion error frame, no done', async () => {
    const res = await post('/v1/generate/stream', { unit: unit(`empty-stream-${Date.now()}`) });
    expect(res.status).toBe(200); // the status line is sent before the provider is called
    const frames = (await res.text())
      .split('\n\n')
      .filter((f) => f.startsWith('data: '))
      .map((f) => JSON.parse(f.slice('data: '.length)) as Record<string, unknown>);

    expect(frames.some((f) => f.type === 'done')).toBe(false);
    const last = frames.at(-1)!;
    expect(last).toMatchObject({
      type: 'error',
      code: 'EmptyCompletion',
      errorCode: 'ERR_EMPTY_COMPLETION',
      message: 'The LLM provider returned an empty answer.',
    });
    expect(typeof last.traceId).toBe('string');
    expect(await traceStatus(last.traceId as string)).toEqual(['failed']);
  }, 60_000);

  // Empty AND `finish_reason: length`: the cap was spent before any text, so
  // the router does NOT retry — exactly one provider call.
  const truncatedUnit = (key: string) => ({
    unitKey: key,
    input: {},
    specOverride: { promptTemplate: 'Responde algo. [[FAKE_REPLY:]] [[FAKE_FINISH_REASON:length]]' },
  });

  it('/v1/generate/sync → 502 CompletionTruncated after ONE provider call', async () => {
    const before = chatCalls();
    const res = await post('/v1/generate/sync', { unit: truncatedUnit(`trunc-sync-${Date.now()}`) });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(502);
    expect(body).toMatchObject({
      error: 'CompletionTruncated',
      code: 'ERR_COMPLETION_TRUNCATED',
      message: 'The LLM provider hit the output token limit before writing an answer.',
    });
    expect(typeof body.traceId).toBe('string');
    expect(chatCalls() - before).toBe(1);
    expect(await traceStatus(body.traceId as string)).toEqual(['failed']);
  }, 60_000);

  it('/v1/generate/stream → terminal CompletionTruncated error frame after ONE provider call', async () => {
    const before = chatCalls();
    const res = await post('/v1/generate/stream', { unit: truncatedUnit(`trunc-stream-${Date.now()}`) });
    expect(res.status).toBe(200);
    const frames = (await res.text())
      .split('\n\n')
      .filter((f) => f.startsWith('data: '))
      .map((f) => JSON.parse(f.slice('data: '.length)) as Record<string, unknown>);

    expect(frames.some((f) => f.type === 'done')).toBe(false);
    const last = frames.at(-1)!;
    expect(last).toMatchObject({
      type: 'error',
      code: 'CompletionTruncated',
      errorCode: 'ERR_COMPLETION_TRUNCATED',
    });
    expect(typeof last.traceId).toBe('string');
    expect(chatCalls() - before).toBe(1);
  }, 60_000);
});
