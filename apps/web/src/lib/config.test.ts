import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES, formatBytes } from './config';

describe('MAX_UPLOAD_BYTES', () => {
  it('is 20 MiB', () => {
    expect(MAX_UPLOAD_BYTES).toBe(20 * 1024 * 1024);
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
