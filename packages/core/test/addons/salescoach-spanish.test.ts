/**
 * Spanish (round four, docs/salescoach.md): the coach follows the customer's language. The language is the one the
 * listener heard most from the customer, then the team; each ask tells the model it when known; the write-up keeps
 * it, preferring what was heard (or the conversation's) over what the model says.
 */
import { describe, expect, it } from 'vitest';
import {
  afterCallPrompt,
  callLanguage,
  checkedAfterCall,
  coachPrompt,
  languageCode,
  type CallLine,
} from '../../src/addons/salescoach/coach';
import { suggestPrompt } from '../../src/addons/salescoach/suggest';

const line = (speaker: CallLine['speaker'], text: string, language?: string | null): CallLine => ({
  speaker,
  text,
  atMs: 0,
  language,
});

const answer = {
  summary: 'Rosa wants a price.',
  notes: [],
  promises: [],
  followUp: 'Gracias, Rosa.',
  objections: [],
  stepsCovered: [],
  tips: [],
  language: 'en',
};
const none = { steps: [], objections: [], points: [] };

describe('the customer’s language', () => {
  it('is two letters, from whatever the listener said', () => {
    expect(languageCode('es-419')).toBe('es');
    expect(languageCode('EN')).toBe('en');
    expect(languageCode('multi')).toBeNull();
    expect(languageCode(28)).toBeNull();
  });

  it('is the one most of the customer’s lines were in, then the team’s, else unknown', () => {
    expect(
      callLanguage([
        line('team', 'Hi Rosa, thanks for calling.', 'en'),
        line('customer', 'Hola, sí.', 'es'),
        line('customer', 'Okay', 'en'),
        line('customer', 'El precio es muy caro.', 'es'),
      ]),
    ).toBe('es');
    // A tie goes to the latest.
    expect(callLanguage([line('customer', 'Hola', 'es'), line('customer', 'Okay', 'en')])).toBe(
      'en',
    );
    expect(callLanguage([line('team', 'Hola', 'es'), line('customer', 'Sí')])).toBe('es');
    expect(callLanguage([line('customer', 'Hello')])).toBeNull();
  });

  it('is told to the model live, in the write-up and for suggested replies, when known', () => {
    const spanish = [line('customer', 'El precio es muy caro.', 'es')];
    expect(coachPrompt(spanish)).toContain('<language>The customer speaks Spanish.</language>');
    expect(coachPrompt([line('customer', 'Too expensive.')])).not.toContain('<language>');
    expect(
      afterCallPrompt({ playbook: '<playbook/>', lines: spanish, today: '2026-10-16' }),
    ).toContain('The customer speaks Spanish.');
    // A written conversation's language is the one the AI teammate noted.
    expect(
      afterCallPrompt({
        playbook: '<playbook/>',
        lines: [line('customer', 'Hola')],
        today: '2026-10-16',
        kind: 'conversation',
        language: 'es',
      }),
    ).toContain('The customer speaks Spanish.');
    expect(
      suggestPrompt({
        channel: 'sms',
        messages: [{ direction: 'inbound', text: '¿Cuánto cuesta?' }],
        language: 'es',
      }),
    ).toContain('The customer speaks Spanish.');
  });

  it('is kept on the write-up: what was heard first, then the conversation’s, then the model’s', () => {
    const heard = [line('customer', 'Muy caro.', 'es')];
    expect(checkedAfterCall(answer, none, heard).language).toBe('es');
    expect(checkedAfterCall(answer, none, [line('customer', 'Hola')], 'es').language).toBe('es');
    expect(checkedAfterCall(answer, none, [line('customer', 'Hello')]).language).toBe('en');
    expect(
      checkedAfterCall({ ...answer, language: null }, none, [line('customer', 'Hello')]).language,
    ).toBeNull();
  });
});
