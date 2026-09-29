/**
 * Getting started's rules (HANDSFREEOS_ONBOARDING_IMPLEMENTATION_PLAN.md §3): the order the answers put the steps in,
 * where each step stands from the facts, what skipping does, when the guide is finished, what each step says, and
 * how the kept settings are read.
 */
import { describe, expect, it } from 'vitest';
import {
  businessOnboardingOf,
  isWizardStep,
  laterOrder,
  mustDoOrder,
  ONBOARDING_GOALS,
  railLine,
  previewDetail,
  QUESTION_WORDS,
  ONBOARDING_WORDS,
  onboardingProgress,
  personalOnboardingOf,
  PHONE_APP_LINKS,
  progressWords,
  stepWords,
  waitingDay,
  withPersonalOnboarding,
  type OnboardingAnswers,
  type OnboardingFacts,
  type OnboardingStepKey,
} from '../src';

type Business = NonNullable<OnboardingFacts['business']>;
type Patch = { [K in keyof Business]?: Partial<Business[K]> };

/** A business on its first day: nothing set up, one member. */
function facts(
  patch: Patch = {},
  person: Partial<OnboardingFacts['person']> = {},
): OnboardingFacts {
  const blank: Business = {
    number: { next: 'buy_number', display: null, since: null, rejectionReason: null },
    payments: { active: false, checking: false, needsInfo: false, broken: false, provider: null },
    customers: { count: 0, asYouGo: false, running: null, migrationNeedsYou: false },
    calendar: { calendars: 0, services: 0, bookingOn: false },
    ai: {
      name: null,
      published: 0,
      profileFilled: 0,
      profileTotal: 7,
      pendingSuggestions: 0,
      scanRunning: false,
    },
    team: { members: 1, liveInvitations: 0 },
    emailChat: { mailbox: false, chat: false },
  };
  const business = Object.fromEntries(
    Object.entries(blank).map(([k, v]) => [k, { ...v, ...(patch[k as keyof Business] ?? {}) }]),
  ) as unknown as Business;
  return { business, person: { phones: 0, calendarConnected: false, ...person } };
}

const answers = (over: Partial<OnboardingAnswers> = {}): OnboardingAnswers => ({
  goal: 'leads',
  customersIn: 'ghl',
  teamSize: 'small',
  ...over,
});

const owner = (
  f: OnboardingFacts,
  a: OnboardingAnswers | null = null,
  skipped: OnboardingStepKey[] = [],
  device = {},
) =>
  onboardingProgress({
    audience: 'business',
    answers: a,
    facts: f,
    skipped: new Set(skipped),
    device,
  });

const keys = (p: ReturnType<typeof owner>, group?: string) =>
  p.steps.filter((s) => !group || s.group === group).map((s) => s.key);
const step = (p: ReturnType<typeof owner>, key: OnboardingStepKey) =>
  p.steps.find((s) => s.key === key)!;

describe('the order', () => {
  it('gives every must-do, whatever the goal, a screen in the setup wizard', () => {
    for (const goal of [...ONBOARDING_GOALS, null])
      for (const key of mustDoOrder(goal)) expect(isWizardStep(key), `${goal}: ${key}`).toBe(true);
    expect(isWizardStep('team')).toBe(false);
    expect(isWizardStep('app')).toBe(false);
  });

  it('puts the number first and the rest in a sensible order when nothing was answered', () => {
    const p = owner(facts());
    expect(keys(p, 'basics')).toEqual(['number', 'customers', 'calendar', 'ai']);
    expect(keys(p, 'later')).toEqual(['team', 'payments', 'email_chat', 'app', 'sign_in']);
    expect(p.steps.every((s) => s.mustDo === (s.group === 'basics'))).toBe(true);
    expect(progressWords(p)).toBe('0 of 9 done');
  });

  it('puts the goal’s own step second, and the number always first', () => {
    expect(keys(owner(facts(), answers({ goal: 'leads' })), 'basics')).toEqual([
      'number',
      'ai',
      'customers',
      'calendar',
    ]);
    expect(keys(owner(facts(), answers({ goal: 'booked' })), 'basics')).toEqual([
      'number',
      'calendar',
      'ai',
      'customers',
    ]);
    expect(keys(owner(facts(), answers({ goal: 'organized' })), 'basics')).toEqual([
      'number',
      'customers',
      'calendar',
      'ai',
    ]);
  });

  it('makes connecting payments a must-do for “Getting paid” (Chris, 2026-09-29)', () => {
    const p = owner(facts(), answers({ goal: 'paid' }));
    expect(keys(p, 'basics')).toEqual(['number', 'payments', 'customers', 'calendar', 'ai']);
    expect(keys(p, 'later')).toEqual(['team', 'email_chat', 'app', 'sign_in']);
    expect(p.total).toBe(9);
  });

  it('leaves Invite your team out for “Just me”', () => {
    expect(keys(owner(facts(), answers({ teamSize: 'solo' })))).not.toContain('team');
  });

  it('gives a teammate only their own four steps', () => {
    const p = onboardingProgress({
      audience: 'personal',
      answers: answers(),
      facts: { business: null, person: { phones: 1, calendarConnected: false } },
      skipped: new Set(),
    });
    expect(keys(p)).toEqual(['app', 'notifications', 'my_calendar', 'sign_in']);
    expect(p.steps.every((s) => s.group === 'yours' && !s.mustDo)).toBe(true);
    // A phone registers for notifications only once they're allowed.
    expect(step(p, 'app').state).toBe('done');
    expect(step(p, 'notifications').state).toBe('done');
    expect(p.next).toBe('my_calendar');
  });
});

describe('where each step stands', () => {
  it('counts the number as done while the carriers review it, and says which day', () => {
    const since = '2026-09-28T15:00:00.000Z';
    const p = owner(
      facts({ number: { next: 'awaiting_approval', display: '(512) 555-0148', since } }),
    );
    const n = step(p, 'number');
    expect(n).toMatchObject({ state: 'waiting', since });
    expect(p.done).toBe(1);
    expect(p.next).toBe('customers');
    expect(waitingDay(since, new Date('2026-09-29T17:00:00Z'))).toBe(2);
  });

  it('needs a fix when the carriers turned texting down, and keeps their reason', () => {
    const p = owner(
      facts({
        number: {
          next: 'rejected',
          display: '(512) 555-0148',
          rejectionReason: 'The business address doesn’t match the EIN record.',
        },
      }),
    );
    expect(step(p, 'number')).toMatchObject({ state: 'needs_fix' });
    expect(stepWords(step(p, 'number')).detail).toBe(
      'The carriers turned down texting: The business address doesn’t match the EIN record. Fix your details and send them again.',
    );
    expect(p.complete).toBe(false);
  });

  it('asks for the carrier details once a number is bought, and waits while one moves over', () => {
    expect(step(owner(facts({ number: { next: 'submit_registration' } })), 'number').state).toBe(
      'todo',
    );
    expect(step(owner(facts({ number: { next: 'porting' } })), 'number').state).toBe('waiting');
    expect(step(owner(facts({ number: { next: 'ready' } })), 'number').state).toBe('done');
  });

  it('tells a payment account being checked from one that needs the owner', () => {
    const at = (p: Partial<Business['payments']>) =>
      step(owner(facts({ payments: { provider: 'stripe', ...p } })), 'payments');
    expect(at({ active: true }).state).toBe('done');
    expect(at({ active: true, checking: true }).state).toBe('waiting');
    expect(at({ active: true, needsInfo: true })).toMatchObject({
      state: 'needs_fix',
      note: { phase: 'needs_info' },
    });
    expect(at({ broken: true })).toMatchObject({ state: 'needs_fix', note: { phase: 'reauth' } });
    expect(stepWords(at({ broken: true })).action).toBe('Reconnect');
  });

  it('counts customers in, or “Add them as you go”, as done; an import running as waiting', () => {
    const at = (c: Partial<Business['customers']>) =>
      step(owner(facts({ customers: c }), answers()), 'customers');
    expect(at({ count: 12 }).state).toBe('done');
    expect(stepWords(at({ count: 12 })).detail).toBe('12 customers in.');
    expect(at({ asYouGo: true }).state).toBe('done');
    expect(at({ running: 'import' }).state).toBe('waiting');
    expect(at({ running: 'migration', migrationNeedsYou: true })).toMatchObject({
      state: 'todo',
      note: { phase: 'migration_check' },
    });
    expect(stepWords(at({}), answers()).action).toBe('Move from GoHighLevel');
    expect(stepWords(at({}), answers({ customersIn: 'none' })).action).toBe('Add customers');
  });

  it('wants services and the booking page on for the calendar', () => {
    const at = (c: Partial<Business['calendar']>) =>
      step(owner(facts({ calendar: c })), 'calendar');
    expect(at({ calendars: 1, services: 3 })).toMatchObject({
      state: 'todo',
      note: { phase: 'booking' },
    });
    expect(stepWords(at({ calendars: 1, services: 3 })).action).toBe('Turn on');
    expect(at({ calendars: 1, services: 3, bookingOn: true }).state).toBe('done');
  });

  it('counts the AI step done by the same rule as the AI teammate’s own warning', () => {
    const at = (a: Partial<Business['ai']>) => step(owner(facts({ ai: a })), 'ai');
    const enough = { name: 'Ava', published: 5, profileFilled: 4, profileTotal: 7 };
    expect(at(enough).state).toBe('done');
    expect(at({ ...enough, published: 4 })).toMatchObject({
      state: 'todo',
      note: { phase: 'thin' },
    });
    expect(at({ ...enough, profileFilled: 3 }).state).toBe('todo');
    expect(at({ name: null, published: 9, profileFilled: 7 }).state).toBe('todo');
    const found = at({ name: 'Ava', pendingSuggestions: 14 });
    expect(stepWords(found)).toMatchObject({
      title: 'Teach Ava',
      detail: 'Ava found 14 things on your website. Keep what’s right.',
      action: 'Review',
    });
  });

  it('counts only live invitations for the team', () => {
    expect(step(owner(facts({ team: { members: 1, liveInvitations: 0 } })), 'team').state).toBe(
      'todo',
    );
    expect(step(owner(facts({ team: { liveInvitations: 1 } })), 'team').state).toBe('done');
    expect(step(owner(facts({ team: { members: 3 } })), 'team').state).toBe('done');
  });

  it('needs both halves of email and website chat', () => {
    const half = step(owner(facts({ emailChat: { mailbox: true } })), 'email_chat');
    expect(half).toMatchObject({ state: 'todo', note: { partsDone: 1, partsTotal: 2 } });
    expect(stepWords(half).action).toBe('Add chat');
    expect(
      step(owner(facts({ emailChat: { mailbox: true, chat: true } })), 'email_chat').state,
    ).toBe('done');
  });

  it('takes the sign-in methods and the phone from the device', () => {
    const p = owner(facts(), null, [], { signIn: true, app: true });
    expect(step(p, 'sign_in').state).toBe('done');
    expect(step(p, 'app').state).toBe('done');
    expect(step(owner(facts()), 'sign_in').state).toBe('todo');
  });
});

describe('skipping and finishing', () => {
  it('skips a step still to do, takes it off the total, and moves on to the next', () => {
    const p = owner(facts(), answers(), ['number']);
    expect(step(p, 'number').state).toBe('skipped');
    expect(p).toMatchObject({ total: 8, skipped: 1, next: 'ai' });
    expect(stepWords(step(p, 'number'))).toMatchObject({
      badge: 'Skipped',
      action: 'Get a number',
    });
    expect(stepWords(step(p, 'number')).detail).toMatch(/^Skipped for now\. /);
  });

  it('shows a skipped step that has been done since as done', () => {
    const p = owner(facts({ customers: { count: 4 } }), answers(), ['customers']);
    expect(step(p, 'customers').state).toBe('done');
    expect(p.skipped).toBe(0);
  });

  it('is complete once every step is done, waiting or skipped, and not before', () => {
    const f = facts({
      number: { next: 'awaiting_approval', since: '2026-09-28T15:00:00Z' },
      customers: { asYouGo: true },
      calendar: { calendars: 1, services: 2, bookingOn: true },
      ai: { name: 'Ava', published: 6, profileFilled: 5 },
    });
    const rest: OnboardingStepKey[] = ['team', 'payments', 'email_chat', 'app'];
    expect(owner(f, answers(), rest).complete).toBe(false);
    const p = owner(f, answers(), [...rest, 'sign_in']);
    expect(p).toMatchObject({ complete: true, next: null, done: 4, total: 4 });
  });
});

describe('the words', () => {
  it('names what’s left when finishing is refused', () => {
    expect(ONBOARDING_WORDS.notFinished(['Connect payments'])).toBe(
      'One step is still to do: Connect payments. Do it, or press Skip for now.',
    );
    expect(
      ONBOARDING_WORDS.notFinished(['Invite your team', 'Connect payments', 'Sign in faster']),
    ).toBe(
      '3 steps are still to do: Invite your team, Connect payments and Sign in faster. Do them, or press Skip for now.',
    );
  });

  it('sends people to the test versions of the app until the store ones are out', () => {
    expect(PHONE_APP_LINKS.testing).toBe(true);
    expect(PHONE_APP_LINKS.links.map((l) => l.url)).toEqual([
      'https://testflight.apple.com/join/GBEM8rJU',
      'https://play.google.com/apps/internaltest/4701652122344223804',
    ]);
    expect(stepWords(step(owner(facts()), 'app'))).toMatchObject({
      action: 'Get the links',
      detail: 'Test version for now: TestFlight on iPhone, Google Play testing on Android.',
    });
  });

  it('says how many days the carriers have had it', () => {
    const n = step(
      owner(
        facts({
          number: {
            next: 'awaiting_approval',
            display: '(512) 555-0148',
            since: new Date().toISOString(),
          },
        }),
      ),
      'number',
    );
    expect(stepWords(n).badge).toBe('In review · day 1');
    expect(stepWords(n).detail).toMatch(/^\(512\) 555-0148\. Calls work now\./);
  });

  it('says under each step in the wizard where it stands', () => {
    const p = owner(
      facts({
        number: { next: 'awaiting_approval', display: '(512) 555-0148', since: null },
        customers: { count: 42 },
      }),
      answers(),
      ['calendar'],
    );
    expect(railLine(step(p, 'number'))).toBe('(512) 555-0148 · texting in review');
    expect(railLine(step(p, 'customers'))).toBe('42 in');
    expect(railLine(step(p, 'calendar'))).toBe('Skipped for now');
    // Still to do: what the quick questions' preview said about it.
    expect(railLine(step(p, 'ai'), answers())).toBe(previewDetail('ai', answers()));
  });
});

describe('what’s kept', () => {
  const ws = '00000000-0000-4000-8000-000000000001';
  const other = '00000000-0000-4000-8000-000000000002';
  const by = '00000000-0000-4000-8000-0000000000aa';

  it('reads a business’s answers and skips forgivingly', () => {
    const got = businessOnboardingOf({
      onboarding: {
        answers: { goal: 'paid', customersIn: 'sheet', teamSize: 'big' },
        skipped: {
          payments: { at: '2026-09-29T10:00:00.000Z', by },
          nonsense: { at: '2026-09-29T10:00:00.000Z', by },
          team: 'yes',
        },
      },
    });
    expect(got.answers).toEqual({ goal: 'paid', customersIn: 'sheet', teamSize: 'big' });
    expect(Object.keys(got.skipped)).toEqual(['payments']);
    expect(businessOnboardingOf({ onboarding: { answers: { goal: 'fly' } } }).answers).toBeNull();
    expect(businessOnboardingOf(null)).toEqual({
      answers: null,
      skipped: {},
      customersAsYouGo: null,
    });
  });

  it('keeps one person’s view per business, and leaves the others alone', () => {
    const settings = {
      menu: { x: 1 },
      onboarding: { [other]: { hidden: true, finishedAt: '2026-09-01T00:00:00.000Z' } },
    };
    expect(personalOnboardingOf(settings, ws)).toEqual({
      hidden: false,
      tourDoneAt: null,
      finishedAt: null,
      skipped: {},
    });
    const next = withPersonalOnboarding(settings, ws, {
      hidden: false,
      tourDoneAt: '2026-09-29T10:00:00.000Z',
      finishedAt: null,
      skipped: { sign_in: '2026-09-29T10:00:00.000Z' },
    });
    expect(next[other]).toEqual(settings.onboarding[other]);
    expect(personalOnboardingOf({ onboarding: next }, ws)).toMatchObject({
      tourDoneAt: '2026-09-29T10:00:00.000Z',
      skipped: { sign_in: '2026-09-29T10:00:00.000Z' },
    });
  });
});

describe('the quick questions', () => {
  it('shows the order while it’s still being answered', () => {
    expect(laterOrder({ teamSize: 'solo' })).toEqual(['payments', 'email_chat', 'app', 'sign_in']);
    expect(laterOrder({ goal: 'paid' })).toEqual(['team', 'email_chat', 'app', 'sign_in']);
    expect(laterOrder(null)).toEqual(['team', 'payments', 'email_chat', 'app', 'sign_in']);
  });

  it('says how the customers come in, from the answer', () => {
    expect(previewDetail('customers', { customersIn: 'ghl' })).toBe(
      'Move them from GoHighLevel; nothing there changes',
    );
    expect(previewDetail('customers', { customersIn: 'sheet' })).toBe('Import your spreadsheet');
    expect(previewDetail('customers')).toBe('Add them as they come in');
    expect(previewDetail('number')).toBe('Pick a number, and send your details to the carriers');
  });

  it('has a label for every answer', () => {
    expect(Object.keys(QUESTION_WORDS.goals)).toEqual(['leads', 'booked', 'paid', 'organized']);
    expect(Object.keys(QUESTION_WORDS.sources)).toEqual(['sheet', 'ghl', 'crm', 'phone', 'none']);
    expect(Object.keys(QUESTION_WORDS.teams)).toEqual(['solo', 'small', 'big']);
  });
});
