import { KEYBOARD_DATA_KEY, KEYBOARD_SEEN_KEY, type KeyboardData } from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as React from 'react';

import KeyboardSettings from '@/app/app/w/[workspaceId]/(tabs)/(more)/settings/keyboard';
import { BusinessProvider } from '@/components/shell/business-context';
import { toast } from '@/components/ui/toast';
import { KeepKeyboardFresh } from '@/keyboard/keep-fresh';
import {
  forgetKeyboard,
  readStoredKeyboard,
  refreshKeyboard,
  watchKeyboardOwner,
} from '@/keyboard/store';
import { api } from '@/lib/api';
import type { Me } from '@/lib/businesses';

import HfosShared from '../../../modules/hfos-shared';

/**
 * The HandsFreeOS keyboard's copy (docs/phone-keyboard.md): the business open now saves its templates (first names
 * asked for, its own details filled in) and its booking pages, live forms, review link and website for the keyboard;
 * no signal keeps the templates it had; without the Inbox there are links only; signing out forgets it all; and the
 * Phone keyboard screen says what's on it and updates it.
 */

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
  usePathname: () => '/',
}));
jest.mock('@/components/shell/status-strip', () => ({ StatusStrip: () => null }));
let mockGrants: { role: string; permissions: string[] | null } = {
  role: 'owner',
  permissions: null,
};
jest.mock('@/lib/grants', () => ({ useGrants: () => mockGrants }));
jest.mock('@/lib/api', () => {
  class ApiError extends Error {
    readonly status: number;
    constructor(message: string, code: number) {
      super(message);
      this.status = code;
    }
  }
  return {
    ApiError,
    api: { POST: jest.fn() },
    unwrap: (result: { data?: unknown; error?: unknown }) => {
      if (result.error) throw result.error;
      return result.data;
    },
  };
});

const { ApiError } = jest.requireMock<{
  ApiError: new (message: string, status: number) => Error;
}>('@/lib/api');

const DALE = '11111111-1111-4111-8111-111111111111';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const me: Me = {
  user: { id: DALE, email: 'dale@lonestarhvac.test', fullName: 'Dale Ramsey' },
  businesses: [
    {
      id: LONE_STAR,
      name: 'Lone Star HVAC & Roofing',
      organizationId: 'org',
      organizationName: 'Lone Star HVAC & Roofing',
      role: 'owner',
      timezone: 'America/Chicago',
    },
  ],
  organizations: [{ id: 'org', name: 'Lone Star HVAC & Roofing', role: 'owner' }],
  fetchedAt: 0,
};

const TEMPLATES = [
  {
    id: 't1',
    name: 'Thanks',
    channel: 'sms',
    folder: null,
    body: 'Hi {{person.first_name}}, thanks for calling {{business.name}}! Book here: {{links.booking}}',
  },
  { id: 't2', name: 'Old', channel: 'sms', folder: null, body: 'Gone', archivedAt: '2026-01-01' },
];

const post = api.POST as unknown as jest.Mock<Promise<unknown>, [string, unknown?]>;
let templatesAnswer: () => unknown = () => ({ data: { templates: TEMPLATES } });

function mockQueries() {
  jest.mocked(useQuery).mockImplementation(((sql: string) => ({
    data: sql.includes('FROM workspaces')
      ? [
          {
            name: 'Lone Star HVAC & Roofing',
            settings: JSON.stringify({
              website: 'https://lonestarhvac.test',
              links: { review: 'https://g.page/r/lonestar/review' },
            }),
          },
        ]
      : sql.includes('booking_sites')
        ? [{ slug: 'lone-star', name: 'Lone Star HVAC & Roofing', enabled: 1 }]
        : sql.includes('calendars')
          ? [
              {
                name: 'Repairs',
                slug: 'repairs',
                status: 'active',
                public: 1,
                created_at: '2026-01-01',
              },
              {
                name: 'Private',
                slug: 'private',
                status: 'active',
                public: 0,
                created_at: '2026-01-02',
              },
            ]
          : sql.includes('FROM forms')
            ? [{ name: 'Get a quote', slug: 'quote', mode: 'form' }]
            : [],
    isLoading: false,
    isFetching: false,
  })) as never);
  post.mockImplementation(async (path: string) =>
    path === '/v1/queries/template.list' ? templatesAnswer() : { data: { domain: null } },
  );
}

function inBusiness(children: React.ReactNode) {
  return (
    <BusinessProvider
      value={{ userId: DALE, me, business: me.businesses[0]!, openSwitcher: () => undefined }}
    >
      {children}
    </BusinessProvider>
  );
}

const onKeyboard = () => readStoredKeyboard()?.businesses.find((b) => b.id === LONE_STAR);

beforeEach(() => {
  forgetKeyboard();
  HfosShared.write(KEYBOARD_SEEN_KEY, null);
  mockGrants = { role: 'owner', permissions: null };
  templatesAnswer = () => ({ data: { templates: TEMPLATES } });
  mockQueries();
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
});

describe('Keeping the keyboard fresh', () => {
  it('saves the open business’s templates and links, a first name asked for and its own details filled in', async () => {
    const view = await render(inBusiness(<KeepKeyboardFresh />));
    await waitFor(() => expect(onKeyboard()).toBeTruthy());
    const business = onKeyboard()!;
    expect(business.name).toBe('Lone Star HVAC & Roofing');
    expect(business.templates).toHaveLength(1);
    expect(business.templates[0]!.asks).toBe(true);
    expect(business.templates[0]!.parts).toEqual([
      { text: 'Hi ' },
      { ask: 'first_name', fallback: 'there', transform: null },
      {
        text: ', thanks for calling Lone Star HVAC & Roofing! Book here: https://app.handsfreeos.com/book/lone-star/repairs',
      },
    ]);
    expect(business.links.map((l) => [l.kind, l.url])).toEqual([
      ['booking', 'https://app.handsfreeos.com/book/lone-star/repairs'],
      ['form', expect.stringContaining('quote')],
      ['review', 'https://g.page/r/lonestar/review'],
      ['website', 'https://lonestarhvac.test'],
    ]);
    view.unmount();
  });

  it('keeps the templates the keyboard has when there’s no signal', async () => {
    const view = await render(inBusiness(<KeepKeyboardFresh />));
    await waitFor(() => expect(onKeyboard()?.templates).toHaveLength(1));
    templatesAnswer = () => {
      throw new Error('Network request failed');
    };
    await act(async () => {
      await refreshKeyboard();
    });
    expect(onKeyboard()?.templates).toHaveLength(1);
    view.unmount();
  });

  it('holds links only for someone who can’t use the Inbox here', async () => {
    templatesAnswer = () => ({ error: new ApiError('Not yours', 403) });
    const view = await render(inBusiness(<KeepKeyboardFresh />));
    await waitFor(() => expect(onKeyboard()).toBeTruthy());
    expect(onKeyboard()!.templates).toEqual([]);
    expect(onKeyboard()!.links).toHaveLength(4);
    view.unmount();
  });

  it('forgets the copy when the person signs out', () => {
    let state: { status: string } = { status: 'signedIn' };
    const listeners = new Set<() => void>();
    watchKeyboardOwner({
      getState: () => state,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    HfosShared.write(KEYBOARD_DATA_KEY, JSON.stringify({ v: 1 }));
    HfosShared.write('keyboard-pick', `${LONE_STAR}|${LONE_STAR}`);
    state = { status: 'signedOut' };
    for (const listener of listeners) listener();
    expect(HfosShared.read(KEYBOARD_DATA_KEY)).toBeNull();
    expect(HfosShared.read('keyboard-pick')).toBeNull();
  });
});

describe('Settings → Phone keyboard', () => {
  it('says what’s on the keyboard, and Update now fetches the templates again', async () => {
    const view = await render(
      inBusiness(
        <>
          <KeepKeyboardFresh />
          <KeyboardSettings />
        </>,
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId('keyboard-on-it')).toHaveTextContent(
        /1 template and 4 links from Lone Star HVAC & Roofing/,
      ),
    );
    // On an iPhone, until the keyboard has opened once with Full Access.
    expect(screen.getByTestId('keyboard-status')).toHaveTextContent(/Not set up yet/);
    const calls = post.mock.calls.length;
    await act(async () => {
      fireEvent.press(screen.getByTestId('keyboard-update'));
    });
    await waitFor(() => expect(toast.show).toHaveBeenCalledWith('The keyboard is up to date.'));
    expect(post.mock.calls.length).toBeGreaterThan(calls);
    view.unmount();
  });

  it('shows it working once the iPhone keyboard has opened with Full Access', async () => {
    HfosShared.write(
      KEYBOARD_SEEN_KEY,
      JSON.stringify({ at: '2026-11-27T12:00:00.000Z', fullAccess: true }),
    );
    const view = await render(inBusiness(<KeyboardSettings />));
    expect(screen.getByTestId('keyboard-status')).toHaveTextContent('On, with Full Access');
    expect(screen.getByTestId('keyboard-on-it')).toHaveTextContent(/Nothing yet/);
    view.unmount();
  });
});

// The copy written is what the keyboard reads back.
it('saves a copy the keyboard can read', async () => {
  const view = await render(inBusiness(<KeepKeyboardFresh />));
  await waitFor(() => expect(onKeyboard()).toBeTruthy());
  const raw = JSON.parse(HfosShared.read(KEYBOARD_DATA_KEY)!) as KeyboardData;
  expect(raw.v).toBe(1);
  expect(raw.current).toBe(LONE_STAR);
  expect(raw.words.askName).toBe('Their first name');
  view.unmount();
});
