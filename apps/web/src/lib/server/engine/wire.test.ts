/**
 * Regression guard for the system-role fold removal.
 *
 * These tests exist so that anyone who re-introduces the fold — flattening the
 * behavioural block back into the user message, or dropping
 * `unit.systemPrompt` during a refactor — gets a RED test rather than a chat
 * that silently answers without its instructions.
 *
 * No network: `buildChatUnitRequest` is pure, and the arrival guard is asserted
 * against a stubbed fetch.
 */

import { describe, expect, it } from 'vitest';
import {
  buildChatUnitRequest,
  partitionMessages,
  PROMPT_TEMPLATE_USER_PROMPT,
  TRANSCRIPT_DIRECTIVE,
} from './wire';

const PERSONA =
  'Eres un asistente que colabora con un miembro del equipo. No inventes detalles.';

describe('partitionMessages', () => {
  it('lifts the leading system message out of the user prompt', () => {
    const { systemPrompt, userPrompt } = partitionMessages([
      { role: 'system', content: PERSONA },
      { role: 'user', content: '¿Qué proyectos tiene el equipo?' },
    ]);

    expect(systemPrompt).toBe(PERSONA);
    // The fold is really gone: no instructions, and no role marker, in the
    // user message.
    expect(userPrompt).toBe('¿Qué proyectos tiene el equipo?');
    expect(userPrompt).not.toContain('No inventes detalles');
    expect(userPrompt).not.toContain('system:');
  });

  it('joins multiple leading system messages, still keeping them out of the user prompt', () => {
    const { systemPrompt, userPrompt } = partitionMessages([
      { role: 'system', content: 'A' },
      { role: 'system', content: 'B' },
      { role: 'user', content: 'pregunta' },
    ]);

    expect(systemPrompt).toBe('A\n\nB');
    expect(userPrompt).toBe('pregunta');
  });

  it('flattens history into a role-marked transcript with a trailing directive', () => {
    const { systemPrompt, userPrompt } = partitionMessages([
      { role: 'system', content: PERSONA },
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: 'qué tal' },
      { role: 'user', content: '[CONTEXTO]\n…\n\nsigue' },
    ]);

    expect(systemPrompt).toBe(PERSONA);
    expect(userPrompt).toBe(
      'user:\nhola\n\n' +
        'assistant:\nqué tal\n\n' +
        'user:\n[CONTEXTO]\n…\n\nsigue\n\n' +
        TRANSCRIPT_DIRECTIVE,
    );
    // History is flattened because ai-service renders exactly one user
    // message — but the behavioural block is NOT part of that flattening.
    expect(userPrompt).not.toContain(PERSONA);
    expect(userPrompt).not.toContain('system:');
  });

  it('returns undefined (never an empty string) when there is no system message', () => {
    // ai-service rejects `systemPrompt: ''` (`min(1)`), and whitespace-only is
    // "not supplied".
    expect(partitionMessages([{ role: 'user', content: 'x' }]).systemPrompt).toBeUndefined();
    expect(
      partitionMessages([
        { role: 'system', content: '   \n ' },
        { role: 'user', content: 'x' },
      ]).systemPrompt,
    ).toBeUndefined();
  });

  it('leaves a mid-conversation system message in the transcript rather than reordering it', () => {
    const { systemPrompt, userPrompt } = partitionMessages([
      { role: 'system', content: PERSONA },
      { role: 'user', content: 'hola' },
      { role: 'system', content: 'nota intermedia' },
      { role: 'user', content: 'sigue' },
    ]);

    expect(systemPrompt).toBe(PERSONA);
    expect(userPrompt).toContain('system:\nnota intermedia');
  });
});

describe('buildChatUnitRequest', () => {
  const messages = [
    { role: 'system', content: PERSONA },
    { role: 'user', content: '[CONTEXTO …]\n\n¿Quién lidera el proyecto?' },
  ];

  it('puts the instructions in unit.systemPrompt and NOT in userPrompt', () => {
    const req = buildChatUnitRequest({ messages, unitKey: 'session-1' });

    expect(req.unit.systemPrompt).toContain('No inventes detalles');
    expect(req.unit.input?.userPrompt).not.toContain('No inventes detalles');
    expect(req.unit.input?.userPrompt).toBe('[CONTEXTO …]\n\n¿Quién lidera el proyecto?');
  });

  it('no longer sends input.messages or a conversation-flattening template', () => {
    const req = buildChatUnitRequest({ messages, unitKey: 'session-1' });

    // The fold's two fingerprints.
    expect(req.unit.input?.messages).toBeUndefined();
    expect(req.unit.specOverride?.promptTemplate).toBe(PROMPT_TEMPLATE_USER_PROMPT);
    expect(req.unit.specOverride?.promptTemplate).not.toContain('#each');
    expect(req.unit.specOverride?.promptTemplate).not.toContain('this.role');
  });

  it('🔴 pins the passthrough to TRIPLE stache', () => {
    // ai-service renders with Handlebars in default escaping mode, so
    // `{{userPrompt}}` would turn `it's` into `it&#x27;s` and every markdown
    // backtick into `&#x60;`. Since chat ships the WHOLE assembled prompt as
    // this one variable, that would corrupt every answer.
    //
    // These bytes are also what the backend seeds as the registry row's
    // `promptTemplate` (`the backend/src/seed/registry.ts`). `renderPrompt` is
    // pure, so identical template + identical vars ⇒ identical prompt: that
    // equality is the proof the registry flip changes nothing the model sees.
    expect(PROMPT_TEMPLATE_USER_PROMPT).toBe('{{{userPrompt}}}');
    expect(PROMPT_TEMPLATE_USER_PROMPT).not.toBe('{{userPrompt}}');
  });

  describe('registry mode (PROMPT_SOURCE=registry)', () => {
    it('omits specOverride entirely so the registry supplies the spec', () => {
      const req = buildChatUnitRequest({ messages, unitKey: 'session-1', useRegistryPrompt: true });

      // Absent, not `{}`: ai-service refuses to stamp registryEntryId /
      // promptVersion whenever ANY override object is present, so an empty one
      // would silently keep chat unattributable.
      expect('specOverride' in req.unit).toBe(false);
      expect(req.unit.specOverride).toBeUndefined();
    });

    it('changes NOTHING else on the wire', () => {
      const inline = buildChatUnitRequest({ messages, unitKey: 'session-1' });
      const registry = buildChatUnitRequest({
        messages,
        unitKey: 'session-1',
        useRegistryPrompt: true,
      });

      // The prompt bytes chat computes are identical; only the slot the
      // template travels in differs. Everything else must match exactly.
      const { specOverride: _dropped, ...inlineRest } = inline.unit;
      expect(registry.unit).toEqual(inlineRest);
      expect(registry.unit.input?.userPrompt).toBe(inline.unit.input?.userPrompt);
      expect(registry.unit.systemPrompt).toBe(inline.unit.systemPrompt);
    });

    it('defaults to inline, so the flag being unset is exactly today', () => {
      const explicit = buildChatUnitRequest({ messages, unitKey: 's', useRegistryPrompt: false });
      const omitted = buildChatUnitRequest({ messages, unitKey: 's' });

      expect(omitted).toEqual(explicit);
      expect(omitted.unit.specOverride?.promptTemplate).toBe(PROMPT_TEMPLATE_USER_PROMPT);
    });
  });

  it('omits systemPrompt entirely when there is none (rather than sending an empty string)', () => {
    const req = buildChatUnitRequest({
      messages: [{ role: 'user', content: 'hola' }],
      unitKey: 'session-1',
    });

    expect('systemPrompt' in req.unit).toBe(false);
  });

  it('carries unitKey, unitType and the optional knobs through', () => {
    const req = buildChatUnitRequest({
      messages,
      unitKey: 'session-9',
      effortLevel: 'standard',
      modelOverride: 'some/model',
    });

    expect(req.unit.unitKey).toBe('session-9');
    expect(req.unit.unitType).toBe('chat');
    expect(req.effortLevel).toBe('standard');
    expect(req.modelOverride).toBe('some/model');
  });
});
