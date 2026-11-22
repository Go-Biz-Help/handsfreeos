import {
  EMAIL_GUIDED_WORDS as W,
  EMAIL_SETUP_WORDS as S,
  GUIDED_SETUP_WORDS as G,
  NO_EMAIL_SETUP,
  startingEmailGuidedAnswers,
  startingEmailSetupAnswers,
  type EmailSetupDomain,
  type EmailSetupState,
} from '@hfos/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as React from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import EmailSetup from '@/app/app/w/[workspaceId]/email-setup';
import { EmailSetupCard } from '@/components/home/email-setup-card';
import { BusinessProvider } from '@/components/shell/business-context';
import { toast } from '@/components/ui/toast';
import { EMAIL_GUIDED_PHONE_WORDS as PW } from '@/email-setup/words';
import { api } from '@/lib/api';
import type { Business, Me } from '@/lib/businesses';
import { openWeb } from '@/lib/open-web';
import { ONBOARDING_SETUP_PHONE_WORDS as P } from '@/onboarding-setup/words';

/**
 * The guided email setup on the phone (the owner, 22 Nov 2026), with HandsFreeOS played by a stand-in: the five
 * questions one a screen through to Set it up, with every answer saved as it's given; coming back to the answers
 * that were left, and starting over; the website name's last step, its checks and Done; Home's card; and what
 * happens with no signal, or for someone who can't change the business's email.
 */

jest.mock('expo-router', () => ({
  router: {
    back: jest.fn(),
    replace: jest.fn(),
    push: jest.fn(),
    setParams: jest.fn(),
    canGoBack: () => true,
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
    person: { userId: '11111111-1111-4111-8111-111111111111', name: 'Blake' },
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
jest.mock('@/lib/open-web', () => ({ openWeb: jest.fn(async () => true) }));
jest.mock('@/home/use-home', () => ({ useWorkspaceRow: () => ({ settings: null }) }));
let mockParams: Record<string, string> = {};

const BLAKE = '11111111-1111-4111-8111-111111111111';
const BURROUGHS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DOMAIN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FREE = 'burroughs-digital-a2ceda@mail.handsfreeos.com';

const OLD_MAIL = [
  { host: 'mx10.antispam.mailspamprotection.com', priority: 10 },
  { host: 'mx20.antispam.mailspamprotection.com', priority: 20 },
];

/** Burroughs Digital as the setup finds it: the free address it was made with, a website, and Ava working. */
const STATE: EmailSetupState = {
  ...NO_EMAIL_SETUP,
  businessName: 'Burroughs Digital',
  websiteDomain: 'burroughs.digital',
  slug: 'burroughs-digital',
  myEmail: 'blake@gmail.com',
  myFirstName: 'Blake',
  myUserId: BLAKE,
  aiTeammate: { name: 'Ava', on: true },
  sender: {
    address: FREE,
    localPart: 'burroughs-digital-a2ceda',
    domain: null,
    displayName: 'Burroughs Digital',
  },
  free: {
    id: '99999999-9999-4999-8999-999999999999',
    localPart: 'burroughs-digital-a2ceda',
    address: FREE,
    displayName: 'Burroughs Digital',
    isDefault: true,
  },
  // Looked up already: looked after at SiteGround, its mail going to a mailbox somewhere else.
  lookup: {
    domain: 'burroughs.digital',
    mailHost: 'other',
    dnsHost: 'siteground',
    mxRecords: OLD_MAIL,
    lookedAt: '2026-11-22T18:00:00.000Z',
  },
};

/** burroughs.digital once Set it up has run: its records on their way, its addresses waiting on them. */
const PENDING: EmailSetupDomain = {
  id: DOMAIN_ID,
  domain: 'burroughs.digital',
  status: 'pending',
  receiving: 'off',
  mailHost: 'other',
  dnsHost: 'siteground',
  plan: {
    team: { localPart: 'office', displayName: 'Burroughs Digital' },
    addresses: [{ localPart: 'blake', userId: BLAKE, aiReads: true }],
    receive: true,
  },
  records: [
    {
      type: 'TXT',
      purpose: 'dkim',
      host: 'pm._domainkey',
      fullHost: 'pm._domainkey.burroughs.digital',
      value: 'k=rsa; p=abc123',
      found: true,
    },
    {
      type: 'CNAME',
      purpose: 'return_path',
      host: 'pm-bounces',
      fullHost: 'pm-bounces.burroughs.digital',
      value: 'pm.mtasv.net',
      found: false,
    },
  ],
  mxRecords: OLD_MAIL,
  lastCheckedAt: null,
  lastError: null,
};
const ADDRESSES: EmailSetupState['addresses'] = [
  {
    id: '77777777-7777-4777-8777-777777777777',
    address: 'office@burroughs.digital',
    localPart: 'office',
    domain: 'burroughs.digital',
    reader: 'team',
    aiReads: false,
    isDefault: true,
  },
  {
    id: '88888888-8888-4888-8888-888888888888',
    address: 'blake@burroughs.digital',
    localPart: 'blake',
    domain: 'burroughs.digital',
    reader: 'me',
    aiReads: true,
    isDefault: false,
  },
];
/** Its records found: it sends as office@, and its mail record still has to change. */
const SENDS: EmailSetupState = {
  ...STATE,
  sender: {
    address: 'office@burroughs.digital',
    localPart: 'office',
    domain: 'burroughs.digital',
    displayName: 'Burroughs Digital',
  },
  addresses: ADDRESSES,
  domains: [
    {
      ...PENDING,
      status: 'verified',
      receiving: 'pending',
      plan: {},
      records: PENDING.records.map((r) => ({ ...r, found: true })),
    },
  ],
};

const gotOf = (state: EmailSetupState) => ({
  state,
  answers: startingEmailSetupAnswers(state),
  guided: startingEmailGuidedAnswers(state),
});

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
    return { data: value ?? {}, response: new Response(null, { status: 200 }) };
  });
}

const business = (role: Business['role']): Business => ({
  id: BURROUGHS,
  name: 'Burroughs Digital',
  organizationId: ORG,
  organizationName: 'Burroughs Digital',
  role,
  timezone: 'America/Chicago',
});
const within = (role: Business['role'], children: React.ReactNode) => {
  const b = business(role);
  const me: Me = {
    user: { id: BLAKE, email: 'blake@gmail.com', fullName: 'Blake Burroughs' },
    businesses: [b],
    organizations: [],
    fetchedAt: 0,
  };
  return (
    <BusinessProvider value={{ userId: BLAKE, me, business: b, openSwitcher: () => undefined }}>
      {children}
    </BusinessProvider>
  );
};
/** The email setup's own screen, for Burroughs Digital, as `role`. */
const open = (role: Business['role'] = 'owner') => render(within(role, <EmailSetup />));

/** Coming back to the app: what the phone hears in place of a live update. */
let appListeners: ((s: AppStateStatus) => void)[] = [];
const backInTheApp = async () => {
  for (const l of appListeners) l('active');
  await waitFor(() => expect(post).toHaveBeenCalled());
};

beforeEach(() => {
  jest.clearAllMocks();
  mockOnline = true;
  mockParams = {};
  appListeners = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    appListeners.push(listener as (s: AppStateStatus) => void);
    return { remove: jest.fn() };
  });
  answers = {
    '/v1/queries/email_setup.get': gotOf(STATE),
    '/v1/queries/guided_setup.get_draft': { setup: 'email', answers: null, savedAt: null },
    '/v1/commands/guided_setup.save_draft': { saved: true },
    '/v1/commands/guided_setup.clear_draft': { cleared: true },
  };
  serve();
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
});

describe('the questions', () => {
  it('asks one a screen, saves the answers, and sets everything up at once', async () => {
    await open();
    // Question 1: its own website name, found already.
    await screen.findByTestId('email-guided-screen-which');
    expect(screen.getByText(G.question(1, 5))).toBeTruthy();
    expect(screen.getByTestId('email-guided-own')).toBeChecked();
    expect(screen.getByTestId('email-guided-domain').props.value).toBe('burroughs.digital');
    expect(screen.getByTestId('email-guided-found')).toBeTruthy();
    // Nothing looked up again: HandsFreeOS already knew the name.
    expect(sent('/v1/commands/email_setup.look_up')).toEqual([]);
    await fireEvent.press(screen.getByTestId('email-guided-next'));

    // Question 2: blake@ and office@.
    await screen.findByTestId('email-guided-screen-addresses');
    await fireEvent.changeText(screen.getByTestId('email-guided-address-0'), 'blake');
    await fireEvent.press(screen.getByTestId('email-guided-add'));
    await fireEvent.changeText(screen.getByTestId('email-guided-address-1'), 'office');
    await fireEvent.press(screen.getByTestId('email-guided-next'));

    // Question 3: picked from the names, and Ava's switch on the one that is his.
    await screen.findByTestId('email-guided-screen-readers');
    expect(screen.getByTestId('email-guided-reader-blake-me')).toBeChecked();
    expect(screen.getByTestId('email-guided-reader-office-team')).toBeChecked();
    expect(screen.getByTestId('email-guided-picked-from-names')).toHaveTextContent(
      W.pickedMine('blake'),
      { exact: false },
    );
    expect(screen.queryByTestId('email-guided-ai-office')).toBeNull();
    await fireEvent(screen.getByTestId('email-guided-ai-blake'), 'press');
    await fireEvent.press(screen.getByTestId('email-guided-next'));

    // Question 4: the team's one is picked; his own can't send for the business.
    await screen.findByTestId('email-guided-screen-sender');
    expect(screen.getByTestId('email-guided-sender-office')).toBeChecked();
    expect(screen.getByTestId('email-guided-sender-blake')).toBeDisabled();
    await fireEvent.press(screen.getByTestId('email-guided-next'));

    // Question 5: nothing picked for him, so Next asks.
    await screen.findByTestId('email-guided-screen-receive');
    await fireEvent.press(screen.getByTestId('email-guided-next'));
    expect(screen.getByText(W.receiveMissing)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('email-guided-receive-here'));
    expect(screen.getByTestId('email-guided-old-stays')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('email-guided-next'));

    // Check it over, in the phone's words.
    await screen.findByTestId('email-guided-screen-review');
    expect(screen.getByText(PW.reviewHint)).toBeTruthy();
    expect(screen.getByTestId('email-guided-review-addresses')).toHaveTextContent(
      'blake@burroughs.digital',
      { exact: false },
    );
    expect(screen.getByTestId('email-guided-review-receive')).toHaveTextContent(W.inHfos, {
      exact: false,
    });

    // Set it up: every answer at once, and the answers kept for later are cleared.
    answers['/v1/queries/email_setup.get'] = gotOf({ ...STATE, domains: [PENDING] });
    answers['/v1/commands/email_setup.apply'] = {
      workspaceId: BURROUGHS,
      changes: [],
      sender: FREE,
      emailDomainId: DOMAIN_ID,
      left: 'records',
    };
    await fireEvent.press(screen.getByTestId('email-guided-next'));
    await screen.findByTestId('email-guided-screen-last_records');
    const applied = sent('/v1/commands/email_setup.apply');
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      workspaceId: BURROUGHS,
      email: {
        with: 'domain',
        domain: 'burroughs.digital',
        addresses: [
          { local: 'blake', reader: 'me', aiReads: true },
          { local: 'office', reader: 'team', aiReads: false },
        ],
        receive: true,
        at: 'review',
        by: BLAKE,
      },
    });
    const drafts = sent('/v1/commands/guided_setup.save_draft');
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts.at(-1)).toMatchObject({
      workspaceId: BURROUGHS,
      setup: 'email',
      answers: { at: 'review', by: BLAKE, receive: true },
    });
    expect(sent('/v1/commands/guided_setup.clear_draft')).toEqual([
      { workspaceId: BURROUGHS, setup: 'email' },
    ]);
  });

  it('comes back to the answers that were left, on the same question, and can start over', async () => {
    answers['/v1/queries/guided_setup.get_draft'] = {
      setup: 'email',
      answers: {
        ...startingEmailGuidedAnswers(STATE),
        addresses: [
          { local: 'blake', reader: 'me', aiReads: true, picked: true },
          { local: 'office', reader: 'team', aiReads: false, picked: true },
        ],
        at: 'readers',
        by: BLAKE,
      },
      savedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    };
    await open();
    await screen.findByTestId('email-guided-screen-readers');
    expect(screen.getByTestId('guided-welcome-back')).toHaveTextContent(G.stoppedAt(3), {
      exact: false,
    });
    expect(screen.getByTestId('guided-saved-saved')).toBeTruthy();
    expect(screen.getByTestId('email-guided-ai-blake')).toBeChecked();

    // Start over asks first, then clears them and opens on question 1.
    await fireEvent.press(screen.getByTestId('guided-start-over'));
    expect(screen.getByTestId('guided-start-over-ask')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('guided-start-over-yes'));
    await screen.findByTestId('email-guided-screen-which');
    expect(sent('/v1/commands/guided_setup.clear_draft')).toEqual([
      { workspaceId: BURROUGHS, setup: 'email' },
    ]);
    expect(screen.queryByTestId('guided-welcome-back')).toBeNull();

    // Finish later goes back, and nothing was set up.
    await fireEvent.press(screen.getByTestId('guided-leave'));
    await waitFor(() => expect(router.back).toHaveBeenCalled());
    expect(sent('/v1/commands/email_setup.apply')).toEqual([]);
  });

  it('sets nothing up without signal, and says so', async () => {
    answers['/v1/queries/guided_setup.get_draft'] = {
      setup: 'email',
      answers: { ...startingEmailGuidedAnswers(STATE), with: 'free', at: 'review', by: BLAKE },
      savedAt: new Date().toISOString(),
    };
    await open();
    await screen.findByTestId('email-guided-screen-review');
    expect(screen.getByTestId('email-guided-review-note')).toHaveTextContent(
      PW.freeNow('burroughsdigital@mail.handsfreeos.com'),
    );
    mockOnline = false;
    await fireEvent.changeText(screen.getByTestId('email-guided-name'), 'Burroughs');
    await fireEvent.press(screen.getByTestId('email-guided-next'));
    expect(await screen.findByTestId('email-guided-error')).toHaveTextContent(P.needsSignal);
    expect(sent('/v1/commands/email_setup.apply')).toEqual([]);
  });
});

describe('the last step', () => {
  it('shows the records, emails the steps, checks, and ends on Done', async () => {
    mockParams = { at: 'records' };
    answers['/v1/queries/email_setup.get'] = gotOf({ ...STATE, domains: [PENDING] });
    answers['/v1/commands/email_domain.send_steps'] = { sent: true };
    answers['/v1/commands/email_domain.verify'] = { status: 'pending', changed: false };
    answers['/v1/commands/email_domain.receive'] = { receiving: 'pending', changed: false };
    await open();

    // Its sending records, one found and one not, and the mail records that follow.
    await screen.findByTestId('email-guided-screen-last_records');
    expect(screen.getByText(W.recordsTitle('SiteGround'))).toBeTruthy();
    expect(screen.getByTestId('email-guided-record-txt')).toHaveTextContent(W.found, {
      exact: false,
    });
    expect(screen.getByTestId('email-guided-record-cname')).toHaveTextContent(W.waiting, {
      exact: false,
    });
    expect(screen.getAllByTestId('email-guided-mx')).toHaveLength(3);
    expect(screen.getByTestId('email-guided-not-done')).toHaveTextContent(W.notDoneRecords(1, 2), {
      exact: false,
    });
    expect(screen.getByTestId('email-guided-stand-addresses')).toHaveTextContent(
      W.standWaiting('office@ and blake@'),
      { exact: false },
    );

    // Easier on a computer: the steps, emailed to him.
    await fireEvent.press(screen.getByTestId('email-guided-send-me'));
    await waitFor(() =>
      expect(sent('/v1/commands/email_domain.send_steps')).toEqual([
        { workspaceId: BURROUGHS, emailDomainId: DOMAIN_ID, to: 'blake@gmail.com' },
      ]),
    );
    expect(toast.show).toHaveBeenCalledWith(W.sentTo('blake@gmail.com'));

    // Check now asks for its sending records; back in the app they're found, and the mail record is what's left.
    await fireEvent.press(screen.getByTestId('email-guided-check'));
    await waitFor(() =>
      expect(sent('/v1/commands/email_domain.verify')).toEqual([
        { workspaceId: BURROUGHS, emailDomainId: DOMAIN_ID },
      ]),
    );
    answers['/v1/queries/email_setup.get'] = gotOf(SENDS);
    await backInTheApp();
    await screen.findByTestId('email-guided-screen-last_mail');
    expect(screen.getByText(W.mailTitle)).toBeTruthy();
    expect(screen.queryByTestId('email-guided-step-sending')).toBeNull();
    expect(screen.getByTestId('email-guided-stand-sending')).toHaveTextContent(
      W.standSendingWorks('office'),
      { exact: false },
    );

    // Now Check now asks for the mail instead; once it lands here, Done.
    await fireEvent.press(screen.getByTestId('email-guided-check'));
    await waitFor(() =>
      expect(sent('/v1/commands/email_domain.receive')).toEqual([
        { workspaceId: BURROUGHS, emailDomainId: DOMAIN_ID },
      ]),
    );
    answers['/v1/queries/email_setup.get'] = gotOf({
      ...SENDS,
      domains: [{ ...SENDS.domains[0]!, receiving: 'on', mailHost: 'handsfreeos', mxRecords: [] }],
    });
    await backInTheApp();
    await screen.findByTestId('email-guided-screen-done');
    expect(screen.getByText(W.doneTitle)).toBeTruthy();
    expect(screen.getAllByTestId('email-guided-done-row')).toHaveLength(2);
    expect(screen.getByText(W.doneOnlyYou('Ava', true))).toBeTruthy();

    // Settings → Email is on the web; the Inbox is right here.
    await fireEvent.press(screen.getByTestId('email-guided-to-settings'));
    expect(openWeb).toHaveBeenCalledWith(`/app/w/${BURROUGHS}/settings/email`);
    await fireEvent.press(screen.getByTestId('email-guided-to-inbox'));
    expect(router.replace).toHaveBeenCalledWith(`/app/w/${BURROUGHS}/inbox`);
  });

  it('opens the questions again when asked to, even with a last step left', async () => {
    mockParams = { again: '1' };
    answers['/v1/queries/email_setup.get'] = gotOf({ ...STATE, domains: [PENDING] });
    await open();
    await screen.findByTestId('email-guided-screen-which');
  });
});

describe('Home’s card', () => {
  it('says what is left in the guided setup’s words, and opens its last step', async () => {
    answers['/v1/queries/email_setup.get'] = gotOf(SENDS);
    await render(within('owner', <EmailSetupCard />));
    await screen.findByTestId('email-setup-card');
    expect(screen.getByText(W.homeMailTitle)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('email-setup-card-open'));
    expect(router.push).toHaveBeenCalledWith(`/app/w/${BURROUGHS}/email-setup?at=records`);
  });

  it('offers the setup while the business still sends from the address it was made with', async () => {
    await render(within('owner', <EmailSetupCard />));
    await screen.findByTestId('email-setup-card');
    expect(screen.getByText(S.homeStartTitle)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('email-setup-card-open'));
    expect(router.push).toHaveBeenCalledWith(`/app/w/${BURROUGHS}/email-setup`);
  });
});

describe('who it is for', () => {
  it('is only for someone who can change the business’s email', async () => {
    await open('member');
    expect(await screen.findByTestId('email-setup-not-allowed')).toHaveTextContent(S.notAllowed);
    expect(post).not.toHaveBeenCalled();
  });

  it('waits for signal before it opens', async () => {
    mockOnline = false;
    await open();
    expect(await screen.findByTestId('email-setup-offline')).toHaveTextContent(P.needsSignal);
    expect(post).not.toHaveBeenCalled();
  });
});
