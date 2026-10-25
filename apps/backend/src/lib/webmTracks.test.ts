/**
 * The recorder's WebM sniffs as `video/webm` (file-type reads the container,
 * not the tracks), so Media has to allow that type and then refuse any WebM
 * that actually carries video. These tests pin the track check.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { isAudioOnlyMatroska, isMatroska, matroskaCodecIds } from './webmTracks'

let hasFfmpeg = true
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
} catch {
  hasFfmpeg = false
}

function make(args: string[]): Uint8Array {
  const out = join(mkdtempSync(join(tmpdir(), 'webm-')), 'f.webm')
  execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', ...args, out])
  return new Uint8Array(readFileSync(out))
}

describe.skipIf(!hasFfmpeg)('webm tracks (real files)', () => {
  it('audio-only Opus WebM is audio-only', () => {
    const buf = make(['-f', 'lavfi', '-i', 'sine=d=1', '-c:a', 'libopus'])
    expect(isMatroska(buf)).toBe(true)
    expect(matroskaCodecIds(buf)).toEqual(['A_OPUS'])
    expect(isAudioOnlyMatroska(buf)).toBe(true)
  })

  it('🔴 WebM with a video track is refused', () => {
    const buf = make([
      '-f', 'lavfi', '-i', 'testsrc=d=1:s=64x64',
      '-f', 'lavfi', '-i', 'sine=d=1',
      '-c:v', 'libvpx', '-c:a', 'libopus',
    ])
    expect(matroskaCodecIds(buf)).toContain('V_VP8')
    expect(isAudioOnlyMatroska(buf)).toBe(false)
  })

  it('video-only WebM is refused', () => {
    const buf = make(['-f', 'lavfi', '-i', 'testsrc=d=1:s=64x64', '-c:v', 'libvpx'])
    expect(isAudioOnlyMatroska(buf)).toBe(false)
  })
})

describe('webm tracks (bytes)', () => {
  const EBML = [0x1a, 0x45, 0xdf, 0xa3]
  const codec = (id: string) => [0x86, 0x80 | id.length, ...Buffer.from(id)]
  const CLUSTER = [0x1f, 0x43, 0xb6, 0x75]

  it('only reads codec ids from the header, before the first Cluster', () => {
    // A "V_VP8"-looking run inside audio data must not count as a video track.
    const buf = new Uint8Array([...EBML, 0, 0, ...codec('A_OPUS'), ...CLUSTER, ...codec('V_VP8')])
    expect(matroskaCodecIds(buf)).toEqual(['A_OPUS'])
    expect(isAudioOnlyMatroska(buf)).toBe(true)
  })

  it('no audio codec at all is not audio-only', () => {
    expect(isAudioOnlyMatroska(new Uint8Array([...EBML, 0, 0]))).toBe(false)
  })

  it('a non-Matroska file is not Matroska', () => {
    expect(isMatroska(new Uint8Array(Buffer.from('RIFF....WAVE')))).toBe(false)
  })
})
