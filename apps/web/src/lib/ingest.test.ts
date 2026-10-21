import { describe, expect, it } from 'vitest';
import {
  AUDIO_CONFIDENCE_TOOLTIP,
  INGEST_STATUSES,
  TRANSCRIPT_EDIT_CANCEL,
  TRANSCRIPT_EDIT_EMPTY_ERROR,
  TRANSCRIPT_EDIT_SAVE,
  TRANSCRIPT_EDIT_SAVED_MESSAGE,
  TRANSCRIPT_EDIT_START,
  transcriptChanged,
  transcriptEditGate,
  TRANSCRIPT_PREVIEW_HIDE,
  TRANSCRIPT_PREVIEW_SHOW,
  TRANSCRIPT_UNAVAILABLE,
  TRANSCRIPT_PROVENANCE_LABEL,
  TRANSCRIPT_PROVENANCE_TOOLTIP,
  TRANSCRIPT_PUBLISH_WARNING,
  audioDurationChip,
  audioLanguageChip,
  audioLanguageLabel,
  audioMetaChips,
  canRetryIngest,
  formatLanguageProbability,
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
  transcriptReadyCallToAction,
  transcriptStatsCopy,
  transcriptionEtaCopy,
  uploadInFlightCopy,
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

  it('carries the ETA while transcribing', () => {
    const badge = ingestBadge('transcribing', 'audio', { durationSeconds: 3600 });
    expect(badge?.title).toContain(transcriptionEtaCopy({ durationSeconds: 3600 }));
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

// ───────────────────────────────────────────────────────────────────────────
// The audio journey, made visible
// ───────────────────────────────────────────────────────────────────────────

describe('audioLanguageChip / audioMetaChips', () => {
  it('names the language in Spanish and keeps the certainty number', () => {
    const chip = audioLanguageChip({ language: 'es', languageProbability: 0.982 });
    expect(chip?.label).toBe('español · 98% de certeza');
  });

  it('🔴 never shows the certainty number without saying what it measures', () => {
    // `languageProbability` is the only confidence signal the pipeline gives,
    // and it is about the LANGUAGE, not the words. A bare percentage next to a
    // transcript reads as "98% of this text is right", which is false.
    const chip = audioLanguageChip({ language: 'es', languageProbability: 0.98 });
    expect(chip?.title).toContain(AUDIO_CONFIDENCE_TOOLTIP);
    expect(AUDIO_CONFIDENCE_TOOLTIP).toMatch(/no mide si las palabras/i);
  });

  it('shows an unknown language code as itself rather than hiding it', () => {
    expect(audioLanguageLabel('nl')).toBe('nl');
    expect(audioLanguageLabel('  ES ')).toBe('español');
    expect(audioLanguageLabel('')).toBeNull();
    expect(audioLanguageLabel(null)).toBeNull();
  });

  it('drops a probability that is missing or out of range instead of inventing one', () => {
    expect(formatLanguageProbability(0.5)).toBe('50%');
    expect(formatLanguageProbability(1)).toBe('100%');
    for (const bad of [null, undefined, 0, -0.2, 1.4, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatLanguageProbability(bad as number)).toBeNull();
    }
  });

  it('still says something when only one half of the metadata arrived', () => {
    expect(audioLanguageChip({ language: 'es' })?.label).toBe('español');
    expect(audioLanguageChip({ languageProbability: 0.9 })?.label).toContain('90%');
    expect(audioLanguageChip({})).toBeNull();
    expect(audioLanguageChip(null)).toBeNull();
  });

  it('lists duration first, then language — and nothing at all for an empty meta', () => {
    const chips = audioMetaChips({ durationSeconds: 45, language: 'es', languageProbability: 0.98 });
    expect(chips.map((c) => c.label)).toEqual(['1 min de audio', 'español · 98% de certeza']);
    expect(audioMetaChips(null)).toEqual([]);
  });

  it('every chip carries an explanation, so none of them is a bare number', () => {
    for (const chip of audioMetaChips({ durationSeconds: 600, language: 'en', languageProbability: 0.7 })) {
      expect(chip.title.length).toBeGreaterThan(10);
    }
  });
});

describe('uploadInFlightCopy', () => {
  it('names a recording while an audio upload is going up', () => {
    expect(uploadInFlightCopy(true).title).toMatch(/grabación/i);
  });

  it('🔴 never promises audio will be quick', () => {
    expect(uploadInFlightCopy(true).title).not.toMatch(IMPLIES_ALMOST_DONE);
  });

  it('is visibly a different message from the document one', () => {
    expect(uploadInFlightCopy(true).title).not.toBe(uploadInFlightCopy(false).title);
  });
});

describe('transcriptStatsCopy', () => {
  it('counts words, singular and plural', () => {
    expect(transcriptStatsCopy('hola')).toBe('1 palabra');
    expect(transcriptStatsCopy('  hola   qué   tal ')).toBe('3 palabras');
  });

  it('says nothing rather than "0 palabras" when there is no text', () => {
    for (const empty of ['', '   ', null, undefined]) {
      expect(transcriptStatsCopy(empty)).toBeNull();
    }
  });
});

describe('transcriptReadyCallToAction', () => {
  const base = { kind: 'audio' as const, ingestStatus: 'ready' as const, publicationStatus: 'draft' };

  it('says the transcript is ready, in one short line', () => {
    const cta = transcriptReadyCallToAction(base)!;
    expect(cta).toMatch(/lista/i);
    expect(cta.split('. ').length).toBe(1);
  });

  it('stays quiet until the transcript actually exists', () => {
    for (const status of ['pending', 'transcribing', 'transcribed', 'embedding', 'failed'] as const) {
      expect(transcriptReadyCallToAction({ ...base, ingestStatus: status })).toBeNull();
    }
  });

  it('stays quiet once there is nothing left to do', () => {
    for (const pub of ['published', 'publishing', 'failed']) {
      expect(transcriptReadyCallToAction({ ...base, publicationStatus: pub })).toBeNull();
    }
  });

  it('never fires for a document that is not a transcript', () => {
    for (const kind of ['pdf', 'docx', 'markdown'] as const) {
      expect(transcriptReadyCallToAction({ ...base, kind })).toBeNull();
    }
  });
});

describe('the transcript-review copy', () => {
  it('says the transcript can be wrong, wherever it is shown', () => {
    expect(TRANSCRIPT_PROVENANCE_TOOLTIP).toMatch(/errores/i);
  });

  it('labels the two preview states differently, so the toggle reads as a toggle', () => {
    expect(TRANSCRIPT_PREVIEW_SHOW).not.toBe(TRANSCRIPT_PREVIEW_HIDE);
    expect(TRANSCRIPT_PREVIEW_SHOW).toMatch(/transcripción/i);
  });

  it('does not imply a missing transcript was lost', () => {
    expect(TRANSCRIPT_UNAVAILABLE).not.toMatch(/error|falló|perdi/i);
  });
});

describe('transcriptEditGate', () => {
  const editable = {
    kind: 'audio' as const,
    publicationStatus: 'draft',
    ingestStatus: 'ready' as const,
    transcript: 'lo que dijo la máquina',
  };

  it('opens for a draft transcript that has text and is at rest', () => {
    expect(transcriptEditGate(editable)).toEqual({ canEdit: true, reason: null });
  });

  // 🔴 THE WINDOW IS THE DRAFT. Once shared, other people may already have read
  // or cited it, and changing the text under a citation is worse than the typo.
  it.each(['published', 'publishing', 'failed', 'unpublishing'])(
    'closes once the document is %s',
    (publicationStatus) => {
      expect(transcriptEditGate({ ...editable, publicationStatus })).toEqual({
        canEdit: false,
        reason: 'published',
      });
    },
  );

  // A PDF's text is an extraction of a file the user already has; editing it
  // would make the indexed text disagree with the document people can open.
  it.each(['pdf', 'docx', 'markdown'] as const)('refuses a %s document', (kind) => {
    expect(transcriptEditGate({ ...editable, kind }).reason).toBe('not-a-transcript');
  });

  // Two writers on one column is not a race worth having.
  it.each(['pending', 'extracting', 'transcribing', 'embedding', 'n/a'] as const)(
    'waits while the pipeline is at %s',
    (ingestStatus) => {
      expect(transcriptEditGate({ ...editable, ingestStatus }).reason).toBe('in-progress');
    },
  );

  it.each(['ready', 'transcribed', 'failed'] as const)('opens at %s', (ingestStatus) => {
    expect(transcriptEditGate({ ...editable, ingestStatus }).canEdit).toBe(true);
  });

  it.each([undefined, null, '', '   '])('has nothing to correct for %p', (transcript) => {
    expect(transcriptEditGate({ ...editable, transcript }).reason).toBe('no-transcript');
  });

});

describe('transcriptChanged', () => {
  it('sees a real correction', () => {
    expect(transcriptChanged('Juan Peres', 'Juan Pérez')).toBe(true);
  });

  // ⚠ Re-indexing is real work on a real queue, and it takes the row out of
  // `listo` for minutes. Opening the editor and closing it must not spend one.
  it.each([
    ['same', 'same'],
    [' same ', 'same'],
    ['same', ' same  '],
  ])('ignores a no-op edit (%p → %p)', (before, after) => {
    expect(transcriptChanged(before, after)).toBe(false);
  });

  it('treats a missing previous transcript as a change', () => {
    expect(transcriptChanged(null, 'algo')).toBe(true);
    expect(transcriptChanged(undefined, '')).toBe(false);
  });
});

describe('the transcript-editing copy', () => {
  // 🔴 A correction that left the chat quoting the old wording would be worse
  // than no correction at all, so the button says what saving actually does.
  it('says on the button that saving re-indexes', () => {
    expect(TRANSCRIPT_EDIT_SAVE).toMatch(/indexar/i);
    expect(TRANSCRIPT_EDIT_SAVED_MESSAGE).toMatch(/indexar|indexando/i);
  });

  it('labels the two buttons distinguishably', () => {
    expect(TRANSCRIPT_EDIT_START).not.toBe(TRANSCRIPT_EDIT_SAVE);
    expect(TRANSCRIPT_EDIT_CANCEL).not.toBe(TRANSCRIPT_EDIT_SAVE);
  });

  // Emptying the box would embed an empty document: retrieval finds nothing and
  // the row still says `listo`. Deleting is the honest way to do that.
  it('offers deletion instead of an empty transcript', () => {
    expect(TRANSCRIPT_EDIT_EMPTY_ERROR).toMatch(/vacía/i);
    expect(TRANSCRIPT_EDIT_EMPTY_ERROR).toMatch(/borra/i);
  });
});
