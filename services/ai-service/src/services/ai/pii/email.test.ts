// Email addresses. Offline, no mocks, no network.

import { describe, expect, it } from 'vitest';

import { emailDetector, isValidEmail } from './email.js';

describe('isValidEmail — accepts', () => {
  it.each([
    ['plain', 'persona@example.mx'],
    ['dotted local part', 'persona.ejemplo@example.mx'],
    ['plus tag', 'persona+etiqueta@example.mx'],
    ['subdomain', 'persona@correo.example.mx'],
    ['hyphenated domain', 'persona@mi-dominio.mx'],
    ['digits', 'usuario2024@example.org'],
    ['long TLD', 'persona@example.company'],
    ['uppercase', 'PERSONA@EXAMPLE.MX'],
  ])('%s', (_label, candidate) => {
    expect(isValidEmail(candidate)).toBe(true);
  });
});

describe('isValidEmail — rejects', () => {
  it.each([
    ['no at sign', 'persona.example.mx'],
    ['no TLD', 'persona@example'],
    ['empty domain label', 'persona@.mx'],
    ['single-letter TLD', 'persona@example.m'],
    ['empty local part', '@example.mx'],
    ['a leading dot in the local part', '.persona@example.mx'],
    ['a trailing dot in the local part', 'persona.@example.mx'],
    ['internal whitespace', 'persona @example.mx'],
    ['two at signs', 'persona@otra@example.mx'],
    ['empty', ''],
  ])('%s', (_label, candidate) => {
    expect(isValidEmail(candidate)).toBe(false);
  });
});

describe('emailDetector', () => {
  it('finds an address in running Spanish, with exact offsets', () => {
    const text = 'Escríbeme a persona.ejemplo@example.mx cuando puedas.';
    const spans = emailDetector.find(text);
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.kind).toBe('email');
    expect(span.detector).toBe('rules:email');
    expect(text.slice(span.start, span.end)).toBe('persona.ejemplo@example.mx');
  });

  it('does not swallow the full stop that ends the sentence', () => {
    // A trailing dot is only absorbed when a letter follows it. Without that,
    // the placeholder eats the punctuation and the scrubbed text stops reading
    // as prose — which is the entire argument for placeholder tokens.
    const text = 'Mi correo es persona@example.mx.';
    expect(emailDetector.find(text).map((s) => s.text)).toEqual(['persona@example.mx']);
  });

  it('does not start mid-token', () => {
    // `texto.usuario@example.mx` is one address, not `usuario@example.mx`
    // preceded by orphaned text.
    const spans = emailDetector.find('texto.usuario@example.mx');
    expect(spans.map((s) => s.text)).toEqual(['texto.usuario@example.mx']);
  });

  it('finds several addresses in one string', () => {
    const text = 'a@example.mx, b@example.org y c@example.com';
    expect(emailDetector.find(text).map((s) => s.text)).toEqual([
      'a@example.mx',
      'b@example.org',
      'c@example.com',
    ]);
  });

  it('does not match prose containing an at sign', () => {
    expect(emailDetector.find('El precio es 3 @ 20 pesos.')).toEqual([]);
  });

  it('is not stateful across calls', () => {
    const text = 'correo: persona@example.mx';
    expect(emailDetector.find(text)).toHaveLength(1);
    expect(emailDetector.find(text)).toHaveLength(1);
  });
});
