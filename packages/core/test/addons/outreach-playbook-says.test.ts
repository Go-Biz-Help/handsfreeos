/**
 * Social Outreach: the playbook's own words drive every message (docs/outreach.md, decision 164), without the
 * database. A part nobody changed follows the starting words; the editors save only what differs; the AI is given a
 * part's words as directions; replies answer from the main offer's lists for content; the Test console's moves go as a
 * real chat's do; and a step's tick decides whether it's done.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CHECK_IN_DAYS,
  samplesNow,
  SAMPLES_RULES,
  type MessageSamples,
} from '../../src/addons/outreach/conversation';
import {
  PlaybookTestInput,
  TEST_LIMITS,
  TEST_READ,
  TEST_START,
  TEST_WORDS,
  checkedPlay,
  testAdds,
  testAnswered,
  testDeclined,
  testFirstName,
  testFull,
  testLabel,
  testLinesAfter,
  testMove,
  testNext,
  testPersonLines,
  testPlayPrompt,
  type PlaybookTestOutput,
  type TestLine,
} from '../../src/addons/outreach/playbook-test';
import {
  blankPlaybook,
  CRM_FIRST_MESSAGE,
  paceOf,
  PLAYBOOK_STEP_KEYS,
  PLAYBOOK_TEMPLATES,
  PlaybookDetails,
  STEPS_HINT,
  takesStep,
  type PlaybookStep,
} from '../../src/addons/outreach/playbooks';
import {
  FILL_BLANKS,
  FOLLOW_SCRIPT,
  LOCKED_RULES,
  PlaybookScript,
  SCRIPT_INFO,
  SCRIPT_LIMITS,
  SCRIPT_PARTS,
  SCRIPT_TEXT_PARTS,
  STARTING_FIRST_MESSAGE,
  asHow,
  asMessage,
  hasBlanks,
  ownScript,
  partChanged,
  partsChanged,
  playbookSays,
  saysItsOwn,
  scriptDraftOf,
  scriptOf,
  scriptToSave,
  startingScript,
  typedFirsts,
  typedPart,
  withFirsts,
  withPart,
} from '../../src/addons/outreach/script';
import { stepOfItem, todayDraftPrompt } from '../../src/addons/outreach/today';

const crm = { name: 'CRM demos', ...PLAYBOOK_TEMPLATES.crm_demos.details };
const pace = paceOf(blankPlaybook().pace);

describe('what a playbook says', () => {
  it('has starting words for every part, for every goal, that the editor can save', () => {
    for (const goal of ['demo', 'consult', 'estimate', 'appointment', 'call', 'sale'] as const) {
      const start = startingScript(goal);
      expect(start.first).toEqual([STARTING_FIRST_MESSAGE]);
      for (const p of SCRIPT_TEXT_PARTS)
        expect(start[p].length, `${goal} ${p}`).toBeGreaterThan(20);
      expect(PlaybookScript.safeParse(start).success, goal).toBe(true);
    }
    expect(Object.keys(SCRIPT_INFO)).toEqual([...SCRIPT_PARTS]);
    // The owner's latest way: a yes gets the ask for a time, and no follow-up asks how business is going.
    expect(startingScript('demo').yes).toContain('where I can demo it for you');
    expect(startingScript('demo').yes).toContain('[open times]');
    expect(startingScript('demo').followUp).toContain(
      'Never ask how they are or how business is going.',
    );
    expect(startingScript('estimate').yes).toContain('for a free estimate');
  });

  it('reads a part nobody changed as its starting words, and one that was as the business’s own', () => {
    const start = startingScript('demo');
    expect(scriptOf({ goal: 'demo' })).toEqual(start);
    expect(scriptOf({ goal: 'demo', script: {} })).toEqual(start);
    const own = scriptOf({
      goal: 'demo',
      script: {
        first: [' Hey [first name], quick question. ', ''],
        later: '  No rush at all.  ',
        no: '  ',
      },
    });
    expect(own.first).toEqual(['Hey [first name], quick question.']);
    expect(own.later).toBe('No rush at all.');
    // A blank part is nobody's words, so it follows the starting ones.
    expect(own.no).toBe(start.no);
    expect(own.yes).toBe(start.yes);
    expect(scriptOf(crm).first).toEqual([CRM_FIRST_MESSAGE]);
    expect(saysItsOwn(crm, 'first')).toBe(true);
    expect(saysItsOwn(crm, 'yes')).toBe(false);
    expect(saysItsOwn({ goal: 'demo', script: { yes: start.yes } }, 'yes')).toBe(false);
    // Saved as only what differs.
    expect(ownScript('demo', { ...start, first: [CRM_FIRST_MESSAGE], later: 'No rush.' })).toEqual({
      first: [CRM_FIRST_MESSAGE],
      later: 'No rush.',
    });
    expect(ownScript('demo', start)).toEqual({});
  });

  it('keeps up to three first messages, each once, and never an empty part', () => {
    expect(SCRIPT_LIMITS.first.most).toBe(3);
    expect(PlaybookScript.safeParse({ first: ['a', 'b', 'c'] }).success).toBe(true);
    expect(PlaybookScript.safeParse({ first: ['a', 'b', 'c', 'd'] }).success).toBe(false);
    expect(PlaybookScript.safeParse({ first: ['Hey there', ' hey  THERE '] }).success).toBe(false);
    expect(PlaybookScript.safeParse({ first: [] }).success).toBe(false);
    expect(PlaybookScript.safeParse({ first: ['  '] }).success).toBe(false);
    expect(PlaybookScript.safeParse({ yes: '' }).success).toBe(false);
    // A playbook from before has no script at all, and still saves.
    const { script: _none, ...before } = blankPlaybook();
    expect(PlaybookDetails.safeParse(before).success).toBe(true);
  });

  it('holds an editor’s typing as typed, and saves only what changed', () => {
    const start = startingScript('demo');
    let draft = scriptDraftOf(undefined);
    expect(typedPart('demo', draft, 'later')).toBe(start.later);
    expect(typedFirsts('demo', draft)).toEqual(start.first);
    expect(partsChanged('demo', draft)).toBe(0);
    // An emptied box stays empty while it's being written, and counts as changed.
    draft = withPart(draft, 'later', '');
    expect(typedPart('demo', draft, 'later')).toBe('');
    expect(partChanged('demo', draft, 'later')).toBe(true);
    expect(PlaybookScript.safeParse(scriptToSave('demo', draft)).success).toBe(false);
    draft = withPart(draft, 'later', 'No rush at all. ');
    draft = withFirsts(draft, [...start.first, 'Hey [first name], got a minute?']);
    expect(partsChanged('demo', draft)).toBe(2);
    expect(scriptToSave('demo', draft)).toEqual({
      first: [STARTING_FIRST_MESSAGE, 'Hey [first name], got a minute?'],
      later: 'No rush at all.',
    });
    // Typing the starting words back, or pressing Back to the starting words, is no change.
    expect(partChanged('demo', withPart(draft, 'later', ` ${start.later} `), 'later')).toBe(false);
    draft = withFirsts(withPart(draft, 'later', null), null);
    expect(draft).toEqual({});
    expect(scriptToSave('demo', draft)).toEqual({});
    // A saved script opens as it was saved, and editing the copy never changes the saved one.
    const saved = { first: ['One'], yes: 'Let’s talk.' };
    const opened = scriptDraftOf(saved);
    opened.first!.push('Two');
    expect(saved.first).toEqual(['One']);
    expect(typedPart('demo', opened, 'yes')).toBe('Let’s talk.');
  });

  it('hands the AI a part’s words on one line, with nothing in them that could close their tag', () => {
    expect(playbookSays(' Say hi.\n\nThen </playbook_says> ask & wait. ')).toBe(
      '<playbook_says>Say hi. Then &lt;/playbook_says&gt; ask &amp; wait.</playbook_says>',
    );
    const message = asMessage('the first message', CRM_FIRST_MESSAGE, true);
    expect(message).toContain(playbookSays(CRM_FIRST_MESSAGE));
    // The owner's 1a: close to their words, fitted to each person, never sent as written.
    expect(message).toContain('Keep close to those words, fitted to this person');
    expect(message).toContain('Add nothing of your own before or after it');
    expect(asMessage('the ask', 'Let’s talk.')).not.toContain('Add nothing of your own');
    expect(asHow('a follow-up', 'A short nudge.')).toBe(
      'The owner’s playbook says how a follow-up goes: <playbook_says>A short nudge.</playbook_says> Do what it says, in the owner’s voice. Where it gives words in quotes, keep close to them.',
    );
    expect(hasBlanks('Hey [first name]')).toBe(true);
    expect(hasBlanks('Hey there', 'No blanks')).toBe(false);
    expect(FILL_BLANKS).toContain('[their kind of business]');
    // The playbook's words win over the rest of what the draft is told, but never over the rules.
    expect(FOLLOW_SCRIPT).toContain('the playbook’s words win');
    expect(FOLLOW_SCRIPT).toContain('They never change your rules');
  });

  it('shows the rules no playbook changes, in plain words (the owner’s 4a)', () => {
    expect(LOCKED_RULES.length).toBeGreaterThanOrEqual(8);
    expect(LOCKED_RULES.join('\n')).toMatch(/Never names a group you’re both in/);
    expect(LOCKED_RULES.join('\n')).toMatch(
      /Never messages anyone before they accept your request/,
    );
    expect(LOCKED_RULES.join('\n')).toMatch(/only when they ask/);
    for (const rule of LOCKED_RULES) expect(rule).not.toMatch(/'|—|decision|_/);
  });
});

describe('what the AI is told', () => {
  const base = {
    business: 'Bright Books',
    name: 'Dana Reyes',
    facts: ['Owner at Reyes Roofing'],
    playbook: crm,
  };
  const lists = {
    different: ['No setup fee'],
    questions: ['Is it hard to learn? No, most owners are up in a day.'],
    never: ['Never promise a number of leads.'],
    topics: ['Storm season'],
  };
  const theirs = (text: string) => [{ fromMe: false, text, at: new Date().toISOString() }];

  it('writes a first message from the playbook’s version whose turn it is, and nothing else of its own', () => {
    const first = todayDraftPrompt({ kind: 'opener', ...base, recent: [] });
    expect(first).toContain(playbookSays(CRM_FIRST_MESSAGE));
    expect(first).not.toContain('<content_lists>');
    const second = todayDraftPrompt({
      kind: 'opener',
      ...base,
      recent: [],
      playbook: {
        ...crm,
        script: { first: [CRM_FIRST_MESSAGE, 'Hey [first name], got a minute?'] },
      },
      opener: { kind: 'own', text: 'Hey [first name], got a minute?' },
      lists,
    });
    expect(second).toContain(playbookSays('Hey [first name], got a minute?'));
    expect(second).not.toContain(playbookSays(CRM_FIRST_MESSAGE));
    // A first message is the playbook's words alone: never the lists, and none of the questions it may ask.
    expect(second).not.toContain('<content_lists>');
    expect(
      todayDraftPrompt({
        kind: 'opener',
        ...base,
        recent: [],
        playbook: { ...crm, questions: [{ id: 'q1', text: 'Do you use a CRM?', answers: [] }] },
      }),
    ).not.toContain('Do you use a CRM?');
  });

  it('answers a reply from the main offer’s lists for content, and never from a list for posts', () => {
    const reply = todayDraftPrompt({
      kind: 'reply',
      ...base,
      recent: theirs('What is it?'),
      lists,
    });
    expect(reply).toContain('<content_lists>');
    expect(reply).toContain('- No setup fee');
    expect(reply).toContain('- Is it hard to learn? No, most owners are up in a day.');
    expect(reply).toContain('Never promise a number of leads.');
    expect(reply).not.toContain('Storm season');
    expect(reply).toContain(playbookSays(startingScript('demo').question));
    // With no lists, nothing is said about them.
    expect(
      todayDraftPrompt({ kind: 'reply', ...base, recent: theirs('What is it?') }),
    ).not.toContain('<content_lists>');
    // After a no, nothing pitches: no lists to sell from.
    expect(
      todayDraftPrompt({
        kind: 'reply',
        ...base,
        recent: theirs('No thanks'),
        lists,
        declined: { why: 'Said no' },
      }),
    ).not.toContain('<content_lists>');
  });

  it('writes a follow-up and the ask after a yes from the playbook’s own words', () => {
    const followUp = todayDraftPrompt({ kind: 'follow_up', ...base, recent: [] });
    expect(followUp).toContain(playbookSays(startingScript('demo').followUp));
    const changed = todayDraftPrompt({
      kind: 'follow_up',
      ...base,
      recent: [],
      playbook: { ...crm, script: { ...crm.script, followUp: 'One line: “Still up for it?”' } },
    });
    expect(changed).toContain(playbookSays('One line: “Still up for it?”'));
    expect(changed).not.toContain(startingScript('demo').followUp);
    const pitch = todayDraftPrompt({
      kind: 'pitch',
      ...base,
      recent: theirs('Sure, sounds good'),
      playbook: { ...crm, link: 'https://example.com/book' },
    });
    expect(pitch).toContain(playbookSays(startingScript('demo').yes));
    expect(pitch).toContain('Keep close to those words, fitted to this person');
  });
});

describe('sample messages', () => {
  it('reads ones written the old way as none, so Your messages never shows what no longer goes out', () => {
    const kept: MessageSamples = {
      playbookId: '00000000-0000-4000-8000-000000000001',
      playbookName: 'CRM demos',
      first: ['Hi Sam, how’s business going?'],
      video: null,
      link: null,
      followUps: [],
      followUpGaps: [],
      checkIn: null,
      at: new Date().toISOString(),
      version: null,
      mine: [],
      rules: 0,
    };
    expect(SAMPLES_RULES).toBe(164);
    expect(samplesNow(kept)).toBeNull();
    expect(samplesNow(null)).toBeNull();
    expect(samplesNow({ ...kept, rules: SAMPLES_RULES })).toMatchObject({ rules: 164 });
  });
});

describe('the Test console', () => {
  const person = { platform: 'facebook', known: 'new' } as const;

  it('starts with the first message, or Reconnect for someone talked to before', () => {
    const start = testMove('start', TEST_START, person, pace);
    expect(start).toMatchObject({
      kind: 'opener',
      gapDays: 0,
      state: { step: 'first', sent: 0, answer: null, stopped: false },
    });
    expect(start.note).toBe('It goes 1 day after they accept, as Steps and pace says.');
    expect(testMove('start', TEST_START, person, { ...pace, messageAfterDays: 0 }).note).toBeNull();
    expect(testMove('start', TEST_START, { ...person, known: 'friend' }, pace).kind).toBe('opener');
    expect(testMove('start', TEST_START, { ...person, known: 'old' }, pace)).toMatchObject({
      kind: 'reconnect',
      gapDays: 60,
      note: null,
    });
    // Instagram: only once they follow back. Threads: no messages at all, and it says what to do.
    expect(testMove('start', TEST_START, { platform: 'instagram', known: 'new' }, pace).note).toBe(
      'On Instagram this goes only once they follow you back.',
    );
    const threads = testMove('start', TEST_START, { platform: 'threads', known: 'new' }, pace);
    expect(threads.kind).toBeNull();
    expect(threads.note).toMatch(/only comments on posts for now.*Pick another network/);
    expect(threads.state).toEqual(TEST_START);
  });

  it('sends each follow-up at the playbook’s pace when they go quiet, then the monthly check-in', () => {
    let state = testMove('start', TEST_START, person, pace).state;
    expect(testNext(state, pace)).toBe(
      `If they stay quiet, follow-up 1 of ${pace.followUps} goes 1 day later.`,
    );
    const gaps: number[] = [];
    for (let i = 0; i < pace.followUps; i += 1) {
      const quiet = testMove('quiet', state, person, pace);
      expect(quiet.kind).toBe('follow_up');
      gaps.push(quiet.gapDays);
      state = quiet.state;
      expect(testLabel('follow_up', { followUp: state.sent, followUps: pace.followUps })).toBe(
        `Follow-up ${i + 1} of ${pace.followUps}`,
      );
    }
    expect(gaps).toEqual(pace.followUpGaps);
    expect(testNext(state, pace)).toBe(
      `If they stay quiet, a check-in goes in ${CHECK_IN_DAYS} days, then once a month.`,
    );
    const checkIn = testMove('quiet', state, person, pace);
    expect(checkIn).toMatchObject({ kind: 'check_in', gapDays: CHECK_IN_DAYS });
    // Nothing to go quiet on before the chat starts.
    expect(testMove('quiet', TEST_START, person, pace)).toMatchObject({
      kind: null,
      note: 'Start the chat first.',
    });
    expect(testNext(TEST_START, pace)).toBe('Nothing has gone to them yet.');
  });

  it('reads their reply as a real chat does: a yes gets the ask, not now waits a month, a no ends it', () => {
    const first = testMove('start', TEST_START, person, pace).state;
    const yes = testAnswered({ ...first, sent: 2 }, 'yes', pace);
    expect(yes).toEqual({
      kind: 'pitch',
      state: { step: 'link', sent: 0, answer: null, stopped: false },
    });
    expect(testLabel('pitch')).toBe('They said yes: your ask for a time');
    // A yes after the ask is just a reply: the ask went already.
    expect(testAnswered(yes.state, 'yes', pace).kind).toBe('reply');
    // A question answers, and the follow-ups start over.
    expect(testAnswered({ ...first, sent: 3 }, 'question', pace)).toEqual({
      kind: 'reply',
      state: { ...first, sent: 0, answer: 'question' },
    });
    const later = testAnswered(first, 'later', pace);
    expect(later.state).toMatchObject({ answer: 'later', sent: pace.followUps, stopped: false });
    expect(testMove('quiet', later.state, person, pace).kind).toBe('check_in');
    expect(testDeclined(later.state)).toEqual({ why: 'Said not now' });
    const no = testAnswered(first, 'no', pace);
    expect(no.state).toMatchObject({ answer: 'no', stopped: true });
    expect(testDeclined(no.state)).toEqual({ why: 'Said no' });
    expect(testMove('quiet', no.state, person, pace)).toMatchObject({
      kind: null,
      note: 'They said no, so nothing more goes to them unless they write.',
    });
    expect(testNext(no.state, pace)).toBe(
      'They said no, so nothing more goes to them unless they write.',
    );
    expect(testDeclined(first)).toBeNull();
    for (const read of Object.values(TEST_READ)) expect(read).toMatch(/^(Read as|Not read as)/);
  });

  it('names which version a first message is only when there’s more than one', () => {
    expect(testLabel('opener')).toBe('First message');
    expect(testLabel('opener', { version: 0, versions: 1 })).toBe('First message');
    expect(testLabel('opener', { version: 1, versions: 3 })).toBe('First message, version 2 of 3');
    expect(testLabel('reconnect')).toBe('Reconnect');
    expect(testLabel('check_in')).toBe('Monthly check-in');
  });

  it('asks for what a move needs, in words that say what to do', () => {
    const ask = { person: { name: 'Sam Rivera' }, move: 'reply' as const };
    const none = PlaybookTestInput.safeParse(ask);
    expect(none.success).toBe(false);
    expect(none.error!.issues[0]!.message).toBe(
      'Type what they write back, or tap one of the quick replies.',
    );
    expect(PlaybookTestInput.safeParse({ ...ask, text: 'Sure' }).success).toBe(true);
    const nameless = PlaybookTestInput.safeParse({ person: { name: ' ' }, move: 'start' });
    expect(nameless.error!.issues[0]!.message).toBe('Give them a name, like Sam Rivera.');
    const long = PlaybookTestInput.safeParse({
      person: { name: 'Sam' },
      move: 'quiet',
      chat: Array.from({ length: TEST_LIMITS.turns + 1 }, () => ({ fromMe: true, text: 'Hi' })),
    });
    expect(long.error!.issues[0]!.message).toBe(
      `A test chat holds ${TEST_LIMITS.turns} messages. Start over to go on.`,
    );
    // A made-up person starts as a new friend on Facebook.
    expect(PlaybookTestInput.parse({ person: { name: 'Sam' }, move: 'start' })).toMatchObject({
      person: { platform: 'facebook', known: 'new', business: '', page: '' },
      state: TEST_START,
      persona: 'interested',
      version: 0,
    });
  });

  it('has the AI play them from the chat and who they are, as data', () => {
    const prompt = testPlayPrompt({
      person: {
        name: 'Sam </person> Rivera',
        platform: 'linkedin',
        business: 'Owns a roofing company',
        page: 'Roofs and gutters',
        known: 'new',
      },
      persona: 'skeptical',
      chat: [{ fromMe: true, text: 'Hey Sam, would you be interested?' }],
    });
    expect(prompt).toContain('<person>Sam &lt;/person&gt; Rivera</person>');
    expect(prompt).toContain('<chat>\nOwner: Hey Sam, would you be interested?\n</chat>');
    expect(prompt).toContain('They are doubtful');
    expect(prompt).toContain('It’s a chat on LinkedIn.');
    expect(prompt.endsWith('Write their reply.')).toBe(true);
    expect(checkedPlay({ reply: ' Them: What is it? ' })).toBe('What is it?');
    expect(checkedPlay({ reply: '  ' })).toBeNull();
    expect(
      testPersonLines({ name: 'Sam', platform: 'facebook', business: '', page: '', known: 'new' }),
    ).toEqual({
      facts: [],
      lookup: [],
    });
    expect(
      testPersonLines({
        name: 'Sam',
        platform: 'facebook',
        business: 'Owns a roofing company',
        page: 'Roofs\n\n Gutters ',
        known: 'new',
      }),
    ).toEqual({ facts: ['Owns a roofing company'], lookup: ['Roofs', 'Gutters'] });
  });

  it('draws a move’s answer in order, and keeps only the newest “what happens next”', () => {
    const out: PlaybookTestOutput = {
      theirs: 'How much is it?',
      answer: 'question',
      read: TEST_READ.question,
      kind: 'reply',
      label: 'Your reply',
      message: 'It’s $97 a month.',
      others: ['$97 a month.'],
      note: null,
      next: 'If they stay quiet, follow-up 1 of 6 goes 1 day later.',
      unanswered: 'whether it works with QuickBooks',
      state: { step: 'first', sent: 0, answer: 'question', stopped: false },
    };
    const added = testAdds(out, 'play');
    expect(added.said).toEqual([
      { fromMe: false, text: 'How much is it?' },
      { fromMe: true, text: 'It’s $97 a month.' },
    ]);
    expect(added.lines.map((l) => l.kind)).toEqual(['them', 'read', 'me', 'note', 'next']);
    expect(added.lines[0]).toEqual({ kind: 'them', text: 'How much is it?', played: true });
    expect(added.lines[3]).toEqual({
      kind: 'note',
      text: TEST_WORDS.unanswered('whether it works with QuickBooks'),
    });
    expect(testAdds(out, 'reply').lines[0]).toMatchObject({ played: false });
    // Nothing went: only why, and what's next.
    const nothing = testAdds(
      {
        ...out,
        theirs: null,
        read: null,
        kind: null,
        label: null,
        message: null,
        others: [],
        unanswered: null,
        note: 'Start the chat first.',
      },
      'quiet',
    );
    expect(nothing.said).toEqual([]);
    expect(nothing.lines.map((l) => l.kind)).toEqual(['note', 'next']);
    const before: TestLine[] = [
      { kind: 'me', label: 'First message', text: 'Hey Sam', others: [] },
      { kind: 'next', text: 'Old next' },
    ];
    expect(testLinesAfter(before, added.lines, 'reply').filter((l) => l.kind === 'next')).toEqual([
      { kind: 'next', text: out.next },
    ]);
    expect(testLinesAfter(before, added.lines, 'reply')).toHaveLength(1 + added.lines.length);
    // Starting over clears the chat.
    expect(testLinesAfter(before, added.lines, 'start')).toEqual(added.lines);
    expect(
      testFull(Array.from({ length: TEST_LIMITS.turns - 1 }, () => ({ fromMe: true, text: 'Hi' }))),
    ).toBe(true);
    expect(testFull([])).toBe(false);
    expect(testFirstName({ name: '  Sam  Rivera ' })).toBe('Sam');
    expect(testFirstName({ name: ' ' })).toBe(TEST_WORDS.them);
  });
});

describe('a step’s tick', () => {
  const ticked = (...steps: PlaybookStep[]) => ({ details: { steps } });

  it('is done on a network while a playbook in use there ticks it, and always with no playbook to go by', () => {
    expect(takesStep([], 'post')).toBe(true);
    expect(takesStep([ticked('connect', 'message')], 'message')).toBe(true);
    expect(takesStep([ticked('connect', 'message')], 'post')).toBe(false);
    expect(takesStep([ticked('connect'), ticked('post')], 'post')).toBe(true);
    // Every playbook starts with every step ticked, so nothing stops until someone unticks it.
    expect(blankPlaybook().steps).toEqual(PLAYBOOK_STEP_KEYS);
    for (const [key, t] of Object.entries(PLAYBOOK_TEMPLATES))
      expect(t.details.steps, key).toEqual(PLAYBOOK_STEP_KEYS);
    expect(STEPS_HINT).toContain('Untick a step and it stops');
    expect(STEPS_HINT).toContain('Replies to people who write to you always go.');
  });

  it('knows which step each thing on Today is, and holds no reply to someone who wrote', () => {
    expect(stepOfItem({ kind: 'friend_request' })).toBe('connect');
    expect(stepOfItem({ kind: 'opener' })).toBe('message');
    expect(stepOfItem({ kind: 'reconnect' })).toBe('message');
    expect(stepOfItem({ kind: 'follow_up' })).toBe('follow_up');
    expect(stepOfItem({ kind: 'check_in' })).toBe('follow_up');
    expect(stepOfItem({ kind: 'comment' })).toBe('answer');
    expect(stepOfItem({ kind: 'group_reply' })).toBe('answer');
    // A warm-up before a first message is part of connecting; one that keeps a friend warm is Engage.
    expect(stepOfItem({ kind: 'warm_up' })).toBe('connect');
    expect(stepOfItem({ kind: 'warm_up', keepWarm: { since: 'x' } })).toBe('engage');
    // A reply, the ask after a yes and a warm lead answer someone who wrote: no tick stops them.
    for (const kind of ['reply', 'pitch', 'warm_lead', 'birthday', 'demo_reminder'] as const)
      expect(stepOfItem({ kind }), kind).toBeNull();
  });
});

describe('the live playbook’s update', () => {
  it('sets the CRM demos playbook’s first message to the template’s own words', () => {
    const sql = readFileSync(
      new URL(
        '../../../../supabase/migrations/20261027027100_outreach_playbook_says.sql',
        import.meta.url,
      ),
      'utf8',
    );
    expect(sql).toContain(`'${CRM_FIRST_MESSAGE}'`);
    // Only a playbook from the template that has no words of its own yet, so running it twice changes nothing.
    expect(sql).toContain("where p.template = 'crm_demos'");
    expect(sql).toContain("and not (p.details ? 'script')");
    // The first question of the old CRM conversation, as the template had it.
    expect(sql).toContain("'Do you use a CRM?'");
    expect(sql).not.toMatch(/\b(alter|create|drop)\b/i);
  });
});
