/**
 * Social Outreach: how the AI writes for the person (docs/outreach.md, "How the AI writes"). Plain words and no long
 * dashes always; their own short forms, acronyms and emoji; a greeting when the chat's been quiet a few days or more;
 * and a message as a few short texts, a few seconds apart, when they text that way.
 */
import { describe, expect, it } from 'vitest';
import { checkedDrafts, todayDraftPrompt } from '../../src/addons/outreach/today';
import {
  gapLine,
  gapWords,
  messageParts,
  noDashes,
  partPauseMs,
  VOICE_DEFAULTS,
  voiceLines,
  voiceSample,
} from '../../src/addons/outreach/voice';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-11T15:00:00Z');
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

describe('no long dashes', () => {
  it('turns a long dash into a comma, and one between numbers into a hyphen', () => {
    expect(noDashes('Hey Sam — quick question')).toBe('Hey Sam, quick question');
    expect(noDashes('Great—thanks!')).toBe('Great, thanks!');
    expect(noDashes('We’re open 9–5 — come by')).toBe('We’re open 9-5, come by');
    expect(noDashes('See you soon —')).toBe('See you soon');
    expect(noDashes('— Sam')).toBe('Sam');
    expect(noDashes('Nothing to change, here.')).toBe('Nothing to change, here.');
  });

  it('cleans every draft the AI writes', () => {
    expect(checkedDrafts({ drafts: ['Hi Sam — how’s it going?'], simple: false }, [])).toEqual([
      'Hi Sam, how’s it going?',
    ]);
  });
});

describe('a message as a few texts', () => {
  it('splits at blank lines when the person texts that way, else goes as one', () => {
    expect(messageParts('Hey Sam!\n\nHow’s the shop?', true)).toEqual([
      'Hey Sam!',
      'How’s the shop?',
    ]);
    expect(messageParts('Hey Sam!\n\nHow’s the shop?', false)).toEqual([
      'Hey Sam!\n\nHow’s the shop?',
    ]);
    expect(messageParts('  ', true)).toEqual([]);
  });

  it('goes as 3 texts at most, the rest joined to the last', () => {
    expect(messageParts('a\n\nb\n\nc\n\nd', true)).toEqual(['a', 'b', 'c\n\nd']);
  });

  it('keeps the AI’s texts apart only when the person sends a few', () => {
    const answer = { drafts: ['Hey Sam!\n\n\nHow’s it going?'], simple: false };
    expect(checkedDrafts(answer, [], 3, true)).toEqual(['Hey Sam!\n\nHow’s it going?']);
    expect(checkedDrafts(answer, [], 3, false)).toEqual(['Hey Sam!\nHow’s it going?']);
  });

  it('waits a few seconds before the next text, longer for a longer one', () => {
    const short = partPauseMs('Hi!', 0.5);
    const long = partPauseMs('x'.repeat(120), 0.5);
    expect(short).toBeGreaterThanOrEqual(1_700);
    expect(long).toBeGreaterThan(short);
    expect(long).toBeLessThanOrEqual(9_200);
  });
});

describe('the gap since the last message', () => {
  it('says how long, once it’s a few days or more', () => {
    expect(gapWords(ago(1), NOW)).toBeNull();
    expect(gapWords(ago(4), NOW)).toBe('4 days');
    expect(gapWords(ago(9), NOW)).toBe('about a week');
    expect(gapWords(ago(21), NOW)).toBe('3 weeks');
    expect(gapWords(ago(100), NOW)).toBe('3 months');
    expect(gapWords(ago(400), NOW)).toBe('over a year');
    expect(gapWords(null, NOW)).toBeNull();
  });

  it('asks for a greeting that fits, as its own text when they send a few', () => {
    const line = gapLine(ago(21), NOW, { split: true, theyWroteLast: true })!;
    expect(line).toMatch(/3 weeks ago/);
    expect(line).toMatch(/greeting/);
    expect(line).toMatch(/slow reply/);
    expect(line).toMatch(/its own text/);
    expect(gapLine(ago(1), NOW, { split: true, theyWroteLast: false })).toBeNull();
  });

  it('tells a message the gap, and never a comment', () => {
    const base = {
      business: 'Lane Roofing',
      name: 'Sam Carter',
      facts: [],
      recent: [{ fromMe: false, text: 'Thanks, talk soon', at: ago(30) }],
      playbook: null,
      now: NOW,
    };
    expect(todayDraftPrompt({ ...base, kind: 'follow_up' })).toMatch(/4 weeks ago/);
    expect(
      todayDraftPrompt({ ...base, kind: 'comment', post: { text: 'Anyone?', group: null } }),
    ).not.toMatch(/ago\./);
  });
});

describe('the person’s own voice', () => {
  it('says what they picked, and plain words always', () => {
    const plain = voiceLines(VOICE_DEFAULTS, true);
    expect(plain).toMatch(/Spell words out/);
    expect(plain).toMatch(/No text acronyms/);
    expect(plain).toMatch(/No emoji/);
    expect(plain).toMatch(/short texts/);
    const theirs = voiceLines({ shorthand: true, acronyms: true, emoji: true, split: false }, true);
    expect(theirs).toMatch(/u, ur, thx/);
    expect(theirs).toMatch(/lol/);
    expect(theirs).toMatch(/An emoji fits/);
    expect(theirs).toMatch(/one message/);
    // A comment is one, in public.
    expect(voiceLines(VOICE_DEFAULTS, false)).toMatch(/one message/);
  });

  it('puts the voice in the draft’s prompt', () => {
    const prompt = todayDraftPrompt({
      kind: 'reply',
      business: 'Lane Roofing',
      name: 'Sam Carter',
      facts: [],
      recent: [],
      playbook: null,
      voice: { shorthand: true, acronyms: false, emoji: false, split: true },
    });
    expect(prompt).toMatch(/u, ur, thx/);
    expect(prompt).toMatch(/blank line between texts/);
  });

  it('shows how a message reads in it', () => {
    expect(voiceSample(VOICE_DEFAULTS)).toHaveLength(2);
    const [one] = voiceSample({ shorthand: true, acronyms: true, emoji: true, split: false });
    expect(one).toMatch(/lol 😊 How r u/);
  });
});
