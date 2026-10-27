/**
 * 🔴 `audioUpload` off: a user's audio create is refused at the row, whatever
 * route it came through. Other kinds, updates and system writes pass.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { invalidateFeatures } from '../../lib/features'
import { AUDIO_UPLOAD_OFF, refuseDisabledAudioUpload } from './featureGates'

const run = (args: { data: Record<string, unknown>; operation?: string; user?: unknown; audioUpload?: boolean }) => {
  const findByID = vi.fn(async () => ({ id: 1, features: { audioUpload: args.audioUpload ?? true } }))
  return refuseDisabledAudioUpload({
    data: args.data,
    operation: args.operation ?? 'create',
    req: { user: args.user === undefined ? { id: 2 } : args.user, payload: { findByID } },
  } as never)
}

beforeEach(() => invalidateFeatures())

describe('refuseDisabledAudioUpload', () => {
  it('403s an audio create when the ecosistema switched it off', async () => {
    await expect(run({ data: { kind: 'audio', organization: 1 }, audioUpload: false })).rejects.toMatchObject({
      status: 403,
      message: AUDIO_UPLOAD_OFF,
    })
  })

  it('passes audio when on (the default)', async () => {
    await expect(run({ data: { kind: 'audio', organization: 1 } })).resolves.toBeTruthy()
  })

  it('passes a pdf, an update, and a system write (no user) when off', async () => {
    await expect(run({ data: { kind: 'pdf', organization: 1 }, audioUpload: false })).resolves.toBeTruthy()
    await expect(
      run({ data: { kind: 'audio', organization: 1 }, operation: 'update', audioUpload: false }),
    ).resolves.toBeTruthy()
    await expect(run({ data: { kind: 'audio', organization: 1 }, user: null, audioUpload: false })).resolves.toBeTruthy()
  })
})
