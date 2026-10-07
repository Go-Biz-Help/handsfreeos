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
  AI_SETUP_READ_FIELDS,
  AI_SETUP_STEPS,
  AI_SETUP_TONE_TEXTS,
  AiSetupAnswers,
  aiSetupBusinessDraftOf,
  aiSetupBusinessOf,
  aiSetupChatSnippet,
  aiSetupChoicesOf,
  aiSetupFindingsOf,
  aiSetupFirstStep,
  aiSetupFoundFrom,
  aiSetupFoundOf,
  aiSetupNextStep,
  aiSetupOf,
  aiSetupPreviousStep,
  aiSetupTemplateAbout,
  aiSetupTemplateOf,
  aiSetupTemplateOfBusiness,
  chosenAiSetupTemplate,
  defaultAiSetupTemplate,
  withAiSetupTemplate,
  aiSetupProblemAt,
  aiSetupProblems,
  aiSetupProblemsOf,
  aiSetupReadDue,
  aiSetupReading,
  aiSetupScreenProblems,
  aiSetupStepHint,
  aiSetupSteps,
  aiSetupStepTitle,
  aiSetupSummary,
  aiSetupTestQuestions,
  aiSetupWentToPerson,
  applyTeammatePatch,
  asksAboutWhoSomeoneIs,
  cleanAiSetupAnswers,
  emptyKnowledgeProfile,
  factAnswersOf,
  firstTextPreview,
  INDUSTRIES,
  laterAiSetupStep,
  mergeAiSetupAnswers,
  newAiSetupQuestion,
  planAiSetup,
  quickFactsFor,
  resumeAiSetup,
  SETUP_KIND_INFO,
  SETUP_KIND_LABELS,
  SETUP_KINDS,
  setupFor,
  setupKindOf,
  startingAiSetupAnswers,
  storedAiSetup,
  teammateConfigFromPreset,
  teammateFromAiSetup,
  toneOfProfile,
  withAiSetupQuestionKind,
  zipCodesOnly,
  type AiSetupAnswersInput,
  type AiSetupFound,
  type AiSetupSiteReading,
  type AiSetupState,
  type AiSetupStep,
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
    page: null,
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
    expect(setupKindOf('med_spa')).toBe('salon');
    expect(setupKindOf('gym')).toBe('fitness');
    expect(setupKindOf('dental')).toBe('health');
    expect(setupKindOf('home_care')).toBe('health');
    expect(setupKindOf('pet_grooming')).toBe('pets');
    expect(setupKindOf('boat_rv')).toBe('auto');
    expect(setupKindOf('childcare')).toBe('lessons');
    expect(setupKindOf('real_estate')).toBe('real_estate');
    expect(setupKindOf('property_management')).toBe('property');
    expect(setupKindOf('insurance')).toBe('insurance');
    expect(setupKindOf('law_firm')).toBe('legal_money');
    expect(setupKindOf('mortgage')).toBe('legal_money');
    expect(setupKindOf('courier')).toBe('professional');
    expect(setupKindOf('florist')).toBe('events');
    expect(setupKindOf('food_truck')).toBe('food');
    expect(setupKindOf('vacation_rentals')).toBe('stays');
    expect(setupKindOf('self_storage')).toBe('rentals');
    expect(setupKindOf('online_store')).toBe('retail');
    expect(setupKindOf('church')).toBe('community');
    expect(setupKindOf('other')).toBe('other');
    expect(setupKindOf('not_a_kind')).toBe('other');
    expect(setupKindOf(null)).toBe('other');
  });

  it('cover every industry in the list', () => {
    const kinds = new Set(INDUSTRIES.map((i) => setupKindOf(i.id)));
    for (const i of INDUSTRIES) if (i.id !== 'other') expect(setupKindOf(i.id)).not.toBe('other');
    expect([...kinds].sort()).toEqual([...SETUP_KINDS].sort());
  });

  it('ask patient care about patients and insurance, and other practices about clients', () => {
    const keys = (industry: string) => quickFactsFor(industry).map((f) => f.key);
    expect(keys('dental')).toContain('new_patients');
    expect(keys('dental')).toContain('takes_insurance');
    expect(keys('dental')).not.toContain('new_clients');
    expect(keys('home_care')).toEqual([
      'new_clients',
      'takes_insurance',
      'payment_plans',
      'assessment',
      'spanish',
    ]);
    expect(keys('law_firm')).toContain('new_clients');
    expect(keys('law_firm')).not.toContain('new_patients');
    expect(keys('law_firm')).not.toContain('takes_insurance');
  });

  it('ask each industry the quick facts that fit it', () => {
    const keys = (industry: string) => quickFactsFor(industry).map((f) => f.key);
    expect(keys('hvac')).toEqual([
      'free_estimates',
      'financing',
      'emergency',
      'warranty',
      'licensed',
      'same_day',
      'spanish',
    ]);
    expect(keys('house_cleaning')).toEqual([
      'free_estimates',
      'regular_visits',
      'guarantee',
      'licensed',
      'same_day',
      'spanish',
    ]);
    expect(keys('childcare')).toEqual([
      'openings',
      'state_licensed',
      'meals',
      'part_time',
      'spanish',
    ]);
    expect(keys('tutoring')).toEqual(['free_lesson', 'online', 'groups', 'beginners', 'spanish']);
    expect(keys('towing')).toEqual(['around_the_clock', 'roadside', 'spanish']);
    expect(keys('restaurant')).toContain('reservations');
    expect(keys('catering')).not.toContain('catering');
    expect(keys('self_storage')).toEqual(['deposit', 'climate', 'access_24', 'spanish']);
    // Fair housing: no pets still welcomes assistance animals.
    for (const industry of ['property_management', 'vacation_rentals'])
      expect(quickFactsFor(industry).find((f) => f.key === 'pets')?.no).toMatch(
        /Assistance animals are always welcome/,
      );
  });

  it('each ask their quick facts once, ending with Spanish', () => {
    for (const kind of SETUP_KINDS) {
      const facts = SETUP_KIND_INFO[kind].facts;
      expect(facts.at(-1)?.key).toBe('spanish');
      expect(new Set(facts.map((f) => f.key)).size).toBe(facts.length);
      expect(new Set(facts.map((f) => f.title)).size).toBe(facts.length);
    }
    for (const { id } of INDUSTRIES) {
      const facts = quickFactsFor(id);
      expect(facts.length, id).toBeGreaterThanOrEqual(3);
      expect(facts.length, id).toBeLessThanOrEqual(9);
      expect(facts.at(-1)?.key).toBe('spanish');
    }
  });

  it('start from qualifying questions that never ask who someone is, and send without apostrophes', () => {
    for (const { id } of INDUSTRIES) {
      const { questions } = setupFor(id);
      expect(questions.length).toBeGreaterThan(0);
      expect(new Set(questions.map((q) => q.id)).size).toBe(questions.length);
      for (const q of questions) {
        const words = [q.question, ...(q.options ?? [])].join(' ');
        expect(asksAboutWhoSomeoneIs(words, id), q.question).toBe(false);
        expect(words).not.toMatch(/[’']/);
      }
      // Each reads as a teammate's question.
      const config = applyTeammatePatch(teammateConfigFromPreset('blank'), {
        qualify: { questions: [...questions] },
      });
      expect(config.qualify.questions).toHaveLength(questions.length);
    }
  });

  it('start childcare, mortgage and storage from questions of their own', () => {
    const ids = (industry: string) => setupFor(industry).questions.map((q) => q.id);
    expect(ids('tutoring')).toEqual(['learn', 'student', 'times', 'start']);
    expect(ids('childcare')).toEqual(['age', 'days', 'start']);
    expect(ids('mortgage')).toEqual(['goal', 'close', 'agent']);
    expect(ids('self_storage')).toEqual(['size', 'when', 'how_long']);
    expect(ids('event_planning')).toContain('where');
    expect(ids('event_venue')).not.toContain('where');
  });

  it('name the booking calendar for the kind of business', () => {
    expect(setupFor('hvac').calendar).toBe('Service calls');
    expect(setupFor('gym').calendar).toBe('Sessions');
    expect(setupFor('music_lessons').calendar).toBe('Lessons');
    expect(setupFor('childcare').calendar).toBe('Tours');
    expect(setupFor('law_firm').calendar).toBe('Consultations');
    expect(setupFor('property_management').calendar).toBe('Showings');
    expect(setupFor('restaurant').calendar).toBe('Reservations');
    expect(setupFor('bakery').calendar).toBe('Appointments');
    expect(setupFor(null).calendar).toBe('Appointments');
  });

  it('spot a question about who someone is, as whole words only', () => {
    expect(asksAboutWhoSomeoneIs('Do you have kids?')).toBe(true);
    expect(asksAboutWhoSomeoneIs('Which school district do you want?')).toBe(true);
    expect(asksAboutWhoSomeoneIs('Is it a  safe   neighborhood?')).toBe(true);
    expect(asksAboutWhoSomeoneIs('Do you live in Sussex County?')).toBe(false);
    expect(asksAboutWhoSomeoneIs('What ZIP code is the job in?')).toBe(false);
  });

  it('let a school ask about the children it teaches, and a church say church', () => {
    expect(asksAboutWhoSomeoneIs('Which school does your child go to?', 'tutoring')).toBe(false);
    expect(asksAboutWhoSomeoneIs('Are the lessons for kids or adults?', 'music_lessons')).toBe(
      false,
    );
    expect(asksAboutWhoSomeoneIs('Which school does your child go to?', 'real_estate')).toBe(true);
    expect(asksAboutWhoSomeoneIs('Is your family religious?', 'childcare')).toBe(true);
    expect(asksAboutWhoSomeoneIs('Have you visited our church before?', 'church')).toBe(false);
    expect(asksAboutWhoSomeoneIs('Have you visited our church before?', 'event_venue')).toBe(true);
  });

  it('hand insurance claims and coverage, medications and test results, and prayer to a person', () => {
    const topics = (industry: string) => {
      const state = business({ industry });
      return teammateFromAiSetup(state, startingAiSetupAnswers(state)).handOff.sensitiveTopics;
    };
    expect(topics('insurance')).toEqual(
      expect.arrayContaining(['Insurance claims', 'What a policy covers']),
    );
    expect(topics('dental')).toEqual(
      expect.arrayContaining(['Medication questions', 'Test results']),
    );
    expect(topics('church')).toEqual(expect.arrayContaining(['Prayer requests']));
    expect(topics('hvac')).toEqual([]);
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
  const noSite = { website: false, page: false, chat: false };
  const site = { website: true, page: false, chat: false };
  const page = { website: false, page: true, chat: false };

  it('show qualifying questions only when Ava asks them, and the chat only for a website without one', () => {
    expect(aiSetupSteps({ jobs: ['reply'] }, noSite)).not.toContain('qualify');
    expect(aiSetupSteps({ jobs: ['qualify'] }, noSite)).toContain('qualify');
    expect(aiSetupSteps({ jobs: [] }, noSite)).not.toContain('chat');
    expect(aiSetupSteps({ jobs: [] }, site)).toContain('chat');
    expect(aiSetupSteps({ jobs: [] }, { ...site, chat: true })).not.toContain('chat');
    expect(aiSetupSteps({ jobs: ['qualify'] }, site)).toEqual([...AI_SETUP_STEPS]);
  });

  it('offer the chat on the simple page for a business with no website', () => {
    expect(aiSetupSteps({ jobs: [] }, page)).toContain('chat');
    expect(aiSetupSteps({ jobs: [] }, { ...page, chat: true })).not.toContain('chat');
    expect(aiSetupStepTitle('chat', 'Ava', { website: false })).toBe('Add Ava to your page?');
    expect(aiSetupStepTitle('chat', 'Ava', { website: true })).toBe(
      aiSetupStepTitle('chat', 'Ava'),
    );
    expect(aiSetupStepHint('chat', 'Max', { website: false })).toContain(
      'a chat on your page, Max',
    );
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

describe('how the screens behave, on the web and the phone', () => {
  const state = business();
  const got = (reached: AiSetupStep | null, teammate: unknown = null) => ({
    state: { website: null, page: null, chat: null, teammate },
    answers: answers({ jobs: ['reply'] }),
    reached,
  });

  it('open where someone left off, or on the test chat after Save', () => {
    expect(aiSetupFirstStep(got(null), null)).toBe('business');
    expect(aiSetupFirstStep(got('hours'), null)).toBe('facts');
    // The last question was finished: it waits there for Save.
    expect(aiSetupFirstStep(got('loop'), null)).toBe('loop');
    expect(aiSetupFirstStep(got('loop'), 'try')).toBe('loop');
    expect(aiSetupFirstStep(got(null, { id: TEAMMATE }), 'try')).toBe('try');
  });

  it('let what Ava read fill in only what nobody changed, on screens still to come', () => {
    const local = answers({ description: 'Typed here', area: 'Katy' });
    const fresh = answers({
      description: 'From the website',
      area: 'Austin',
      services: [{ name: 'AC repair' }],
      name: 'Max',
    });
    const read = mergeAiSetupAnswers(
      local,
      fresh,
      new Set(['description'] as const),
      'jobs',
      AI_SETUP_READ_FIELDS,
    );
    expect(read.description).toBe('Typed here');
    expect(read.area).toBe('Austin');
    expect(read.services).toEqual([{ name: 'AC repair', description: '' }]);
    // Not something Ava reads.
    expect(read.name).toBe('Ava');
    // A screen already finished keeps its answers.
    expect(mergeAiSetupAnswers(local, fresh, new Set(), 'about', AI_SETUP_READ_FIELDS).area).toBe(
      'Katy',
    );
    // After the first screen, everything not changed on screen.
    const all = mergeAiSetupAnswers(local, fresh, new Set(['area'] as const), 'business');
    expect(all.name).toBe('Max');
    expect(all.area).toBe('Katy');
  });

  it('say what a screen still needs, by the path of the answer', () => {
    expect(
      aiSetupScreenProblems('business', answers(), state, { name: ' ', industry: '' }),
    ).toEqual({
      'business.name': 'Name your business.',
      'business.industry': 'Pick the kind of business from the list, or Other.',
    });
    // Only this screen's answers: the empty name is the next screen's to ask about.
    const raw = {
      ...answers({ jobs: ['book'] }),
      services: [{ name: ' ', description: '' }],
      name: '',
    };
    expect(aiSetupScreenProblems('about', raw, state, { name: 'x', industry: 'hvac' })).toEqual({
      'services.0.name': 'Name the service.',
      description: 'Say what your business does in a sentence or two, so Ava can tell customers.',
    });
    expect(
      aiSetupScreenProblems('jobs', answers({ jobs: [], name: 'Max' }), state, {
        name: 'x',
        industry: 'hvac',
      }),
    ).toEqual({ jobs: 'Tick at least one thing for Max to do.' });
  });

  it('read a refusal’s details as the screens name their answers', () => {
    expect(
      aiSetupProblemsOf([
        { path: 'answers.services.0.name', message: 'Name the service.' },
        { path: '/answers/area', message: 'Keep it under 500 characters.' },
        { path: ['answers', 'questions', 1, 'question'], message: 'Ask what they need.' },
        { path: 'answers.services.0.name', message: 'A second message.' },
        { path: 'business.website', message: 'That isn’t a website.' },
        { message: 'No path.' },
        null,
      ]),
    ).toEqual({
      'services.0.name': 'Name the service.',
      area: 'Keep it under 500 characters.',
      'questions.1.question': 'Ask what they need.',
      'business.website': 'That isn’t a website.',
    });
    expect(aiSetupProblemsOf(undefined)).toEqual({});
    expect(aiSetupProblemAt({ 'services.2.name': 'Name the service.' }, 'services')).toBe(
      'Name the service.',
    );
    expect(aiSetupProblemAt({}, 'services')).toBeUndefined();
  });

  it('keep what’s ticked on “What Ava learned” and turn down the rest', () => {
    const findings = [{ id: uid(41) }, { id: uid(42) }, { id: uid(43) }];
    const kept = cleanAiSetupAnswers('learned', answers({ dropFindings: [uid(42)] }), findings);
    expect(kept.keepFindings).toEqual([uid(41), uid(43)]);
    expect(kept.dropFindings).toEqual([uid(42)]);
    // Any other screen only checks them.
    expect(
      cleanAiSetupAnswers('voice', answers({ dropFindings: [uid(42)] }), findings).keepFindings,
    ).toEqual([]);
  });

  it('list what the scan found that’s still waiting, in the order it found them', () => {
    const item = (n: number, patch: { status?: string; reason?: string } = {}) => ({
      id: uid(n),
      kind: 'faq',
      status: 'pending',
      reason: 'scan',
      proposed: { title: `Title ${n}`, body: `Body ${n}` },
      ...patch,
    });
    expect(
      aiSetupFindingsOf([
        item(3),
        item(2, { status: 'accepted' }),
        item(1),
        item(4, { reason: 'gap' }),
      ]),
    ).toEqual([
      { id: uid(1), kind: 'faq', title: 'Title 1', body: 'Body 1' },
      { id: uid(3), kind: 'faq', title: 'Title 3', body: 'Body 3' },
    ]);
  });

  it('save the first screen’s website as typed, or none', () => {
    const draft = aiSetupBusinessDraftOf({
      businessName: 'Lone Star HVAC',
      industry: null,
      website: 'https://lonestarhvac.com/',
    });
    expect(draft).toEqual({
      name: 'Lone Star HVAC',
      industry: '',
      site: 'lonestarhvac.com',
      noSite: false,
    });
    expect(aiSetupBusinessOf({ ...draft, name: ' Lone Star ', industry: 'hvac' })).toEqual({
      name: 'Lone Star',
      industry: 'hvac',
      website: 'lonestarhvac.com',
    });
    expect(aiSetupBusinessOf({ ...draft, noSite: true }).website).toBeNull();
    expect(aiSetupBusinessOf({ ...draft, site: '  ' }).website).toBeNull();
  });

  it('add qualifying questions and change how they’re answered', () => {
    expect(newAiSetupQuestion([]).id).toBe('q1');
    const added = newAiSetupQuestion([{ id: 'q1' }, { id: 'q3' }]);
    expect(added).toMatchObject({ id: 'q4', question: '', kind: 'text', options: [] });
    const choice = {
      ...added,
      kind: 'choice' as const,
      options: ['Cooling', 'Heating'],
      notAFitIf: { answers: ['Heating'], below: null, above: null },
    };
    expect(withAiSetupQuestionKind(choice, 'yes_no')).toMatchObject({
      kind: 'yes_no',
      options: [],
      notAFitIf: { answers: [] },
    });
    expect(withAiSetupQuestionKind(choice, 'choice').options).toEqual(['Cooling', 'Heating']);
    expect(aiSetupChoicesOf(' Cooling, ,Heating ,')).toEqual(['Cooling', 'Heating']);
  });

  it('mark the test chat’s questions that went to a person, and give the chat’s code', () => {
    expect(aiSetupWentToPerson('handed_off')).toBe(true);
    expect(aiSetupWentToPerson('no_reply')).toBe(true);
    expect(aiSetupWentToPerson('replied')).toBe(false);
    expect(aiSetupWentToPerson(null)).toBe(false);
    expect(aiSetupChatSnippet('https://app.handsfreeos.com', 'wk_1')).toBe(
      '<script async src="https://app.handsfreeos.com/embed/v1/wk_1.js"></script>',
    );
    expect(firstTextPreview('Max', 'first_message', 'Lone Star HVAC')).toBe(
      'Hi Mike, this is Max, the AI assistant at Lone Star HVAC. How can I help?',
    );
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

  it('keeps where the answers start from with the draft, our picks included', () => {
    const record = {
      draft: answers(),
      reached: 'business' as const,
      kind: 'home' as const,
      started: mark,
      finished: null,
      runs: 0,
    };
    for (const template of [uid(40), null])
      expect(aiSetupOf({ aiSetup: storedAiSetup({ ...record, template }) })).toEqual({
        ...record,
        template,
      });
    // Nobody picked yet.
    expect(aiSetupOf({ aiSetup: storedAiSetup(record) })).not.toHaveProperty('template');
    expect(
      aiSetupOf({ aiSetup: { ...storedAiSetup(record), template: 'Plumbers' } }),
    ).not.toHaveProperty('template');
    // Finished: the next run picks again.
    expect(
      storedAiSetup({ ...record, template: uid(40), draft: null, reached: null }),
    ).not.toHaveProperty('template');
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
    expect(toneOfProfile('', 'health')).toBe('professional');
    expect(toneOfProfile('', 'pets')).toBe('friendly');
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

describe('an agency’s saved answers', () => {
  const MAX_Q = {
    id: 'tank',
    question: 'Is the water heater gas or electric?',
    kind: 'choice' as const,
    options: ['Gas', 'Electric'],
    required: true,
  };

  it('names every kind of business', () => {
    for (const kind of SETUP_KINDS) expect(SETUP_KIND_LABELS[kind]).toMatch(/^[A-Z]/);
  });

  it('reads each saved answer on its own, leaving one that doesn’t read to the business’s picks', () => {
    expect(
      aiSetupTemplateOf({
        jobs: ['reply', 'fly'],
        name: 'Max',
        tone: 'keep',
        disclosure: 'when_asked',
        questions: 'none',
        // Not one an agency saves.
        description: 'Pipes and drains.',
      }),
    ).toEqual({ name: 'Max', disclosure: 'when_asked' });
    expect(aiSetupTemplateOf(null)).toEqual({});
    expect(aiSetupTemplateOf(['Max'])).toEqual({});

    const salon = business({ industry: 'hair_salon' });
    const started = startingAiSetupAnswers(salon, { name: 'Max', allowPrices: true });
    expect(started).toMatchObject({ name: 'Max', allowPrices: true });
    // The rest are the salon's own picks.
    expect(started.jobs).toEqual(startingAiSetupAnswers(salon).jobs);
    expect(started.tone).toBe(SETUP_KIND_INFO.salon.tone);
    expect(started.questions).toEqual(startingAiSetupAnswers(salon).questions);
  });

  it('keeps what a business was set up with, but not its own words or questions it doesn’t ask', () => {
    const set = withTeammate(
      {
        identity: { name: 'Max', disclosure: 'when_asked' },
        qualify: { enabled: true, questions: [MAX_Q] },
        hours: { mode: 'after_hours' },
      },
      { profile: { ...emptyKnowledgeProfile(), tone: AI_SETUP_TONE_TEXTS.professional } },
    );
    const kept = aiSetupTemplateOfBusiness(set);
    expect(Object.keys(kept).sort()).toEqual(
      [
        'allowPrices',
        'answerWhen',
        'customHours',
        'disclosure',
        'jobs',
        'name',
        // The onboarding setup's open hours (the owner's 54A).
        'openHours',
        'questions',
        'tone',
      ].sort(),
    );
    expect(kept).toMatchObject({
      name: 'Max',
      disclosure: 'when_asked',
      answerWhen: 'after_hours',
      tone: 'professional',
      openHours: startingAiSetupAnswers(set).openHours,
      questions: [expect.objectContaining({ question: MAX_Q.question })],
    });

    const own = aiSetupTemplateOfBusiness(
      withTeammate(
        { qualify: { enabled: false, questions: [] } },
        { profile: { ...emptyKnowledgeProfile(), tone: 'Like a pirate.' } },
      ),
    );
    expect(own).not.toHaveProperty('tone');
    expect(own).not.toHaveProperty('questions');
  });

  it('picks the saved answers again in place of what was answered, and nothing else', () => {
    const state = business();
    const answered = answers({
      ...startingAiSetupAnswers(state),
      description: 'We fix AC.',
      jobs: ['answer'],
      name: 'Sam',
    });
    const now = withAiSetupTemplate(answered, state, { name: 'Max', tone: 'short' });
    expect(now).toMatchObject({ description: 'We fix AC.', name: 'Max', tone: 'short' });
    expect(now.jobs).toEqual(startingAiSetupAnswers(state).jobs);
    // Our picks for this kind of business.
    expect(withAiSetupTemplate(answered, state, null)).toMatchObject({
      description: 'We fix AC.',
      name: 'Ava',
    });
  });

  it('starts from the ones picked, else the newest saved for the kind of business', () => {
    const saved = [
      { id: uid(41), kind: 'home', updatedAt: '2026-10-01T10:00:00.000Z' },
      { id: uid(42), kind: 'home', updatedAt: '2026-10-03T10:00:00.000Z' },
      { id: uid(43), kind: 'salon', updatedAt: '2026-10-04T10:00:00.000Z' },
    ];
    expect(defaultAiSetupTemplate(saved, 'home')?.id).toBe(uid(42));
    expect(defaultAiSetupTemplate(saved, 'health')).toBeNull();
    expect(chosenAiSetupTemplate(saved, undefined, 'salon')?.id).toBe(uid(43));
    expect(chosenAiSetupTemplate(saved, uid(41), 'salon')?.id).toBe(uid(41));
    // Our picks, picked; and ones removed since.
    expect(chosenAiSetupTemplate(saved, null, 'home')).toBeNull();
    expect(chosenAiSetupTemplate(saved, uid(49), 'home')).toBeNull();
  });

  it('says what saved answers set, in a line', () => {
    expect(
      aiSetupTemplateAbout({
        name: 'Max',
        tone: 'professional',
        jobs: ['follow_up', 'reply', 'book'],
      }),
    ).toBe('Max · Professional · Replies to new leads, books appointments, follows up');
    expect(aiSetupTemplateAbout({ jobs: ['answer'] })).toBe('Answers questions');
    expect(aiSetupTemplateAbout({})).toBe('');
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

  it('keeps the questions about children for a school, and drops them for anyone else', () => {
    const kids = (industry: string | null) =>
      aiSetupFoundFrom(READING, SITE, [], industry).questions.map((q) => q.question);
    expect(kids('tutoring')).toContain('Do you have kids at home?');
    expect(kids('hvac')).not.toContain('Do you have kids at home?');
    expect(kids(null)).not.toContain('Do you have kids at home?');
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
        { name: 'AC repair', description: '', minutes: null, priceCents: null },
        { name: 'Furnace tune-up', description: '', minutes: null, priceCents: null },
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

  it('asks the test chat’s questions in the words of the kind of business', () => {
    const first = (industry: string, patch: AiSetupAnswersInput) =>
      aiSetupTestQuestions(business({ industry }), answers({ openHours: [], ...patch }));
    expect(first('insurance', { jobs: ['qualify'], area: 'Texas and Oklahoma' })).toEqual([
      'Can you insure me in Texas?',
      'I need a quote. Can you help?',
      'Are you a real person?',
    ]);
    expect(first('online_store', { jobs: ['answer'], area: 'Canada and the US' })[0]).toBe(
      'Do you ship to Canada?',
    );
    expect(first('childcare', { jobs: ['book'], area: '12 Lake Rd, Naperville' })).toEqual([
      'Where are you located?',
      'Can we come for a tour next week?',
      'Are you a real person?',
    ]);
    expect(first('restaurant', { jobs: ['book'] })[0]).toBe('Can I book a table for Friday?');
  });
});
