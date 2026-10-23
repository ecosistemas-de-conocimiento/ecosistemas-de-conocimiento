import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth', () => ({
  backendUrl: () => 'http://backend.test',
  backendFetch: vi.fn(),
}));

import { bytesMatchKind, uploadDocument } from './uploadDocument';
import { backendFetch } from '$lib/server/auth';

const enc = (s: string) => new TextEncoder().encode(s);
const PDF = enc('%PDF-1.7\n');
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const MP3 = enc('ID3\x04\x00\x00');
const MP3_FRAME = new Uint8Array([0xff, 0xfb, 0x90, 0x64]);
const M4A = new Uint8Array([0, 0, 0, 0x20, ...enc('ftypM4A ')]);
const WAV = enc('RIFF\x24\x00\x00\x00WAVEfmt ');
const OGG = enc('OggS\x00\x02');

describe('bytesMatchKind', () => {
  it.each([
    ['pdf', PDF],
    ['pdf', enc('\n\n%PDF-1.4')],
    ['docx', ZIP],
    ['audio', MP3],
    ['audio', MP3_FRAME],
    ['audio', M4A],
    ['audio', WAV],
    ['audio', OGG],
  ] as const)('accepts %s with matching bytes', (kind, bytes) => {
    expect(bytesMatchKind(bytes, kind)).toBe(true);
  });

  it.each([
    ['pdf', MP3],
    ['pdf', M4A],
    ['pdf', ZIP],
    ['docx', PDF],
    ['docx', MP3],
    ['audio', PDF],
    ['audio', ZIP],
    ['pdf', enc('hello')],
  ] as const)('refuses %s whose bytes say otherwise', (kind, bytes) => {
    expect(bytesMatchKind(bytes, kind)).toBe(false);
  });
});

describe('uploadDocument — content sniffing', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (backendFetch as unknown as ReturnType<typeof vi.fn>).mockReset();
  });

  it('refuses an audio file renamed a.pdf before anything goes up', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const form = new FormData();
    form.append('file', new File([MP3], 'a.pdf', { type: 'application/pdf' }));
    form.append('contentKind', 'documento');

    const res = await uploadDocument('tok', form, { session: [1], defaultPinned: true });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'unsupported_kind', reason: 'content_mismatch' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(backendFetch).not.toHaveBeenCalled();
  });

  it('refuses a PDF renamed acta.docx', async () => {
    const form = new FormData();
    form.append('file', new File([PDF], 'acta.docx', { type: '' }));
    form.append('contentKind', 'documento');

    const res = await uploadDocument('tok', form, { session: [], defaultPinned: false });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ reason: 'content_mismatch', kind: 'docx' });
  });
});

describe('uploadDocument — which ecosistema the create names', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (backendFetch as unknown as ReturnType<typeof vi.fn>).mockReset();
  });

  async function sentBody(opts: Parameters<typeof uploadDocument>[2]) {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ doc: { id: 11 } }), { status: 201 }),
    );
    (backendFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ doc: { id: 21 } }), { status: 201 }),
    );
    const form = new FormData();
    form.append('file', new File([PDF], 'informe.pdf', { type: 'application/pdf' }));
    form.append('contentKind', 'documento');
    const res = await uploadDocument('tok', form, opts);
    expect(res.status).toBe(201);
    const call = (backendFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    return JSON.parse(call[2].body as string) as Record<string, unknown>;
  }

  it('names the given ecosistema on a conversation-less upload', async () => {
    expect(await sentBody({ session: [], defaultPinned: false, organization: '4' })).toMatchObject({
      session: [],
      organization: '4',
    });
  });

  it('names none on a conversation upload: the backend derives it from the session', async () => {
    expect(await sentBody({ session: [7], defaultPinned: true })).not.toHaveProperty('organization');
  });
});
