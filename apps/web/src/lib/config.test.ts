import { describe, expect, it } from 'vitest';
import {
  MAX_AUDIO_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  UPLOAD_ACCEPT,
  formatBytes,
  isAudioUpload,
  maxUploadBytesFor,
} from './config';

describe('MAX_UPLOAD_BYTES', () => {
  it('is 20 MiB', () => {
    expect(MAX_UPLOAD_BYTES).toBe(20 * 1024 * 1024);
  });
});

describe('MAX_AUDIO_UPLOAD_BYTES', () => {
  it('is 200 MiB', () => {
    expect(MAX_AUDIO_UPLOAD_BYTES).toBe(200 * 1024 * 1024);
  });

  // ⚠ The property, not the number: 20 MB is about twenty minutes of speech,
  // and the recording this whole feature exists for is a two-hour junta. If the
  // audio cap ever collapses back to the document cap, the feature is unusable
  // for its actual use case while still looking like it works.
  it('is strictly larger than the document cap', () => {
    expect(MAX_AUDIO_UPLOAD_BYTES).toBeGreaterThan(MAX_UPLOAD_BYTES);
  });
});

describe('isAudioUpload', () => {
  it.each([
    ['audio/mpeg', 'junta.mp3'],
    ['audio/mp4', 'junta.m4a'],
    ['video/mp4', 'grabacion.mp4'],
    ['video/quicktime', 'grabacion.mov'],
  ])('accepts %s — a video container is still an audio track we want', (type, name) => {
    expect(isAudioUpload({ name, type })).toBe(true);
  });

  // 🔴 The reason the extension check exists at all. Safari and Android report
  // `.m4a` and `.opus` as `application/octet-stream` or as nothing; a MIME-only
  // check would silently reject perfectly good phone recordings — the single
  // most likely way a user records a meeting.
  it.each([
    ['reunion.m4a', ''],
    ['reunion.m4a', 'application/octet-stream'],
    ['nota.opus', ''],
    ['nota.opus', 'application/octet-stream'],
  ])('accepts %s by extension when the MIME is %p', (name, type) => {
    expect(isAudioUpload({ name, type })).toBe(true);
  });

  it('rejects the documents that have their own pipeline', () => {
    expect(isAudioUpload({ name: 'informe.pdf', type: 'application/pdf' })).toBe(false);
    expect(isAudioUpload({ name: 'notes.txt', type: 'text/plain' })).toBe(false);
  });
});

describe('maxUploadBytesFor', () => {
  it('applies the audio cap to audio and the document cap to everything else', () => {
    expect(maxUploadBytesFor({ name: 'junta.m4a', type: '' })).toBe(MAX_AUDIO_UPLOAD_BYTES);
    expect(maxUploadBytesFor({ name: 'junta.mp3', type: 'audio/mpeg' })).toBe(
      MAX_AUDIO_UPLOAD_BYTES,
    );
    expect(maxUploadBytesFor({ name: 'informe.pdf', type: 'application/pdf' })).toBe(
      MAX_UPLOAD_BYTES,
    );
  });
});

describe('UPLOAD_ACCEPT', () => {
  // Both halves are needed: `audio/*` covers the browsers that sniff correctly,
  // and the explicit extensions cover the ones that don't — same reason
  // `isAudioUpload` has a filename fallback. A picker that greys out a valid
  // `.m4a` reads as "this app doesn't take my recording".
  it('offers the audio wildcard AND the explicit extensions', () => {
    expect(UPLOAD_ACCEPT).toContain('audio/*');
    for (const ext of ['.mp3', '.m4a', '.wav', '.ogg', '.opus', '.mp4', '.mov']) {
      expect(UPLOAD_ACCEPT).toContain(ext);
    }
  });

  it('still offers the document types', () => {
    expect(UPLOAD_ACCEPT).toContain('application/pdf');
    expect(UPLOAD_ACCEPT).toContain('.docx');
  });

  it('offers markdown notes', () => {
    for (const entry of ['.md', '.markdown', 'text/markdown']) {
      expect(UPLOAD_ACCEPT.split(',')).toContain(entry);
    }
  });

  it('offers spreadsheets and web pages', () => {
    for (const entry of ['.xlsx', '.csv', '.html', '.htm', 'text/csv', 'text/html']) {
      expect(UPLOAD_ACCEPT.split(',')).toContain(entry);
    }
  });
});

describe('formatBytes', () => {
  it('renders sub-KiB values in bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('renders KiB with one decimal at the 1 KiB boundary', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 * 100)).toBe('100.0 KB');
  });

  it('renders MiB with one decimal at the 1 MiB boundary', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(MAX_UPLOAD_BYTES)).toBe('20.0 MB');
  });
});
