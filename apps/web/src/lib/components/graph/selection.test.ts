import { describe, expect, it } from 'vitest';

import { isMapEscape, nextSelection } from './selection';

describe('nextSelection — the map selection rules', () => {
  it('selects the clicked node, from nothing or from another node', () => {
    expect(nextSelection(null, { kind: 'node', id: 'a' })).toBe('a');
    expect(nextSelection('b', { kind: 'node', id: 'a' })).toBe('a');
  });

  it('a second click on the selected node clears it, as the map always did', () => {
    expect(nextSelection('a', { kind: 'node', id: 'a' })).toBeNull();
  });

  it('clears on a click on empty space and on Esc', () => {
    expect(nextSelection('a', { kind: 'background' })).toBeNull();
    expect(nextSelection('a', { kind: 'escape' })).toBeNull();
    expect(nextSelection(null, { kind: 'escape' })).toBeNull();
  });
});

describe('isMapEscape', () => {
  it('takes a plain Esc on the page', () => {
    expect(isMapEscape({ key: 'Escape', target: { tagName: 'BODY' } })).toBe(true);
    expect(isMapEscape({ key: 'Escape' })).toBe(true);
  });

  it('ignores other keys', () => {
    expect(isMapEscape({ key: 'Enter', target: { tagName: 'BODY' } })).toBe(false);
  });

  it('ignores Esc while typing, and Esc something else already handled', () => {
    for (const tagName of ['INPUT', 'textarea', 'SELECT']) {
      expect(isMapEscape({ key: 'Escape', target: { tagName } })).toBe(false);
    }
    expect(isMapEscape({ key: 'Escape', target: { tagName: 'DIV', isContentEditable: true } })).toBe(false);
    expect(isMapEscape({ key: 'Escape', defaultPrevented: true })).toBe(false);
  });
});
