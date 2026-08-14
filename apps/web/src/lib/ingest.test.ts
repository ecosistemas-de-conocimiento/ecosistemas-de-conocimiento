import { describe, expect, it } from 'vitest';
import {
  INGEST_STATUSES,
  TRANSCRIBING_REASSURANCE,
  TRANSCRIPT_PROVENANCE_LABEL,
  TRANSCRIPT_PROVENANCE_TOOLTIP,
  TRANSCRIPT_PUBLISH_WARNING,
  audioDurationChip,
  canRetryIngest,
  formatDuration,
  ingestBadge,
  ingestErrorCode,
  ingestFailureCopy,
  isIngestStatus,
  isTerminalIngest,
  isTranscript,
  pollDeadlineMs,
  pollIntervalMs,
  publishConfirmCopy,
  transcriptionEtaCopy,
} from './ingest';

/**
 * A phrase that promises the wait is nearly over. Transcription runs at roughly
 * real time on CPU, so any of these in the `transcribing` copy is a lie that
 * makes the user re-upload — which costs another hour of a core.
 */
const IMPLIES_ALMOST_DONE = /un momento|enseguida|casi list/i;

describe('the ingest states', () => {
  it('includes the two audio-only states the backend can now report', () => {
    expect(INGEST_STATUSES).toContain('transcribing');
    expect(INGEST_STATUSES).toContain('transcribed');
  });

  it('recognises its own members and nothing else', () => {
    for (const s of INGEST_STATUSES) expect(isIngestStatus(s)).toBe(true);
    for (const s of ['TRANSCRIBING', 'transcribe', 'done', '', null, undefined, 7, {}]) {
      expect(isIngestStatus(s)).toBe(false);
    }
  });
});

describe('isTerminalIngest', () => {
  // Terminal means "nothing else will happen on its own" — the poller may stop.
  it('treats ready, failed and n/a as terminal', () => {
    expect(isTerminalIngest('ready')).toBe(true);
    expect(isTerminalIngest('failed')).toBe(true);
    expect(isTerminalIngest('n/a')).toBe(true);
  });

  // ⚠ The load-bearing half: stopping on `transcribing` would freeze the row on
  // screen for the hours the job actually takes, so it must NOT be terminal.
  it('keeps every in-flight state non-terminal, transcription included', () => {
    for (const s of ['pending', 'extracting', 'transcribing', 'transcribed', 'embedding'] as const) {
      expect(isTerminalIngest(s)).toBe(false);
    }
  });
});

describe('isTranscript', () => {
  it('is true only for audio — the only kind whose text a machine wrote', () => {
    expect(isTranscript('audio')).toBe(true);
    for (const k of ['pdf', 'docx', 'markdown'] as const) expect(isTranscript(k)).toBe(false);
  });
});

describe('pollDeadlineMs', () => {
  it('gives a document 15 minutes and audio 4 hours', () => {
    expect(pollDeadlineMs('pdf')).toBe(15 * 60_000);
    expect(pollDeadlineMs('docx')).toBe(15 * 60_000);
    expect(pollDeadlineMs('markdown')).toBe(15 * 60_000);
    expect(pollDeadlineMs('audio')).toBe(4 * 60 * 60_000);
  });

  // The property that actually matters, stated without the numbers: a
  // transcription is ~as long as the recording, so a document-sized deadline
  // would abandon nearly every real junta before it ever finishes.
  it('never lets the audio deadline collapse to the document one', () => {
    expect(pollDeadlineMs('audio')).toBeGreaterThan(pollDeadlineMs('pdf'));
  });
});

describe('pollIntervalMs', () => {
  it('polls audio less often — 10 s over four hours is ~1400 requests', () => {
    expect(pollIntervalMs('audio')).toBe(30_000);
    expect(pollIntervalMs('pdf')).toBe(10_000);
    expect(pollIntervalMs('docx')).toBe(10_000);
    expect(pollIntervalMs('audio')).toBeGreaterThan(pollIntervalMs('pdf'));
  });
});

describe('formatDuration', () => {
  // No duration is a real case (the backend has not probed the file yet), and
  // it must read as "we don't know", never as "0 min".
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined])(
    'is null for %p',
    (input) => {
      expect(formatDuration(input as number)).toBeNull();
    },
  );

  it('rounds to whole minutes', () => {
    expect(formatDuration(95)).toBe('2 min');
    expect(formatDuration(59)).toBe('1 min');
  });

  // Anything under a minute still reads as "1 min": a zero would suggest the
  // job is instant, which is the one impression this module exists to prevent.
  it('never rounds a real recording down to nothing', () => {
    expect(formatDuration(1)).toBe('1 min');
  });

  it('switches to hours at the hour, and drops a zero minute part', () => {
    expect(formatDuration(3600)).toBe('1 h');
    expect(formatDuration(5400)).toBe('1 h 30 min');
  });
});

describe('transcriptionEtaCopy', () => {
  it('quotes the duration when the backend probed one', () => {
    const copy = transcriptionEtaCopy({ durationSeconds: 5400 });
    expect(copy).toContain('1 h 30 min');
  });

  // 🔴 THE HONESTY PROPERTY. Without a duration the copy has nothing concrete
  // to say — and the tempting fix ("un momento…") is exactly the lie that makes
  // a user conclude the upload broke and start over.
  it.each([
    ['a known duration', { durationSeconds: 900 }],
    ['no metadata at all', null],
    ['metadata with no duration', { durationSeconds: null }],
  ])('does not imply the wait is nearly over with %s', (_label, meta) => {
    const copy = transcriptionEtaCopy(meta);
    expect(copy).not.toMatch(IMPLIES_ALMOST_DONE);
    expect(copy.length).toBeGreaterThan(0);
  });

  it('still names the recording as the unit of waiting when the duration is unknown', () => {
    expect(transcriptionEtaCopy(undefined)).toMatch(/dura la grabaci/i);
  });
});

describe('ingestBadge', () => {
  // A markdown note has no pipeline. Rendering "en cola" on it would invent a
  // wait that will never end.
  it('renders nothing for a document with no pipeline', () => {
    expect(ingestBadge('n/a')).toBeNull();
    expect(ingestBadge(undefined)).toBeNull();
  });

  it('gives every live state a label and an explanation', () => {
    for (const s of INGEST_STATUSES) {
      if (s === 'n/a') continue;
      const badge = ingestBadge(s);
      expect(badge?.label).toBeTruthy();
      expect(badge?.title).toBeTruthy();
    }
  });

  it.each([
    ['pending', 'pending'],
    ['extracting', 'pending'],
    ['transcribing', 'pending'],
    ['transcribed', 'pending'],
    ['embedding', 'pending'],
    ['ready', 'ready'],
    ['failed', 'failed'],
  ] as const)('tones %s as %s', (status, tone) => {
    expect(ingestBadge(status)?.tone).toBe(tone);
  });

  // ⚠ Both halves are required: the ETA says how long, the reassurance says the
  // work survives closing the tab. Either one alone leaves the user guessing.
  it('carries both the ETA and the "you can close this" promise while transcribing', () => {
    const badge = ingestBadge('transcribing', 'audio', { durationSeconds: 3600 });
    expect(badge?.title).toContain(transcriptionEtaCopy({ durationSeconds: 3600 }));
    expect(badge?.title).toContain(TRANSCRIBING_REASSURANCE);
    expect(badge?.title).toContain('1 h');
  });

  it('does not imply a short wait anywhere in the transcribing badge', () => {
    const badge = ingestBadge('transcribing', 'audio', null);
    expect(`${badge?.label} ${badge?.title}`).not.toMatch(IMPLIES_ALMOST_DONE);
  });

  // "Disponible para el chat" is wrong for a transcript: the next thing the
  // user should do is read it, because a machine wrote it.
  it('says something different on `ready` for audio than for a pdf', () => {
    const audio = ingestBadge('ready', 'audio');
    const pdf = ingestBadge('ready', 'pdf');
    expect(audio?.title).not.toBe(pdf?.title);
    expect(audio?.title).toMatch(/transcripci/i);
  });

  it('promises a queued transcription a turn, not a moment', () => {
    expect(ingestBadge('pending', 'audio')?.title).not.toMatch(IMPLIES_ALMOST_DONE);
  });
});

describe('ingestErrorCode', () => {
  it('takes the code half of `code: message`', () => {
    expect(ingestErrorCode('no_audio_stream: ffprobe found no audio track')).toBe(
      'no_audio_stream',
    );
  });

  it('treats a bare string as the whole code', () => {
    expect(ingestErrorCode('abandoned')).toBe('abandoned');
  });

  it.each([['', ''], ['   ', ''], [null, ''], [undefined, '']])(
    'is empty for %p',
    (input, expected) => {
      expect(ingestErrorCode(input)).toBe(expected);
    },
  );

  it('trims the code so a stray space cannot miss the switch', () => {
    expect(ingestErrorCode('  too_long : 7 hours  ')).toBe('too_long');
  });
});

describe('ingestFailureCopy', () => {
  /**
   * `needsDifferentFile` decides whether a retry button appears. Getting it
   * wrong is not cosmetic in either direction: `true` on a transient failure
   * strands a perfectly good recording, and `false` on a bad file invites the
   * user to burn CPU-hours re-running a job that cannot succeed.
   */
  it.each([
    ['no_audio_stream: no track', true],
    ['empty_transcript: silence', true],
    ['too_long: 7h', true],
    ['payload_too_large: 600MB', true],
    ['unsupported_media_type: .zip', true],
    ['empty_audio: 0 bytes', true],
    ['empty_extraction: scanned pdf', true],
    ['source_missing', true],
    ['media_unreadable', true],
    ['no_media', true],
    ['abandoned: worker died', false],
    ['audio_service_not_configured', false],
    ['callbacks_not_configured', false],
    ['some_code_we_have_never_seen: boom', false],
    [null, false],
  ])('%s → needsDifferentFile %s', (ingestError, needsDifferentFile) => {
    expect(ingestFailureCopy(ingestError).needsDifferentFile).toBe(needsDifferentFile);
  });

  // The backend's own message is English diagnostic text from audio-service.
  // It must never leak out as the primary explanation, so a cheap proxy: our
  // copy is non-empty and reads as Spanish.
  it.each([
    'no_audio_stream: ffprobe found no audio stream in the container',
    'empty_transcript: the transcript was empty',
    'too_long: duration exceeds the limit',
    'payload_too_large',
    'unsupported_media_type',
    'empty_audio',
    'empty_extraction',
    'abandoned',
    'audio_service_not_configured',
    'callbacks_not_configured',
    'source_missing',
    'media_unreadable',
    'no_media',
    'brand_new_code',
    '',
  ])('answers %p in Spanish, with a title and advice', (ingestError) => {
    const copy = ingestFailureCopy(ingestError);
    expect(copy.title.length).toBeGreaterThan(0);
    expect(copy.message.length).toBeGreaterThan(0);
    expect(`${copy.title} ${copy.message}`).not.toContain(' the ');
  });

  it('falls back to "our problem, try again" for a code it has never seen', () => {
    // A new backend code must not be presented as the user's fault; the safe
    // reading is that the service failed, which is retryable.
    expect(ingestFailureCopy('quantum_flux: ???')).toMatchObject({
      needsDifferentFile: false,
    });
  });
});

describe('canRetryIngest', () => {
  // Markdown never had a pipeline, so there is nothing to re-run.
  it('never offers a retry for a markdown note', () => {
    expect(
      canRetryIngest({ kind: 'markdown', ingestStatus: 'failed', ingestError: 'abandoned' }),
    ).toBe(false);
  });

  it('only offers a retry from `failed` — not mid-flight, not when it worked', () => {
    for (const s of ['pending', 'extracting', 'transcribing', 'transcribed', 'embedding', 'ready', 'n/a'] as const) {
      expect(canRetryIngest({ kind: 'audio', ingestStatus: s, ingestError: null })).toBe(false);
    }
  });

  // Retrying a file with no audio track produces the same failure and another
  // wait. The user has to change the file, so the button would be a trap.
  it('hides the retry when the same file would fail the same way', () => {
    expect(
      canRetryIngest({
        kind: 'audio',
        ingestStatus: 'failed',
        ingestError: 'no_audio_stream: none found',
      }),
    ).toBe(false);
  });

  it('offers the retry when the failure was ours', () => {
    expect(
      canRetryIngest({ kind: 'audio', ingestStatus: 'failed', ingestError: 'abandoned: worker died' }),
    ).toBe(true);
    expect(
      canRetryIngest({ kind: 'pdf', ingestStatus: 'failed', ingestError: 'weird_new_code' }),
    ).toBe(true);
    expect(canRetryIngest({ kind: 'audio', ingestStatus: 'failed', ingestError: null })).toBe(true);
  });
});

/**
 * 🔴 THE ASR MITIGATION, asserted on purpose.
 *
 * These three strings are the agreed price of letting machine-written text into
 * the shared corpus: an audio document's text can contain errors, and once it is
 * published the ecosistema's assistant will quote it as fact. They live in a
 * plain module precisely so a refactor of `DocsPanel.svelte` cannot drop them
 * silently — a test is the only thing standing between a rename and an
 * unlabelled transcript.
 */
describe('the transcript provenance copy', () => {
  it.each([
    ['TRANSCRIPT_PROVENANCE_LABEL', TRANSCRIPT_PROVENANCE_LABEL],
    ['TRANSCRIPT_PROVENANCE_TOOLTIP', TRANSCRIPT_PROVENANCE_TOOLTIP],
    ['TRANSCRIPT_PUBLISH_WARNING', TRANSCRIPT_PUBLISH_WARNING],
    ['TRANSCRIBING_REASSURANCE', TRANSCRIBING_REASSURANCE],
  ])('%s exists, is non-empty and is in Spanish', (_name, value) => {
    expect(typeof value).toBe('string');
    expect(value.trim().length).toBeGreaterThan(0);
    expect(value).not.toContain(' the ');
  });

  it('says out loud that the text was machine-made and may be wrong', () => {
    expect(TRANSCRIPT_PROVENANCE_LABEL).toMatch(/autom/i);
    expect(TRANSCRIPT_PROVENANCE_TOOLTIP).toMatch(/error/i);
    expect(TRANSCRIPT_PUBLISH_WARNING).toMatch(/error/i);
  });
});

describe('publishConfirmCopy', () => {
  // Publishing a transcript is the moment ASR errors become the ecosistema's
  // apparent facts, so this confirm is the last place to say so.
  it('warns about transcription errors before an audio doc is shared', () => {
    const copy = publishConfirmCopy('audio', 'Junta del 3 de marzo');
    expect(copy).toContain(TRANSCRIPT_PUBLISH_WARNING);
    expect(copy).toContain('Junta del 3 de marzo');
  });

  it('does not warn about transcription for a pdf, which nobody transcribed', () => {
    const copy = publishConfirmCopy('pdf', 'Informe anual');
    expect(copy).not.toContain(TRANSCRIPT_PUBLISH_WARNING);
    expect(copy).toContain('Informe anual');
    expect(copy).toMatch(/ecosistema/i);
  });
});

describe('audioDurationChip', () => {
  it('says nothing when we have no duration to show', () => {
    expect(audioDurationChip(null)).toBeNull();
    expect(audioDurationChip(undefined)).toBeNull();
    expect(audioDurationChip({ durationSeconds: null })).toBeNull();
  });

  it('names the length of the recording', () => {
    expect(audioDurationChip({ durationSeconds: 1834 })).toBe('31 min de audio');
  });
});
