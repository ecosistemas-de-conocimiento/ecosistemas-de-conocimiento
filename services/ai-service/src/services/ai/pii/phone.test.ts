// Mexican phone numbers. Offline, no mocks, no network.

import { describe, expect, it } from 'vitest';

import { isValidMxPhone, nationalDigits, phoneDetector } from './phone.js';

describe('nationalDigits — the stage-2 decision', () => {
  it.each([
    ['bare 10 digits', '5512345678', '5512345678'],
    ['grouped', '55 1234 5678', '5512345678'],
    ['hyphenated', '55-1234-5678', '5512345678'],
    ['parenthesised LADA', '(55) 1234-5678', '5512345678'],
    ['3-digit LADA', '999 123 4567', '9991234567'],
    ['country code', '+52 55 1234 5678', '5512345678'],
    ['country code, no plus', '52 55 1234 5678', '5512345678'],
    ['legacy mobile 1', '+52 1 55 1234 5678', '5512345678'],
    ['international access', '0052 55 1234 5678', '5512345678'],
    ['legacy 01 long distance', '01 800 123 4567', '8001234567'],
    ['toll free, no prefix', '800 123 4567', '8001234567'],
    ['dots', '55.1234.5678', '5512345678'],
  ])('accepts %s', (_label, raw, expected) => {
    expect(nationalDigits(raw)).toBe(expected);
  });

  it('does not decapitate a CDMX number that begins with the country code digits', () => {
    // LADA 52 is Orizaba. A ten-digit number there BEGINS with the same two
    // digits as the country code, so an unguarded `52` strip would eat them and
    // leave 8 digits, which then fails the length test and leaks the number.
    // The `d.length > 10` guard on that strip is the whole defence.
    expect(nationalDigits('5212345678')).toBe('5212345678');
  });

  it.each([
    ['9 digits', '551234567'],
    ['11 bare digits', '55123456789'],
    ['a national number starting 0', '0512345678'],
    ['a national number starting 1', '1512345678'],
    ['an epoch-seconds timestamp', '1757000000'],
    ['a list of small numbers', '01 02 03 04 05'],
    ['a year', '2024'],
    ['nothing numeric', 'sin teléfono'],
  ])('rejects %s', (_label, raw) => {
    expect(nationalDigits(raw)).toBeUndefined();
  });
});

describe('isValidMxPhone', () => {
  it('accepts a well-formed number on its own', () => {
    expect(isValidMxPhone('  +52 55 1234 5678 ')).toBe(true);
  });

  it('rejects a number with trailing prose', () => {
    expect(isValidMxPhone('55 1234 5678 ext. 9')).toBe(false);
  });

  it('rejects a shape that passes stage 1 but fails stage 2', () => {
    // `01 02 03 04 05` matches the pair-grouped written shape, so the ONLY
    // thing rejecting it is the leading-digit rule in `nationalDigits`. This
    // assertion is what proves stage 2 is load-bearing rather than decorative.
    expect(isValidMxPhone('01 02 03 04 05')).toBe(false);
  });
});

describe('phoneDetector', () => {
  it('finds a number in running Spanish, with exact offsets', () => {
    const text = 'Márcame al 55 1234 5678 después de las seis.';
    const spans = phoneDetector.find(text);
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.kind).toBe('phone');
    expect(span.detector).toBe('rules:phone');
    expect(text.slice(span.start, span.end)).toBe('55 1234 5678');
  });

  it('keeps the +52 prefix inside the span', () => {
    const text = 'WhatsApp: +52 55 1234 5678';
    const spans = phoneDetector.find(text);
    expect(spans.map((s) => s.text)).toEqual(['+52 55 1234 5678']);
  });

  it('finds two numbers separated by a word', () => {
    const text = 'Oficina 55 1234 5678 o casa 33 8765 4321.';
    expect(phoneDetector.find(text).map((s) => s.text)).toEqual(['55 1234 5678', '33 8765 4321']);
  });

  it('emits no span at all for a candidate that fails stage 2', () => {
    // Not a low-confidence span — no span. A span is a redaction, and there is
    // nothing here to redact.
    expect(phoneDetector.find('Los turnos son 01 02 03 04 05.')).toEqual([]);
  });

  it('does not redact a date, a year or a currency amount', () => {
    expect(phoneDetector.find('El 15 de marzo de 2024 se pagaron 1234.56 pesos.')).toEqual([]);
  });

  it('does not match a digit run longer than a phone number', () => {
    expect(phoneDetector.find('folio 551234567890')).toEqual([]);
  });

  it('is not stateful across calls', () => {
    const text = 'Tel 55 1234 5678';
    expect(phoneDetector.find(text)).toHaveLength(1);
    expect(phoneDetector.find(text)).toHaveLength(1);
  });
});
