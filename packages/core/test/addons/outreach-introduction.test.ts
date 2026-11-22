/**
 * Social Outreach: a playbook that starts with an introduction in place of the pitch (docs/outreach.md, decision 168),
 * without the database. The first message is the playbook's introduction, which ends with a question about them
 * (decision 173), as a text of its own right after it when the person sends a few (decision 175); one nudge follows
 * it, then the monthly check-in; a yes still gets the ask for a time; and the AI is told who the owner is so it can say
 * so.
 */
import { describe, expect, it } from 'vitest';
import {
  CHECK_IN_DAYS,
  checkInsOnly,
  introSent,
  stepAfterYes,
} from '../../src/addons/outreach/conversation';
import { OPENER_KINDS, openersOf } from '../../src/addons/outreach/openers';
import {
  TEST_START,
  testAnswered,
  testLabel,
  testMove,
  testNext,
} from '../../src/addons/outreach/playbook-test';
import {
  blankPlaybook,
  paceOf,
  PLAYBOOK_GOAL_KEYS,
  PLAYBOOK_KEPT_KEYS,
  PLAYBOOK_TEMPLATES,
  PlaybookDetails,
} from '../../src/addons/outreach/playbooks';
import {
  FILL_BLANKS,
  firstMessagesOf,
  waysOf,
  OPEN_WAYS,
  PLAYBOOK_OPENS,
  PLAYBOOK_OPENS_KEYS,
  playbookSays,
  SCRIPT_BLANKS,
  SCRIPT_INFO,
  STARTING_FIRST_MESSAGE,
  STARTING_INTRO,
  scriptOf,
  startingScript,
} from '../../src/addons/outreach/script';
import { RULES_VERSION } from '../../src/addons/outreach/sends';
import {
  connectedLately,
  introTask,
  requestsTask,
  todayDraftPrompt,
} from '../../src/addons/outreach/today';
import { introTexts, VOICE_DEFAULTS } from '../../src/addons/outreach/voice';

const crm = { name: 'CRM demos', ...PLAYBOOK_TEMPLATES.crm_demos.details };
const intro = { ...crm, opens: 'intro' as const };
const pace = paceOf(blankPlaybook().pace);

describe('a playbook that starts with an introduction', () => {
  it('has the owner’s starting words, and a choice that keeps when a save leaves it out', () => {
    expect(STARTING_INTRO).toBe(
      'Hey [first name], thanks for connecting! [something you have in common] I’m [your first name] with [your business name]. [a question about them]',
    );
    for (const goal of PLAYBOOK_GOAL_KEYS) expect(startingScript(goal).intro).toBe(STARTING_INTRO);
    expect(SCRIPT_INFO.intro.label).toBe('Introduction');
    expect(SCRIPT_BLANKS.map((b) => b.blank)).toEqual(
      expect.arrayContaining(['[your first name]', '[your business name]']),
    );
    expect(FILL_BLANKS).toContain('[your first name]');
    expect(FILL_BLANKS).toContain('[your business name]');
    expect(PLAYBOOK_OPENS_KEYS).toEqual(['pitch', 'intro']);
    expect(PLAYBOOK_OPENS.intro.label).toBe('Introduction');
    // A new playbook pitches, as every playbook did before; one saved before the choice reads as a pitch too.
    expect(blankPlaybook().opens).toBe('pitch');
    expect(waysOf(crm)).toEqual(['pitch']);
    expect(waysOf(intro)).toEqual(['intro']);
    expect(waysOf(null)).toEqual(['pitch']);
    expect(PLAYBOOK_KEPT_KEYS).toContain('opens');
    expect(PlaybookDetails.parse({ ...intro, name: undefined }).opens).toBe('intro');
    expect(() => PlaybookDetails.parse({ ...crm, opens: 'hello' })).toThrow();
  });

  it('sends the introduction in place of the first message’s versions, and Results counts it apart', () => {
    expect(firstMessagesOf(crm)).toEqual(
      scriptOf(crm).first.map((text) => ({ way: 'pitch', text })),
    );
    expect(firstMessagesOf(intro)).toEqual([{ way: 'intro', text: STARTING_INTRO }]);
    const own = {
      ...intro,
      script: { intro: 'Hi [first name], thanks for the add! I’m [your first name].' },
    };
    expect(firstMessagesOf(own)).toEqual([
      { way: 'intro', text: 'Hi [first name], thanks for the add! I’m [your first name].' },
    ]);
    // Both ticked: the pitch's versions and the introduction, for the AI to pick between (decision 183).
    expect(firstMessagesOf({ ...crm, ways: ['pitch', 'intro'] }).map((f) => f.way)).toEqual([
      ...scriptOf(crm).first.map(() => 'pitch'),
      'intro',
    ]);
    expect(openersOf(intro)).toEqual([{ kind: 'intro', text: STARTING_INTRO }]);
    expect(openersOf(crm).every((o) => o.kind !== 'intro')).toBe(true);
    expect(OPENER_KINDS.intro).toBe('Introduction');
  });

  it('gets one nudge, then only check-ins, and a yes still gets the ask for a time', () => {
    expect(checkInsOnly('intro')).toBe(true);
    expect(checkInsOnly('first')).toBe(false);
    expect(introSent(pace)).toBe(pace.followUps - 1);
    expect(stepAfterYes('intro')).toBe('pitch');
  });
});

describe('the Test console with an introduction', () => {
  const person = { platform: 'facebook', known: 'new' } as const;

  it('starts with the introduction, then one nudge, then a check-in a month later', () => {
    const start = testMove('start', TEST_START, person, pace, true);
    expect(start).toMatchObject({
      kind: 'opener',
      state: { step: 'intro', sent: pace.followUps - 1, answer: null, stopped: false },
    });
    expect(testLabel('opener', { version: 0, versions: 1, way: 'intro' })).toBe('Introduction');
    expect(testLabel('opener', { way: 'compliment' })).toBe('First message: Compliment first');
    const gap = pace.followUpGaps.at(-1)!;
    expect(testNext(start.state, pace)).toBe(
      `If they stay quiet, one friendly nudge goes ${gap} day${gap === 1 ? '' : 's'} later, then a check-in once a month.`,
    );
    const nudge = testMove('quiet', start.state, person, pace, true);
    expect(nudge).toMatchObject({ kind: 'follow_up', gapDays: gap });
    expect(testLabel('follow_up', { step: 'intro', followUp: 6, followUps: 6 })).toBe('Nudge');
    expect(testMove('quiet', nudge.state, person, pace, true)).toMatchObject({
      kind: 'check_in',
      gapDays: CHECK_IN_DAYS,
    });
    // Someone talked to before still gets Reconnect.
    expect(testMove('start', TEST_START, { ...person, known: 'old' }, pace, true).kind).toBe(
      'reconnect',
    );
  });

  it('answers a question and waits for the check-in, and a yes moves on to the ask', () => {
    const start = testMove('start', TEST_START, person, pace, true).state;
    const asked = testAnswered(start, 'question', pace);
    expect(asked.state).toMatchObject({ step: 'intro', sent: pace.followUps, answer: 'question' });
    expect(testMove('quiet', asked.state, person, pace, true).kind).toBe('check_in');
    expect(testAnswered(start, 'yes', pace)).toEqual({
      kind: 'pitch',
      state: { step: 'link', sent: 0, answer: null, stopped: false, call: false },
    });
    // A yes to a networking call (decision 173) asks for a time for the call.
    const call = testAnswered(start, 'yes', pace, 'call');
    expect(call.state.call).toBe(true);
    expect(testLabel('pitch', { call: true })).toBe('They said yes to a call: your ask for a time');
  });
});

describe('what the AI is told for an introduction', () => {
  const base = {
    business: 'Bright Books',
    name: 'Dana Reyes',
    facts: ['Owner at Reyes Roofing'],
    playbook: intro,
  };

  it('writes the introduction, not the pitch, with the owner’s name to fill it', () => {
    const prompt = todayDraftPrompt({
      kind: 'opener',
      ...base,
      recent: [],
      ownerName: 'Chris Lee',
    });
    expect(prompt).toContain(playbookSays(STARTING_INTRO));
    expect(prompt).not.toContain(playbookSays(STARTING_FIRST_MESSAGE));
    expect(prompt).toContain('an introduction, not a pitch');
    // It ends with a question about them, from their page (decision 173).
    expect(prompt).toContain('[a question about them] is one short, friendly question about them');
    expect(prompt).toContain('They just connected with the owner');
    expect(prompt).toContain('<owner_name>Chris Lee</owner_name>');
    // The turn's opener is the introduction itself.
    const own = todayDraftPrompt({
      kind: 'opener',
      ...base,
      recent: [],
      opener: { kind: 'intro', text: 'Hi [first name], thanks for the add!' },
    });
    expect(own).toContain(playbookSays('Hi [first name], thanks for the add!'));
    expect(own).not.toMatch(/<owner_name>.*<\/owner_name>/);
    // A pitch playbook's first message is unchanged.
    const pitch = todayDraftPrompt({ kind: 'opener', ...base, playbook: crm, recent: [] });
    expect(pitch).not.toContain('an introduction, not a pitch');
    expect(pitch).not.toMatch(/<owner_name>.*<\/owner_name>/);
  });

  it('says hello in place of thanks to a friend of a while', () => {
    const later = todayDraftPrompt({ kind: 'opener', ...base, recent: [], fresh: false });
    expect(later).toContain('say a friendly hello');
    expect(introTask(STARTING_INTRO, true)).toContain('They just connected with the owner');
    const day = 86_400_000;
    const now = Date.now();
    expect(connectedLately(null, now)).toBe(true);
    expect(connectedLately(new Date(now - day), now)).toBe(true);
    expect(connectedLately(new Date(now - 400 * day).toISOString(), now)).toBe(false);
  });

  it('asks its question about them as a second text right after it, or last in one message (decision 175)', () => {
    const split = todayDraftPrompt({ kind: 'opener', ...base, recent: [] });
    expect(split).toContain('The question goes as its own text, right after the introduction');
    expect(split).toContain('Write it as two short texts, with a blank line between them.');
    expect(split).not.toContain('Write it as one message');
    // It always asks one, even when the playbook's own words don't.
    expect(introTask('Hi [first name], thanks for the add!', true)).toContain(
      'or, when they ask none, one about them from their page',
    );
    // Someone who sends each message as one text: one message, the question last.
    const one = todayDraftPrompt({
      kind: 'opener',
      ...base,
      recent: [],
      voice: { ...VOICE_DEFAULTS, split: false },
    });
    expect(one).toContain('It’s one message, with the question last.');
    expect(one).toContain('Write it as one message, with no blank lines.');
    expect(one).not.toContain('The question goes as its own text');
    // To their Requests on Instagram it's one text, and a pitch's first message is unchanged.
    const requests = todayDraftPrompt({ kind: 'opener', ...base, recent: [], requests: true });
    expect(requests).not.toContain('The question goes as its own text');
    const pitch = todayDraftPrompt({ kind: 'opener', ...base, playbook: crm, recent: [] });
    expect(pitch).not.toContain('The question goes as its own text');
    expect(pitch).toContain('Write it as one message, with no blank lines.');
  });

  it('moves a question the AI left in the introduction to a text of its own', () => {
    const intro =
      'Hey Marcea, thanks for connecting! I’m Chris. We help piercing shops get more bookings with our CRM.';
    expect(introTexts(`${intro} How did you get into piercing?`)).toBe(
      `${intro}\n\nHow did you get into piercing?`,
    );
    expect(introTexts(`${intro} Saw your post about the new studio, how’s that going?`)).toBe(
      `${intro}\n\nSaw your post about the new studio, how’s that going?`,
    );
    // Already two texts, kept; more than two keep the question alone.
    expect(introTexts(`${intro}\n\nHow did you get into piercing?`)).toBe(
      `${intro}\n\nHow did you get into piercing?`,
    );
    expect(introTexts('Hey Marcea!\n\nI’m Chris.\n\n  How did you   start?')).toBe(
      'Hey Marcea! I’m Chris.\n\nHow did you start?',
    );
    // Nothing to move: no question, a question alone, or one too short to be a sentence of its own.
    expect(introTexts(intro)).toBe(intro);
    expect(introTexts('How did you get into piercing?')).toBe('How did you get into piercing?');
    expect(introTexts('We’re in St. Louis?')).toBe('We’re in St. Louis?');
  });

  it('writes again the introductions already waiting, so they ask it too', () => {
    expect(RULES_VERSION).toBeGreaterThanOrEqual(4);
  });

  it('says one true thing they have in common right after the thanks (decision 181)', () => {
    // The starting words put it after the thanks and before who the owner is.
    expect(STARTING_INTRO.indexOf('[something you have in common]')).toBeGreaterThan(
      STARTING_INTRO.indexOf('thanks for connecting!'),
    );
    expect(STARTING_INTRO.indexOf('[something you have in common]')).toBeLessThan(
      STARTING_INTRO.indexOf('I’m [your first name]'),
    );
    expect(SCRIPT_BLANKS.map((b) => b.blank)).toContain('[something you have in common]');
    expect(PLAYBOOK_OPENS.intro.hint).toContain('says something you have in common');
    const prompt = todayDraftPrompt({ kind: 'opener', ...base, recent: [] });
    expect(prompt).toContain(FILL_BLANKS);
    expect(FILL_BLANKS).toContain('[something you have in common] is one short line');
    // Only what's true: local, the same work, About you, or both running a business; never a group or a guess.
    expect(FILL_BLANKS).toContain('that they’re local to each other, when the facts say so');
    expect(FILL_BLANKS).toContain('only when the owner’s own business is in it');
    expect(FILL_BLANKS).toContain('something About you says of the owner');
    expect(FILL_BLANKS).toContain('Always good to meet a fellow business owner!');
    expect(FILL_BLANKS).toContain('Never a group, or where the owner came across them');
    expect(FILL_BLANKS).toContain('never as a question');
    // A friend of a while gets a hello in its place, and keeps the rest of the words.
    expect(todayDraftPrompt({ kind: 'opener', ...base, recent: [], fresh: false })).toContain(
      playbookSays(STARTING_INTRO),
    );
    // To their Requests it's left out, to keep that one text short; words without it are told nothing of it.
    expect(requestsTask(STARTING_INTRO)).toContain(
      'leave out [something you have in common] and its line',
    );
    expect(requestsTask(STARTING_FIRST_MESSAGE)).not.toContain('[something you have in common]');
    // A playbook's own words without it get no such line added.
    const own = todayDraftPrompt({
      kind: 'opener',
      ...base,
      recent: [],
      opener: { kind: 'intro', text: 'Hi [first name], thanks for the add!' },
    });
    expect(own).toContain('Add nothing of your own before or after it');
    // The introductions already waiting are written again with it.
    expect(RULES_VERSION).toBeGreaterThanOrEqual(6);
  });

  it('says who the owner is and nothing of what the business does, which waits until they ask (decision 190)', () => {
    // The starting words: the thanks, what they share, who the owner is, then the question. No word of the offer.
    expect(STARTING_INTRO).not.toMatch(/We help|\[what your offer|\[their kind of business\]/);
    expect(STARTING_INTRO).toMatch(
      /I’m \[your first name\] with \[your business name\]\. \[a question about them\]$/,
    );
    // The task keeps the offer out of it, whatever else the draft is told of the business.
    const prompt = todayDraftPrompt({
      kind: 'opener',
      ...base,
      recent: [],
      ownerName: 'Chris Lee',
    });
    expect(prompt).toContain('It says who the owner is, as the playbook’s words do');
    expect(prompt).toContain(
      'Say nothing of what the business does or offers in it unless the playbook’s words do: that waits until they ask.',
    );
    expect(prompt).not.toContain('what the business offers, then asks');
    // A business's own words are still its own: one that says more of the person is kept close to, as written.
    const founder =
      'Hey [first name], thanks for connecting! I’m [your first name], the founder of [your business name]. [a question about them]';
    const own = todayDraftPrompt({
      kind: 'opener',
      ...base,
      recent: [],
      ownerName: 'Chris Lee',
      opener: { kind: 'intro', text: founder },
    });
    expect(own).toContain(playbookSays(founder));
    expect(own).toContain('<owner_name>Chris Lee</owner_name>');
    // The choice's words say so too, on the web and the phone.
    expect(PLAYBOOK_OPENS.intro.hint).toContain(
      'It doesn’t say what you offer: that waits until they ask.',
    );
    expect(OPEN_WAYS.intro.hint).toContain('What you offer waits until they ask.');
    // The introductions already waiting are written again without it.
    expect(RULES_VERSION).toBeGreaterThanOrEqual(7);
  });

  it('tells a check-in after an introduction that nothing was asked', () => {
    const checkIn = todayDraftPrompt({
      kind: 'check_in',
      ...base,
      recent: [],
      conversation: { step: 'intro', sent: pace.followUps, followUps: pace.followUps },
    });
    expect(checkIn).toContain('wrote first to start a chat with them a while ago');
  });
});
