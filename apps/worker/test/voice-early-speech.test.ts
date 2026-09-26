/**
 * Saying a reply on a call while it's still being written (voice-agent/early-speech.ts): the message read out of
 * the tool call's JSON as it grows, a checked sentence at a time, and only for a reply that may go out early.
 */
import type { AiToolInput } from '@hfos/ai';
import { describe, expect, it } from 'vitest';
import { EarlySpeech, partialString, streamSpoken } from '../src/voice-agent/early-speech';

/** A tool call written a few characters at a time, as a model streams it. */
function written(
  id: string,
  name: string,
  args: Record<string, unknown>,
  piece = 5,
): AiToolInput[] {
  const json = JSON.stringify(args);
  const out: AiToolInput[] = [{ id, name, json: '', done: false }];
  for (let end = piece; end < json.length; end += piece)
    out.push({ id, name, json: json.slice(0, end), done: false });
  out.push({ id, name, json, done: true });
  return out;
}

function speech(o: { passes?: (words: string) => boolean; mayStart?: () => boolean } = {}) {
  const said: { sentence: string; ending: boolean }[] = [];
  const checked: string[] = [];
  const early = new EarlySpeech({
    passes: (words) => {
      checked.push(words);
      return o.passes ? o.passes(words) : true;
    },
    mayStart: o.mayStart ?? (() => true),
    say: (sentence, ending) => said.push({ sentence, ending }),
  });
  return { early, said, checked };
}

describe('reading a message as it is written', () => {
  it('gives as much of the string as has arrived, and whether it is whole', () => {
    expect(partialString('{"message": "We’re open Mon', 'message')).toEqual({
      text: 'We’re open Mon',
      whole: false,
    });
    expect(partialString('{"message":"Hi.","language":"en"}', 'message')).toEqual({
      text: 'Hi.',
      whole: true,
    });
    expect(partialString('{"message":"Say \\"hi\\"\\nnow \\u00e9', 'message')).toEqual({
      text: 'Say "hi"\nnow é',
      whole: false,
    });
  });

  it('stops before an escape that is only half there', () => {
    expect(partialString('{"message":"Tab\\', 'message')?.text).toBe('Tab');
    expect(partialString('{"message":"caf\\u00', 'message')?.text).toBe('caf');
  });

  it('finds the field after others, whatever they hold', () => {
    const json = '{"language":"es","extra":{"a":[1,"}",{"b":null}]},"n":2,"message":"Hola. ¿Qué';
    expect(partialString(json, 'message')).toEqual({ text: 'Hola. ¿Qué', whole: false });
  });

  it('is null before the field starts, or when it is not a string', () => {
    expect(partialString('', 'message')).toBeNull();
    expect(partialString('{"langu', 'message')).toBeNull();
    expect(partialString('{"language":"e', 'message')).toBeNull();
    expect(partialString('{"message":', 'message')).toBeNull();
    expect(partialString('{"message":12}', 'message')).toBeNull();
    expect(partialString('["message"]', 'message')).toBeNull();
  });
});

describe('saying it early', () => {
  it('says each sentence as soon as it is finished, and the last one when the message is whole', () => {
    const { early, said, checked } = speech();
    const message = 'We’re open Monday through Friday. Eight to five! Anything else?';
    const events = written('c1', 'reply', { message });
    // Nothing is said until a sentence is done.
    early.onToolInput(events[0]!, 1);
    early.onToolInput(events[3]!, 1);
    expect(said).toEqual([]);
    for (const e of events) early.onToolInput(e, 1);
    expect(said).toEqual([
      { sentence: 'We’re open Monday through Friday.', ending: false },
      { sentence: 'Eight to five!', ending: false },
      { sentence: 'Anything else?', ending: false },
    ]);
    // Everything said so far is what's checked, not just the new sentence.
    expect(checked).toEqual([
      'We’re open Monday through Friday.',
      'We’re open Monday through Friday. Eight to five!',
      message,
    ]);
    expect(early.said).toBe(message);
  });

  it('says a one-sentence answer as soon as its message ends, before the rest of the call is written', () => {
    const { early, said } = speech();
    const events = written('c1', 'reply', { message: 'We’re open eight to five.', language: 'en' });
    const closed = events.findIndex((e) => partialString(e.json, 'message')?.whole);
    for (const e of events.slice(0, closed + 1)) early.onToolInput(e, 1);
    expect(events[closed]!.done).toBe(false);
    expect(said).toEqual([{ sentence: 'We’re open eight to five.', ending: false }]);
    // The rest of the call says nothing more.
    for (const e of events.slice(closed + 1)) early.onToolInput(e, 1);
    expect(said).toHaveLength(1);
  });

  it('says a goodbye as the ending', () => {
    const { early, said } = speech();
    for (const e of written('c1', 'end_call', { message: 'Thanks for calling. Bye now!' }))
      early.onToolInput(e, 1);
    expect(said.every((s) => s.ending)).toBe(true);
    expect(said.map((s) => s.sentence)).toEqual(['Thanks for calling.', 'Bye now!']);
  });

  it('stops at the first sentence that fails the check, and keeps what it said', () => {
    const { early, said } = speech({ passes: (words) => !words.includes('example.com') });
    const message = 'Sure thing. Our site is example.com today. Call anytime.';
    for (const e of written('c1', 'reply', { message })) early.onToolInput(e, 1);
    expect(said.map((s) => s.sentence)).toEqual(['Sure thing.']);
    expect(early.said).toBe('Sure thing.');
  });

  it('waits when a tool comes before the reply in the same answer', () => {
    const { early, said } = speech();
    for (const e of written('c1', 'book', { startsAt: '2026-10-01T10:00' }))
      early.onToolInput(e, 1);
    for (const e of written('c2', 'reply', { message: 'You’re booked. See you then.' }))
      early.onToolInput(e, 1);
    expect(said).toEqual([]);
    // The next answer's reply is its first call, so it's said.
    for (const e of written('c3', 'reply', { message: 'All set. Bye.' })) early.onToolInput(e, 2);
    expect(said.map((s) => s.sentence)).toEqual(['All set.', 'Bye.']);
  });

  it('says nothing early on a turn that holds a change or asks for money', () => {
    const { early, said } = speech({ mayStart: () => false });
    for (const e of written('c1', 'reply', { message: 'Done. You’re booked.' }))
      early.onToolInput(e, 1);
    expect(said).toEqual([]);
    expect(early.said).toBe('');
  });

  it('says one reply per turn at most', () => {
    const { early, said } = speech();
    for (const e of written('c1', 'reply', { message: 'First try. Here.' }))
      early.onToolInput(e, 1);
    for (const e of written('c2', 'reply', { message: 'Second try.' })) early.onToolInput(e, 2);
    expect(said.map((s) => s.sentence)).toEqual(['First try.', 'Here.']);
  });

  it('streams only the reply and goodbye tools as they are written', () => {
    const def = { name: 'reply', description: '', inputSchema: {} };
    expect(streamSpoken(def).streamInput).toBe(true);
    expect(streamSpoken({ ...def, name: 'end_call' }).streamInput).toBe(true);
    expect(streamSpoken({ ...def, name: 'book' }).streamInput).toBeUndefined();
  });
});
