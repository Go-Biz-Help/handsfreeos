/**
 * Social Outreach's manifest and operations, held to the add-on rules (docs/addon-architecture.md), its playbook
 * templates, how a chat read again joins what was saved before, the warning past the daily limits, and how someone
 * who asked to be friends fits a playbook. Pure: no database.
 */
import { describe, expect, it } from 'vitest';
import {
  addonAiIssues,
  addonAssistantIssues,
  addonModuleIssues,
  allAddonAiTools,
  commands,
  manifestIssues,
  queries,
} from '../../src/server';
import { outreachAddon } from '../../src/addons/outreach/manifest';
import { POST_SEARCH_WORDS_MOST, wordsDue } from '../../src/addons/outreach/topics';
import { hashtagOf } from '../../src/addons/outreach/posts';
import {
  answerNextLabel,
  blankPlaybook,
  FIND_WORDS_PARTS,
  followUpGapsFor,
  hasWordsOn,
  paceOf,
  nextQuestionId,
  PLAYBOOK_TEMPLATES,
  PlaybookDetails,
  renumberQuestions,
  upgradePlaybookDetails,
  WORDS_PLATFORM_KEYS,
  type PlaybookQuestion,
} from '../../src/addons/outreach/playbooks';
import {
  checkedAssist,
  PlaybookAssistInput,
  playbookAssistPrompt,
} from '../../src/addons/outreach/playbook-assist';
import { OUTREACH_WORDS, playbookSectionTitle } from '../../src/addons/outreach/words';
import {
  bestFit,
  byFit,
  fitFor,
  placesIn,
  quoted,
  type FitPlaybook,
} from '../../src/addons/outreach/fit';
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

  it('gives the Assistant everything a person does on its screens, and nothing the extension or worker sends in', () => {
    const tools = new Map(allAddonAiTools([outreachAddonServer]).map((t) => [t.op.name, t]));
    // A new operation a person runs is the Assistant's unless the module lists it as one it never runs, with why:
    // what the extension reads off a network and sends in (only a person's own browser can see Facebook), and a note
    // of a draft being copied. The worker's own work is never a person's, so never a tool.
    expect(addonAssistantIssues([outreachAddonServer])).toEqual([]);
    expect(Object.keys(outreachAddonServer.notForTheAssistant ?? {})).toContain('outreach.lookup');
    // What reaches people, changes settings, adds a customer or can't be taken back waits for the person's OK.
    expect(
      [...tools.values()]
        .filter((t) => t.autonomy === 'confirm')
        .map((t) => t.op.name)
        .sort(),
    ).toEqual(
      [
        'outreach.ask.code',
        'outreach.ask.make',
        'outreach.ask.reply',
        'outreach.automation.save',
        'outreach.chat.keep',
        'outreach.checks.again',
        'outreach.client.set',
        'outreach.computer.remove',
        'outreach.country.decide',
        'outreach.country.unskip',
        'outreach.day.start',
        'outreach.messages.edit',
        'outreach.friend.set',
        'outreach.friends.cancel_all',
        'outreach.helpful.ok',
        // Retry and Retry all on any step handed over (decision 144): a message goes again, a request goes back on Today.
        'outreach.need.retry',
        'outreach.partner.mark',
        'outreach.partner.potential',
        'outreach.playbook.archive',
        'outreach.playbook.save',
        'outreach.profile.contact',
        'outreach.readiness.messages',
        'outreach.readiness.numbers',
        // Confirm or Delete on a friend request (decision 136): it reaches someone on their network.
        'outreach.request.answer',
        'outreach.send.approve',
        'outreach.send.retry',
        'outreach.wheels.end',
      ].sort(),
    );
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

  it('has ready-made playbooks after it: real estate agents, then home services, then coaches (decision 117)', () => {
    expect(Object.keys(PLAYBOOK_TEMPLATES)).toEqual([
      'crm_demos',
      'real_estate',
      'home_services',
      'coaching',
    ]);
    const made = [
      PLAYBOOK_TEMPLATES.real_estate,
      PLAYBOOK_TEMPLATES.home_services,
      PLAYBOOK_TEMPLATES.coaching,
    ];
    expect(made.map((t) => [t.details.goal, t.details.worksOnline])).toEqual([
      ['consult', false],
      ['estimate', false],
      ['call', true],
    ]);
    for (const { name, details: d } of made) {
      // Questions and openers to start with, and the words each of its networks looks with.
      expect(d.questions.length, name).toBeGreaterThanOrEqual(4);
      expect(d.openerStyles, name).toHaveLength(3);
      for (const p of WORDS_PLATFORM_KEYS)
        expect(d[FIND_WORDS_PARTS[p]]!.length > 0, `${name} on ${p}`).toBe(hasWordsOn(d, p));
      // Already the person's own: the AI writes none over them, and they're as a save keeps them.
      expect(wordsDue(d).networks, name).toEqual([]);
      expect(
        d.hashtags!.map((h) => hashtagOf(h)),
        name,
      ).toEqual(d.hashtags);
      for (const s of [...d.facebookSearches!, ...d.postSearches!])
        expect(s.split(' ').length, s).toBeLessThanOrEqual(POST_SEARCH_WORDS_MOST);
      // Everything blank that's the person's own: where, the link, and anything they must say.
      expect([d.area, d.link, d.disclaimer], name).toEqual([null, null, null]);
    }
    // A home or a neighborhood is never described by who it suits (fair housing).
    expect(PLAYBOOK_TEMPLATES.real_estate.details.avoid).toEqual(
      expect.arrayContaining(['Family-friendly', 'Safe neighborhood']),
    );
    // Selling skips the questions about buying; a coach leaves anyone in a crisis alone.
    const selling = PLAYBOOK_TEMPLATES.real_estate.details.questions[0]!.answers[1]!;
    expect(selling).toEqual({ label: 'Selling', tag: 'Seller', next: 'q4' });
    expect(PLAYBOOK_TEMPLATES.coaching.details.skip).toContain(
      'People going through a crisis or asking for medical help',
    );
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
    expect(now.pace).toEqual({
      messageAfterDays: 1,
      followUps: 6,
      followUpGaps: [1, 1, 1, 2, 2, 2],
    });
    // One in today's shape comes back as it was.
    const crm = PLAYBOOK_TEMPLATES.crm_demos.details;
    expect(upgradePlaybookDetails(crm)).toBe(crm);
  });

  it('reads one saved before it had a niche, a problem, proof and something useful, with them empty', () => {
    const { niche, problem, proof, usefulWhat, usefulLink, ...before } =
      PLAYBOOK_TEMPLATES.crm_demos.details;
    void [niche, problem, proof, usefulWhat, usefulLink];
    const now = PlaybookDetails.parse(upgradePlaybookDetails(before));
    expect(now).toMatchObject({
      niche: null,
      problem: null,
      proof: [],
      usefulWhat: null,
      usefulLink: null,
    });
    expect(now.questions).toEqual(PLAYBOOK_TEMPLATES.crm_demos.details.questions);
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

  it('keeps the pace to whole days within its limits, with 5 to 7 follow-ups', () => {
    const pace = (p: object) =>
      PlaybookDetails.safeParse({ ...blankPlaybook(), pace: p }).error?.issues.map((i) =>
        i.path.join('.'),
      );
    expect(
      pace({ messageAfterDays: 0, followUps: 5, followUpGaps: [1, 1, 1, 2, 14] }),
    ).toBeUndefined();
    expect(pace({ messageAfterDays: 15, followUps: 8 })).toEqual([
      'pace.messageAfterDays',
      'pace.followUps',
    ]);
    expect(pace({ messageAfterDays: 1.5, followUps: 6 })).toEqual(['pace.messageAfterDays']);
    expect(pace({ messageAfterDays: 1, followUps: 6, followUpGaps: [1, 1, 1, 2, 2] })).toEqual([
      'pace.followUpGaps',
    ]);
    expect(pace({ messageAfterDays: 1, followUps: 5, followUpGaps: [1, 1, 0, 2, 2] })).toEqual([
      'pace.followUpGaps.2',
    ]);
  });

  it('reads one saved before each network had its own words, with them empty (data version 8)', () => {
    const {
      facebookSearches,
      hashtags,
      postSearches,
      businessKinds,
      worksOnline,
      wordsWritten,
      ...before
    } = PLAYBOOK_TEMPLATES.crm_demos.details;
    void [facebookSearches, hashtags, postSearches, businessKinds, worksOnline, wordsWritten];
    expect(PlaybookDetails.parse(upgradePlaybookDetails(before))).toMatchObject({
      facebookSearches: [],
      hashtags: [],
      postSearches: [],
      businessKinds: [],
      worksOnline: null,
      wordsWritten: [],
    });
    // Its own words parse, each list once, and only the networks the AI writes for.
    const words = {
      ...blankPlaybook(),
      hashtags: ['austinroofing', 'hailrepair'],
      postSearches: ['missed calls'],
      businessKinds: ['Roofing Contractor'],
      worksOnline: true,
      wordsWritten: ['instagram', 'alignable'],
    };
    expect(PlaybookDetails.parse(words)).toEqual(words);
    const issues = (over: object) =>
      PlaybookDetails.safeParse({ ...blankPlaybook(), ...over }).error?.issues.map((i) =>
        i.path.join('.'),
      );
    expect(issues({ hashtags: ['austinroofing', 'AustinRoofing'] })).toEqual(['hashtags']);
    expect(issues({ businessKinds: ['x'.repeat(81)] })).toEqual(['businessKinds.0']);
    expect(issues({ wordsWritten: ['tiktok'] })).toEqual(['wordsWritten.0']);
  });

  it('lets go of the AI’s words on who a playbook is for, to be written around its topic (data version 9)', () => {
    const v8 = {
      ...blankPlaybook(),
      hashtags: ['roofingcontractor', 'rooferlife'],
      postSearches: ['missed calls'],
      businessKinds: ['Roofing Contractor'],
      wordsWritten: ['instagram', 'linkedin', 'alignable'],
    } as Record<string, unknown>;
    delete v8['facebookSearches'];
    // Instagram's and LinkedIn's lists the AI wrote go, to be written again; Alignable's kinds of business stay.
    expect(PlaybookDetails.parse(upgradePlaybookDetails(v8))).toMatchObject({
      facebookSearches: [],
      hashtags: [],
      postSearches: [],
      businessKinds: ['Roofing Contractor'],
      wordsWritten: ['alignable'],
    });
    // A list the person emptied stays empty and written, so the AI never writes it; their own words stay theirs.
    const kept = { ...v8, hashtags: [], postSearches: ['roof leak'], wordsWritten: ['instagram'] };
    expect(PlaybookDetails.parse(upgradePlaybookDetails(kept))).toMatchObject({
      hashtags: [],
      postSearches: ['roof leak'],
      wordsWritten: ['instagram'],
    });
    // Once upgraded, it reads the same again: words written after it stay.
    const now = { ...blankPlaybook(), hashtags: ['roofleakhelp'], wordsWritten: ['instagram'] };
    expect(PlaybookDetails.parse(upgradePlaybookDetails(now))).toEqual(now);
  });

  it('gives a network its own words only on a customers’ playbook that runs there', () => {
    const customers = {
      ...blankPlaybook(),
      platforms: ['facebook' as const, 'instagram' as const],
    };
    expect(hasWordsOn(customers, 'instagram')).toBe(true);
    expect(hasWordsOn(customers, 'alignable')).toBe(false);
    expect(hasWordsOn({ ...customers, goal: 'partner' }, 'instagram')).toBe(false);
    expect(playbookSectionTitle('hashtags', customers)).toBe('Hashtags on Instagram');
    expect(OUTREACH_WORDS.findWords.written(5)).toBe(
      'The AI wrote these around your topic: the problem you solve and running that kind of business. Change any; it looks at 5 a day, in turn.',
    );
  });

  it('helps with each network’s own words: hashtags as people tag them, and whether it works online', () => {
    const input = PlaybookAssistInput.parse({
      part: 'hashtags',
      mode: 'suggest',
      draft: { name: 'Roofers', hashtags: ['#AustinRoofing'], worksOnline: false },
    });
    expect(
      checkedAssist(
        {
          options: ['#Hail Repair!', 'austinroofing', '##', 'roofleak', 'RoofLeak'],
          questions: [],
        },
        input,
      ).options,
    ).toEqual(['hailrepair', 'roofleak']);
    const prompt = playbookAssistPrompt(input, 'Summit Roofing');
    expect(prompt).toContain('Works online: no');
    expect(prompt).toContain('#AustinRoofing');
    expect(prompt).toContain('a few local ones for the area');
  });

  it('moves the follow-ups saved as one number into 6, keeping a pace the business changed', () => {
    // Left at the start (3 days): the new pace, a day apart for three, then two.
    expect(paceOf({ messageAfterDays: 2, followUpAfterDays: 3 })).toEqual({
      messageAfterDays: 2,
      followUps: 6,
      followUpGaps: [1, 1, 1, 2, 2, 2],
    });
    // Changed to 5: every follow-up 5 quiet days apart, as the business had it.
    expect(paceOf({ messageAfterDays: 1, followUpAfterDays: 5 }).followUpGaps).toEqual([
      5, 5, 5, 5, 5, 5,
    ]);
    // A save that leaves the follow-ups out is read with the starting ones.
    expect(paceOf({ messageAfterDays: 1 })).toEqual({
      messageAfterDays: 1,
      followUps: 6,
      followUpGaps: [1, 1, 1, 2, 2, 2],
    });
    expect(followUpGapsFor(7)).toEqual([1, 1, 1, 2, 2, 2, 2]);
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

describe('how someone fits a playbook', () => {
  const crm: FitPlaybook = {
    id: 'crm',
    name: 'CRM demos',
    details: {
      ...PLAYBOOK_TEMPLATES.crm_demos.details,
      skip: ['“Realtor”', 'Competitors'],
      area: 'within 30 miles of Austin, TX',
    },
  };
  const facts = (lines: string[], mutualFriends: number | null = null, groupName = null) => ({
    lines,
    mutualFriends,
    groupName,
  });

  it('reads the words in quotes, and the places an area names', () => {
    expect(quoted('“Owner”, “Founder” or "CEO" in their intro')).toEqual([
      'Owner',
      'Founder',
      'CEO',
    ]);
    expect(placesIn('Austin and Round Rock')).toEqual(['Austin', 'Round Rock']);
    expect(placesIn('within 30 miles of Denver, CO')).toEqual(['Denver']);
    expect(placesIn('the Phoenix metro area')).toEqual(['Phoenix']);
    expect(placesIn('Texas')).toEqual(['Texas']);
    expect(placesIn(null)).toEqual([]);
  });

  it('counts the signs in quotes, the area, mutual friends and the group, and says why', () => {
    expect(fitFor(crm, facts(['Owner at Cole Landscaping', 'Lives in Austin, Texas'], 12))).toEqual(
      {
        level: 'good',
        score: 6,
        playbookId: 'crm',
        playbookName: 'CRM demos',
        reasons: ['“Owner” on their profile', 'In Austin', '12 mutual friends'],
      },
    );
    // Whole words only: "Ownership" isn't "Owner".
    expect(fitFor(crm, facts(['Ownership coach'], 1)).reasons).toEqual(['1 mutual friend']);
    expect(fitFor(crm, facts([])).level).toBe('unknown');
    expect(
      fitFor(null, { lines: [], mutualFriends: null, groupName: 'Westfield Makers Market' }),
    ).toMatchObject({ level: 'maybe', reasons: ['Found in Westfield Makers Market'] });
  });

  it('skips who the playbook says to, whatever else fits', () => {
    expect(fitFor(crm, facts(['Owner and Realtor in Austin'], 50))).toMatchObject({
      level: 'skip',
      reasons: ['“Realtor” on their profile'],
    });
  });

  it('takes the playbook they fit best, and orders requests best first', () => {
    const roofing: FitPlaybook = {
      id: 'roof',
      name: 'Roofing estimates',
      details: { signs: ['“Homeowner”'], skip: [], area: 'Round Rock' },
    };
    const fit = bestFit([crm, roofing], facts(['Homeowner in Round Rock']));
    expect(fit).toMatchObject({ playbookName: 'Roofing estimates', score: 4 });
    const list = [
      { name: 'A', fit: { score: 0 }, mutualFriends: 3 },
      { name: 'B', fit: { score: 4 }, mutualFriends: 0 },
      { name: 'C', fit: { score: 0 }, mutualFriends: 9 },
      { name: 'D', fit: null, mutualFriends: null },
    ];
    expect(byFit(list).map((x) => x.name)).toEqual(['B', 'C', 'A', 'D']);
  });
});
