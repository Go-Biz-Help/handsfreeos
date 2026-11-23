import { CHAT_SETUP_WORDS as W, GUIDED_SETUP_WORDS as G } from '@hfos/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as React from 'react';

import ChatSetup from '@/app/app/w/[workspaceId]/chat-setup';
import { BusinessProvider } from '@/components/shell/business-context';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import type { Business, Me } from '@/lib/businesses';
import { openWeb } from '@/lib/open-web';

/**
 * The guided website chat setup on the phone (the owner, 23 Nov 2026, W4 b: the six questions here too, only the code
 * step opens the web), with HandsFreeOS played by a stand-in: the six questions one a screen, starting from the
 * business's website and colour, through Check it over to Turn on website chat, which turns on Ava's Website chat too
 * (W1), then Put it on your site, which opens the web; a chat that's made but not on the site yet opening on that
 * step; and someone who can't change the business's channels.
 */

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
  usePathname: () => '/',
}));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('@/lib/open-web', () => ({ openWeb: jest.fn(async () => true) }));
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
jest.mock('@/admin/staff', () => ({ useStaff: () => ({ staff: null, status: 'ready' }) }));
jest.mock('@/lib/network', () => ({
  useNetwork: () => ({ online: true, lastOnlineAt: 0 }),
  networkSnapshot: () => ({ online: true, lastOnlineAt: 0 }),
  subscribeNetwork: () => () => undefined,
  isTestOffline: () => false,
  appFetch: jest.fn(),
}));

const DALE = '11111111-1111-4111-8111-111111111111';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AVA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CHAT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const widget = {
  id: CHAT,
  name: 'lonestarhvac.com',
  ownName: null,
  publicKey: 'wk_aaaaaaaaaaaaaaaaaaaa',
  allowedOrigins: ['https://lonestarhvac.com', 'https://www.lonestarhvac.com'],
  teammate: null,
  greeting: 'Hi! Questions about a repair?',
  launcherLabel: 'Chat with us',
  accentColor: '#2d69d8',
  textColor: '#ffffff',
  ownTextColor: null,
  headerColor: null,
  showLogo: true,
  position: 'right',
  placement: {
    desktop: { position: 'right', lift: 0, button: 'label' },
    mobile: { position: 'right', ownPosition: false, lift: 0, button: 'label' },
  },
  awayMessage: null,
  whenAway: 'chat',
  askFor: { name: 'when_needed', phone: 'when_needed', email: 'when_needed' },
  smsConsent: true,
  dailyCap: 200,
  paused: false,
  pausedAt: null,
  hiddenUntilTexting: false,
  install: { seen: false, lastSeenOrigin: null, lastSeenAt: null },
  createdAt: '2026-11-23T07:00:00.000Z',
  updatedAt: '2026-11-23T07:00:00.000Z',
};

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
      <ChatSetup />
    </BusinessProvider>,
  );
};
const next = () => fireEvent.press(screen.getByTestId('chat-setup-next'));

beforeEach(() => {
  jest.clearAllMocks();
  answers = {
    '/v1/queries/workspace.get': {
      workspace: {
        id: LONE_STAR,
        name: 'Lone Star HVAC',
        settings: {
          website: 'lonestarhvac.com',
          look: { color: { hex: '#b42318', from: 'person', at: '2026-11-22T17:00:00.000Z' } },
        },
      },
    },
    '/v1/queries/chat_widget.list': { items: [] },
    '/v1/queries/ai_teammate.get': {
      teammate: {
        id: AVA,
        name: 'Ava',
        status: 'training',
        config: { channels: { chat: false, widgetId: null } },
      },
    },
    '/v1/queries/guided_setup.get_draft': { setup: 'chat', answers: null, savedAt: null },
    '/v1/commands/guided_setup.save_draft': { savedAt: '2026-11-23T07:00:00.000Z' },
    '/v1/commands/guided_setup.clear_draft': { cleared: true },
    '/v1/commands/chat_setup.save': {
      widgetId: CHAT,
      publicKey: 'wk_aaaaaaaaaaaaaaaaaaaa',
      created: true,
      teammateChat: 'turned_on',
    },
  };
  serve();
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
});

describe('a business with no website chat yet', () => {
  it('asks the six questions, turns it on with Ava, then opens the web for the code', async () => {
    await open();
    // 1. Which website: the one from sign-up, with its www twin.
    await screen.findByTestId('chat-setup-screen-sites');
    expect(screen.getByText(G.question(1, 6))).toBeTruthy();
    expect(screen.getByTestId('chat-setup-site')).toHaveTextContent('lonestarhvac.com', {
      exact: false,
    });
    expect(screen.getByTestId('chat-setup-site')).toHaveTextContent(W.sites.fromSignUp, {
      exact: false,
    });
    // Taking it off stops Next, in plain words.
    await fireEvent.press(screen.getByTestId('chat-setup-site-remove'));
    await next();
    expect(screen.getByText('Add the website the chat goes on, like acme.com.')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('chat-setup-site-input'), 'lonestarhvac.com');
    expect(screen.getByTestId('chat-setup-site-note')).toHaveTextContent(
      'Adds lonestarhvac.com and www.lonestarhvac.com.',
    );
    await fireEvent.press(screen.getByTestId('chat-setup-site-submit'));
    await next();

    // 2. Who answers: Ava, whose Website chat is off, so picking her turns it on.
    await screen.findByTestId('chat-setup-screen-who');
    expect(screen.getByTestId('chat-setup-who-ai')).toBeChecked();
    expect(screen.getByTestId('chat-setup-who-turn-on')).toHaveTextContent(W.who.turnOn('Ava'));
    await next();

    // 3. When nobody is answering: a short form.
    await screen.findByTestId('chat-setup-screen-away');
    await fireEvent.press(screen.getByTestId('chat-setup-away-form'));
    await next();

    // 4. What it asks: today's three rows (W2 b).
    await screen.findByTestId('chat-setup-screen-ask');
    await fireEvent.press(screen.getByTestId('chat-setup-askEmail-never'));
    await next();

    // 5. How it looks: the business colour first; empty words on the button stop Next.
    await screen.findByTestId('chat-setup-screen-look');
    expect(screen.getByTestId('chat-setup-colour-b42318')).toBeChecked();
    await fireEvent.changeText(screen.getByTestId('chat-setup-label'), ' ');
    await next();
    expect(screen.getByText(W.problems.labelEmpty)).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('chat-setup-label'), 'Ask us anything');
    await next();

    // 6. Where the button sits: moved up above a bar on phones.
    await screen.findByTestId('chat-setup-screen-place');
    await fireEvent.press(screen.getByTestId('chat-setup-phone-lift'));
    await fireEvent.press(screen.getByTestId('chat-setup-lift-120'));
    expect(screen.getByText(G.checkItOver)).toBeTruthy();
    await next();

    // Check it over, saved as it goes.
    await screen.findByTestId('chat-setup-screen-review');
    expect(screen.getByTestId('chat-review-ask')).toHaveTextContent('email never', {
      exact: false,
    });
    expect(screen.getByTestId('chat-review-next')).toHaveTextContent(W.review.nextAi('Ava'), {
      exact: false,
    });
    await waitFor(() =>
      expect(sent('/v1/commands/guided_setup.save_draft').at(-1)).toMatchObject({
        workspaceId: LONE_STAR,
        setup: 'chat',
        answers: { mode: 'new', widgetId: null, at: 'review', who: 'ai', askEmail: 'never' },
      }),
    );

    // Turn on website chat: every answer at once, then Put it on your site, which opens the web.
    expect(screen.getByTestId('chat-setup-next')).toHaveTextContent(W.review.turnOn);
    await next();
    await waitFor(() => expect(sent('/v1/commands/chat_setup.save')).toHaveLength(1));
    expect(sent('/v1/commands/chat_setup.save')[0]).toMatchObject({
      workspaceId: LONE_STAR,
      widgetId: null,
      answers: {
        sites: ['lonestarhvac.com'],
        who: 'ai',
        whenAway: 'away_form',
        askEmail: 'never',
        launcherLabel: 'Ask us anything',
        accentColor: '#b42318',
        phone: 'lift',
        mobileLift: 120,
      },
    });
    await screen.findByTestId('chat-setup-on');
    expect(screen.getByTestId('chat-setup-done-chips')).toHaveTextContent('Ava answers', {
      exact: false,
    });
    expect(screen.queryByTestId('chat-setup-again')).toBeNull();
    await fireEvent.press(screen.getByTestId('chat-setup-open-web'));
    expect(openWeb).toHaveBeenCalledWith(`/onboarding/${LONE_STAR}/chat?step=install&new=1`);
    await fireEvent.press(screen.getByTestId('chat-setup-install-done'));
    expect(router.back).toHaveBeenCalled();
  });
});

describe('a business whose chat isn’t on its site yet', () => {
  it('opens on Put it on your site, with the questions behind it to change the chat', async () => {
    answers['/v1/queries/chat_widget.list'] = { items: [widget] };
    answers['/v1/commands/chat_setup.save'] = {
      widgetId: CHAT,
      publicKey: widget.publicKey,
      created: false,
      teammateChat: 'none',
    };
    await open();
    await screen.findByTestId('chat-setup-screen-install');
    expect(screen.queryByTestId('chat-setup-on')).toBeNull();
    await fireEvent.press(screen.getByTestId('chat-setup-open-web'));
    expect(openWeb).toHaveBeenCalledWith(`/onboarding/${LONE_STAR}/chat?step=install`);

    // The questions start from the chat as it is: only the team answers it.
    await fireEvent.press(screen.getByTestId('chat-setup-again'));
    await screen.findByTestId('chat-setup-screen-sites');
    await next();
    await screen.findByTestId('chat-setup-screen-who');
    expect(screen.getByTestId('chat-setup-who-team')).toBeChecked();
    for (const s of ['away', 'ask', 'look', 'place']) {
      await next();
      await screen.findByTestId(`chat-setup-screen-${s}`);
    }
    await next();
    await screen.findByTestId('chat-setup-screen-review');
    expect(screen.getByTestId('chat-setup-next')).toHaveTextContent(W.review.save);
    await next();
    await waitFor(() => expect(sent('/v1/commands/chat_setup.save')).toHaveLength(1));
    expect(sent('/v1/commands/chat_setup.save')[0]).toMatchObject({
      widgetId: CHAT,
      answers: { sites: ['https://lonestarhvac.com'], who: 'team' },
    });
    await waitFor(() => expect(toast.show).toHaveBeenCalledWith(W.review.saved));
    expect(router.back).toHaveBeenCalled();
  });
});

it('tells someone who can’t change the business’s channels who can', async () => {
  await open('member');
  expect(await screen.findByTestId('chat-setup-not-allowed')).toHaveTextContent(W.notAllowed);
  expect(post).not.toHaveBeenCalledWith('/v1/queries/chat_widget.list', expect.anything());
});
