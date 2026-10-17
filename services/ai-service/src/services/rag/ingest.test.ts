// Unit tests for IngestService's request-time gates (PLAN-live-ingest
// findings A2/A11, decisions D4 and D1). The DB is a recording stub: these
// tests pin what the service refuses BEFORE it writes, and what it answers
// for an id it has never seen. The happy paths are covered against a real
// Postgres in `routes/ingest.integration.test.ts`.

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../../db/client.js';
import type { IngestQueueLike } from '../../queue/queues.js';
import { env, type ApiKeyEntry } from '../../config/env.js';
import { deriveApiKeyId } from '../../plugins/auth.js';
import { __resetCallbackSecretCache, CallbackSecretMissingError } from '../callbacks/emit.js';
import { IngestNotFoundError, IngestService } from './ingest.js';

/** Every builder chain resolves to `rows`; every call is recorded. */
function stubDb(rows: unknown[] = []) {
  const calls: string[] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'leftJoin', 'values', 'set']) {
    chain[m] = (..._a: unknown[]) => chain;
  }
  chain.limit = async () => rows;
  chain.groupBy = async () => rows;
  chain.returning = async () => rows;
  const db = {
    select: (..._a: unknown[]) => {
      calls.push('select');
      return chain;
    },
    insert: (..._a: unknown[]) => {
      calls.push('insert');
      return chain;
    },
    update: (..._a: unknown[]) => {
      calls.push('update');
      return chain;
    },
  } as unknown as Db;
  return { db, calls };
}

const queue = { add: vi.fn(async () => undefined) } as unknown as IngestQueueLike;
const CTX = { org: 'test-org', project: 'test-project' };

describe('getIngestStatus — unknown id is a 404 (A11)', () => {
  it('a well-formed UUID with no request row and no documents → IngestNotFoundError', async () => {
    const { db } = stubDb([]);
    const svc = new IngestService({ db, queue });
    const id = '6f1c2b1e-9d4a-4c1b-8f0e-1a2b3c4d5e6f';
    const err = await svc.getIngestStatus(id, CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IngestNotFoundError);
    const e = err as IngestNotFoundError;
    expect(e.status).toBe(404);
    expect(e.toBody()).toEqual({
      error: 'IngestNotFoundError',
      code: 'ERR_INGEST_NOT_FOUND',
      ingestId: id,
      message: `ingest '${id}' not found in this org/project`,
    });
  });

  it('a non-UUID id is a 404 too, without touching the database', async () => {
    const { db, calls } = stubDb([]);
    const svc = new IngestService({ db, queue });
    await expect(svc.getIngestStatus('not-a-uuid', CTX)).rejects.toBeInstanceOf(IngestNotFoundError);
    expect(calls).toEqual([]);
  });
});

describe('ingestBatch — callbackUrl from a key without a callbackSecret (D4)', () => {
  const RAW = 'svc-test-key';
  const KEY_ID = deriveApiKeyId(RAW);

  function installKey(secret?: string): void {
    (env.API_KEYS as Record<string, ApiKeyEntry>)[RAW] = {
      org: 'test-org',
      project: 'test-project',
      role: 'app',
      ...(secret ? { callbackSecret: secret } : {}),
    };
    __resetCallbackSecretCache();
  }

  afterEach(() => {
    delete (env.API_KEYS as Record<string, ApiKeyEntry>)[RAW];
    __resetCallbackSecretCache();
  });

  const REQ = {
    corpus: 'c',
    callbackUrl: 'http://203.0.113.7:1/cb',
    documents: [{ id: 'd1', text: 'hello' }],
  };

  it('refuses with CallbackSecretMissingError (400) and writes nothing', async () => {
    installKey(undefined);
    const { db, calls } = stubDb([]);
    const svc = new IngestService({ db, queue });
    const err = await svc
      .ingestBatch(REQ as never, { ...CTX, apiKeyId: KEY_ID })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CallbackSecretMissingError);
    expect((err as CallbackSecretMissingError).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('refuses a callbackUrl when no apiKeyId was captured at all', async () => {
    const { db, calls } = stubDb([]);
    const svc = new IngestService({ db, queue });
    await expect(svc.ingestBatch(REQ as never, CTX)).rejects.toBeInstanceOf(
      CallbackSecretMissingError,
    );
    expect(calls).toEqual([]);
  });

  it('lets the same request through the gate once the key has a secret', async () => {
    installKey('a-callback-secret-of-at-least-32-chars');
    const { db } = stubDb([{ id: 'row-1' }]);
    const svc = new IngestService({ db, queue });
    const err = await svc
      .ingestBatch(REQ as never, { ...CTX, apiKeyId: KEY_ID })
      .catch((e: unknown) => e);
    // Whatever the stub DB does next, the D4 gate is not what stopped it.
    expect(err).not.toBeInstanceOf(CallbackSecretMissingError);
  });

  it('a request WITHOUT callbackUrl never consults the secret', async () => {
    installKey(undefined);
    const { db } = stubDb([{ id: 'row-1' }]);
    const svc = new IngestService({ db, queue });
    const { callbackUrl: _drop, ...noCallback } = REQ;
    const err = await svc
      .ingestBatch(noCallback as never, { ...CTX, apiKeyId: KEY_ID })
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(CallbackSecretMissingError);
  });
});
