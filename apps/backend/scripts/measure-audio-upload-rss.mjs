#!/usr/bin/env node
/**
 * Peak RSS of handing one recording to a fake audio-service: the pre-I-10 path
 * (whole file → Buffer → Uint8Array → Blob → FormData) against the streaming
 * one (`openObjectStream` / `fs.openAsBlob` → `submitTranscription`).
 *
 *   node scripts/measure-audio-upload-rss.mjs <file> [s3-key]
 *
 * Each mode runs in a fresh child process and reports `process.resourceUsage().maxRSS`.
 * The fake audio-service is a local HTTP server that discards the body.
 *
 * With `s3-key`, the S3 modes read that object using the usual S3_* variables
 * (see `src/lib/storage/client.ts`). A throwaway RustFS works:
 *   docker run -d --rm --name rss-rustfs \
 *     --tmpfs /data:uid=10001,gid=10001 --tmpfs /logs:uid=10001,gid=10001 \
 *     -e RUSTFS_ACCESS_KEY=… -e RUSTFS_SECRET_KEY=… -e RUSTFS_VOLUMES=/data \
 *     -p 127.0.0.1:0:9000 rustfs/rustfs:1.0.0-rc.1
 *
 * Needs a Node that strips TypeScript types (22.18+ or 23.6+). Put the test file
 * on a tmpfs (`/dev/shm`) to keep it off the disk.
 */

import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))
// The sources import each other without extensions; Node's loader needs `.ts`.
const HOOKS = `data:text/javascript,${encodeURIComponent(`
  export async function resolve(s, c, next) {
    try { return await next(s, c) } catch (e) {
      if (e?.code === 'ERR_MODULE_NOT_FOUND' && s.startsWith('.')) return next(s + '.ts', c)
      throw e
    }
  }`)}`
const REGISTER = `data:text/javascript,${encodeURIComponent(
  `import { register } from 'node:module'; register(${JSON.stringify(HOOKS)})`,
)}`

const [, , first, second, third, fourth] = process.argv

async function parent(file, key) {
  let received = 0
  const server = http.createServer((req, res) => {
    let n = 0
    req.on('data', (c) => (n += c.length))
    req.on('end', () => {
      received = n
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ transcribeId: 'tr_1', durationSeconds: 1 }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const modes = ['baseline', 'old-local', 'new-local', ...(key ? ['old-s3', 'new-s3'] : [])]
  console.log(`node ${process.version}, file ${file}`)
  for (const mode of modes) {
    const out = await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        ['--no-warnings', '--import', REGISTER, fileURLToPath(import.meta.url), '--child', mode, file, `${key ?? ''}|${port}`],
        { stdio: ['ignore', 'pipe', 'inherit'] },
      )
      let text = ''
      child.stdout.on('data', (d) => (text += d))
      child.on('close', () => resolve(text.trim()))
    })
    console.log(`${mode.padEnd(10)} ${out.padEnd(16)} server received ${received} bytes`)
    received = 0
  }
  server.close()
}

async function child(mode, file, keyAndPort) {
  const [key, port] = keyAndPort.split('|')
  process.env.AUDIO_SERVICE_URL = `http://127.0.0.1:${port}`
  process.env.AUDIO_SERVICE_API_KEY = 'measure'
  const { submitTranscription } = await import(`${SRC}lib/audioClient.ts`)
  const storage = await import(`${SRC}lib/storage/client.ts`)
  const { openAsBlob } = await import('node:fs')
  const { readFile } = await import('node:fs/promises')
  const req = { filename: 'voz.m4a', contentType: 'audio/x-m4a', externalId: '1', idempotencyKey: 'k' }
  // The pre-I-10 upload, verbatim in shape: an in-memory Blob in undici's FormData.
  const oldSubmit = async (bytes) => {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(bytes)], { type: 'audio/x-m4a' }), 'voz.m4a')
    form.append('externalId', '1')
    const res = await fetch(`http://127.0.0.1:${port}/v1/transcribe`, { method: 'POST', body: form })
    if (!res.ok) throw new Error(`old upload: ${res.status}`)
  }
  if (mode === 'old-local') await oldSubmit(await readFile(file))
  if (mode === 'new-local') {
    const r = await submitTranscription({ ...req, body: await openAsBlob(file) })
    if (!r.ok) throw new Error(r.message)
  }
  if (mode === 'old-s3') await oldSubmit((await storage.getObjectBytes(key)).bytes)
  if (mode === 'new-s3') {
    const o = await storage.openObjectStream(key)
    try {
      const r = await submitTranscription({ ...req, body: { size: o.size, stream: o.stream } })
      if (!r.ok) throw new Error(r.message)
    } finally {
      o.close()
    }
  }
  console.log(`maxRSS ${(process.resourceUsage().maxRSS / 1024).toFixed(0)} MB`)
}

if (first === '--child') await child(second, third, fourth)
else if (first) await parent(first, second)
else {
  console.error('usage: node scripts/measure-audio-upload-rss.mjs <file> [s3-key]')
  process.exit(2)
}
