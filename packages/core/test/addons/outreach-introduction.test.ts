/**
 * Social Outreach: a playbook that starts with an introduction in place of the pitch (docs/outreach.md, decision 168),
 * without the database. The first message is the playbook's introduction, which ends with a question about them
 * (decision 173); one nudge follows it, then the monthly check-in; a yes still gets the ask for a time; and the AI is
 * told who the owner is so it can say so.
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
  opensWithIntro,
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
import { connectedLately, introTask, todayDraftPrompt } from '../../src/addons/outreach/today';

const crm = { name: 'CRM demos', ...PLAYBOOK_TEMPLATES.crm_demos.details };
const intro = { ...crm, opens: 'intro' as const };
const pace = paceOf(blankPlaybook().pace);

describe('a playbook that starts with an introduction', () => {
  it('has the owner’s starting words, and a choice that keeps when a save leaves it out', () => {
    expect(STARTING_INTRO).toBe(
      'Hey [first name], thanks for connecting! I’m [your first name] with [your business name]. We help [their kind of business] businesses get [what your offer gets them] with [what your offer is]. [a question about them]',
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
    expect(opensWithIntro(crm)).toBe(false);
    expect(opensWithIntro(intro)).toBe(true);
    expect(opensWithIntro(null)).toBe(false);
    expect(PLAYBOOK_KEPT_KEYS).toContain('opens');
    expect(PlaybookDetails.parse({ ...intro, name: undefined }).opens).toBe('intro');
    expect(() => PlaybookDetails.parse({ ...crm, opens: 'hello' })).toThrow();
  });

  it('sends the introduction in place of the first message’s versions, and Results counts it apart', () => {
    expect(firstMessagesOf(crm)).toEqual(scriptOf(crm).first);
    expect(firstMessagesOf(intro)).toEqual([STARTING_INTRO]);
    const own = {
      ...intro,
      script: { intro: 'Hi [first name], thanks for the add! I’m [your first name].' },
    };
    expect(firstMessagesOf(own)).toEqual([
      'Hi [first name], thanks for the add! I’m [your first name].',
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
    expect(testLabel('opener', { version: 0, versions: 1, intro: true })).toBe('Introduction');
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

  it('tells a check-in after an introduction that nothing was asked', () => {
    const checkIn = todayDraftPrompt({
      kind: 'check_in',
      ...base,
      recent: [],
      conversation: { step: 'intro', sent: pace.followUps, followUps: pace.followUps },
    });
    expect(checkIn).toContain('introduced themselves a while ago');
  });
});
