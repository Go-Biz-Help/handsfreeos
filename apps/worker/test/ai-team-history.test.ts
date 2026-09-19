/**
 * What the AI teammate reads of the phone. Before this it read only what was typed, so a customer who left a
 * voicemail and then texted "like I said on the phone" was answering a question the model had never seen asked.
 */
import { describe, expect, it } from 'vitest';
import { historyBlock, type HistoryView } from '../src/ai-team/prompt';
import type { HistoryCall, HistoryLine } from '../src/ai-team/context';

const AT = Date.parse('2026-09-17T14:05:00Z');

const view = (history: HistoryLine[]): HistoryView => ({
  history,
  workspace: { timeZone: 'America/Chicago' },
  config: { identity: { name: 'Ava' } },
});

const call = (over: Partial<HistoryCall> = {}): HistoryCall => ({
  id: '11111111-2222-3333-4444-555555555555',
  kind: 'voicemail',
  seconds: 24,
  words: 'here',
  more: false,
  ...over,
});

const line = (over: Partial<HistoryLine> = {}): HistoryLine => ({
  at: AT,
  who: 'customer',
  name: null,
  text: '',
  ...over,
});

const render = (h: HistoryLine[]) => historyBlock(view(h)).join('\n');

describe('a call in the history', () => {
  it('reads as something that happened, not as a turn of typing', () => {
    const out = render([
      line({ text: 'Hi, it’s Mike. Can you come look at the roof?', call: call() }),
    ]);
    expect(out).toContain('The customer called and left a voicemail (24 seconds).');
    expect(out).toContain('What they said:');
    expect(out).toContain('“Hi, it’s Mike. Can you come look at the roof?”');
    // Never "Customer: …", which would read as something they typed.
    expect(out).not.toContain('Customer:');
  });

  it('says how long a call ran in words a model can’t read as a time of day', () => {
    expect(
      render([
        line({ text: 'Ava: Hello. Mike: Hi.', call: call({ kind: 'talked', seconds: 192 }) }),
      ]),
    ).toContain('for 3 minutes 12 seconds');
    expect(render([line({ text: 'Hi.', call: call({ seconds: 61 }) })])).toContain(
      '(1 minute 1 second)',
    );
    expect(render([line({ text: 'Hi.', call: call({ seconds: 120 }) })])).toContain('(2 minutes)');
  });

  it('points at read_call_transcript only when it is holding something back', () => {
    const short = render([line({ text: 'Hi.', call: call({ kind: 'talked', seconds: 40 }) })]);
    expect(short).not.toContain('read_call_transcript');
    const long = render([
      line({ text: 'Hi.', call: call({ kind: 'talked', seconds: 400, more: true }) }),
    ]);
    expect(long).toContain('read_call_transcript with callId 11111111-2222-3333-4444-555555555555');
  });

  it('tells apart words that are coming from words that will never come', () => {
    expect(render([line({ call: call({ words: 'coming' }) })])).toContain('isn’t written out yet');
    expect(render([line({ call: call({ words: 'never' }) })])).toContain('Nothing was written out');
    // Both say not to guess: an empty space is what made the model invent what was said.
    for (const w of ['coming', 'never'] as const)
      expect(render([line({ call: call({ words: w }) })])).toContain('Don’t guess at it.');
  });

  it('says nothing about words for a call nobody answered', () => {
    const out = render([line({ call: call({ kind: 'missed', seconds: null, words: 'never' }) })]);
    expect(out).toContain('The customer called and nobody answered.');
    expect(out).not.toContain('written out');
  });

  it('names the person who rang out, and never calls a call the teammate’s own', () => {
    expect(
      render([
        line({ who: 'person', name: 'Dale Reyes', call: call({ kind: 'talked', seconds: 90 }) }),
      ]),
    ).toContain('Dale Reyes');
    expect(
      render([line({ who: 'automatic', call: call({ kind: 'missed', words: 'never' }) })]),
    ).toContain('The business called them and they didn’t answer.');
  });

  it('leaves a message alone', () => {
    const out = render([
      line({ text: 'Can you come Tuesday?' }),
      line({ who: 'ai', text: 'Tuesday works.' }),
    ]);
    expect(out).toContain('Customer: Can you come Tuesday?');
    expect(out).toContain('You (Ava): Tuesday works.');
  });

  it('says so plainly when there is nothing before now', () => {
    expect(render([])).toBe('<history>\n(nothing earlier)\n</history>');
  });
});
