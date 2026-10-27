import { APIError, type CollectionBeforeValidateHook } from 'payload'

import { featureEnabled } from '../../lib/features'
import { relationId } from '../../lib/permissions'

export const AUDIO_UPLOAD_OFF = 'La subida de audio está desactivada en este ecosistema.'

/**
 * 🔴 `audioUpload` (`lib/features.ts`), enforced at the row: a user's create
 * with `kind: 'audio'` is refused when the ecosistema switched it off. `kind`
 * is what starts a transcription (`startTranscription`), so this is the gate,
 * whatever route the upload came through. Runs after `bindDocumentToEcosystem`,
 * which has bound `organization` by then.
 *
 * System writes (no `req.user`: seeds, scripts) are not uploads and pass.
 */
export const refuseDisabledAudioUpload: CollectionBeforeValidateHook = async ({ data, operation, req }) => {
  if (operation !== 'create' || !req.user) return data
  const next = (data ?? {}) as Record<string, unknown>
  if (next.kind !== 'audio') return data
  const organizationId = relationId(next.organization)
  if (!(await featureEnabled(req.payload, organizationId, 'audioUpload'))) {
    throw new APIError(AUDIO_UPLOAD_OFF, 403, undefined, true)
  }
  return data
}
