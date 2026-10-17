/**
 * A thin HTTP client for the live backend. No abstraction beyond "attach the
 * caller's token and give me back status + body", because an E2E assertion that
 * cannot see the raw status code is not an E2E assertion.
 *
 * ⚠ AUTH IS `Authorization: JWT <token>`, NOT A COOKIE. The stack runs with
 * NODE_ENV=production, so `Users.auth.cookies` is `SameSite=None; Secure` and a
 * cookie would be dropped over plain HTTP. Payload accepts the same token in the
 * header, which is also what the SvelteKit BFF does server-to-server.
 */

import fs from 'node:fs'
import path from 'node:path'

import { BACKEND_URL, FIXTURES_DIR } from './env'

export interface ApiResult<T = any> {
  status: number
  ok: boolean
  body: T
  headers: Headers
  /** Raw text, kept for the cases where the body is not JSON. */
  text: string
}

export interface Caller {
  /** Payload session token. Empty string = anonymous. */
  token: string
  label: string
}

export const anonymous: Caller = { token: '', label: 'anonymous' }

function authHeaders(caller: Caller): Record<string, string> {
  return caller.token ? { Authorization: `JWT ${caller.token}` } : {}
}

async function readBody(res: Response): Promise<{ body: any; text: string }> {
  const text = await res.text()
  try {
    return { body: text ? JSON.parse(text) : null, text }
  } catch {
    return { body: null, text }
  }
}

export async function apiGet<T = any>(
  caller: Caller,
  path_: string,
  init: RequestInit = {},
): Promise<ApiResult<T>> {
  const res = await fetch(`${BACKEND_URL}${path_}`, {
    ...init,
    method: 'GET',
    headers: { ...authHeaders(caller), ...(init.headers as Record<string, string> | undefined) },
    // ⚠ `manual` so a 302 to a presigned URL shows up as a 302 instead of being
    // silently followed. Asserting "no redirect" is a real requirement here.
    redirect: 'manual',
  })
  const { body, text } = await readBody(res)
  return { status: res.status, ok: res.ok, body, headers: res.headers, text }
}

export async function apiJson<T = any>(
  caller: Caller,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path_: string,
  payload?: unknown,
): Promise<ApiResult<T>> {
  const res = await fetch(`${BACKEND_URL}${path_}`, {
    method,
    headers: {
      ...authHeaders(caller),
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    redirect: 'manual',
  })
  const { body, text } = await readBody(res)
  return { status: res.status, ok: res.ok, body, headers: res.headers, text }
}

/** `POST /api/media` — a real multipart upload of a fixture file. */
export async function uploadFixture(
  caller: Caller,
  fixture: string,
  contentType: string,
  filename = fixture,
): Promise<ApiResult> {
  return uploadBytes(caller, fs.readFileSync(path.join(FIXTURES_DIR, fixture)), contentType, filename)
}

/** `POST /api/media` with bytes built in the test rather than read from `e2e/fixtures`. */
export async function uploadBytes(
  caller: Caller,
  bytes: Uint8Array,
  contentType: string,
  filename: string,
): Promise<ApiResult> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(bytes)], { type: contentType }), filename)
  const res = await fetch(`${BACKEND_URL}/api/media`, {
    method: 'POST',
    headers: authHeaders(caller),
    body: form,
    redirect: 'manual',
  })
  const { body, text } = await readBody(res)
  return { status: res.status, ok: res.ok, body, headers: res.headers, text }
}

/**
 * The id behind a relationship field, whatever depth the response came back at.
 * Payload returns a bare id at `depth=0` and a populated document above it, and
 * a test that only handles one of those is asserting on the serializer.
 */
export function idOf(value: unknown): number | string | null {
  if (typeof value === 'number' || typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const id = (value as { id?: unknown }).id
    if (typeof id === 'number' || typeof id === 'string') return id
  }
  return null
}

export function fixtureBytes(fixture: string): Buffer {
  return fs.readFileSync(path.join(FIXTURES_DIR, fixture))
}

/** Log in and return a Caller. Throws loudly — a failed login is not a test result. */
export async function login(email: string, password: string, label = email): Promise<Caller> {
  const res = await apiJson(anonymous, 'POST', '/api/users/login', { email, password })
  if (res.status !== 200 || typeof res.body?.token !== 'string') {
    throw new Error(`[e2e] login failed for ${email}: ${res.status} ${res.text.slice(0, 300)}`)
  }
  return { token: res.body.token, label }
}

/**
 * Poll until `predicate` holds, or give up with a message that includes the LAST
 * observed value. "Timed out" on its own is useless; "timed out, last status was
 * `failed` with `media_unreadable`" is a bug report.
 */
export async function pollUntil<T>(
  describe_: string,
  fetchOnce: () => Promise<T>,
  predicate: (value: T) => boolean,
  opts: { timeoutMs: number; intervalMs?: number } = { timeoutMs: 60_000 },
): Promise<T> {
  const interval = opts.intervalMs ?? 1500
  const deadline = Date.now() + opts.timeoutMs
  let last: T | undefined
  for (;;) {
    last = await fetchOnce()
    if (predicate(last)) return last
    if (Date.now() >= deadline) {
      throw new Error(
        `[e2e] timed out after ${opts.timeoutMs}ms waiting for ${describe_}. ` +
          `Last observed: ${JSON.stringify(last)?.slice(0, 600)}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}
