/**
 * Social Outreach's first message is one short question that says how the owner can help them (docs/outreach.md,
 * decisions 137 and 152): the owner's words, with their first name, their kind of business and what the offer is put
 * in. Today's drafts, the one text to someone's Requests on Instagram, and Your messages' first samples all ask for it,
 * as one text, and a playbook's AI style only words the question. Reconnect asks it too, right after a catch-up.
 */
import { describe, expect, it } from 'vitest';
import {
  DEMO_ASK_EXAMPLE,
  DEMO_ASK_SHAPE,
  FIRST_MESSAGE_EXAMPLE,
  FIRST_MESSAGE_SHAPE,
  FIRST_MESSAGE_WORDS,
  RECONNECT_QUESTION_EXAMPLE,
  RECONNECT_QUESTION_SHAPE,
  messageRewritePrompt,
  messageSamplesPrompt,
  type SamplesFacts,
} from '../../src/addons/outreach/conversation';
import { PLAYBOOK_SUGGESTIONS, PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import {
  firstStepFact,
  RECONNECT_CATCH_UP,
  REQUESTS_TASK,
  todayDraftPrompt,
} from '../../src/addons/outreach/today';
import { VOICE_DEFAULTS } from '../../src/addons/outreach/voice';
import { firstMessagePreview } from '../../src/main-offer/words';

const crm = { name: 'CRM demos', ...PLAYBOOK_TEMPLATES.crm_demos.details };
const opener = (more: Partial<Parameters<typeof todayDraftPrompt>[0]> = {}) =>
  todayDraftPrompt({
    kind: 'opener',
    business: 'Bright Books',
    name: 'Dana Reyes',
    facts: ['Owner at Reyes Roofing', 'Roofing and gutters in Tulsa'],
    recent: [],
    playbook: crm,
    ...more,
  });

describe('a first message', () => {
  it('is the owner’s question on how they can help, with their name, kind of business and the offer put in', () => {
    expect(FIRST_MESSAGE_EXAMPLE.split(/\s+/).length).toBeLessThan(FIRST_MESSAGE_WORDS);
    // The owner's own words (decision 152).
    expect(FIRST_MESSAGE_EXAMPLE).toMatch(
      /^Hey Sam, if I could get you more deals while also saving you time for your roofing business using my easy to use CRM software, would you be interested\?$/,
    );
    const prompt = opener();
    expect(prompt).toContain(FIRST_MESSAGE_SHAPE);
    expect(prompt).toContain(FIRST_MESSAGE_EXAMPLE);
    expect(prompt).toMatch(/name its kind from the facts or their pages/);
    expect(prompt).toMatch(/say “your business”/);
    // "Hey" and their first name (3b), or just "Hey," when their name isn't a person's.
    expect(prompt).toMatch(/“Hey” and their first name/);
    expect(prompt).toMatch(/start with just “Hey,”/);
    // What it is, in a few plain words (2a), never its brand name, how it works, a link or the price.
    expect(prompt).toMatch(/Name what it is the way the offer does, in a few plain words/);
    expect(prompt).toMatch(/never by its brand name/);
    expect(prompt).toMatch(
      /Never say how it works, a link or the price, and never promise more info/,
    );
    expect(prompt).toMatch(/Put nothing else before or after the question: no line about them/);
    // Only what the offer really does: SEO brings customers, credit repair is for people, not a business.
    expect(prompt).toMatch(/say only what the offer really does and what it really is/);
    expect(prompt).toMatch(/help raise your credit score/);
    expect(prompt).toMatch(/leave out “for your … business”/);
    expect(prompt).not.toMatch(/for your home/);
    // Decision 137's mystery and decision 65's ask are gone.
    expect(prompt).not.toMatch(/Never say what the thing is|makes them curious|no greeting/);
    expect(prompt).not.toMatch(/will send more info|open to the offer’s outcome|just say hi/);
  });

  it('is asked without the check’s first step, which is for Reconnect’s catch-up and the rest', () => {
    expect(firstStepFact('opener', 'Ask how the new shop is going')).toBeNull();
    expect(firstStepFact('reconnect', 'Ask how the new shop is going')).toBe(
      'A good first step: Ask how the new shop is going',
    );
    expect(firstStepFact('reconnect', null)).toBeNull();
  });

  it('goes as one text, whatever the voice says about splitting', () => {
    expect(VOICE_DEFAULTS.split).toBe(true);
    expect(opener({ voice: VOICE_DEFAULTS })).toContain(
      'Write it as one message, with no blank lines.',
    );
    // A reply still goes as texts.
    const reply = todayDraftPrompt({
      kind: 'reply',
      business: 'Bright Books',
      name: 'Dana Reyes',
      facts: [],
      recent: [{ fromMe: false, text: 'What is it?', at: new Date().toISOString() }],
      playbook: crm,
      voice: VOICE_DEFAULTS,
    });
    expect(reply).toMatch(/blank line between texts/);
    expect(reply).not.toContain(FIRST_MESSAGE_SHAPE);
  });

  it('is the same question to someone’s Requests on Instagram, and once they follow back', () => {
    expect(REQUESTS_TASK).toContain(FIRST_MESSAGE_SHAPE);
    expect(opener({ platform: 'instagram', requests: true })).toContain(REQUESTS_TASK);
    const back = opener({ platform: 'instagram' });
    expect(back).toContain(
      'They and the owner haven’t talked yet, so this is the owner’s first message to them.',
    );
    expect(back).toContain(FIRST_MESSAGE_SHAPE);
    expect(opener({ platform: 'linkedin' })).toContain(FIRST_MESSAGE_SHAPE);
  });

  it('takes a playbook’s style only for how the question is worded', () => {
    const style = 'Say it could stop leads slipping through the cracks.';
    const prompt = opener({ opener: { kind: 'style', text: style } });
    expect(prompt).toContain(
      `Word the question in this style, as far as it fits one short question with nothing added: ${style}`,
    );
    expect(prompt).not.toMatch(/Write the line about them/);
  });

  it('is what the ready-made playbooks’ styles and the suggestions word', () => {
    const styles = [
      ...Object.values(PLAYBOOK_TEMPLATES).flatMap((t) => t.details.openerStyles),
      ...PLAYBOOK_SUGGESTIONS.openerStyles,
    ];
    expect(styles.length).toBeGreaterThan(0);
    for (const s of styles) expect(s).toMatch(/^Say it could /);
    expect(PLAYBOOK_TEMPLATES.crm_demos.details.openerStyles[0]).toBe(
      'Say it could get them more deals while saving them time.',
    );
  });

  it('reads the same way in the main offer builder’s preview', () => {
    expect(firstMessagePreview('10 booked inspections')).toBe(
      'Hey Sam, if I could get you 10 booked inspections for your business, would you be interested?',
    );
  });
});

describe('Reconnect', () => {
  const reconnect = (more: Partial<Parameters<typeof todayDraftPrompt>[0]> = {}) =>
    todayDraftPrompt({
      kind: 'reconnect',
      business: 'Bright Books',
      name: 'Dana Reyes',
      facts: ['Owner at Reyes Roofing', 'A good first step: Ask how the new truck is working out'],
      recent: [],
      playbook: crm,
      offer: {
        version: 1,
        line: 'We help roofers get more deals using our easy to use CRM software.',
        outcome: 'more deals',
        guarantee: null,
        method: [],
        proof: [],
        price: '$97 a month',
      },
      ...more,
    });

  it('catches up first, then asks the first message’s question right after (decision 152)', () => {
    expect(RECONNECT_QUESTION_EXAMPLE.split(/\s+/).length).toBeLessThan(FIRST_MESSAGE_WORDS);
    expect(RECONNECT_QUESTION_EXAMPLE).toMatch(/^I was wondering if I could get you more deals/);
    const prompt = reconnect();
    expect(prompt).toMatch(
      /Write a short, warm catch-up, then right after it why the owner is writing/,
    );
    expect(prompt).toMatch(/greets them by first name, says it’s been a while/);
    // Its catch-up asks nothing, so the question is its only one, as every draft asks at most one.
    expect(prompt).toMatch(/with no question of its own, so the only question is the one after it/);
    expect(prompt).toContain(RECONNECT_QUESTION_SHAPE);
    expect(prompt).toMatch(/name its kind from the facts or their pages/);
    // It's told the offer now, for its question.
    expect(prompt).toMatch(/<offer>/);
    expect(prompt).toMatch(/The outcome, in a few words: more deals/);
    expect(prompt).not.toMatch(/Don’t pitch yet/);
  });

  it('is for someone the owner has talked with, and a first message for someone never talked to (decision 155)', () => {
    expect(reconnect()).toContain(
      'They’ve chatted with the owner before, but neither has written in over a month.',
    );
    expect(RECONNECT_CATCH_UP).toMatch(/^They’ve chatted with the owner before/);
    for (const platform of ['facebook', 'linkedin', 'instagram'] as const) {
      const first = todayDraftPrompt({
        kind: 'opener',
        business: 'Bright Books',
        name: 'Dana Reyes',
        facts: [],
        recent: [],
        playbook: crm,
        platform,
      });
      expect(first).toContain(
        'They and the owner haven’t talked yet, so this is the owner’s first message to them.',
      );
      expect(first).not.toMatch(/just accepted|it’s been a while/);
    }
  });

  it('goes as two texts when the person sends a few, else as one message', () => {
    const split = reconnect({ voice: VOICE_DEFAULTS, lastAt: '2026-08-01T00:00:00.000Z' });
    expect(split).toContain('Write it as two short texts, with a blank line between them.');
    // The greeting is the catch-up's, never a text of its own ahead of it.
    expect(split).toMatch(/open with a short, natural greeting/);
    expect(split).not.toMatch(/Make the greeting its own text, first/);
    const whole = reconnect({ voice: { ...VOICE_DEFAULTS, split: false } });
    expect(whole).toContain('Write it as one message, with no blank lines.');
  });

  it('only catches up with someone who turned the offer down', () => {
    const prompt = reconnect({ declined: { why: 'Said they already have a CRM' } });
    expect(prompt).toContain(RECONNECT_CATCH_UP);
    expect(prompt).not.toContain(RECONNECT_QUESTION_SHAPE);
    expect(prompt).toMatch(/Respect it: nothing that pitches/);
    expect(prompt).not.toMatch(/Link:/);
    expect(prompt).toMatch(/1 to 3 short texts/);
  });
});

describe('Send the link (decision 153)', () => {
  it('asks for a time to demo it, in the owner’s words, with the link to book', () => {
    expect(DEMO_ASK_EXAMPLE).toBe(
      'Let’s schedule a time where I can demo it for you so you can see what it’s about. If you don’t like it, no pressure. How’s that sound?',
    );
    const prompt = todayDraftPrompt({
      kind: 'pitch',
      business: 'Bright Books',
      name: 'Dana Reyes',
      facts: [],
      recent: [{ fromMe: false, text: 'Sure, sounds interesting', at: new Date().toISOString() }],
      playbook: { ...crm, link: 'https://brightbooks.com/book/demo' },
    });
    expect(prompt).toContain(DEMO_ASK_SHAPE);
    expect(prompt).toMatch(/“demo it for you” when the offer is something that can be shown/);
    expect(prompt).toMatch(/Never a plan, numbers or results they’ll get from the call/);
    expect(prompt).toContain(
      'Put this link in every draft, exactly as written: https://brightbooks.com/book/demo',
    );
    expect(prompt).not.toMatch(/a plan for their business, with their numbers\. No pressure/);
  });
});

describe('Your messages’ first samples', () => {
  const facts: SamplesFacts = {
    business: 'Pine Roof Leads',
    playbook: {
      name: 'CRM demos',
      niche: 'Roofers with 2 to 3 crews',
      problem: null,
      tone: null,
      samples: [],
      avoid: [],
      disclaimer: null,
      usefulWhat: null,
      hasVideo: false,
    },
    offer: { line: null, outcome: 'more booked calls' },
    followUps: 6,
    voice: 'No emoji.',
  };

  it('are written, and written again, in the same shape for the niche’s kind of business', () => {
    const all = messageSamplesPrompt(facts);
    expect(all).toContain(`- first: 2 different first messages`);
    expect(all).toContain(FIRST_MESSAGE_SHAPE);
    expect(all).toMatch(/kind of business the playbook’s niche runs/);
    expect(all).not.toMatch(/will send more info/);
    const again = messageRewritePrompt({
      ...facts,
      slot: { part: 'first', index: 0 },
      before: 'Hi Sam! Open to more booked calls?',
      others: [],
    });
    expect(again).toContain(FIRST_MESSAGE_SHAPE);
    // The link sample asks for the demo the owner's way too (decision 153).
    expect(all).toContain(
      `- link: the message when they want a call, with [booking link]: it ${DEMO_ASK_SHAPE}`,
    );
    expect(
      messageRewritePrompt({
        ...facts,
        slot: { part: 'link', index: 0 },
        before: 'Book here',
        others: [],
      }),
    ).toContain(DEMO_ASK_SHAPE);
  });
});
