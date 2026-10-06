/**
 * The onboarding setup's shared part (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md): the address and
 * its time zone, what the kind of business picks, the screens and when they show, the answers kept and where they
 * carry on from, what each stop sets, and the summary. No database: `onboarding-setup-commands.test.ts` runs the
 * commands.
 */
import { describe, expect, it } from 'vitest';
import {
  addressLines,
  AiSetupAnswers,
  AiSetupService,
  applyTeammatePatch,
  BusinessAddress,
  cityAndState,
  emptyKnowledgeProfile,
  industriesForPicker,
  INDUSTRIES,
  myHoursFrom,
  ONBOARDING_KIND_INFO,
  ONBOARDING_PICKER,
  ONBOARDING_SETUP_SCREENS,
  ONBOARDING_SETUP_STOPS,
  onboardingKindFor,
  onboardingSetupBusinessDraftOf,
  onboardingSetupBusinessOf,
  onboardingSetupFirstScreen,
  onboardingSetupHint,
  onboardingSetupNextScreen,
  onboardingSetupOf,
  onboardingSetupPreviousScreen,
  onboardingSetupProgress,
  onboardingSetupScreenProblemsOf,
  onboardingSetupScreens,
  onboardingSetupSummary,
  onboardingSetupTitle,
  OnboardingSetupAnswers,
  pickerKeyOf,
  planAiSetup,
  planOnboardingBooking,
  planOnboardingSetup,
  planPriceList,
  resumeOnboardingSetup,
  SETUP_KINDS,
  setupKindOf,
  startingOnboardingSetupAnswers,
  storedOnboardingSetup,
  teammateConfigFromPreset,
  timeZoneForAddress,
  usTimeZoneLabel,
  withBusinessAddress,
  type OnboardingSetupAnswersInput,
  type OnboardingSetupState,
} from '../src';

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DALE = uid(1);
const CALENDAR = uid(20);
const SERVICE = uid(40);
const PRODUCT = uid(50);

const AUSTIN = {
  line1: '12 Oak St',
  line2: '',
  city: 'Austin',
  state: 'TX',
  postalCode: '78701',
  country: 'US',
} as const;

/** A business on its first day, of the given industry. */
function business(patch: Partial<OnboardingSetupState> = {}): OnboardingSetupState {
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
    number: false,
    textingReady: false,
    scan: { state: 'none', pending: 0 },
    found: null,
    reading: false,
    quick: null,
    address: null,
    reviewLink: null,
    numberSetup: { next: 'buy_number', display: null, since: null, rejectionReason: null },
    payments: { active: false, checking: false, needsInfo: false, broken: false, provider: null },
    customers: { count: 0, running: null, migrationNeedsYou: false, asYouGo: false },
    booking: { on: false, site: null },
    team: { members: 1, invited: [] },
    bookable: [],
    priceList: [],
    myHours: null,
    phones: 0,
    ...patch,
  };
}

const answers = (patch: OnboardingSetupAnswersInput = {}): OnboardingSetupAnswers =>
  OnboardingSetupAnswers.parse(patch);
const facts = { website: false, chat: false };

describe('the address', () => {
  it('picks the time zone from the state, and from the ZIP code where a state is split', () => {
    expect(timeZoneForAddress({ state: 'TX', postalCode: '78701' })).toBe('America/Chicago');
    expect(timeZoneForAddress({ state: 'tx', postalCode: '79901' })).toBe('America/Denver');
    expect(timeZoneForAddress({ state: 'FL', postalCode: '32501' })).toBe('America/Chicago');
    expect(timeZoneForAddress({ state: 'FL', postalCode: '33101' })).toBe('America/New_York');
    expect(timeZoneForAddress({ state: 'IN', postalCode: '46402' })).toBe('America/Chicago');
    expect(timeZoneForAddress({ state: 'TN', postalCode: '37902' })).toBe('America/New_York');
    expect(timeZoneForAddress({ state: 'AZ' })).toBe('America/Phoenix');
    expect(timeZoneForAddress({ state: 'HI', postalCode: null })).toBe('Pacific/Honolulu');
    expect(timeZoneForAddress({ state: 'ZZ', postalCode: '12345' })).toBeNull();
  });

  it('is checked the way the carriers want it, with the problem in plain words', () => {
    expect(BusinessAddress.parse({ ...AUSTIN, state: ' tx ' }).state).toBe('TX');
    const bad = BusinessAddress.safeParse({ ...AUSTIN, state: 'Texas', postalCode: '787' });
    expect(bad.success).toBe(false);
    expect(bad.error!.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['state', 'Pick the state.'],
      ['postalCode', 'Use the 5-digit ZIP code.'],
    ]);
  });

  it('reads as it heads an invoice, and as the summary says it', () => {
    const a = BusinessAddress.parse(AUSTIN);
    expect(addressLines(a)).toBe('12 Oak St\nAustin, TX 78701');
    expect(addressLines({ ...a, line2: 'Suite 4' })).toBe('12 Oak St\nSuite 4\nAustin, TX 78701');
    expect(cityAndState(a)).toBe('Austin, Texas');
    expect(usTimeZoneLabel('America/Denver')).toBe('Mountain');
    expect(usTimeZoneLabel('Europe/London')).toBe('Europe/London');
  });
});

describe('what the kind of business picks', () => {
  it('covers every kind, booking a time where customers usually do', () => {
    expect(Object.keys(ONBOARDING_KIND_INFO).sort()).toEqual([...SETUP_KINDS].sort());
    expect(onboardingKindFor('hvac')).toMatchObject({
      kind: 'home',
      booksTime: false,
      services: 'Services',
      calendar: 'Service calls',
    });
    expect(onboardingKindFor('hair_salon')).toMatchObject({
      booksTime: true,
      calendar: 'Appointments',
    });
    expect(onboardingKindFor('childcare')).toMatchObject({ booksTime: true, calendar: 'Tours' });
    expect(onboardingKindFor('restaurant').services).toBe('Menu');
  });

  it('puts every kind of business under one big button, Something else holding the rest', () => {
    expect(ONBOARDING_PICKER).toHaveLength(8);
    const shown = ONBOARDING_PICKER.flatMap((b) => industriesForPicker(b.key).map((i) => i.id));
    expect(shown.sort()).toEqual(INDUSTRIES.map((i) => i.id).sort());
    expect(new Set(shown).size).toBe(shown.length);
    expect(pickerKeyOf('dog_training')).toBe('else');
    expect(pickerKeyOf('hvac')).toBe('home');
    expect(pickerKeyOf(null)).toBeNull();
  });
});

describe('the screens', () => {
  it('skip booking when customers don’t book a time, and the AI part’s optional screens as it does', () => {
    const none = onboardingSetupScreens(answers(), facts);
    expect(none).not.toContain('booking');
    expect(none).not.toContain('qualify');
    expect(none).not.toContain('chat');
    const all = onboardingSetupScreens(answers({ booksTime: true, ai: { jobs: ['qualify'] } }), {
      website: true,
      chat: false,
    });
    expect(all).toEqual([...ONBOARDING_SETUP_SCREENS]);
    expect(onboardingSetupScreens(answers(), { website: true, chat: true })).not.toContain('chat');
  });

  it('go on and back past the ones that don’t apply', () => {
    const a = answers();
    expect(onboardingSetupNextScreen('customers', a, facts)).toBe('number');
    expect(onboardingSetupPreviousScreen('number', a, facts)).toBe('customers');
    expect(onboardingSetupNextScreen('customers', answers({ booksTime: true }), facts)).toBe(
      'booking',
    );
    expect(onboardingSetupNextScreen('done', a, facts)).toBeNull();
    expect(onboardingSetupPreviousScreen('business', a, facts)).toBeNull();
  });

  it('count the stops this business goes through, signing up first', () => {
    expect(ONBOARDING_SETUP_STOPS[0].key).toBe('signup');
    expect(onboardingSetupProgress('business', answers(), facts)).toEqual({
      stop: 'business',
      at: 2,
      of: 12,
    });
    expect(onboardingSetupProgress('meet', answers({ booksTime: true }), facts)).toEqual({
      stop: 'ai',
      at: 10,
      of: 13,
    });
  });

  it('take the setup’s words, and the AI quick setup’s for its own screens', () => {
    expect(onboardingSetupTitle('goal', 'Ava')).toBe('What do you want help with first?');
    expect(onboardingSetupTitle('hours', 'Ava')).toBe('When are you open?');
    expect(onboardingSetupTitle('meet', 'Max')).toBe('Meet Max');
    expect(onboardingSetupHint('business', 'Max')).toContain('Max starts reading your website');
    for (const s of ONBOARDING_SETUP_SCREENS) expect(onboardingSetupTitle(s, 'Ava')).not.toBe('');
  });
});

describe('what the business keeps', () => {
  it('is read forgivingly, and stored with nothing empty kept', () => {
    const mark = { at: '2026-10-06T19:00:00.000Z', by: DALE };
    const record = {
      draft: answers({ goal: 'paid' }),
      reached: 'goal' as const,
      kind: 'home' as const,
      started: mark,
      finished: null,
    };
    const stored = storedOnboardingSetup(record);
    expect(stored).not.toHaveProperty('finished');
    expect(onboardingSetupOf({ onboardingSetup: stored })).toEqual(record);
    expect(onboardingSetupOf({ onboardingSetup: { ...stored, draft: { goal: 'win' } } })).toEqual({
      draft: null,
      reached: null,
      kind: null,
      started: mark,
      finished: null,
    });
    expect(onboardingSetupOf({ onboardingSetup: 'nonsense' })).toMatchObject({ draft: null });
    expect(onboardingSetupOf(null)).toMatchObject({ draft: null, started: null });
  });
});

describe('the picks', () => {
  it('start an HVAC business on answering leads, with no booking page', () => {
    const a = startingOnboardingSetupAnswers(business());
    expect(a).toMatchObject({
      goal: 'leads',
      teamSize: 'solo',
      booksTime: false,
      customersIn: 'none',
      hasEin: null,
      payWith: 'later',
      reviewLink: '',
    });
    expect(a.ai.jobs).toEqual(['reply', 'answer', 'follow_up']);
  });

  it('start a salon on getting booked, with Ava booking', () => {
    const a = startingOnboardingSetupAnswers(business({ industry: 'hair_salon' }));
    expect(a).toMatchObject({ goal: 'booked', booksTime: true });
    expect(a.ai.jobs).toContain('book');
  });

  it('start from what the business has and said', () => {
    const a = startingOnboardingSetupAnswers(
      business({
        goal: 'paid',
        quick: { goal: 'paid', customersIn: 'ghl', teamSize: 'big' },
        calendars: [{ id: CALENDAR, name: 'Service calls' }],
        payments: {
          active: true,
          checking: false,
          needsInfo: false,
          broken: false,
          provider: 'square',
        },
        reviewLink: 'https://g.page/r/lonestar/review',
      }),
    );
    expect(a).toMatchObject({
      goal: 'paid',
      teamSize: 'big',
      booksTime: true,
      customersIn: 'ghl',
      payWith: 'square',
      reviewLink: 'https://g.page/r/lonestar/review',
    });
    expect(a.ai.jobs).toContain('book');
    expect(
      startingOnboardingSetupAnswers(
        business({
          customers: { count: 0, running: 'migration', migrationNeedsYou: false, asYouGo: false },
        }),
      ).customersIn,
    ).toBe('ghl');
  });

  it('leave a teammate’s jobs as they are', () => {
    const config = applyTeammatePatch(teammateConfigFromPreset('blank', { industry: 'hvac' }), {
      book: { enabled: true },
    });
    const a = startingOnboardingSetupAnswers(
      business({ teammate: { id: uid(10), name: 'Ava', status: 'training', revision: 2, config } }),
    );
    expect(a.booksTime).toBe(false);
    expect(a.ai.jobs).toContain('book');
  });
});

describe('carrying on', () => {
  const state = business();
  const draft = answers({
    goal: 'booked',
    teamSize: 'small',
    booksTime: true,
    customersIn: 'sheet',
    ai: { description: 'We fix AC.', jobs: ['answer'], name: 'Max' },
  });

  it('keeps the answers of the screens finished, and the picks for the rest', () => {
    const a = resumeOnboardingSetup(state, { draft, reached: 'about', kind: 'home' });
    expect(a).toMatchObject({ goal: 'booked', teamSize: 'small', booksTime: true });
    expect(a.customersIn).toBe('none');
    expect(a.ai.description).toBe('We fix AC.');
    expect(a.ai.name).toBe('Ava');
    // Ava's jobs aren't asked yet, so they follow the goal and booking kept.
    expect(a.ai.jobs).toEqual(['answer', 'book', 'follow_up']);
  });

  it('keeps the AI part’s answers once its screens are finished', () => {
    const a = resumeOnboardingSetup(state, { draft, reached: 'meet', kind: 'home' });
    expect(a.ai).toMatchObject({ jobs: ['answer'], name: 'Max' });
  });

  it('picks again what the kind picks when the kind of business changed', () => {
    const a = resumeOnboardingSetup(state, { draft, reached: 'meet', kind: 'salon' });
    expect(a.goal).toBe('booked');
    expect(a.booksTime).toBe(false);
    expect(a.ai.jobs).not.toEqual(['answer']);
    expect(a.ai.name).toBe('Max');
  });

  it('starts from the picks before anyone started', () => {
    expect(resumeOnboardingSetup(state, { draft: null, reached: null, kind: null })).toEqual(
      startingOnboardingSetupAnswers(state),
    );
  });
});

describe('the booking page', () => {
  const services = [
    { name: 'AC repair', minutes: 90, priceCents: 8900 },
    { name: ' ac  REPAIR ' },
    { name: 'Tune-up' },
  ];

  it('makes a calendar named for the kind, with the services and the owner’s hours', () => {
    const open = [1, 2, 3, 4, 5].map((day) => ({ day, start: '07:00', end: '18:00' }));
    const plan = planOnboardingBooking(
      business(),
      answers({ booksTime: true, ai: { services, openHours: open } }),
    );
    expect(plan).toMatchObject({
      calendar: 'Service calls',
      myHours: open,
      site: 'make',
      services: [
        { name: 'AC repair', description: '', minutes: 90, priceCents: 8900 },
        { name: 'Tune-up', description: '', minutes: null, priceCents: null },
      ],
    });
    expect(plan.changes).toEqual([
      'Adds the services AC repair and Tune-up to Calendars',
      'Makes the booking calendar Service calls, with your services on it',
      'Your hours: Mon–Fri 7:00 AM–6:00 PM',
      'Turns on your booking page',
    ]);
  });

  it('leaves what’s there: a calendar customers book, hours someone saved, a site that’s on', () => {
    const plan = planOnboardingBooking(
      business({
        calendars: [{ id: CALENDAR, name: 'Appointments' }],
        myHours: [{ day: 1, start: '10:00', end: '14:00' }],
        booking: { on: true, site: { slug: 'lonestar', name: 'Lone Star HVAC', enabled: true } },
      }),
      answers({ booksTime: true, ai: { services } }),
    );
    expect(plan).toEqual({ services: [], calendar: null, myHours: null, site: null, changes: [] });
  });

  it('turns a site that was switched off back on, and makes no calendar without services', () => {
    const plan = planOnboardingBooking(
      business({ booking: { on: false, site: { slug: 'ls', name: 'LS', enabled: false } } }),
      answers({ booksTime: true }),
    );
    expect(plan).toMatchObject({ calendar: null, site: 'turn_on' });
  });

  it('keeps someone on the default hours when the open hours are the same', () => {
    const nineToFive = [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '17:00' }));
    expect(myHoursFrom(business(), answers({ ai: { openHours: nineToFive } }))).toBeNull();
    expect(myHoursFrom(business(), answers({ ai: { openHours: [] } }))).toBeNull();
  });
});

describe('the price list', () => {
  it('adds what has a price, as the price of the service of that name, and changes a new price', () => {
    const plan = planPriceList(
      business({
        bookable: [
          { id: SERVICE, name: 'AC repair', minutes: 90, priceCents: null },
          { id: uid(41), name: 'Tune-up', minutes: 60, priceCents: null },
        ],
        priceList: [
          { id: PRODUCT, name: 'Tune-Up', priceCents: 9900, serviceId: null },
          { id: uid(51), name: 'Old', priceCents: 100, serviceId: uid(41) },
        ],
      }),
      answers({
        ai: {
          services: [
            { name: 'AC repair', priceCents: 8900 },
            { name: 'ac repair', priceCents: 1 },
            { name: 'tune-up', priceCents: 12900 },
            { name: 'Duct cleaning' },
          ],
        },
      }),
    );
    expect(plan).toEqual({
      create: [{ name: 'AC repair', priceCents: 8900, serviceId: SERVICE }],
      update: [{ id: PRODUCT, name: 'Tune-Up', priceCents: 12900 }],
    });
  });

  it('is part of what Stay in the loop saves, with the AI part', () => {
    const state = business();
    const a = answers({ ai: { services: [{ name: 'AC repair', priceCents: 8900, minutes: 90 }] } });
    const plan = planOnboardingSetup(state, a);
    expect(plan.ai.profile?.services).toEqual([
      { name: 'AC repair', description: '', price: '$89' },
    ]);
    expect(plan.changes).toContain('Adds AC repair ($89) to your price list');
    expect(plan.changes[0]).toBe('Sets up Ava, your AI teammate');
  });
});

describe('services with a price and a length', () => {
  it('are kept, and go to booking and the profile', () => {
    expect(AiSetupService.parse({ name: 'Cut', priceCents: 4500, minutes: 45 })).toEqual({
      name: 'Cut',
      description: '',
      priceCents: 4500,
      minutes: 45,
    });
    expect(AiSetupService.safeParse({ name: 'Cut', minutes: 2 }).error?.issues[0]?.message).toBe(
      'At least 5 minutes.',
    );
    const plan = planAiSetup(
      business({ industry: 'hair_salon' }),
      AiSetupAnswers.parse({
        jobs: ['book'],
        services: [{ name: 'Cut', priceCents: 4500, minutes: 45 }, { name: 'Color' }],
      }),
    );
    expect(plan.booking.services).toEqual([
      { name: 'Cut', description: '', minutes: 45, priceCents: 4500 },
      { name: 'Color', description: '', minutes: null, priceCents: null },
    ]);
    expect(plan.profile?.services.map((s) => s.price)).toEqual(['$45', null]);
  });
});

describe('the summary', () => {
  it('says what the business will have, in plain sentences', () => {
    const state = business({
      address: BusinessAddress.parse(AUSTIN),
      found: {
        url: 'https://lonestarhvac.com',
        at: '2026-10-06T00:00:00.000Z',
        description: '',
        services: [{ name: 'AC repair', description: '' }],
        area: '',
        openHours: null,
        facts: {},
        questions: [],
      },
      numberSetup: {
        next: 'awaiting_approval',
        display: '(512) 555-0142',
        since: '2026-10-06T00:00:00.000Z',
        rejectionReason: null,
      },
      customers: { count: 1240, running: 'migration', migrationNeedsYou: false, asYouGo: false },
      payments: {
        active: true,
        checking: false,
        needsInfo: false,
        broken: false,
        provider: 'stripe',
      },
    });
    const lines = onboardingSetupSummary(
      state,
      answers({
        reviewLink: 'https://g.page/r/x/review',
        ai: {
          jobs: ['reply', 'answer', 'follow_up'],
          services: [{ name: 'AC repair' }],
          openHours: [1, 2, 3, 4, 5].map((day) => ({ day, start: '07:00', end: '18:00' })),
        },
      }),
    );
    expect(lines).toEqual([
      'Lone Star HVAC: HVAC in Austin, Texas, on Central time.',
      'Open Mon–Fri 7:00 AM–6:00 PM.',
      '1 service, from your website.',
      '1,240 customers so far, with more moving over from GoHighLevel.',
      'Texts will come from (512) 555-0142 once the carriers approve it, usually in 1 to 3 weeks. Calls work now.',
      'Customers pay by card through Stripe.',
      'Thank-you texts ask for a Google review.',
      'Ava replies to new leads within a minute, with training wheels.',
    ]);
  });

  it('follows the answers before anything is set up', () => {
    const lines = onboardingSetupSummary(
      business({ industry: 'hair_salon', businessName: 'Bella' }),
      answers({ booksTime: true, hasEin: false, payWith: 'stripe', ai: { openHours: [] } }),
    );
    expect(lines).toContain('No open hours yet.');
    expect(lines).toContain('Customers will book Appointments on your booking page.');
    expect(lines).toContain('New customers add themselves as they come in.');
    expect(lines).toContain('You’ll get a toll-free number, approved faster.');
    expect(lines).toContain('Connect Stripe to take payments.');
    expect(lines[0]).toBe('Bella: Hair salon, on Central time.');
  });
});

describe('the screens’ behaviour', () => {
  it('open after the furthest screen finished', () => {
    const got = (reached: (typeof ONBOARDING_SETUP_SCREENS)[number] | null, finished = false) =>
      onboardingSetupFirstScreen({
        state: { website: null, chat: null },
        answers: answers(),
        reached,
        finished: finished ? { at: '2026-10-06T00:00:00.000Z', by: DALE } : null,
      });
    expect(got(null)).toBe('business');
    expect(got('goal')).toBe('about');
    expect(got('customers')).toBe('number');
    expect(got('done')).toBe('done');
    expect(got(null, true)).toBe('done');
  });

  it('pick the time zone from the address, unless someone picked their own', () => {
    const draft = onboardingSetupBusinessDraftOf(business());
    expect(withBusinessAddress(draft, { ...AUSTIN, state: 'CO' }).timeZone).toBe('America/Denver');
    expect(
      withBusinessAddress(
        { ...draft, timeZone: 'America/Chicago', timeZonePicked: true },
        { ...AUSTIN, state: 'CO' },
      ).timeZone,
    ).toBe('America/Chicago');
    expect(
      onboardingSetupBusinessOf({ ...draft, site: 'lonestar.com', noSite: true }),
    ).toMatchObject({
      website: null,
      timezone: 'America/Chicago',
    });
  });

  it('say what a screen still needs, at the answer it’s about', () => {
    const state = business();
    const draft = onboardingSetupBusinessDraftOf(state);
    expect(
      onboardingSetupScreenProblemsOf('business', answers(), state, {
        ...draft,
        name: ' ',
        address: { ...AUSTIN, postalCode: '7' },
      }),
    ).toEqual({
      'business.name': 'Name your business.',
      'business.address.postalCode': 'Use the 5-digit ZIP code.',
    });
    expect(
      onboardingSetupScreenProblemsOf('about', answers({ booksTime: true }), state, draft),
    ).toEqual({
      'ai.services': 'Add what customers book, so your booking page has something to book.',
      'ai.description':
        'Say what your business does in a sentence or two, so Ava can tell customers.',
    });
    expect(
      onboardingSetupScreenProblemsOf(
        'paid',
        { ...answers(), reviewLink: 'x'.repeat(501) },
        state,
        draft,
      ),
    ).toEqual({ reviewLink: 'Keep it under 500 characters.' });
  });
});
