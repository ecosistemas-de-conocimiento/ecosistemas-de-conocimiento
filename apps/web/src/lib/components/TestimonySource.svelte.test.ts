import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import TestimonySource from './TestimonySource.svelte';

describe('TestimonySource (SSR)', () => {
  it('audio: a labelled icon and the day', () => {
    const { body } = render(TestimonySource, { props: { audio: true, day: '24 oct' } });
    expect(body).toContain('aria-label="Audio"');
    expect(body).toContain('24 oct');
  });

  it('text/chat: the Conversación label; no day, no empty text', () => {
    const { body } = render(TestimonySource, { props: { audio: false, day: '' } });
    expect(body).toContain('aria-label="Conversación"');
    expect(body).not.toContain('<span></span>');
  });
});
