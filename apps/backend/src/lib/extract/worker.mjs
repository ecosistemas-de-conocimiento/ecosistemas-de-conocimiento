// The extraction worker. Spawned once per file by `./sandbox.ts`.
//
// ⚠ PLAIN JAVASCRIPT ON PURPOSE. The Next bundle never sees this file: the
// sandbox points a `Worker` at it on disk (the runtime image ships `src/`), and
// tsx loads the TypeScript extractors from here, as `payload run` does.
import { workerData, parentPort } from 'node:worker_threads'

import { tsImport } from 'tsx/esm/api'

const { kind, bytes, maxChars } = workerData
try {
  const { extractFileText } = await tsImport('./run.ts', import.meta.url)
  const text = await extractFileText(kind, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), maxChars)
  parentPort.postMessage({ ok: true, text })
} catch (err) {
  parentPort.postMessage({ ok: false, message: err instanceof Error ? err.message : String(err) })
}
