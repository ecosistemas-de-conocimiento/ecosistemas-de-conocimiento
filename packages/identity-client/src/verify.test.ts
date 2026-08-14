// Verification tests run against a REAL Ed25519 keypair and a REAL local
// JWKS endpoint. `jose`'s Node runtime fetches JWKS with `node:http`, not
// `fetch`, so stubbing `globalThis.fetch` would not exercise this path.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair, type KeyLike } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IdentityTokenError } from './errors.js';
import { clearJwksCache, verifyIdentityToken } from './verify.js';

const ISSUER = 'https://identity.test.example.org';
const AUDIENCE = 'edc';
const KID = 'identity-test-1';

let privateKey: KeyLike;
let otherPrivateKey: KeyLike;
let server: Server;
let jwksUrl: string;
let jwksHits = 0;

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { extractable: true });
  privateKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);

  const other = await generateKeyPair('EdDSA', { extractable: true });
  otherPrivateKey = other.privateKey;

  const jwks = { keys: [{ ...publicJwk, kid: KID, alg: 'EdDSA', use: 'sig' }] };

  server = createServer((_req, res) => {
    jwksHits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(jwks));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  jwksUrl = `http://127.0.0.1:${port}/.well-known/jwks.json`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => clearJwksCache());

interface SignOpts {
  aud?: string;
  iss?: string;
  lifetimeSec?: number;
  iat?: number;
  key?: KeyLike;
  alg?: string;
  claims?: Record<string, unknown>;
}

async function sign(opts: SignOpts = {}): Promise<string> {
  const iat = opts.iat ?? Math.floor(Date.now() / 1000);
  const exp = iat + (opts.lifetimeSec ?? 900);
  return new SignJWT({
    email: 'ana@example.org',
    name: 'Ana',
    roles: ['coordinator'],
    perms: ['story:edit'],
    ...(opts.claims ?? {}),
  })
    .setProtectedHeader({ alg: opts.alg ?? 'EdDSA', kid: KID })
    .setIssuer(opts.iss ?? ISSUER)
    .setSubject('ana@example.org')
    .setAudience(opts.aud ?? AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(opts.key ?? privateKey);
}

const baseOpts = () => ({ issuer: ISSUER, audience: AUDIENCE, jwksUrl });

async function expectRejection(token: string, reason: string, opts = baseOpts()) {
  await expect(verifyIdentityToken(token, opts)).rejects.toMatchObject({
    name: 'IdentityTokenError',
    reason,
  });
}

describe('verifyIdentityToken', () => {
  it('accepts a well-formed token and returns typed claims', async () => {
    const claims = await verifyIdentityToken(await sign(), baseOpts());
    expect(claims.sub).toBe('ana@example.org');
    expect(claims.email).toBe('ana@example.org');
    expect(claims.aud).toBe(AUDIENCE);
    expect(claims.iss).toBe(ISSUER);
    expect(claims.roles).toEqual(['coordinator']);
    expect(claims.perms).toEqual(['story:edit']);
    expect(claims.kid).toBe(KID);
  });

  it('rejects a wrong audience — the confused-deputy case', async () => {
    await expectRejection(await sign({ aud: 'chat' }), 'audience');
  });

  it('rejects a wrong issuer', async () => {
    await expectRejection(await sign({ iss: 'https://evil.example' }), 'issuer');
  });

  it('rejects an expired token', async () => {
    const iat = Math.floor(Date.now() / 1000) - 3600;
    await expectRejection(await sign({ iat, lifetimeSec: 60 }), 'expired');
  });

  it('rejects a signature from an unknown key', async () => {
    // Same `kid`, different key: the JWKS has a matching entry, so this is a
    // signature failure rather than a key-lookup failure.
    await expectRejection(await sign({ key: otherPrivateKey }), 'signature');
  });

  it('rejects `alg: none` without touching the network', async () => {
    const before = jwksHits;
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: ISSUER,
        sub: 'ana@example.org',
        aud: AUDIENCE,
        perms: ['story:edit'],
        iat: 1,
        exp: 9_999_999_999,
      }),
    ).toString('base64url');
    await expectRejection(`${header}.${payload}.`, 'algorithm');
    expect(jwksHits).toBe(before);
  });

  it('rejects an HMAC-signed token', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    await expectRejection(`${header}.e30.c2ln`, 'algorithm');
  });

  it('rejects garbage', async () => {
    await expectRejection('not-a-token', 'malformed');
    await expectRejection('', 'malformed');
  });

  it('rejects a token whose declared lifetime exceeds the 900s cap', async () => {
    await expectRejection(await sign({ lifetimeSec: 3600 }), 'lifetime');
  });

  it('honours an explicit lifetime override', async () => {
    const claims = await verifyIdentityToken(await sign({ lifetimeSec: 3600 }), {
      ...baseOpts(),
      maxTokenLifetimeSec: 3600,
    });
    expect(claims.exp - claims.iat).toBe(3600);
  });

  it('rejects a signed token with a malformed `perms` claim', async () => {
    await expectRejection(await sign({ claims: { perms: 'story:edit' } }), 'claims');
  });

  it('treats absent roles/perms as empty, not as an error', async () => {
    const claims = await verifyIdentityToken(
      await sign({ claims: { roles: undefined, perms: undefined } }),
      baseOpts(),
    );
    expect(claims.roles).toEqual([]);
    expect(claims.perms).toEqual([]);
  });

  it('reports an unreachable JWKS as a non-permanent `jwks` failure', async () => {
    const token = await sign();
    const err = await verifyIdentityToken(token, {
      ...baseOpts(),
      jwksUrl: 'http://127.0.0.1:1/.well-known/jwks.json',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdentityTokenError);
    expect((err as IdentityTokenError).reason).toBe('jwks');
    expect((err as IdentityTokenError).isPermanent).toBe(false);
  });

  it('caches the key set across verifications', async () => {
    const a = await sign();
    const b = await sign();
    const before = jwksHits;
    await verifyIdentityToken(a, baseOpts());
    await verifyIdentityToken(b, baseOpts());
    expect(jwksHits).toBe(before + 1);
  });

  it('requires issuer, audience and jwksUrl', async () => {
    const token = await sign();
    await expect(
      verifyIdentityToken(token, { ...baseOpts(), audience: '' }),
    ).rejects.toMatchObject({ name: 'IdentityConfigError' });
  });
});
