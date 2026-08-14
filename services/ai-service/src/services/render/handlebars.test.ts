import { describe, expect, it } from 'vitest';

import { RenderError, renderPrompt } from './handlebars.js';

describe('renderPrompt', () => {
  it('returns plain strings unchanged via the fast path', () => {
    const input = 'hello world — no template syntax here {single} or }}stray';
    expect(renderPrompt(input, {})).toBe(input);
  });

  it('returns empty string unchanged', () => {
    expect(renderPrompt('', {})).toBe('');
  });

  it('substitutes simple {{var}} interpolations', () => {
    expect(renderPrompt('Hello {{name}}!', { name: 'Ada' })).toBe('Hello Ada!');
  });

  it('renders nested {{a.b}} paths', () => {
    expect(renderPrompt('{{user.name}}', { user: { name: 'Grace' } })).toBe('Grace');
  });

  it('honours {{#if}} for truthy branches', () => {
    const tpl = '{{#if show}}YES{{else}}NO{{/if}}';
    expect(renderPrompt(tpl, { show: true })).toBe('YES');
  });

  it('honours {{#if}} for falsy branches', () => {
    const tpl = '{{#if show}}YES{{else}}NO{{/if}}';
    expect(renderPrompt(tpl, { show: false })).toBe('NO');
  });

  it('iterates {{#each}} over arrays', () => {
    const tpl = '{{#each items}}[{{this}}]{{/each}}';
    expect(renderPrompt(tpl, { items: ['a', 'b', 'c'] })).toBe('[a][b][c]');
  });

  it('iterates {{#each}} over array of objects with field access', () => {
    const tpl = '{{#each items}}{{name}}={{value}};{{/each}}';
    expect(
      renderPrompt(tpl, {
        items: [
          { name: 'x', value: 1 },
          { name: 'y', value: 2 },
        ],
      }),
    ).toBe('x=1;y=2;');
  });

  it('throws RenderError when a referenced variable is unset (strict)', () => {
    expect(() => renderPrompt('Hello {{name}}!', {})).toThrow(RenderError);
  });

  it('preserves the original Handlebars error as cause on unset variable', () => {
    try {
      renderPrompt('Hello {{name}}!', {});
      throw new Error('expected RenderError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RenderError);
      expect((err as RenderError).cause).toBeInstanceOf(Error);
    }
  });

  it('throws RenderError on a parse error', () => {
    // Mismatched block tags — `if` closed by `each`.
    expect(() => renderPrompt('{{#if x}}stuff{{/each}}', { x: true })).toThrow(RenderError);
  });

  it('does not expose the {{lookup}} helper', () => {
    // `lookup` is unregistered. Calling it as a helper either throws (no
    // helper found, or downstream TypeError) — either way it must NOT
    // succeed in returning the looked-up value.
    expect(() =>
      renderPrompt('{{lookup obj "k"}}', { obj: { k: 'value' } }),
    ).toThrow();
  });

  it('does not expose the {{#with}} block helper', () => {
    expect(() =>
      renderPrompt('{{#with user}}{{name}}{{/with}}', { user: { name: 'Ada' } }),
    ).toThrow();
  });

  it('does not expose the {{#unless}} block helper', () => {
    expect(() =>
      renderPrompt('{{#unless flag}}hidden{{/unless}}', { flag: false }),
    ).toThrow();
  });

  it('does not register file-system or partial helpers (no {{> partial}})', () => {
    // Partials were never registered; referencing one must fail.
    expect(() => renderPrompt('{{> somePartial}}', {})).toThrow();
  });
});
