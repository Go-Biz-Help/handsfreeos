/**
 * Social Outreach's first message is the playbook's own (docs/outreach.md, decisions 152 and 164): the words under
 * What it says, kept close to and fitted to each person, with their first name, their kind of business and what the
 * offer is put in for the words in brackets. Today's drafts, the one text to someone's Requests on Instagram, and
 * Your messages' samples are all written from them, and so are Reconnect (a catch-up, then the first message's
 * question) and the ask after a yes. A playbook that never changed them follows the starting words: the owner's own.
 */
import { describe, expect, it } from 'vitest';
import {
  DEMO_ASK_EXAMPLE,
  FIRST_MESSAGE_EXAMPLE,
  RECONNECT_QUESTION_EXAMPLE,
  messageRewritePrompt,
  messageSamplesPrompt,
  type SamplesFacts,
} from '../../src/addons/outreach/conversation';
import {
  CRM_FIRST_MESSAGE,
  PLAYBOOK_SUGGESTIONS,
  PLAYBOOK_TEMPLATES,
} from '../../src/addons/outreach/playbooks';
import {
  asMessage,
  FILL_BLANKS,
  playbookSays,
  scriptOf,
  STARTING_FIRST_MESSAGE,
  startingScript,
} from '../../src/addons/outreach/script';
import {
  firstStepFact,
  RECONNECT_CATCH_UP,
  requestsTask,
  todayDraftPrompt,
} from '../../src/addons/outreach/today';
import { VOICE_DEFAULTS } from '../../src/addons/outreach/voice';
import { firstMessagePreview } from '../../src/main-offer/words';

const crm = { name: 'CRM demos', ...PLAYBOOK_TEMPLATES.crm_demos.details };
const says = scriptOf(crm);
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
  it('starts as the owner’s question on how they can help, with blanks for their name, kind of business and the offer', () => {
    // The owner's own words (decision 152), as every playbook starts and as the CRM one has them.
    expect(STARTING_FIRST_MESSAGE).toBe(
      'Hey [first name], if I could get you [what your offer gets them] for your [their kind of business] business using [what your offer is], would you be interested?',
    );
    expect(CRM_FIRST_MESSAGE).toBe(
      'Hey [first name], if I could get you more deals while also saving you time for your [their kind of business] business using my easy to use CRM software, would you be interested?',
    );
    expect(says.first).toEqual([CRM_FIRST_MESSAGE]);
    expect(FIRST_MESSAGE_EXAMPLE).toBe(
      'Hey Sam, if I could get you more deals while also saving you time for your roofing business using my easy to use CRM software, would you be interested?',
    );
    for (const t of Object.values(PLAYBOOK_TEMPLATES)) {
      for (const first of scriptOf(t.details).first) expect(first).toMatch(/^Hey \[first name\], /);
    }
    for (const first of PLAYBOOK_SUGGESTIONS.firsts) expect(first).toMatch(/\[first name\]/);
  });

  it('is written from the playbook’s words: kept close to, fitted to the person, nothing added', () => {
    const prompt = opener();
    expect(prompt).toContain(
      'They and the owner haven’t talked yet, so this is the owner’s first message to them.',
    );
    expect(prompt).toContain(asMessage('the first message', CRM_FIRST_MESSAGE, true));
    expect(prompt).toContain(playbookSays(CRM_FIRST_MESSAGE));
    expect(prompt).toMatch(/Keep close to those words, fitted to this person/);
    expect(prompt).toMatch(/so no two people get the very same text/);
    expect(prompt).toMatch(/Add nothing of your own before or after it/);
    // The words in brackets are filled in for each person, never guessed from the playbook.
    expect(prompt).toContain(FILL_BLANKS);
    expect(prompt).toMatch(/\[their kind of business\] is the kind of business they run/);
    expect(prompt).toMatch(/say “your business”/);
    expect(prompt).toMatch(/leave the name out and keep the greeting \(“Hey,”\)/);
    expect(prompt).toMatch(/never by its brand name/);
    expect(prompt).toMatch(
      /Never say how the offer works or the price in it, never promise more info/,
    );
    // The old ways are gone: no compliment line, no style, no questions from the old conversation.
    expect(prompt).not.toMatch(
      /Word the question in this style|genuinely liked|line about them first/,
    );
    expect(prompt).not.toMatch(/Conversation:|Questions it may ask:/);
    expect(prompt).not.toMatch(/how business is going\?/);
  });

  it('follows the playbook when its words change, and takes the version whose turn it is', () => {
    const own =
      'Hey [first name], quick one: are you taking on new [their kind of business] jobs right now?';
    const changed = opener({ playbook: { ...crm, script: { first: [own, 'Second version?'] } } });
    expect(changed).toContain(playbookSays(own));
    expect(changed).not.toContain(playbookSays(CRM_FIRST_MESSAGE));
    // The draft's opener is the version picked (`nextOpener`): that one is written.
    const second = opener({
      playbook: { ...crm, script: { first: [own, 'Second version?'] } },
      opener: { kind: 'own', text: 'Second version?' },
    });
    expect(second).toContain(playbookSays('Second version?'));
    expect(second).not.toContain(playbookSays(own));
    // With no blanks in it, nothing is said about filling any.
    expect(second).not.toContain(FILL_BLANKS);
    // A playbook with none of its own follows the starting words.
    const { script: _s, ...plain } = crm;
    expect(opener({ playbook: plain })).toContain(playbookSays(STARTING_FIRST_MESSAGE));
  });

  it('is asked without the check’s first step, which is for Reconnect’s catch-up only', () => {
    expect(firstStepFact('opener', 'Ask how the new shop is going')).toBeNull();
    expect(firstStepFact('follow_up', 'Ask how business is going')).toBeNull();
    expect(firstStepFact('check_in', 'Ask how business is going')).toBeNull();
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
    expect(reply).not.toContain(playbookSays(CRM_FIRST_MESSAGE));
  });

  it('is the same words to someone’s Requests on Instagram, and once they follow back', () => {
    const task = requestsTask(CRM_FIRST_MESSAGE);
    expect(task).toContain(asMessage('the first message', CRM_FIRST_MESSAGE, true));
    expect(task).toMatch(
      /no link, no video and no web address, whatever the playbook’s words have/,
    );
    expect(opener({ platform: 'instagram', requests: true })).toContain(task);
    const back = opener({ platform: 'instagram' });
    expect(back).toContain(
      'They and the owner haven’t talked yet, so this is the owner’s first message to them.',
    );
    expect(back).toContain(playbookSays(CRM_FIRST_MESSAGE));
    expect(opener({ platform: 'linkedin' })).toContain(playbookSays(CRM_FIRST_MESSAGE));
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

  it('catches up first, then asks the first message’s question right after (decisions 152 and 164)', () => {
    expect(RECONNECT_QUESTION_EXAMPLE).toMatch(/^I was wondering if I could get you more deals/);
    // The starting words say so, and the draft is told them with the playbook's first message.
    expect(says.reconnect).toMatch(/^A short, warm catch-up first: greet them by first name/);
    expect(says.reconnect).toMatch(/Ask nothing in it\./);
    expect(says.reconnect).toMatch(/starting “I was wondering if I could”/);
    const prompt = reconnect();
    expect(prompt).toContain(playbookSays(says.reconnect));
    expect(prompt).toContain(
      `The first message it speaks of is the playbook’s: ${playbookSays(CRM_FIRST_MESSAGE)}`,
    );
    expect(prompt).toMatch(/Ask one question at most: the first message’s, after the catch-up/);
    // It's told the offer now, for its question.
    expect(prompt).toMatch(/<offer>/);
    expect(prompt).toMatch(/The outcome, in a few words: more deals/);
    expect(prompt).not.toMatch(/Don’t pitch yet/);
    // The playbook's own way wins when it has one.
    const own = reconnect({
      playbook: { ...crm, script: { reconnect: 'Say “Long time!” and ask what they’re up to.' } },
    });
    expect(own).toContain(playbookSays('Say “Long time!” and ask what they’re up to.'));
    expect(own).not.toContain(playbookSays(says.reconnect));
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

  it('only catches up with someone who turned the offer down, whatever the playbook says', () => {
    const prompt = reconnect({ declined: { why: 'Said they already have a CRM' } });
    expect(prompt).toContain(RECONNECT_CATCH_UP);
    expect(prompt).not.toContain(playbookSays(CRM_FIRST_MESSAGE));
    expect(prompt).not.toContain(playbookSays(says.reconnect));
    expect(prompt).toMatch(/Respect it: nothing that pitches/);
    expect(prompt).not.toMatch(/Link:/);
    expect(prompt).toMatch(/1 to 3 short texts/);
  });
});

describe('the ask after a yes (decisions 153 and 164)', () => {
  const pitch = (playbook: Parameters<typeof todayDraftPrompt>[0]['playbook']) =>
    todayDraftPrompt({
      kind: 'pitch',
      business: 'Bright Books',
      name: 'Dana Reyes',
      facts: [],
      recent: [{ fromMe: false, text: 'Sure, sounds interesting', at: new Date().toISOString() }],
      playbook,
    });

  it('asks for a time to demo it, in the playbook’s words, with the link to book', () => {
    expect(DEMO_ASK_EXAMPLE).toBe(
      'Let’s schedule a time where I can demo it for you so you can see what it’s about. If you don’t like it, no pressure. How’s that sound?',
    );
    // The starting words are the owner's, with blanks for the open times and the link.
    expect(startingScript('demo').yes).toBe(
      'Let’s schedule a time where I can demo it for you so you can see what it’s about. If you don’t like it, no pressure. I have [open times], how’s that sound? Or grab any time that works for you here: [booking link]',
    );
    expect(startingScript('estimate').yes).toMatch(/^Let’s schedule a time for a free estimate/);
    const prompt = pitch({ ...crm, link: 'https://brightbooks.com/book/demo' });
    expect(prompt).toContain(asMessage('the ask', says.yes));
    expect(prompt).toMatch(/Never a plan, numbers or results they’ll get from it/);
    expect(prompt).toMatch(/\[open times\] are the times under <times>/);
    expect(prompt).toMatch(
      /with none given, leave out the words that offer them and keep the rest/,
    );
    expect(prompt).toContain(
      'Put this link in every draft, exactly as written: https://brightbooks.com/book/demo',
    );
  });

  it('is the playbook’s own once the business writes it', () => {
    const own = 'Awesome! Want to hop on a quick 15 minute call this week? [booking link]';
    const prompt = pitch({ ...crm, script: { yes: own } });
    expect(prompt).toContain(asMessage('the ask', own));
    expect(prompt).not.toContain(playbookSays(says.yes));
  });
});

describe('Your messages’ samples', () => {
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
      script: says,
    },
    offer: { line: null, outcome: 'more booked calls' },
    followUps: 6,
    voice: 'No emoji.',
  };

  it('are written, and written again, from the playbook’s words', () => {
    const all = messageSamplesPrompt(facts);
    // One sample for each version of the first message.
    expect(all).toContain('- first: 1 first message, sent once they accept the friend request.');
    expect(all).toContain(asMessage('the first message', CRM_FIRST_MESSAGE, true));
    expect(all).toMatch(
      /\[their kind of business\] the kind of business the playbook’s niche runs/,
    );
    expect(all).not.toMatch(/will send more info/);
    expect(all).toContain(playbookSays(says.followUp));
    expect(all).toContain(playbookSays(says.checkIn));
    const three = messageSamplesPrompt({
      ...facts,
      playbook: { ...facts.playbook, script: { ...says, first: ['One?', 'Two?', 'Three?'] } },
    });
    expect(three).toMatch(/- first: 3 first messages/);
    for (const v of ['One?', 'Two?', 'Three?']) expect(three).toContain(playbookSays(v));
    const again = messageRewritePrompt({
      ...facts,
      slot: { part: 'first', index: 0 },
      before: 'Hi Sam! Open to more booked calls?',
      others: [],
    });
    expect(again).toContain(asMessage('the first message', CRM_FIRST_MESSAGE, true));
    // The message after a yes is the playbook's ask too (decision 153).
    expect(all).toContain(
      `- link: the message after they say yes, with [booking link]. ${asMessage('the ask', says.yes)}`,
    );
    expect(
      messageRewritePrompt({
        ...facts,
        slot: { part: 'link', index: 0 },
        before: 'Book here',
        others: [],
      }),
    ).toContain(asMessage('the ask', says.yes));
  });
});
