import {
  GUIDED_SETUP_WORDS as G,
  LINK_WORDS,
  PHONE_SETUP_WORDS as W,
  phoneSetupStart,
} from '@hfos/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as React from 'react';

import PhoneSetup from '@/app/app/w/[workspaceId]/phone-setup';
import { BusinessProvider } from '@/components/shell/business-context';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import type { Business, Me } from '@/lib/businesses';
import { workerPost } from '@/lib/worker';
import { PHONE_SETUP_PHONE_WORDS as PW } from '@/phone-setup/words';

/**
 * The guided phone number setup on the phone (the owner, 22 Nov 2026), with HandsFreeOS played by a stand-in: the
 * seven questions one a screen through to Get my number, with every answer saved as it's given; the number bought and
 * Done, with texting approval emailed as a link; keeping a number they already have, also a link; coming back to a
 * number somebody else took meanwhile; and someone who can't change the business's texting and calls.
 */

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
  usePathname: () => '/',
}));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('@/components/shell/status-strip', () => ({ StatusStrip: () => null }));
jest.mock('@/lib/api', () => ({
  ...jest.requireActual<object>('@/lib/api'),
  api: { POST: jest.fn() },
}));
jest.mock('@/lib/worker', () => ({ workerPost: jest.fn() }));
jest.mock('@/lib/config', () => ({
  config: {
    ...jest.requireActual<{ config: object }>('@/lib/config').config,
    workerUrl: 'https://worker.test',
  },
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
jest.mock('@/admin/staff', () => ({ useStaff: () => ({ staff: null, status: 'ready' }) }));
let mockOnline = true;
jest.mock('@/lib/network', () => ({
  useNetwork: () => ({ online: mockOnline, lastOnlineAt: 0 }),
  networkSnapshot: () => ({ online: mockOnline, lastOnlineAt: 0 }),
  subscribeNetwork: () => () => undefined,
  isTestOffline: () => false,
  appFetch: jest.fn(),
}));
jest.mock('@/home/use-home', () => ({
  useWorkspaceRow: () => ({
    settings: JSON.stringify({
      address: {
        line1: '4410 Westpark Dr',
        line2: '',
        city: 'Houston',
        state: 'TX',
        postalCode: '77027',
      },
    }),
  }),
}));

const DALE = '11111111-1111-4111-8111-111111111111';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NUMBER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PICKED = '+17135550148';
const OTHER = '+17135550199';

/** Lone Star HVAC with no number yet, and Ava answering. */
const NO_NUMBER = {
  number: null,
  numbers: [],
  accountStatus: null,
  registrations: [],
  messagingReady: false,
  voiceReady: false,
  nextStep: 'buy_number',
  localRegistrationStep: 'submit_registration',
  settings: {
    quietHours: { enabled: true, start: '20:00', end: '08:00' },
    unansweredReminderMinutes: 10,
    texting: 'on',
    teammateAnswers: null,
  },
  timezone: 'America/Chicago',
  quiet: { quiet: false, localTime: '10:00', endsAt: null },
  canManage: true,
  teammate: {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    name: 'Ava',
    on: true,
    answersCalls: false,
    answer: 'no_answer',
    canManage: true,
  },
  rcsSender: null,
  rcsRequest: null,
  textingFees: null,
};
/** The number once the carrier has it, answering the way the setup said. */
const BOUGHT = {
  ...NO_NUMBER,
  number: {
    id: NUMBER_ID,
    e164: PICKED,
    display: '(713) 555-0148',
    numberType: 'local',
    status: 'active',
    label: null,
    isDefault: true,
    memberUserIds: [],
    routing: {
      forwarding: [],
      ringSeconds: 20,
      voicemailEnabled: true,
      voicemailGreeting: null,
      forwardedCallerId: 'customer',
      announceRecording: true,
    },
    purchasedAt: '2026-11-23T05:30:00.000Z',
    lastError: null,
  },
  nextStep: 'submit_registration',
  voiceReady: true,
  teammate: { ...NO_NUMBER.teammate, answersCalls: true },
};

const FREE = [
  { e164: PICKED, display: '(713) 555-0148', locality: 'Houston', region: 'TX' },
  { e164: OTHER, display: '(713) 555-0199', locality: 'Houston', region: 'TX' },
];

let answers: Record<string, unknown>;
const post = api.POST as unknown as jest.Mock<
  Promise<{ data?: unknown; error?: unknown; response: Response }>,
  [string, { body: Record<string, unknown> }]
>;
const sent = (path: string) => post.mock.calls.filter((c) => c[0] === path).map((c) => c[1].body);
const worker = workerPost as unknown as jest.Mock<
  Promise<unknown>,
  [string, Record<string, unknown>]
>;
/** What the carrier has free: every search, or a search for one number's own digits. */
let free: typeof FREE;

function serve() {
  post.mockImplementation(async (path, { body }) => {
    const answer = answers[path];
    const value = typeof answer === 'function' ? (answer as (b: unknown) => unknown)(body) : answer;
    return { data: value ?? {}, response: new Response(null, { status: 200 }) };
  });
  worker.mockImplementation(async (_path, body) => {
    const contains = typeof body['contains'] === 'string' ? body['contains'] : '';
    return { numbers: contains ? free.filter((n) => n.e164.endsWith(contains)) : free };
  });
}

const open = (role: Business['role'] = 'owner') => {
  const business: Business = {
    id: LONE_STAR,
    name: 'Lone Star HVAC',
    organizationId: 'org',
    organizationName: 'Lone Star HVAC',
    role,
    timezone: 'America/Chicago',
  };
  const me: Me = {
    user: { id: DALE, email: 'dale@lonestarhvac.test', fullName: 'Dale Ramsey' },
    businesses: [business],
    organizations: [],
    fetchedAt: 0,
  };
  return render(
    <BusinessProvider value={{ userId: DALE, me, business, openSwitcher: () => undefined }}>
      <PhoneSetup />
    </BusinessProvider>,
  );
};
const next = () => fireEvent.press(screen.getByTestId('phone-setup-next'));

beforeEach(() => {
  jest.clearAllMocks();
  mockOnline = true;
  free = FREE;
  answers = {
    '/v1/queries/phone.setup_status': NO_NUMBER,
    '/v1/queries/guided_setup.get_draft': { setup: 'phone', answers: null, savedAt: null },
    '/v1/commands/guided_setup.save_draft': { saved: true },
    '/v1/commands/guided_setup.clear_draft': { cleared: true },
    '/v1/commands/onboarding.send_link': {
      workspaceId: LONE_STAR,
      step: 'number',
      email: 'dale@lonestarhvac.test',
      sent: true,
    },
  };
  serve();
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
});

describe('the questions', () => {
  it('asks one a screen, saves the answers, and buys the number on the last one', async () => {
    await open();
    // 1. A new number, picked already.
    await screen.findByTestId('phone-setup-screen-have');
    expect(screen.getByText(G.question(1, 7))).toBeTruthy();
    expect(screen.getByTestId('have-new')).toBeChecked();
    await next();

    // 2. Texting, yes by default.
    await screen.findByTestId('phone-setup-screen-texting');
    expect(screen.getByTestId('texting-yes')).toBeChecked();
    await next();

    // 3. The EIN: nothing picked, so Next asks.
    await screen.findByTestId('phone-setup-screen-ein');
    await next();
    expect(screen.getByText(/Pick yes or no/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('ein-yes'));
    await next();

    // 4. The numbers near the business's address, straight away.
    await screen.findByTestId('phone-setup-screen-number');
    await waitFor(() => expect(screen.getByTestId('number-17135550148')).toBeTruthy());
    expect(worker.mock.calls[0]![1]).toMatchObject({
      workspaceId: LONE_STAR,
      numberType: 'local',
      city: 'Houston',
      state: 'TX',
      withinMiles: 25,
    });
    await next();
    expect(screen.getByText(/Pick one of the numbers/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('number-17135550148'));
    await next();

    // 5. What rings: a cell too.
    await screen.findByTestId('phone-setup-screen-ring');
    await fireEvent.press(screen.getByTestId('phone-more'));
    await fireEvent.changeText(screen.getByTestId('phone-label-0'), 'Dale’s cell');
    await fireEvent.changeText(screen.getByTestId('phone-number-0'), '12');
    await next();
    expect(screen.getByText(/doesn’t look like a phone number/)).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('phone-number-0'), '(713) 555-0117');
    await next();

    // 6. If nobody picks up: Ava, marked Best.
    await screen.findByTestId('phone-setup-screen-missed');
    expect(screen.getByTestId('missed-teammate')).toBeChecked();
    await next();

    // 7. Quiet hours: overnight.
    await screen.findByTestId('phone-setup-screen-quiet');
    expect(screen.getByTestId('quiet-night')).toBeChecked();
    expect(screen.getByText(G.checkItOver)).toBeTruthy();
    await next();

    // Check it over.
    await screen.findByTestId('phone-setup-screen-review');
    expect(screen.getByTestId('review-number')).toHaveTextContent('(713) 555-0148', {
      exact: false,
    });
    expect(screen.getByTestId('review-ring')).toHaveTextContent('HandsFreeOS and Dale’s cell', {
      exact: false,
    });
    expect(screen.queryByTestId('review-have')).toBeNull();
    // Saved as they went, with the screen they were on.
    await waitFor(() =>
      expect(sent('/v1/commands/guided_setup.save_draft').at(-1)).toMatchObject({
        workspaceId: LONE_STAR,
        setup: 'phone',
        answers: { mode: 'new', at: 'review', ein: true },
      }),
    );

    // Get my number: still free, then bought and set up the way they said.
    answers['/v1/queries/phone.setup_status'] = BOUGHT;
    await fireEvent.press(screen.getByTestId('phone-setup-next'));
    await waitFor(() => expect(sent('/v1/commands/phone_setup.save')).toHaveLength(1));
    expect(worker.mock.calls.at(-1)![1]).toMatchObject({ contains: '7135550148' });
    expect(sent('/v1/commands/phone_setup.save')[0]).toEqual({
      workspaceId: LONE_STAR,
      buy: { e164: PICKED, numberType: 'local' },
      ring: {
        forwarding: [{ e164: '+17135550117', label: 'Dale’s cell', enabled: true }],
        forwardedCallerId: 'customer',
      },
      missed: { ringSeconds: 20, then: 'teammate', teammateMode: 'no_answer' },
      texting: 'on',
      quietHours: { enabled: true, start: '20:00', end: '08:00' },
    });

    // Done: the number, and texting approval emailed as a link.
    await screen.findByTestId('phone-setup-done');
    expect(screen.getByText('(713) 555-0148')).toBeTruthy();
    await waitFor(() => expect(sent('/v1/commands/guided_setup.clear_draft')).toHaveLength(1));
    expect(screen.getByText(W.done.approveTitle)).toBeTruthy();
    expect(screen.getByText(PW.approveOnComputer)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('phone-setup-approval-link'));
    await waitFor(() =>
      expect(sent('/v1/commands/onboarding.send_link')).toEqual([
        { workspaceId: LONE_STAR, step: 'number' },
      ]),
    );
    await fireEvent.press(screen.getByTestId('phone-setup-later'));
    expect(router.back).toHaveBeenCalled();
  });

  it('skips the EIN and quiet hours for calls only, and offers numbers with their own area code', async () => {
    await open();
    await screen.findByTestId('phone-setup-screen-have');
    await next();
    await screen.findByTestId('phone-setup-screen-texting');
    await fireEvent.press(screen.getByTestId('texting-no'));
    await next();
    await screen.findByTestId('phone-setup-screen-number');
    expect(screen.getByText(G.question(3, 5))).toBeTruthy();
    await waitFor(() => expect(worker).toHaveBeenCalled());
    expect(worker.mock.calls[0]![1]).toMatchObject({ numberType: 'local' });
  });

  it('emails a link to move a number they already have', async () => {
    await open();
    await screen.findByTestId('phone-setup-screen-have');
    await fireEvent.press(screen.getByTestId('have-keep'));
    expect(screen.getByTestId('have-on-computer')).toHaveTextContent(PW.moveOnComputer);
    expect(screen.getByTestId('phone-setup-next')).toHaveTextContent(LINK_WORDS.action);
    await next();
    await waitFor(() =>
      expect(sent('/v1/commands/onboarding.send_link')).toEqual([
        { workspaceId: LONE_STAR, step: 'number' },
      ]),
    );
    expect(toast.show).toHaveBeenCalledWith(LINK_WORDS.sent('dale@lonestarhvac.test'));
  });
});

describe('coming back', () => {
  it('says so when the number picked earlier was taken, and takes them back where they were', async () => {
    const start = phoneSetupStart({ teammate: null }, { city: 'Houston', state: 'TX' });
    answers['/v1/queries/guided_setup.get_draft'] = {
      setup: 'phone',
      answers: {
        ...start,
        mode: 'new',
        at: 'missed',
        ein: true,
        number: {
          e164: PICKED,
          display: '(713) 555-0148',
          numberType: 'local',
          place: 'Houston, TX',
        },
      },
      savedAt: '2026-11-20T15:00:00.000Z',
    };
    // Somebody else got it meanwhile.
    free = FREE.filter((n) => n.e164 !== PICKED);
    await open();
    await screen.findByTestId('number-gone');
    expect(screen.getByText(W.number.goneTitle('(713) 555-0148'))).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('number-17135550199')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('number-17135550199'));
    await next();
    // Back to the question they had got to, not through every one again.
    await screen.findByTestId('phone-setup-screen-missed');
  });

  it('welcomes them back to their answers, and Start over clears them', async () => {
    const start = phoneSetupStart({ teammate: null }, { city: 'Houston', state: 'TX' });
    answers['/v1/queries/guided_setup.get_draft'] = {
      setup: 'phone',
      answers: { ...start, mode: 'new', at: 'texting', texting: false },
      savedAt: '2026-11-20T15:00:00.000Z',
    };
    await open();
    await screen.findByTestId('phone-setup-screen-texting');
    expect(screen.getByTestId('texting-no')).toBeChecked();
    expect(screen.getByTestId('guided-welcome-back')).toHaveTextContent('Welcome back, Dale', {
      exact: false,
    });
    await fireEvent.press(screen.getByTestId('guided-start-over'));
    await fireEvent.press(screen.getByTestId('guided-start-over-yes'));
    await screen.findByTestId('phone-setup-screen-have');
    await waitFor(() => expect(sent('/v1/commands/guided_setup.clear_draft')).toHaveLength(1));
  });
});

describe('who and where', () => {
  it('is only for someone who can change the business’s texting and calls', async () => {
    await open('member');
    expect(await screen.findByTestId('phone-setup-not-allowed')).toHaveTextContent(PW.notAllowed);
    expect(sent('/v1/queries/phone.setup_status')).toEqual([]);
  });

  it('needs signal', async () => {
    mockOnline = false;
    await open();
    expect(await screen.findByTestId('phone-setup-offline')).toBeTruthy();
  });
});
