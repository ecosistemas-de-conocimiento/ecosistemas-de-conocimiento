import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

import {
  CHUNK_DATA_RULE,
  ECOSYSTEM_STYLE_HEADER,
  FOLLOW_UP_RULE,
  ORIENTATION_RULE,
  PLAIN_LANGUAGE_RULE,
  chatSystemPrompt,
  interviewSystemPrompt,
  resonanciasSystemPrompt,
  withEcosystemStyle,
  withTurnRules,
} from './prompt';
import { CHAT_ENGINE_CONFIG, answerStyleFor, chatEngineConfigFor, withAnswerStyle } from './config';
import type { AnswerStyles } from '$lib/answerStyle';
import type { SessionKind } from '$lib/sessionKind';
import type { ChatTurnMode } from './turnMode';

/**
 * The ecosistema answer style (owner ruling 2026-10-28): appended LAST, under
 * a header that keeps the rules; no style = the exact same config.
 */

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const NONE: AnswerStyles = { generales: null, resonancias: null, interviewer: null };
const STYLES: AnswerStyles = { generales: 'ESTILO-G', resonancias: 'ESTILO-R', interviewer: 'ESTILO-I' };

const CASES: Array<{ kind: SessionKind; mode: ChatTurnMode; base: () => string; style: string }> = [
  { kind: 'generales', mode: 'answer', base: () => chatSystemPrompt('E'), style: 'ESTILO-G' },
  { kind: 'generales', mode: 'interview', base: interviewSystemPrompt, style: 'ESTILO-I' },
  { kind: 'resonancias', mode: 'answer', base: resonanciasSystemPrompt, style: 'ESTILO-R' },
  { kind: 'resonancias', mode: 'interview', base: resonanciasSystemPrompt, style: 'ESTILO-R' },
];

describe('no style: nothing changes', () => {
  it('Generales answer is still CHAT_ENGINE_CONFIG itself, with no style, null, or blank styles', () => {
    for (const styles of [undefined, null, NONE, { ...NONE, generales: '   ' }]) {
      expect(chatEngineConfigFor('generales', 'answer', styles)).toBe(CHAT_ENGINE_CONFIG);
    }
  });

  it('withAnswerStyle returns the same object when the turn\'s own style is empty', () => {
    const config = chatEngineConfigFor('resonancias');
    // A Generales style never touches a Resonancias turn, and the other way round.
    expect(withAnswerStyle(config, 'resonancias', 'answer', { ...NONE, generales: 'X', interviewer: 'Y' })).toBe(config);
    const answer = chatEngineConfigFor('generales', 'answer');
    expect(withAnswerStyle(answer, 'generales', 'answer', { ...NONE, resonancias: 'X', interviewer: 'Y' })).toBe(answer);
  });

  it('the pinned base-prompt hashes hold (same pins as prompt.test.ts)', () => {
    expect(sha(chatEngineConfigFor('generales', 'answer', NONE).systemPrompt)).toBe('95a1caa51aa2585b');
    expect(sha(chatEngineConfigFor('resonancias', 'answer', NONE).systemPrompt)).toBe('09dabb21d0af9c91');
    expect(sha(chatEngineConfigFor('generales', 'interview', NONE).systemPrompt)).toBe('f8031c659fb8c9b9');
  });

  it('withEcosystemStyle with no text is the prompt itself', () => {
    expect(withEcosystemStyle('BASE', null)).toBe('BASE');
    expect(withEcosystemStyle('BASE', undefined)).toBe('BASE');
    expect(withEcosystemStyle('BASE', ' \n ')).toBe('BASE');
  });
});

describe('with a style: the block comes last and the rules are intact', () => {
  for (const { kind, mode, base, style } of CASES) {
    it(`${kind} / ${mode}: base prompt, then the header, then its own style`, () => {
      const config = chatEngineConfigFor(kind, mode, STYLES);
      const prompt = config.systemPrompt;
      expect(prompt).toBe(`${base()}\n\n${ECOSYSTEM_STYLE_HEADER}\n\n${style}`);
      expect(prompt.endsWith(style)).toBe(true);
      // Only its own style.
      for (const other of Object.values(STYLES)) if (other !== style) expect(prompt).not.toContain(other);
      // Every rule still there, before the style.
      for (const rule of [CHUNK_DATA_RULE, ORIENTATION_RULE, PLAIN_LANGUAGE_RULE]) {
        expect(prompt.indexOf(rule)).toBeGreaterThanOrEqual(0);
        expect(prompt.indexOf(rule)).toBeLessThan(prompt.indexOf(ECOSYSTEM_STYLE_HEADER));
      }
      // Only the system prompt moves; the preamble is the kind's own.
      expect(config.userContextPreamble).toBe(chatEngineConfigFor(kind, mode).userContextPreamble);
    });
  }

  it('the header keeps the rules: [N], <fuente> as data, no inventing, plain language', () => {
    expect(ECOSYSTEM_STYLE_HEADER).toContain('nunca cambia las reglas');
    expect(ECOSYSTEM_STYLE_HEADER).toContain('[N]');
    expect(ECOSYSTEM_STYLE_HEADER).toContain('<fuente>');
    expect(ECOSYSTEM_STYLE_HEADER).toContain('no inventes');
    expect(ECOSYSTEM_STYLE_HEADER).toContain('lenguaje sencillo');
    expect(ECOSYSTEM_STYLE_HEADER).toContain('valen las reglas');
  });

  it('turn rules added afterwards go before the style, which stays last', () => {
    const styled = chatEngineConfigFor('generales', 'answer', STYLES).systemPrompt;
    const prompt = withTurnRules(styled, [FOLLOW_UP_RULE, 'OTRA REGLA']);
    expect(prompt).toBe(
      `${chatSystemPrompt('E')}\n\n${FOLLOW_UP_RULE}\n\nOTRA REGLA\n\n${ECOSYSTEM_STYLE_HEADER}\n\nESTILO-G`,
    );
    // Without a style, withTurnRules is what it always was.
    expect(withTurnRules('BASE', ['R'])).toBe('BASE\n\nR');
  });

  it('does not mutate CHAT_ENGINE_CONFIG', () => {
    chatEngineConfigFor('generales', 'answer', STYLES);
    expect(sha(CHAT_ENGINE_CONFIG.systemPrompt)).toBe('95a1caa51aa2585b');
  });

  it('answerStyleFor picks Resonancias by kind, the interviewer by mode, else Generales', () => {
    expect(answerStyleFor('resonancias', 'interview', STYLES)).toBe('ESTILO-R');
    expect(answerStyleFor('generales', 'interview', STYLES)).toBe('ESTILO-I');
    expect(answerStyleFor('generales', 'answer', STYLES)).toBe('ESTILO-G');
    expect(answerStyleFor('generales', 'answer', null)).toBeNull();
  });
});
