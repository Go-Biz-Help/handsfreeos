/**
 * Quick setup for the AI teammate (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md): the kinds of business and what
 * each picks, the screens and when they show, carrying on part way through, where the answers start, the plan Save
 * carries out with its words, the summary and the test chat's questions.
 */
import { describe, expect, it } from 'vitest';
import {
  AI_SETUP_FACT_TAG,
  AI_SETUP_FOUND_KEY,
  AI_SETUP_FOUND_LIMITS,
  AI_SETUP_NEW_CALENDAR,
  AI_SETUP_READ_AGAIN_MS,
  AI_SETUP_READ_ASKED_KEY,
  AI_SETUP_READING_MS,
  AI_SETUP_STEPS,
  AI_SETUP_TONE_TEXTS,
  AiSetupAnswers,
  aiSetupFoundFrom,
  aiSetupFoundOf,
  aiSetupNextStep,
  aiSetupOf,
  aiSetupPreviousStep,
  aiSetupProblems,
  aiSetupReadDue,
  aiSetupReading,
  aiSetupSteps,
  aiSetupSummary,
  aiSetupTestQuestions,
  applyTeammatePatch,
  asksAboutWhoSomeoneIs,
  emptyKnowledgeProfile,
  factAnswersOf,
  laterAiSetupStep,
  planAiSetup,
  quickFactsFor,
  resumeAiSetup,
  SETUP_KIND_INFO,
  SETUP_KINDS,
  setupKindOf,
  startingAiSetupAnswers,
  storedAiSetup,
  teammateConfigFromPreset,
  teammateFromAiSetup,
  toneOfProfile,
  zipCodesOnly,
  type AiSetupAnswersInput,
  type AiSetupFound,
  type AiSetupSiteReading,
  type AiSetupState,
  type TeammatePatch,
} from '../src';

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DALE = uid(1);
const TEAMMATE = uid(10);
const CALENDAR = uid(20);
const WIDGET = uid(30);

const WEEKDAYS_8_TO_5 = [1, 2, 3, 4, 5].map((day) => ({ day, start: '08:00', end: '17:00' }));

/** A business on its first day, of the given industry. */
function business(patch: Partial<AiSetupState> = {}): AiSetupState {
  const industry = patch.industry === undefined ? 'hvac' : patch.industry;
  return {
    businessName: 'Lone Star HVAC',
    industry,
    kind: setupKindOf(industry),
    goal: null,
    website: null,
    timeZone: 'America/Chicago',
    openHours: null,
    teammate: null,
    profile: emptyKnowledgeProfile(),
    facts: [],
    services: [],
    calendars: [],
    territories: 0,
    emailAddress: null,
    chat: null,
    number: true,
    textingReady: true,
    scan: { state: 'none', pending: 0 },
    found: null,
    reading: false,
    ...patch,
  };
}

/** A business that has a teammate with these settings. */
function withTeammate(patch: TeammatePatch = {}, state: Partial<AiSetupState> = {}): AiSetupState {
  const config = applyTeammatePatch(teammateConfigFromPreset('blank', { industry: 'hvac' }), patch);
  return business({
    teammate: { id: TEAMMATE, name: config.identity.name, status: 'training', revision: 3, config },
    ...state,
  });
}

const answers = (patch: AiSetupAnswersInput = {}): AiSetupAnswers => AiSetupAnswers.parse(patch);

const SITE = 'https://lonestarhvac.com';

/** What the model said about the fixture's pages, repeats, slips and all. */
const READING: AiSetupSiteReading = {
  description: '  We repair and replace heating and air conditioning\n for homes across Austin. ',
  services: [
    { name: 'AC repair', description: 'Same day when you call before noon.' },
    { name: ' ac  REPAIR ', description: 'The same service again.' },
    { name: '   ', description: 'A service without a name.' },
    { name: 'Furnace installation', description: 'With a ten-year parts warranty. '.repeat(20) },
    ...Array.from({ length: 15 }, (_, i) => ({ name: `Service ${i + 1}`, description: '' })),
  ],
  area: 'Austin, Round Rock and Pflugerville',
  hours: [
    ...[1, 2, 3, 4, 5].map((day) => ({ day, start: '7:00', end: '18:00' })),
    { day: 6, start: '08:00', end: '14:00' },
  ],
  facts: [
    { key: 'emergency', answer: 'yes' },
    { key: 'warranty', answer: ' YES' },
    // A second answer for the same question: the first counts.
    { key: 'emergency', answer: 'no' },
    { key: 'financing', answer: 'maybe' },
    // Not a question this business is asked.
    { key: 'walk_ins', answer: 'yes' },
  ],
  questions: [
    { question: 'What needs fixing?', kind: 'choice', options: ['Cooling', 'Heating', 'Both'] },
    { question: 'Do you have kids at home?', kind: 'yes_no', options: [] },
    { question: 'What’s the address?', kind: 'text', options: [] },
    { question: 'what needs  fixing?', kind: 'text', options: [] },
    { question: 'Do you own the home?', kind: 'yes_no', options: ['Yes', 'No'] },
    { question: 'When should we come?', kind: 'whenever', options: [] },
    { question: 'Which unit?', kind: 'choice', options: ['Upstairs'] },
  ],
};

/** The quick facts an HVAC business is asked. */
const HVAC_FACTS = quickFactsFor('hvac').map((f) => f.key);

const found = (patch: Partial<AiSetupFound> = {}): AiSetupFound => ({
  ...aiSetupFoundFrom(READING, SITE, HVAC_FACTS),
  at: '2026-10-06T00:00:00.000Z',
  ...patch,
});

describe('kinds of business', () => {
  it('come from the industry, with anything the lists don’t name as other', () => {
    expect(setupKindOf('plumbing')).toBe('home');
    expect(setupKindOf('hair_salon')).toBe('salon');
    expect(setupKindOf('pet_grooming')).toBe('salon');
    expect(setupKindOf('dental')).toBe('office');
    expect(setupKindOf('law_firm')).toBe('office');
    expect(setupKindOf('real_estate')).toBe('real_estate');
    expect(setupKindOf('insurance')).toBe('insurance');
    expect(setupKindOf('food_truck')).toBe('other');
    expect(setupKindOf(null)).toBe('other');
  });

  it('ask health offices about patients and insurance, and other offices about clients', () => {
    const keys = (industry: string) => quickFactsFor(industry).map((f) => f.key);
    expect(keys('dental')).toContain('new_patients');
    expect(keys('dental')).toContain('takes_insurance');
    expect(keys('dental')).not.toContain('new_clients');
    expect(keys('law_firm')).toContain('new_clients');
    expect(keys('law_firm')).not.toContain('new_patients');
    expect(keys('law_firm')).not.toContain('takes_insurance');
  });

  it('each ask their quick facts once, ending with Spanish', () => {
    for (const kind of SETUP_KINDS) {
      const facts = SETUP_KIND_INFO[kind].facts;
      expect(facts.at(-1)?.key).toBe('spanish');
      expect(new Set(facts.map((f) => f.key)).size).toBe(facts.length);
      expect(new Set(facts.map((f) => f.title)).size).toBe(facts.length);
    }
  });

  it('start from qualifying questions that never ask who someone is, and send without apostrophes', () => {
    for (const kind of SETUP_KINDS) {
      const questions = SETUP_KIND_INFO[kind].questions;
      expect(questions.length).toBeGreaterThan(0);
      for (const q of questions) {
        const words = [q.question, ...(q.options ?? [])].join(' ');
        expect(asksAboutWhoSomeoneIs(words)).toBe(false);
        expect(words).not.toMatch(/[’']/);
      }
      // Each reads as a teammate's question.
      const config = applyTeammatePatch(teammateConfigFromPreset('blank'), {
        qualify: { questions: [...questions] },
      });
      expect(config.qualify.questions).toHaveLength(questions.length);
    }
  });

  it('spot a question about who someone is, as whole words only', () => {
    expect(asksAboutWhoSomeoneIs('Do you have kids?')).toBe(true);
    expect(asksAboutWhoSomeoneIs('Which school district do you want?')).toBe(true);
    expect(asksAboutWhoSomeoneIs('Is it a  safe   neighborhood?')).toBe(true);
    expect(asksAboutWhoSomeoneIs('Do you live in Sussex County?')).toBe(false);
    expect(asksAboutWhoSomeoneIs('What ZIP code is the job in?')).toBe(false);
  });

  it('hand insurance claims and coverage to a person', () => {
    const state = business({ industry: 'insurance' });
    const config = teammateFromAiSetup(state, startingAiSetupAnswers(state));
    expect(config.handOff.sensitiveTopics).toEqual(
      expect.arrayContaining(['Insurance claims', 'What a policy covers']),
    );
  });
});

describe('the answers', () => {
  it('start from plain picks', () => {
    const a = answers();
    expect(a).toMatchObject({
      jobs: [],
      name: 'Ava',
      disclosure: 'first_message',
      tone: 'friendly',
      answerWhen: 'always',
      allowPrices: false,
      chat: false,
    });
    expect(a.openHours).toEqual(WEEKDAYS_8_TO_5);
  });

  it('refuse a job twice, more than three top questions, and a finding twice', () => {
    expect(AiSetupAnswers.safeParse({ jobs: ['reply', 'reply'] }).success).toBe(false);
    const q = { question: 'Do you do weekends?', answer: 'Yes, Saturdays.' };
    expect(AiSetupAnswers.safeParse({ topQuestions: [q, q, q, q] }).success).toBe(false);
    expect(AiSetupAnswers.safeParse({ keepFindings: [uid(5), uid(5)] }).success).toBe(false);
  });

  it('refuse open hours that overlap', () => {
    const r = AiSetupAnswers.safeParse({
      openHours: [
        { day: 1, start: '08:00', end: '12:00' },
        { day: 1, start: '11:00', end: '17:00' },
      ],
    });
    expect(r.success).toBe(false);
  });
});

describe('the screens', () => {
  const noSite = { website: false, chat: false };
  const site = { website: true, chat: false };

  it('show qualifying questions only when Ava asks them, and the chat only for a website without one', () => {
    expect(aiSetupSteps({ jobs: ['reply'] }, noSite)).not.toContain('qualify');
    expect(aiSetupSteps({ jobs: ['qualify'] }, noSite)).toContain('qualify');
    expect(aiSetupSteps({ jobs: [] }, noSite)).not.toContain('chat');
    expect(aiSetupSteps({ jobs: [] }, site)).toContain('chat');
    expect(aiSetupSteps({ jobs: [] }, { website: true, chat: true })).not.toContain('chat');
    expect(aiSetupSteps({ jobs: ['qualify'] }, site)).toEqual([...AI_SETUP_STEPS]);
  });

  it('skip the hidden ones going forward and back', () => {
    expect(aiSetupNextStep('learned', { jobs: ['reply'] }, noSite)).toBe('loop');
    expect(aiSetupNextStep('loop', { jobs: ['reply'] }, noSite)).toBe('try');
    expect(aiSetupPreviousStep('try', { jobs: ['reply'] }, noSite)).toBe('loop');
    expect(aiSetupPreviousStep('loop', { jobs: ['qualify'] }, noSite)).toBe('qualify');
    expect(aiSetupNextStep('try', { jobs: [] }, site)).toBeNull();
    expect(aiSetupPreviousStep('business', { jobs: [] }, site)).toBeNull();
  });

  it('keep the furthest screen reached', () => {
    expect(laterAiSetupStep(null, 'jobs')).toBe('jobs');
    expect(laterAiSetupStep('hours', 'jobs')).toBe('hours');
    expect(laterAiSetupStep('jobs', 'hours')).toBe('hours');
  });
});

describe('what the business keeps part way through', () => {
  const mark = { at: '2026-10-05T22:00:00.000Z', by: DALE };

  it('reads forgivingly: answers that no longer read count as never given', () => {
    expect(aiSetupOf({})).toEqual({
      draft: null,
      reached: null,
      kind: null,
      started: null,
      finished: null,
      runs: 0,
    });
    expect(aiSetupOf({ aiSetup: { draft: { jobs: ['fly'] }, reached: 'jobs' } }).draft).toBeNull();
    expect(aiSetupOf({ aiSetup: { draft: {}, reached: 'nowhere' } }).draft).toBeNull();
    expect(aiSetupOf({ aiSetup: { runs: 1.5, started: { at: 'yesterday' } } })).toMatchObject({
      runs: 0,
      started: null,
    });
  });

  it('stores nothing empty, and reads back what it stored', () => {
    const record = {
      draft: answers({ jobs: ['reply'] }),
      reached: 'jobs' as const,
      kind: 'home' as const,
      started: mark,
      finished: null,
      runs: 2,
    };
    const stored = storedAiSetup(record);
    expect(stored).not.toHaveProperty('finished');
    expect(aiSetupOf({ aiSetup: stored })).toEqual(record);
    expect(storedAiSetup({ ...record, draft: null, reached: null, kind: null })).toEqual({
      started: mark,
      runs: 2,
    });
  });

  it('carries on with the screens finished, and today’s picks for the rest', () => {
    const state = business();
    const starting = startingAiSetupAnswers(state);
    const draft = answers({
      ...starting,
      jobs: ['answer'],
      description: 'We fix AC.',
      name: 'Max',
    });
    const resumed = resumeAiSetup(starting, { draft, reached: 'about', kind: 'home' }, 'home');
    expect(resumed.jobs).toEqual(['answer']);
    expect(resumed.description).toBe('We fix AC.');
    // "Meet Ava" wasn't finished, so its answers are today's picks.
    expect(resumed.name).toBe('Ava');
    expect(resumeAiSetup(starting, { draft: null, reached: null, kind: null }, 'home')).toBe(
      starting,
    );
  });

  it('picks again what the kind of business picks when the kind changed', () => {
    const salon = business({ industry: 'hair_salon' });
    const starting = startingAiSetupAnswers(salon);
    const draft = answers({
      ...starting,
      jobs: ['reply'],
      description: 'Haircuts.',
      facts: { free_estimates: 'yes' },
      name: 'Max',
    });
    const resumed = resumeAiSetup(starting, { draft, reached: 'meet', kind: 'home' }, 'salon');
    expect(resumed.jobs).toEqual(starting.jobs);
    expect(resumed.facts).toEqual(starting.facts);
    expect(resumed.description).toBe('Haircuts.');
    expect(resumed.name).toBe('Max');
  });
});

describe('where the answers start', () => {
  it('ticks the goal’s jobs and the kind’s', () => {
    expect(startingAiSetupAnswers(business({ goal: 'booked' })).jobs).toEqual([
      'answer',
      'book',
      'follow_up',
    ]);
    expect(startingAiSetupAnswers(business({ industry: 'real_estate' })).jobs).toEqual([
      'reply',
      'answer',
      'qualify',
      'follow_up',
    ]);
    expect(startingAiSetupAnswers(business({ industry: 'dental' })).jobs).toEqual([
      'reply',
      'answer',
      'book',
      'follow_up',
    ]);
  });

  it('starts from the teammate a business has', () => {
    const state = withTeammate({
      identity: { name: 'Max', disclosure: 'when_asked' },
      respond: { enabled: true, newLeads: { enabled: false } },
      answer: { enabled: true },
      book: { enabled: true },
      followUp: { enabled: true },
      hours: { mode: 'after_hours' },
      qualify: { questions: [{ id: 'roof', question: 'How old is the roof?', kind: 'text' }] },
    });
    const a = startingAiSetupAnswers(state);
    expect(a.jobs).toEqual(['answer', 'book', 'follow_up']);
    expect(a).toMatchObject({ name: 'Max', disclosure: 'when_asked', answerWhen: 'after_hours' });
    expect(a.questions.map((q) => q.id)).toEqual(['roof']);
  });

  it('starts from the business profile, else the booking services', () => {
    const profile = {
      ...emptyKnowledgeProfile(),
      description: 'Heating and cooling in Katy.',
      services: [{ name: 'AC repair', description: 'Same week', price: '$89 visit' }],
      serviceArea: 'Katy, Cypress',
      allowPrices: true,
    };
    const a = startingAiSetupAnswers(business({ profile }));
    expect(a).toMatchObject({
      description: 'Heating and cooling in Katy.',
      services: [{ name: 'AC repair', description: 'Same week' }],
      area: 'Katy, Cypress',
      allowPrices: true,
    });
    expect(
      startingAiSetupAnswers(business({ services: [{ id: uid(50), name: 'Tune-up' }] })).services,
    ).toEqual([{ name: 'Tune-up', description: '' }]);
  });

  it('fills what the business hasn’t said from what Ava read on its website', () => {
    const a = startingAiSetupAnswers(business({ website: SITE, found: found() }));
    expect(a.description).toBe(
      'We repair and replace heating and air conditioning for homes across Austin.',
    );
    expect(a.services.slice(0, 2).map((x) => x.name)).toEqual([
      'AC repair',
      'Furnace installation',
    ]);
    expect(a.area).toBe('Austin, Round Rock and Pflugerville');
    expect(a.openHours).toContainEqual({ day: 1, start: '07:00', end: '18:00' });
    expect(a.questions.map((q) => q.question)).toEqual([
      'What needs fixing?',
      'Do you own the home?',
      'When should we come?',
    ]);
    // What the business has said, and the questions its teammate asks, come first.
    const profile = {
      ...emptyKnowledgeProfile(),
      description: 'Our own words.',
      serviceArea: 'Katy',
    };
    const said = startingAiSetupAnswers(
      withTeammate(
        {
          qualify: { questions: [{ id: 'roof', question: 'How old is the roof?', kind: 'text' }] },
        },
        { website: SITE, found: found(), profile, openHours: WEEKDAYS_8_TO_5 },
      ),
    );
    expect(said).toMatchObject({ description: 'Our own words.', area: 'Katy' });
    expect(said.openHours).toEqual(WEEKDAYS_8_TO_5);
    expect(said.questions.map((q) => q.id)).toEqual(['roof']);
    // Nothing read: the kind's starters, and the usual hours.
    const none = startingAiSetupAnswers(
      business({ found: found({ questions: [], openHours: null }) }),
    );
    expect(none.questions).toEqual(startingAiSetupAnswers(business()).questions);
    expect(none.openHours).toEqual(startingAiSetupAnswers(business()).openHours);
  });

  it('answers the quick facts the website answers, unless the business has its own answer', () => {
    expect(startingAiSetupAnswers(business({ website: SITE, found: found() })).facts).toEqual({
      emergency: 'yes',
      warranty: 'yes',
    });
    // What quick setup saved before stands, and a fact a person rewrote is theirs.
    const facts = [
      {
        id: uid(60),
        title: 'Emergency service',
        body: 'We don’t take emergency calls.',
        tags: [AI_SETUP_FACT_TAG],
        status: 'published' as const,
      },
      {
        id: uid(61),
        title: 'Warranty',
        body: 'Two years on parts and labor.',
        tags: [AI_SETUP_FACT_TAG],
        status: 'published' as const,
      },
    ];
    expect(
      startingAiSetupAnswers(business({ website: SITE, found: found(), facts })).facts,
    ).toEqual({ emergency: 'no' });
  });

  it('keeps a tone of voice a person wrote', () => {
    expect(toneOfProfile('', 'office')).toBe('professional');
    expect(toneOfProfile(AI_SETUP_TONE_TEXTS.short, 'home')).toBe('short');
    expect(toneOfProfile('Like a Texan neighbor', 'home')).toBe('keep');
  });

  it('offers the chat to a website without one', () => {
    expect(startingAiSetupAnswers(business()).chat).toBe(false);
    expect(startingAiSetupAnswers(business({ website: 'https://lonestarhvac.com' })).chat).toBe(
      true,
    );
    expect(
      startingAiSetupAnswers(
        business({ website: 'https://lonestarhvac.com', chat: { id: WIDGET, name: 'x' } }),
      ).chat,
    ).toBe(false);
  });

  it('takes an agency’s saved answers only for a business without a teammate', () => {
    const template = {
      ...answers(),
      jobs: ['reply' as const],
      name: 'Sam',
      tone: 'short' as const,
    };
    expect(startingAiSetupAnswers(business(), template)).toMatchObject({
      jobs: ['reply'],
      name: 'Sam',
      tone: 'short',
    });
    expect(startingAiSetupAnswers(withTeammate(), template).name).toBe('Ava');
  });

  it('reads the quick facts back from what it saved, never from one a person rewrote', () => {
    const fact = (title: string, body: string, status: 'published' | 'archived' = 'published') => ({
      id: uid(title.length + 100),
      title,
      body,
      tags: [AI_SETUP_FACT_TAG],
      status,
    });
    const state = business({
      facts: [
        fact('Free estimates', 'We give free estimates.'),
        fact('Financing', 'We don’t offer financing.'),
        fact('Warranty', 'Two years on parts and labor.'),
        fact('Licensed and insured', 'We’re licensed and insured.', 'archived'),
      ],
    });
    expect(factAnswersOf(state)).toEqual({
      free_estimates: 'yes',
      financing: 'no',
      licensed: 'no',
    });
  });
});

describe('what Ava read on the website', () => {
  it('keeps the services once each, named, trimmed and at most twelve', () => {
    const { services } = aiSetupFoundFrom(READING, SITE);
    expect(services).toHaveLength(AI_SETUP_FOUND_LIMITS.services);
    expect(services[0]).toEqual({
      name: 'AC repair',
      description: 'Same day when you call before noon.',
    });
    expect(services[1]!.name).toBe('Furnace installation');
    expect(services[1]!.description.length).toBeLessThanOrEqual(
      AI_SETUP_FOUND_LIMITS.serviceDescription,
    );
    expect(services[1]!.description.endsWith('…')).toBe(true);
    expect(services.filter((x) => x.name.toLowerCase() === 'ac repair')).toHaveLength(1);
  });

  it('keeps questions that never ask who someone is, send without apostrophes, and each once', () => {
    const { questions } = aiSetupFoundFrom(READING, SITE);
    expect(questions).toEqual([
      expect.objectContaining({
        id: 'what_needs_fixing',
        question: 'What needs fixing?',
        kind: 'choice',
        options: ['Cooling', 'Heating', 'Both'],
      }),
      expect.objectContaining({ id: 'do_you_own_the_home', kind: 'yes_no', options: [] }),
      // A kind it doesn't know is a question answered in words.
      expect.objectContaining({ id: 'when_should_we_come', kind: 'text' }),
    ]);
    const many = aiSetupFoundFrom(
      {
        ...READING,
        questions: Array.from({ length: 9 }, (_, i) => ({
          question: `Question number ${i + 1}?`,
          kind: 'text',
          options: [],
        })),
      },
      SITE,
    );
    expect(many.questions).toHaveLength(AI_SETUP_FOUND_LIMITS.questions);
  });

  it('keeps open hours only when they can be the business’s open hours', () => {
    expect(aiSetupFoundFrom(READING, SITE).openHours).toEqual([
      ...[1, 2, 3, 4, 5].map((day) => ({ day, start: '07:00', end: '18:00' })),
      { day: 6, start: '08:00', end: '14:00' },
    ]);
    const hours = (h: AiSetupSiteReading['hours']) =>
      aiSetupFoundFrom({ ...READING, hours: h }, SITE).openHours;
    expect(hours([])).toBeNull();
    expect(hours([{ day: 1, start: '9 AM', end: '5 PM' }])).toBeNull();
    expect(hours([{ day: 8, start: '09:00', end: '17:00' }])).toBeNull();
    expect(
      hours([
        { day: 1, start: '08:00', end: '12:00' },
        { day: 1, start: '11:00', end: '17:00' },
      ]),
    ).toBeNull();
  });

  it('keeps the quick facts the website answers: only the ones asked, yes or no, the first answer each', () => {
    expect(found().facts).toEqual({ emergency: 'yes', warranty: 'yes' });
    expect(aiSetupFoundFrom(READING, SITE).facts).toEqual({});
  });

  it('is being read for a little while after it’s asked for, until it’s kept', () => {
    const now = new Date('2026-10-06T00:30:00.000Z');
    const asked = (ago: number, url = SITE) => ({
      url: SITE,
      settings: {
        [AI_SETUP_READ_ASKED_KEY]: { url, at: new Date(now.getTime() - ago).toISOString() },
      },
    });
    const read = {
      url: SITE,
      settings: { ...asked(1_000).settings, [AI_SETUP_FOUND_KEY]: found() },
    };
    expect(aiSetupReading(asked(1_000), now)).toBe(true);
    expect(aiSetupReading(asked(AI_SETUP_READING_MS), now)).toBe(false);
    expect(aiSetupReading(asked(1_000, 'https://lonestarhvac.net'), now)).toBe(false);
    expect(aiSetupReading({ url: SITE, settings: {} }, now)).toBe(false);
    expect(aiSetupReading(read, now)).toBe(false);
    // Asked again only when nothing came of it for a while.
    expect(aiSetupReadDue(asked(AI_SETUP_READING_MS), now)).toBe(false);
    expect(aiSetupReadDue(asked(AI_SETUP_READ_AGAIN_MS), now)).toBe(true);
    expect(aiSetupReadDue({ url: SITE, settings: null }, now)).toBe(true);
    expect(aiSetupReadDue(read, now)).toBe(false);
  });

  it('counts only while that address is still the website', () => {
    const kept = found();
    const settings = { other: true, [AI_SETUP_FOUND_KEY]: kept };
    expect(aiSetupFoundOf({ url: SITE, settings })).toEqual(kept);
    expect(aiSetupFoundOf({ url: 'https://lonestarhvac.net', settings })).toBeNull();
    expect(aiSetupFoundOf({ url: SITE, settings: {} })).toBeNull();
    expect(aiSetupFoundOf({ url: SITE, settings: null })).toBeNull();
    expect(
      aiSetupFoundOf({ url: SITE, settings: { [AI_SETUP_FOUND_KEY]: 'nonsense' } }),
    ).toBeNull();
  });
});

describe('the plan Save carries out', () => {
  it('sets up a new teammate, with the business’s hours, profile, facts and a booking calendar', () => {
    const state = business({ website: 'https://www.lonestarhvac.com' });
    const plan = planAiSetup(
      state,
      answers({
        ...startingAiSetupAnswers(state),
        jobs: ['reply', 'answer', 'book', 'follow_up'],
        description: 'Heating and cooling in Katy.',
        services: [{ name: 'AC repair' }, { name: 'Furnace tune-up' }],
        area: '77494, 77433',
        facts: { free_estimates: 'yes', licensed: 'no' },
        topQuestions: [{ question: 'Do you work weekends?', answer: 'Saturdays, 8 to noon.' }],
        chat: true,
      }),
    );
    expect(plan.creates).toBe(true);
    expect(plan.changes[0]).toBe('Sets up Ava, your AI teammate');
    expect(plan.openHours).toEqual(WEEKDAYS_8_TO_5);
    expect(plan.profile).toMatchObject({
      description: 'Heating and cooling in Katy.',
      serviceArea: '77494, 77433',
      tone: AI_SETUP_TONE_TEXTS.friendly,
    });
    expect(plan.profile?.hours).not.toBe('');
    // A No that isn't worth telling customers keeps nothing.
    expect(plan.facts.create).toEqual([
      { key: 'free_estimates', title: 'Free estimates', body: 'We give free estimates.' },
    ]);
    expect(plan.faqs).toHaveLength(1);
    expect(plan.booking).toEqual({
      services: [
        { name: 'AC repair', description: '' },
        { name: 'Furnace tune-up', description: '' },
      ],
      calendar: 'Service calls',
      zipCodes: ['77494', '77433'],
    });
    expect(plan.chat).toBe(true);
    expect(plan.changes).toContain('Adds a website chat for lonestarhvac.com');
    expect(plan.changes).toContain(
      'Makes the booking calendar Service calls, with your services on it',
    );
    expect(plan.teammate.book).toMatchObject({
      enabled: true,
      calendarIds: [AI_SETUP_NEW_CALENDAR],
    });
    expect(plan.teammate.channels).toMatchObject({ sms: true, chat: true });
    expect(plan.teammate.handOff.alerts.email).toBe(false);
  });

  it('changes nothing when nothing was changed', () => {
    const state = withTeammate(
      { book: { enabled: true, calendarIds: [CALENDAR] } },
      {
        website: 'https://lonestarhvac.com',
        chat: { id: WIDGET, name: 'lonestarhvac.com' },
        openHours: WEEKDAYS_8_TO_5,
        calendars: [{ id: CALENDAR, name: 'Service calls' }],
        profile: {
          ...emptyKnowledgeProfile(),
          description: 'Heating and cooling.',
          services: [{ name: 'AC repair', description: '', price: '$89' }],
          hours: 'Weekdays 8 to 5',
          tone: 'Like a Texan neighbor',
        },
      },
    );
    const plan = planAiSetup(state, startingAiSetupAnswers(state));
    expect(plan.changes).toEqual([]);
    expect(plan.profile).toBeNull();
    expect(plan.openHours).toBeNull();
    expect(plan.teammate).toEqual(state.teammate!.config);
  });

  it('keeps a service’s price, and words what changes on the teammate', () => {
    const state = withTeammate(
      { respond: { enabled: true, newLeads: { enabled: true } }, answer: { enabled: true } },
      {
        openHours: WEEKDAYS_8_TO_5,
        profile: {
          ...emptyKnowledgeProfile(),
          services: [{ name: 'AC Repair', description: '', price: '$89' }],
          hours: 'Weekdays 8 to 5',
          tone: AI_SETUP_TONE_TEXTS.friendly,
        },
      },
    );
    const plan = planAiSetup(
      state,
      answers({
        ...startingAiSetupAnswers(state),
        services: [{ name: 'ac repair' }, { name: 'Duct cleaning' }],
        name: 'Max',
        jobs: ['answer', 'follow_up'],
      }),
    );
    expect(plan.profile?.services).toEqual([
      { name: 'ac repair', description: '', price: '$89' },
      { name: 'Duct cleaning', description: '', price: null },
    ]);
    expect(plan.changes).toEqual([
      'Business profile: services updated',
      'Name: Ava → Max',
      'Respond: on → off',
      'Messages new leads: on → off',
      'Follows up: off → on',
    ]);
    expect(plan.changes.some((l) => l.startsWith('Sets up'))).toBe(false);
  });

  it('never rewrites a fact a person rewrote, and archives a Yes that became a No', () => {
    const fact = (n: number, title: string, body: string) => ({
      id: uid(n),
      title,
      body,
      tags: [AI_SETUP_FACT_TAG],
      status: 'published' as const,
    });
    const state = business({
      facts: [
        fact(61, 'Warranty', 'Two years on parts and labor.'),
        fact(62, 'Licensed and insured', 'We’re licensed and insured.'),
        fact(63, 'Financing', 'We offer financing.'),
      ],
    });
    const plan = planAiSetup(
      state,
      answers({
        ...startingAiSetupAnswers(state),
        facts: { warranty: 'no', licensed: 'no', financing: 'no' },
      }),
    );
    expect(plan.facts.create).toEqual([]);
    expect(plan.facts.update).toEqual([
      { id: uid(63), key: 'financing', title: 'Financing', body: 'We don’t offer financing.' },
    ]);
    expect(plan.facts.archive).toEqual([{ id: uid(62), title: 'Licensed and insured' }]);
  });

  it('makes no calendar when one takes bookings, and no service area for a list of towns', () => {
    const state = business({ calendars: [{ id: CALENDAR, name: 'Service calls' }] });
    const plan = planAiSetup(
      state,
      answers({ jobs: ['book'], services: [{ name: 'AC repair' }], area: 'Katy, Cypress' }),
    );
    expect(plan.booking).toEqual({ services: [], calendar: null, zipCodes: null });
    expect(plan.teammate.book.calendarIds).toEqual([CALENDAR]);
  });

  it('connects only the chat Save adds', () => {
    const state = withTeammate({}, { chat: { id: WIDGET, name: 'lonestarhvac.com' } });
    expect(teammateFromAiSetup(state, startingAiSetupAnswers(state)).channels.chat).toBe(false);
    const made = teammateFromAiSetup(business(), answers(), { widgetId: WIDGET });
    expect(made.channels).toMatchObject({ chat: true, widgetId: WIDGET });
  });

  it('tells owners and admins about a qualified lead unless someone is named', () => {
    const state = business({ industry: 'real_estate' });
    const config = teammateFromAiSetup(state, startingAiSetupAnswers(state));
    expect(config.qualify.enabled).toBe(true);
    expect(config.qualify.whenQualified.notify).toEqual({ kind: 'admins' });
    expect(config.qualify.questions.map((q) => q.id)).toEqual(
      SETUP_KIND_INFO.real_estate.questions.map((q) => q.id),
    );
  });

  it('reads ZIP codes only from a list of nothing else', () => {
    expect(zipCodesOnly('77494, 77433 and 77450')).toEqual(['77494', '77433', '77450']);
    expect(zipCodesOnly('77494 77494')).toEqual(['77494']);
    expect(zipCodesOnly('Katy, 77494')).toBeNull();
    expect(zipCodesOnly('')).toBeNull();
  });
});

describe('what quick setup says back', () => {
  it('sums the setup up in plain sentences', () => {
    const state = business({
      goal: 'booked',
      calendars: [{ id: CALENDAR, name: 'Service calls' }],
    });
    const lines = aiSetupSummary(state, startingAiSetupAnswers(state));
    expect(lines[0]).toBe(
      'Ava answers questions from what it knows about Lone Star HVAC, and never quotes prices.',
    );
    expect(lines).toContain('It books appointments on Service calls.');
    expect(lines).toContain('It works all the time and says it’s AI in its first message.');
    expect(lines.at(-1)).toBe('Every message waits for your OK until you’ve approved 20.');
  });

  it('says what a screen still needs, in the teammate’s name', () => {
    const state = business();
    const problems = aiSetupProblems(
      answers({ jobs: ['book', 'qualify'], name: 'Max', answerWhen: 'custom', customHours: [] }),
      state,
    );
    expect(problems.map((p) => p.path)).toEqual([
      'description',
      'services',
      'customHours',
      'questions',
    ]);
    expect(problems[0]?.message).toContain('Max');
    expect(aiSetupProblems(answers({ jobs: [] }), state)[0]?.path).toBe('jobs');
  });

  it('starts the test chat with questions the setup just answered', () => {
    const state = business();
    const questions = aiSetupTestQuestions(
      state,
      answers({
        jobs: ['book'],
        area: 'Katy, Cypress',
        facts: { spanish: 'yes', free_estimates: 'yes' },
        services: [{ name: 'AC repair' }],
      }),
    );
    expect(questions).toEqual([
      'Do you serve Katy?',
      'Do you give free estimates?',
      'How much does AC repair cost?',
      'Can someone come out next week?',
      'Are you open on Saturday?',
      'Are you a real person?',
    ]);
  });
});
