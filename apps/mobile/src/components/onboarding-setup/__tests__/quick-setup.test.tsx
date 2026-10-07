import {
  AI_SETUP_WORDS,
  aiSetupFlowFactsOf,
  emptyKnowledgeProfile,
  LINK_WORDS,
  ONBOARDING_SETUP_WORDS as W,
  OnboardingSetupAnswers,
  OnboardingSetupGetOutput,
  onboardingSetupPreviousScreen,
  onboardingSetupProgress,
  onboardingSetupStateOf,
  setupKindOf,
  startingOnboardingSetupAnswers,
  teammateConfigFromPreset,
  usTimeZoneLabel,
  type OnboardingSetupAnswersInput,
  type OnboardingSetupScreen,
  type OnboardingSetupStateOut,
} from '@hfos/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import * as React from 'react';

import ChooseBusiness from '@/app/app/index';
import OnboardingSetup from '@/app/app/w/[workspaceId]/setup';
import { BusinessProvider } from '@/components/shell/business-context';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import type { Business, Me } from '@/lib/businesses';
import { deviceStore } from '@/lib/device-store';
import { ONBOARDING_SETUP_PHONE_WORDS as P } from '@/onboarding-setup/words';

/**
 * The onboarding setup on the phone (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §8), with HandsFreeOS
 * and the worker played by stand-ins: the first screen making the business straight after signing up; carrying on
 * where it was left, each screen kept as it's finished, and the booking page made as its screen opens; a number
 * found near the address and bought; payments connected in the phone's browser; "Stay in the loop", the test chat
 * and what already works; and someone who can't run it, and no signal.
 */

jest.mock('expo-router', () => ({
  router: {
    back: jest.fn(),
    replace: jest.fn(),
    push: jest.fn(),
    setParams: jest.fn(),
    canGoBack: () => true,
  },
  Redirect: ({ href }: { href: string }) => {
    mockRedirects.push(href);
    return null;
  },
  useLocalSearchParams: () => mockParams,
  usePathname: () => '/',
}));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('expo-web-browser', () => ({
  openBrowserAsync: jest.fn(async () => ({ type: 'dismiss' })),
}));
jest.mock('@/components/shell/status-strip', () => ({ StatusStrip: () => null }));
jest.mock('@/lib/api', () => ({
  ...jest.requireActual<object>('@/lib/api'),
  api: { POST: jest.fn() },
}));
jest.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: jest.fn(async () => ({ data: { session: null } })) } },
}));
jest.mock('@/lib/auth', () => ({
  session: { accessToken: async () => 'token-1', signOut: jest.fn(async () => undefined) },
  useSession: () => ({
    status: 'signedIn',
    person: { userId: '11111111-1111-4111-8111-111111111111', name: 'Dale' },
    expiresAt: 0,
  }),
}));
// The worker's address: the number search and the payment providers' sign-in go through it.
jest.mock('@/lib/config', () => {
  const actual = jest.requireActual<{ config: Record<string, unknown> }>('@/lib/config');
  return { ...actual, config: { ...actual.config, workerUrl: 'http://worker.test' } };
});
jest.mock('@/admin/staff', () => ({ useStaff: () => ({ staff: null, status: 'ready' }) }));
let mockOnline = true;
const mockAppFetch = jest.fn<Promise<Response>, [string, RequestInit]>();
jest.mock('@/lib/network', () => ({
  useNetwork: () => ({ online: mockOnline, lastOnlineAt: 0 }),
  networkSnapshot: () => ({ online: mockOnline, lastOnlineAt: 0 }),
  subscribeNetwork: () => () => undefined,
  isTestOffline: () => false,
  appFetch: (url: string, init: RequestInit) => mockAppFetch(url, init),
}));
jest.mock('@/lib/open-web', () => ({ openWeb: jest.fn(async () => true) }));
jest.mock('@/push/hooks', () => ({
  usePushRegistration: () => ({ permission: 'granted', canAskAgain: true }),
}));
jest.mock('@/push/device', () => ({
  pushRegistration: { ask: jest.fn(async () => 'granted') },
}));
let mockParams: Record<string, string> = {};
const mockRedirects: string[] = [];

const DALE = '11111111-1111-4111-8111-111111111111';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TEAMMATE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const MARK = { at: '2026-10-06T12:00:00.000Z', by: DALE };

const AUSTIN = {
  line1: '12 Oak St',
  line2: '',
  city: 'Austin',
  state: 'TX',
  postalCode: '78701',
  country: 'US',
} as const;

/** Lone Star as the setup finds it once the first screen made it: a plumber in Austin with no website. */
const STATE: OnboardingSetupStateOut = {
  businessName: 'Lone Star Plumbing',
  industry: 'plumbing',
  kind: setupKindOf('plumbing'),
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
  address: AUSTIN,
  reviewLink: null,
  numberSetup: { next: 'buy_number', display: null, since: null, rejectionReason: null },
  payments: { active: false, checking: false, needsInfo: false, broken: false, provider: null },
  customers: { count: 0, running: null, migrationNeedsYou: false, asYouGo: false },
  booking: { on: false, site: null },
  team: { members: 1, invited: [] },
  bookable: [],
  priceList: [],
  myHours: null,
  phones: 1,
};

/** What `onboarding_setup.get` says: where it stands, the answers so far, and how far it got. */
function gotOf(
  state: OnboardingSetupStateOut = STATE,
  extra: { reached?: OnboardingSetupScreen | null; answers?: OnboardingSetupAnswersInput } = {},
) {
  const starting = startingOnboardingSetupAnswers(onboardingSetupStateOf(state));
  return OnboardingSetupGetOutput.parse({
    state,
    answers: { ...starting, ...extra.answers, ai: { ...starting.ai, ...extra.answers?.ai } },
    starting,
    reached: extra.reached ?? null,
    started: MARK,
    finished: null,
  });
}

/** The screen before this one for Lone Star's answers: where someone stopped to open the setup on this one. */
const before = (screen: OnboardingSetupScreen, given: OnboardingSetupAnswersInput = {}) =>
  onboardingSetupPreviousScreen(
    screen,
    OnboardingSetupAnswers.parse(given),
    aiSetupFlowFactsOf(onboardingSetupStateOf(STATE)),
  );

class Refusal {
  constructor(
    readonly status: number,
    readonly error: { code: string; message: string; rule?: string; details?: unknown },
  ) {}
}

let answers: Record<string, unknown>;
const post = api.POST as unknown as jest.Mock<
  Promise<{ data?: unknown; error?: unknown; response: Response }>,
  [string, { body: Record<string, unknown> }]
>;
const sent = (path: string) => post.mock.calls.filter((c) => c[0] === path).map((c) => c[1].body);

function serve() {
  post.mockImplementation(async (path, { body }) => {
    const answer = answers[path];
    const value = typeof answer === 'function' ? (answer as (b: unknown) => unknown)(body) : answer;
    if (value instanceof Refusal)
      return {
        error: { error: value.error },
        response: new Response(null, { status: value.status }),
      };
    return { data: value ?? {}, response: new Response(null, { status: 200 }) };
  });
}

/** `onboarding_setup.save` as HandsFreeOS answers it: the screen just finished is the furthest. */
const saved = (body: unknown) => ({
  workspaceId: LONE_STAR,
  reached: (body as { screen: OnboardingSetupScreen }).screen,
  kind: STATE.kind,
  kindChanged: false,
  scanStarted: false,
  invited: [],
  changes: [],
  notes: [],
  calendarId: null,
});

/** `account.me`, with the businesses given. */
const meOut = (businesses: readonly string[]) => ({
  user: { id: DALE, email: 'dale@lonestarplumbing.test', fullName: 'Dale Porter' },
  workspaces: businesses.map((id) => ({
    id,
    name: 'Lone Star Plumbing',
    organizationId: ORG,
    organizationName: 'Lone Star Plumbing',
    role: 'owner',
    timezone: 'America/Chicago',
  })),
  organizations: businesses.length ? [{ id: ORG, name: 'Lone Star Plumbing', role: 'owner' }] : [],
});

/** The setup's own screen, for Lone Star, as `role`. */
async function open(role: Business['role'] = 'owner') {
  const business: Business = {
    id: LONE_STAR,
    name: 'Lone Star Plumbing',
    organizationId: ORG,
    organizationName: 'Lone Star Plumbing',
    role,
    timezone: 'America/Chicago',
  };
  const me: Me = {
    user: { id: DALE, email: 'dale@lonestarplumbing.test', fullName: 'Dale Porter' },
    businesses: [business],
    organizations: [],
    fetchedAt: 0,
  };
  await render(
    <BusinessProvider value={{ userId: DALE, me, business, openSwitcher: () => undefined }}>
      <OnboardingSetup />
    </BusinessProvider>,
  );
}

/** The worker's answer to the number search. */
const numbersFound = (numbers: { e164: string; display: string }[]) =>
  new Response(
    JSON.stringify({
      numbers: numbers.map((n) => ({ ...n, locality: 'Austin', region: 'TX' })),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

beforeEach(() => {
  jest.clearAllMocks();
  // The businesses this phone knew from the test before.
  deviceStore.remove(`person.${DALE}.me`);
  mockOnline = true;
  mockParams = {};
  mockRedirects.length = 0;
  answers = {
    '/v1/queries/onboarding_setup.get': gotOf(),
    '/v1/queries/knowledge_scan.get': { scan: null },
    '/v1/queries/branded_domain.get': { domain: null },
    '/v1/commands/onboarding_setup.save': saved,
  };
  serve();
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
});

describe('straight after signing up', () => {
  it('makes the business on the setup’s first screen, then opens the rest of the setup', async () => {
    let made = false;
    answers['/v1/queries/account.me'] = () => meOut(made ? [LONE_STAR] : []);
    answers['/v1/commands/organization.create'] = () => {
      made = true;
      return { organizationId: ORG, workspaceId: LONE_STAR };
    };
    await render(<ChooseBusiness />);
    // In no business yet: the first screen, where the business is made, and Sign out beside it.
    await screen.findByTestId('onboarding-setup-step-business');
    const at = onboardingSetupProgress('business', OnboardingSetupAnswers.parse({}), {
      website: false,
      chat: false,
    });
    expect(screen.getByText(W.position(at.at, at.of))).toBeTruthy();
    expect(screen.getByTestId('choose-business-sign-out')).toHaveTextContent(P.signOut);
    // Someone invited to a business joins it from the invitation instead.
    expect(screen.getByTestId('setup-invited')).toHaveTextContent(P.invited);

    // Nothing filled in: each part says what it needs, and nothing is made.
    await fireEvent.press(screen.getByTestId('onboarding-setup-next'));
    expect(screen.getByText(W.businessNameMissing)).toBeTruthy();
    expect(screen.getByText(W.kindMissing)).toBeTruthy();
    expect(sent('/v1/commands/organization.create')).toEqual([]);

    await fireEvent.changeText(screen.getByTestId('setup-business-name'), 'Lone Star Plumbing');
    // What they do: a big button opens the kinds in it.
    await fireEvent.press(screen.getByTestId('setup-kind-button-home'));
    await fireEvent.press(await screen.findByTestId('setup-kind-plumbing'));
    await waitFor(() => expect(screen.getByTestId('ai-setup-kind')).toHaveTextContent('Plumbing'));
    // The address, its state picked on a sheet, sets the time zone.
    await fireEvent.changeText(screen.getByTestId('setup-line1'), '12 Oak St');
    await fireEvent.changeText(screen.getByTestId('setup-city'), 'Austin');
    await fireEvent.press(screen.getByTestId('setup-state'));
    await fireEvent.changeText(await screen.findByTestId('setup-state-search'), 'tex');
    await fireEvent.press(screen.getByTestId('setup-state-TX'));
    await fireEvent.changeText(screen.getByTestId('setup-postal-code'), '78701');
    expect(screen.getByTestId('setup-time-zone')).toHaveTextContent(
      W.timeZoneFromAddress(usTimeZoneLabel('America/Chicago')),
      { exact: false },
    );
    await fireEvent.press(screen.getByTestId('ai-setup-no-website'));

    await fireEvent.press(screen.getByTestId('onboarding-setup-next'));
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith(`/app/w/${LONE_STAR}/setup?at=goal`),
    );
    expect(sent('/v1/commands/organization.create')).toEqual([
      { businessName: 'Lone Star Plumbing', timezone: 'America/Chicago', industry: 'plumbing' },
    ]);
    expect(sent('/v1/commands/onboarding_setup.save')).toEqual([
      expect.objectContaining({
        workspaceId: LONE_STAR,
        screen: 'business',
        business: {
          name: 'Lone Star Plumbing',
          industry: 'plumbing',
          address: expect.objectContaining({
            line1: '12 Oak St',
            city: 'Austin',
            state: 'TX',
            postalCode: '78701',
          }),
          timezone: 'America/Chicago',
          website: null,
        },
      }),
    ]);
    // The business joined the list while it was made, and the screen didn't open its Home meanwhile.
    expect(mockRedirects).toEqual([]);
  });

  it('keeps what was typed when there’s no signal, and makes nothing', async () => {
    answers['/v1/queries/account.me'] = meOut([]);
    await render(<ChooseBusiness />);
    await screen.findByTestId('onboarding-setup-step-business');
    mockOnline = false;
    await fireEvent.changeText(screen.getByTestId('setup-business-name'), 'Lone Star Plumbing');
    await fireEvent.press(screen.getByTestId('setup-kind-button-home'));
    await fireEvent.press(await screen.findByTestId('setup-kind-plumbing'));
    await fireEvent.changeText(screen.getByTestId('setup-line1'), '12 Oak St');
    await fireEvent.changeText(screen.getByTestId('setup-city'), 'Austin');
    await fireEvent.press(screen.getByTestId('setup-state'));
    await fireEvent.press(await screen.findByTestId('setup-state-TX'));
    await fireEvent.changeText(screen.getByTestId('setup-postal-code'), '78701');
    await fireEvent.press(screen.getByTestId('onboarding-setup-next'));
    expect(screen.getByTestId('onboarding-setup-error')).toHaveTextContent(P.needsSignal);
    expect(screen.getByTestId('setup-business-name')).toHaveDisplayValue('Lone Star Plumbing');
    expect(sent('/v1/commands/organization.create')).toEqual([]);
  });
});

describe('the screens after the first', () => {
  it('carries on where it was left, keeps each screen as it’s finished, and makes the booking page', async () => {
    answers['/v1/queries/onboarding_setup.get'] = gotOf(STATE, {
      reached: 'goal',
      answers: { goal: 'booked' },
    });
    await open();
    // Started before: it opens after the furthest screen finished, and says so.
    await screen.findByTestId('onboarding-setup-step-about');
    expect(screen.getByTestId('onboarding-setup-carry-on')).toHaveTextContent(W.carryOn, {
      exact: false,
    });

    // About the business: what it does, a service with its price and length, where, and booking.
    await fireEvent.changeText(
      screen.getByTestId('ai-setup-description'),
      'We fix leaks and water heaters in Austin.',
    );
    await fireEvent.press(screen.getByTestId('ai-setup-add-service'));
    await fireEvent.changeText(screen.getByTestId('ai-setup-service-0-name'), 'Leak repair');
    await fireEvent.changeText(screen.getByTestId('ai-setup-service-0-price'), '89');
    await fireEvent.press(screen.getByTestId('ai-setup-service-0-minutes'));
    await fireEvent.press(await screen.findByTestId('ai-setup-service-0-minutes-90'));
    await fireEvent.changeText(screen.getByTestId('ai-setup-area'), 'Austin and Round Rock');
    await fireEvent.press(screen.getByTestId('ai-setup-books-time-yes'));
    await fireEvent.press(screen.getByTestId('onboarding-setup-next'));
    await screen.findByTestId('onboarding-setup-step-hours');
    expect(sent('/v1/commands/onboarding_setup.save')).toEqual([
      expect.objectContaining({
        workspaceId: LONE_STAR,
        screen: 'about',
        answers: expect.objectContaining({
          booksTime: true,
          ai: expect.objectContaining({
            description: 'We fix leaks and water heaters in Austin.',
            services: [
              expect.objectContaining({ name: 'Leak repair', priceCents: 8900, minutes: 90 }),
            ],
            area: 'Austin and Round Rock',
          }),
        }),
      }),
    ]);
    expect(router.setParams).toHaveBeenCalledWith({ at: 'hours' });
    expect(screen.queryByTestId('onboarding-setup-carry-on')).toBeNull();

    await fireEvent.press(screen.getByTestId('onboarding-setup-next'));
    await screen.findByTestId('onboarding-setup-step-customers');

    // Customers in GoHighLevel: bringing them in is easier on a computer, so it emails a link.
    answers['/v1/commands/onboarding.send_link'] = {
      workspaceId: LONE_STAR,
      step: 'customers',
      email: 'dale@lonestarplumbing.test',
      sent: true,
    };
    await fireEvent.press(screen.getByTestId('setup-customers-ghl'));
    expect(screen.getByTestId('setup-customers-computer')).toHaveTextContent(
      P.customersOnComputer,
      { exact: false },
    );
    await fireEvent.press(screen.getByTestId('setup-customers-link'));
    await waitFor(() =>
      expect(sent('/v1/commands/onboarding.send_link')).toEqual([
        { workspaceId: LONE_STAR, step: 'customers' },
      ]),
    );
    await waitFor(() =>
      expect(toast.show).toHaveBeenCalledWith(LINK_WORDS.sent('dale@lonestarplumbing.test')),
    );

    // The booking page is made as its screen opens, and its link is there to share.
    answers['/v1/commands/onboarding_setup.save'] = (body: { screen: string }) => ({
      ...saved(body),
      changes: body.screen === 'booking' ? ['Makes your booking page'] : [],
    });
    answers['/v1/queries/onboarding_setup.get'] = gotOf(
      {
        ...STATE,
        booking: {
          on: true,
          site: { slug: 'lone-star-plumbing', name: 'Lone Star Plumbing', enabled: true },
        },
      },
      { reached: 'booking', answers: { goal: 'booked', booksTime: true, customersIn: 'ghl' } },
    );
    await fireEvent.press(screen.getByTestId('onboarding-setup-next'));
    await screen.findByTestId('onboarding-setup-step-booking');
    expect(await screen.findByTestId('setup-booking-changes')).toHaveTextContent(
      'Makes your booking page',
    );
    expect(await screen.findByTestId('setup-booking-link')).toHaveTextContent(
      'https://app.handsfreeos.com/book/lone-star-plumbing',
      { exact: false },
    );
    expect(
      sent('/v1/commands/onboarding_setup.save').map((b) => (b as { screen: string }).screen),
    ).toEqual(['about', 'hours', 'customers', 'booking']);

    // Next from the booking page goes straight on: it was saved as it opened.
    await fireEvent.press(screen.getByTestId('onboarding-setup-next'));
    await screen.findByTestId('onboarding-setup-step-number');
  });

  it('finds numbers near the address and buys the one picked', async () => {
    answers['/v1/queries/onboarding_setup.get'] = gotOf(STATE, { reached: before('number') });
    answers['/v1/commands/phone_number.buy'] = new Refusal(402, {
      code: 'rule',
      rule: 'wallet_short',
      message:
        'There isn’t enough on your balance for a phone number’s first month. Top up in Settings → Usage & balance, then try again.',
    });
    mockAppFetch.mockImplementation(async () =>
      numbersFound([
        { e164: '+15125550148', display: '(512) 555-0148' },
        { e164: '+15125550199', display: '(512) 555-0199' },
      ]),
    );
    await open();
    await screen.findByTestId('onboarding-setup-step-number');

    // An EIN: local numbers, near the business's city.
    await fireEvent.press(screen.getByTestId('setup-ein-yes'));
    await screen.findByTestId('setup-number-15125550148');
    expect(screen.getByText(P.numbersNear('Austin'))).toBeTruthy();
    const [url, init] = mockAppFetch.mock.calls[0]!;
    expect(url).toBe('http://worker.test/v1/telephony/available-numbers');
    expect(init.headers).toEqual(expect.objectContaining({ authorization: 'Bearer token-1' }));
    expect(JSON.parse(init.body as string)).toEqual({
      workspaceId: LONE_STAR,
      numberType: 'local',
      city: 'Austin',
      state: 'TX',
      withinMiles: 25,
    });
    expect(screen.getByTestId('setup-number-15125550148')).toBeChecked();
    await fireEvent.press(screen.getByTestId('setup-number-15125550199'));
    expect(screen.getByTestId('setup-number-buy')).toHaveTextContent(P.getNumber('(512) 555-0199'));

    // Not enough on the balance: it says where to top up, and stays.
    await fireEvent.press(screen.getByTestId('setup-number-buy'));
    expect(await screen.findByTestId('setup-number-buy-error')).toHaveTextContent(
      'Top up in Settings → Usage & balance',
      { exact: false },
    );

    // Topped up: bought, and it says where the number stands.
    answers['/v1/commands/phone_number.buy'] = { phoneNumberId: 'number-1' };
    answers['/v1/queries/onboarding_setup.get'] = gotOf(
      {
        ...STATE,
        numberSetup: {
          next: 'provisioning',
          display: '(512) 555-0199',
          since: null,
          rejectionReason: null,
        },
      },
      { reached: before('number'), answers: { hasEin: true } },
    );
    await fireEvent.press(screen.getByTestId('setup-number-buy'));
    await screen.findByTestId('setup-number-provisioning');
    expect(sent('/v1/commands/phone_number.buy')).toEqual([
      { workspaceId: LONE_STAR, e164: '+15125550199', numberType: 'local' },
      { workspaceId: LONE_STAR, e164: '+15125550199', numberType: 'local' },
    ]);
    expect(toast.show).toHaveBeenCalledWith(P.bought('(512) 555-0199'));
  });

  it('looks for toll-free numbers for a business with no EIN', async () => {
    answers['/v1/queries/onboarding_setup.get'] = gotOf(STATE, { reached: before('number') });
    mockAppFetch.mockImplementation(async () =>
      numbersFound([{ e164: '+18335550123', display: '(833) 555-0123' }]),
    );
    await open();
    await screen.findByTestId('onboarding-setup-step-number');
    await fireEvent.press(screen.getByTestId('setup-ein-no'));
    await screen.findByTestId('setup-number-18335550123');
    expect(screen.getByText(P.tollFreeNumbers)).toBeTruthy();
    expect(JSON.parse(mockAppFetch.mock.calls[0]![1].body as string)).toEqual({
      workspaceId: LONE_STAR,
      numberType: 'toll_free',
    });
    // Keeping a number they already have is easier on a computer.
    await fireEvent.press(screen.getByTestId('setup-number-have'));
    expect(screen.getByText(P.haveNumber)).toBeTruthy();
  });

  it('connects payments in the phone’s browser, and asks where it stands on the way back', async () => {
    answers['/v1/queries/onboarding_setup.get'] = gotOf(STATE, { reached: before('paid') });
    answers['/v1/commands/payment_connection.connect'] = { state: 'st-1' };
    await open();
    await screen.findByTestId('onboarding-setup-step-paid');
    await fireEvent.press(screen.getByTestId('setup-pay-stripe'));
    answers['/v1/queries/onboarding_setup.get'] = gotOf(
      {
        ...STATE,
        payments: {
          active: true,
          checking: false,
          needsInfo: false,
          broken: false,
          provider: 'stripe',
        },
      },
      { reached: before('paid'), answers: { payWith: 'stripe' } },
    );
    await fireEvent.press(screen.getByTestId('setup-pay-connect'));
    await waitFor(() =>
      expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith(
        'http://worker.test/oauth/stripe/start?state=st-1',
      ),
    );
    expect(sent('/v1/commands/payment_connection.connect')).toEqual([
      { workspaceId: LONE_STAR, provider: 'stripe' },
    ]);
    expect(await screen.findByTestId('setup-pay-connected')).toHaveTextContent(
      W.payConnected('Stripe'),
    );
  });

  it('saves the rest on “Stay in the loop”, then the test chat, then what already works', async () => {
    answers['/v1/queries/onboarding_setup.get'] = gotOf(STATE, { reached: before('loop') });
    answers['/v1/commands/onboarding_setup.finish'] = {
      teammateId: TEAMMATE,
      revision: 1,
      changes: ['Sets up Ava, your AI teammate'],
      chat: null,
      calendarId: null,
      notes: [],
    };
    await open();
    await screen.findByTestId('onboarding-setup-step-loop');
    expect(screen.getByTestId('onboarding-setup-next')).toHaveTextContent(AI_SETUP_WORDS.save);

    answers['/v1/queries/onboarding_setup.get'] = gotOf(
      {
        ...STATE,
        teammate: {
          id: TEAMMATE,
          name: 'Ava',
          status: 'off',
          revision: 1,
          config: teammateConfigFromPreset('blank', { industry: 'plumbing' }) as unknown as Record<
            string,
            unknown
          >,
        },
      },
      { reached: 'loop' },
    );
    await fireEvent.press(screen.getByTestId('onboarding-setup-next'));
    await screen.findByTestId('ai-setup-try');
    expect(sent('/v1/commands/onboarding_setup.finish')).toEqual([
      expect.objectContaining({ workspaceId: LONE_STAR, baseRevision: null }),
    ]);
    expect(router.setParams).toHaveBeenCalledWith({ at: 'try' });

    // Not yet: on to what already works, and Go to Home.
    await fireEvent.press(screen.getByTestId('ai-setup-not-yet'));
    await screen.findByTestId('onboarding-setup-done');
    expect(sent('/v1/commands/onboarding_setup.save')).toEqual([
      expect.objectContaining({ screen: 'try' }),
    ]);
    await fireEvent.press(screen.getByTestId('onboarding-setup-home'));
    expect(router.back).toHaveBeenCalled();
  });
});

describe('who can run it', () => {
  it('tells someone who can’t set the business up who can, and asks nothing', async () => {
    await open('member');
    expect(await screen.findByTestId('onboarding-setup-not-allowed')).toHaveTextContent(
      P.notAllowed,
      { exact: false },
    );
    expect(sent('/v1/queries/onboarding_setup.get')).toEqual([]);
  });

  it('needs signal, and says so', async () => {
    mockOnline = false;
    await open();
    expect(await screen.findByTestId('onboarding-setup-offline')).toHaveTextContent(P.needsSignal);
  });
});
