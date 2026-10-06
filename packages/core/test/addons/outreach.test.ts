/**
 * Social Outreach's manifest and operations, held to the add-on rules (docs/addon-architecture.md), its playbook
 * templates, how a chat read again joins what was saved before, and the warning past the daily limits. Pure: no
 * database.
 */
import { describe, expect, it } from 'vitest';
import {
  addonAiIssues,
  addonModuleIssues,
  commands,
  manifestIssues,
  queries,
} from '../../src/server';
import { outreachAddon } from '../../src/addons/outreach/manifest';
import {
  answerNextLabel,
  blankPlaybook,
  nextQuestionId,
  PLAYBOOK_TEMPLATES,
  PlaybookDetails,
  renumberQuestions,
  upgradePlaybookDetails,
  type PlaybookQuestion,
} from '../../src/addons/outreach/playbooks';
import { DAILY_LIMITS, pastLimitWords } from '../../src/addons/outreach/limits';
import { joinMessages, type ChatMessage, type SavedMessage } from '../../src/addons/outreach/saves';
import { outreachAddonServer } from '../../src/addons/outreach/server';

describe('Social Outreach', () => {
  it('has a valid manifest', () => {
    expect(manifestIssues(outreachAddon)).toEqual([]);
  });

  it('joins core’s operations cleanly', () => {
    const core = {
      commands: commands.filter((c) => c.addon?.id !== 'outreach'),
      queries: queries.filter((q) => q.addon?.id !== 'outreach'),
    };
    expect(addonModuleIssues(core, [outreachAddonServer])).toEqual([]);
  });

  it('declares every event its commands emit, and only those', () => {
    const emitted = (outreachAddonServer.commands ?? [])
      .flatMap((c) => c.emits)
      .filter((e) => e.startsWith('outreach.'));
    expect([...new Set(emitted)].sort()).toEqual([...(outreachAddon.events?.emits ?? [])].sort());
  });

  it('offers the AI only what it may use', () => {
    expect(addonAiIssues([outreachAddonServer])).toEqual([]);
  });
});

describe('playbooks', () => {
  it('starts every template and a blank one as a playbook its editor can save', () => {
    for (const [key, template] of Object.entries(PLAYBOOK_TEMPLATES))
      expect(PlaybookDetails.parse(template.details), key).toEqual(template.details);
    expect(PlaybookDetails.parse(blankPlaybook())).toEqual(blankPlaybook());
  });

  it('starts with the owner’s CRM-demo playbook, with their questions and tags', () => {
    const crm = PLAYBOOK_TEMPLATES.crm_demos;
    expect(crm.details.goal).toBe('demo');
    expect(crm.details.questions.map((q) => q.text)).toEqual([
      'Do you use a CRM?',
      'Which one?',
      'Is it doing what you need?',
      'How do you keep track of follow-ups now?',
    ]);
    // "No" skips the questions about the CRM they don't have; "Not really" makes the offer.
    expect(crm.details.questions[0]!.answers.find((a) => a.label === 'No')!.next).toBe('q4');
    expect(crm.details.questions[2]!.answers.find((a) => a.label === 'Not really')).toEqual({
      label: 'Not really',
      tag: 'Unhappy with CRM',
      next: 'offer',
    });
    expect(crm.details.skip).toContain('Group admins and moderators');
    expect(crm.details.tags).toEqual([
      'Business owner',
      'Uses a CRM',
      'Happy with CRM',
      'Unhappy with CRM',
      'Wants a demo',
      'Not a fit',
      'Friend or family',
    ]);
  });

  it('refuses a tag twice, an empty line, and a link that isn’t one', () => {
    const issues = (over: Partial<PlaybookDetails>) =>
      PlaybookDetails.safeParse({ ...blankPlaybook(), ...over }).error?.issues.map((i) =>
        i.path.join('.'),
      );
    expect(issues({ tags: ['Business owner', 'business owner'] })).toEqual(['tags']);
    expect(issues({ signs: ['Owner', '  '] })).toEqual(['signs.1']);
    expect(issues({ link: 'book with me' })).toEqual(['link']);
    expect(issues({ link: 'https://example.com/book' })).toBeUndefined();
  });
});

describe('a playbook’s conversation', () => {
  const ask = (id: string, text: string, answers: PlaybookQuestion['answers'] = []) => ({
    id,
    text,
    answers,
  });
  const issues = (questions: PlaybookQuestion[], tags = ['Uses a CRM']) =>
    PlaybookDetails.safeParse({ ...blankPlaybook(), tags, questions }).error?.issues.map(
      (i) => `${i.path.join('.')}: ${i.message}`,
    );

  it('lets an answer add one of the playbook’s tags and lead to a question further down', () => {
    expect(
      issues([
        ask('q1', 'Do you use a CRM?', [
          { label: 'Yes', tag: 'uses a crm', next: 'q2' },
          { label: 'No', tag: null, next: 'offer' },
        ]),
        ask('q2', 'Which one?'),
      ]),
    ).toBeUndefined();
  });

  it('refuses a tag the playbook doesn’t have, a step back up, and a question that isn’t there', () => {
    expect(
      issues([
        ask('q1', 'Do you use a CRM?', [
          { label: 'Yes', tag: 'Loves spreadsheets', next: 'continue' },
          { label: 'No', tag: null, next: 'q9' },
        ]),
        ask('q2', 'Which one?', [{ label: 'HubSpot', tag: null, next: 'q1' }]),
      ]),
    ).toEqual([
      'questions.0.answers.0.tag: “Loves spreadsheets” isn’t one of this playbook’s tags. Add it under Tags, or pick another.',
      'questions.0.answers.1.next: That question isn’t in this playbook anymore. Pick what happens next again.',
      'questions.1.answers.0.next: An answer can only lead to a question further down.',
    ]);
  });

  it('refuses the same question name twice, the same answer twice, and a question leading to itself', () => {
    expect(
      issues([
        ask('q1', 'Do you use a CRM?', [
          { label: 'Yes', tag: null, next: 'q1' },
          { label: 'yes', tag: null, next: 'stop' },
        ]),
        ask('q1', 'Which one?'),
      ]),
    ).toEqual([
      'questions.0.answers: Each answer once.',
      'questions.0.answers.0.next: An answer can only lead to a question further down.',
      'questions.1.id: Each question once.',
    ]);
  });

  it('reads one saved before questions had answers, and before it had a pace', () => {
    const { questions, pace, ...rest } = blankPlaybook();
    void questions;
    void pace;
    const old = { ...rest, questions: ['Do you use a CRM?', 'Which one?'] };
    const now = PlaybookDetails.parse(upgradePlaybookDetails(old));
    expect(now.questions).toEqual([ask('q1', 'Do you use a CRM?'), ask('q2', 'Which one?')]);
    expect(now.pace).toEqual({ messageAfterDays: 1, followUpAfterDays: 3 });
    // One in today's shape comes back as it was.
    const crm = PLAYBOOK_TEMPLATES.crm_demos.details;
    expect(upgradePlaybookDetails(crm)).toBe(crm);
  });

  it('renames questions q1, q2… in order on saving, with every answer leading where it did', () => {
    const out = renumberQuestions([
      ask('q4', 'Do you use a CRM?', [{ label: 'No', tag: null, next: 'q7' }]),
      ask('q2', 'Which one?'),
      ask('q7', 'How do you keep track now?', [{ label: 'Notes', tag: null, next: 'offer' }]),
    ]);
    expect(out.map((q) => q.id)).toEqual(['q1', 'q2', 'q3']);
    expect(out[0]!.answers[0]!.next).toBe('q3');
    expect(out[2]!.answers[0]!.next).toBe('offer');
    expect(nextQuestionId(out)).toBe('q4');
    expect(nextQuestionId([])).toBe('q1');
  });

  it('says what an answer leads to in words', () => {
    const qs = [ask('q2', 'Which one?')];
    expect(answerNextLabel('offer', qs)).toBe('Make the offer');
    expect(answerNextLabel('q2', qs)).toBe('Ask “Which one?”');
    expect(answerNextLabel('q5', qs)).toBe('A question that isn’t here anymore');
  });

  it('keeps the pace to whole days within its limits', () => {
    const pace = (p: object) =>
      PlaybookDetails.safeParse({ ...blankPlaybook(), pace: p }).error?.issues.map((i) =>
        i.path.join('.'),
      );
    expect(pace({ messageAfterDays: 0, followUpAfterDays: 30 })).toBeUndefined();
    expect(pace({ messageAfterDays: 15, followUpAfterDays: 0 })).toEqual([
      'pace.messageAfterDays',
      'pace.followUpAfterDays',
    ]);
    expect(pace({ messageAfterDays: 1.5, followUpAfterDays: 3 })).toEqual([
      'pace.messageAfterDays',
    ]);
  });
});

describe('a chat read again', () => {
  const AT = '2026-10-05T12:00:00.000Z';
  const LATER = '2026-10-06T09:00:00.000Z';
  const them = (text: string): ChatMessage => ({ from: 'them', sender: 'Dana', text, when: null });
  const me = (text: string): ChatMessage => ({ from: 'me', sender: null, text, when: null });
  const saved = (list: ChatMessage[]): SavedMessage[] => list.map((m) => ({ ...m, savedAt: AT }));
  const texts = (list: readonly ChatMessage[]) => list.map((m) => m.text);

  it('saves every message the first time', () => {
    const first = joinMessages([], [them('Hi!'), me('Hey Dana')], AT);
    expect(first.added).toBe(2);
    expect(first.messages.every((m) => m.savedAt === AT)).toBe(true);
  });

  it('adds only what’s new when the chat has moved on', () => {
    const before = saved([them('Hi!'), me('Hey Dana'), them('Do you do demos?')]);
    const read = [me('Hey Dana'), them('Do you do demos?'), me('Yes, Tuesday?'), them('Works')];
    const joined = joinMessages(before, read, LATER);
    expect(joined.added).toBe(2);
    expect(texts(joined.messages)).toEqual([
      'Hi!',
      'Hey Dana',
      'Do you do demos?',
      'Yes, Tuesday?',
      'Works',
    ]);
    expect(joined.messages.map((m) => m.savedAt)).toEqual([AT, AT, AT, LATER, LATER]);
  });

  it('changes nothing for the same messages, or a stretch from the middle', () => {
    const before = saved([them('Hi!'), me('Hey Dana'), them('Do you do demos?'), me('Yes')]);
    expect(joinMessages(before, before, LATER)).toEqual({ messages: before, added: 0 });
    expect(joinMessages(before, [me('Hey Dana'), them('Do you do demos?')], LATER).added).toBe(0);
  });

  it('puts older messages, read by scrolling up, before the ones saved', () => {
    const before = saved([me('Yes, Tuesday?'), them('Works')]);
    const joined = joinMessages(before, [them('Do you do demos?'), me('Yes, Tuesday?')], LATER);
    expect(texts(joined.messages)).toEqual(['Do you do demos?', 'Yes, Tuesday?', 'Works']);
    expect(joined.added).toBe(1);
  });

  it('places a repeated short message where it overlaps the most', () => {
    const before = saved([me('ok'), them('Tuesday?'), me('ok')]);
    const joined = joinMessages(before, [them('Tuesday?'), me('ok'), them('Great')], LATER);
    expect(texts(joined.messages)).toEqual(['ok', 'Tuesday?', 'ok', 'Great']);
    expect(joined.added).toBe(1);
  });

  it('learns who sent a message when the first read couldn’t tell', () => {
    const before = saved([{ from: 'unknown', sender: null, text: 'Hi!', when: null }]);
    const joined = joinMessages(before, [them('Hi!'), me('Hello')], LATER);
    expect(joined.messages[0]).toMatchObject({ from: 'them', sender: 'Dana', savedAt: AT });
    expect(joined.added).toBe(1);
  });

  it('keeps only the most recent', () => {
    const before = saved([them('one'), them('two'), them('three')]);
    const joined = joinMessages(before, [them('three'), them('four')], LATER, 3);
    expect(texts(joined.messages)).toEqual(['two', 'three', 'four']);
    expect(joined.added).toBe(1);
  });
});

describe('the daily limits', () => {
  const day = { friend_request: 0, first_message: 0, follow_up: 0, comment: 0, like: 0 };

  it('warns only past a limit, naming each step past it', () => {
    expect(pastLimitWords({ ...day, friend_request: DAILY_LIMITS.friend_request })).toBeNull();
    expect(pastLimitWords({ ...day, like: DAILY_LIMITS.like + 1 })).toBe(
      'Past today’s limit for likes. Slow down, so Facebook doesn’t block you.',
    );
    expect(
      pastLimitWords({
        ...day,
        friend_request: 21,
        comment: 16,
        like: 41,
      }),
    ).toMatch(/^Past today’s limit for friend requests, comments and likes\./);
  });
});
