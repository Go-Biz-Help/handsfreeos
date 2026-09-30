import { LINK_WORDS, PHONE_GUIDE_WORDS } from '@hfos/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as React from 'react';

import { GettingStartedCard } from '@/components/onboarding/getting-started-card';
import { BusinessProvider } from '@/components/shell/business-context';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import type { Business, Me } from '@/lib/businesses';
import { pushRegistration } from '@/push/device';

import {
  forgetGettingStarted,
  type OnboardingStatus,
  type OnboardingStep,
} from '../use-getting-started';

/**
 * Getting started on the phone's Home (HANDSFREEOS_ONBOARDING_IMPLEMENTATION_PLAN.md §6, boards 9 and 10): an owner's
 * card, shorter than the web's, where a step that's easier on a computer emails a link; a teammate's four rows, with
 * notifications turned on from the phone itself; the tour of the bottom bar; and "You're set up" once.
 */

jest.mock('@/lib/api', () => ({
  ...jest.requireActual<object>('@/lib/api'),
  api: { POST: jest.fn() },
}));
let mockOnline = true;
jest.mock('@/lib/network', () => ({
  useNetwork: () => ({ online: mockOnline }),
  networkSnapshot: () => ({ online: mockOnline, lastOnlineAt: 0 }),
}));
let mockPermission: 'granted' | 'denied' | 'undetermined' | null = 'granted';
jest.mock('@/push/hooks', () => ({
  usePushRegistration: () => ({ permission: mockPermission, canAskAgain: true }),
}));
jest.mock('@/push/device', () => ({
  pushRegistration: { ask: jest.fn(async () => 'granted') },
}));
jest.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: jest.fn(async () => ({ data: { session: null } })) } },
}));

const DALE = '11111111-1111-4111-8111-111111111111';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const step = (
  key: OnboardingStep['key'],
  group: OnboardingStep['group'],
  state: OnboardingStep['state'] = 'todo',
  note: OnboardingStep['note'] = {},
): OnboardingStep => ({ key, group, mustDo: group === 'basics', state, since: null, note });

const view = { hidden: false, tourDoneAt: null, finishedAt: null, show: true };

/** An owner's business on day two: the number with the carriers, customers next. */
const OWNER: OnboardingStatus = {
  workspaceId: LONE_STAR,
  audience: 'business',
  enabled: true,
  answers: { goal: 'leads', customersIn: 'ghl', teamSize: 'small' },
  website: null,
  steps: [
    step('number', 'basics', 'waiting', { number: '(512) 555-0148' }),
    step('ai', 'basics', 'done', { name: 'Ava' }),
    step('customers', 'basics'),
    step('calendar', 'basics'),
    step('team', 'later'),
    step('payments', 'later'),
    step('email_chat', 'later'),
    step('app', 'later', 'done'),
    step('sign_in', 'later'),
  ],
  done: 3,
  total: 9,
  skipped: 0,
  complete: false,
  next: 'customers',
  view,
};

/** A teammate who has just joined. */
const TEAMMATE: OnboardingStatus = {
  ...OWNER,
  audience: 'personal',
  steps: [
    step('app', 'yours', 'done'),
    step('notifications', 'yours'),
    step('my_calendar', 'yours'),
    step('sign_in', 'yours'),
  ],
  done: 1,
  total: 4,
  next: 'notifications',
};

let answers: Record<string, unknown>;
const post = api.POST as unknown as jest.Mock<
  Promise<{ data?: unknown; error?: unknown; response: Response }>,
  [string, { body: Record<string, unknown> }]
>;
const sent = (path: string) => post.mock.calls.filter((call) => call[0] === path);

async function show(status: OnboardingStatus) {
  answers['/v1/queries/onboarding.status'] = status;
  post.mockImplementation(async (path) => {
    const answer = answers[path];
    if (answer === null) throw new TypeError('Network request failed');
    return { data: answer ?? {}, response: new Response(null, { status: 200 }) };
  });
  const business: Business = {
    id: LONE_STAR,
    name: 'Lone Star HVAC & Roofing',
    organizationId: 'org',
    organizationName: 'Lone Star HVAC & Roofing',
    role: status.audience === 'business' ? 'owner' : 'member',
    timezone: 'America/Chicago',
  };
  const me: Me = {
    user: { id: DALE, email: 'dale@lonestarhvac.test', fullName: 'Dale Ramsey' },
    businesses: [business],
    organizations: [],
    fetchedAt: 0,
  };
  await render(
    <BusinessProvider value={{ userId: DALE, me, business, openSwitcher: () => undefined }}>
      <GettingStartedCard />
    </BusinessProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  forgetGettingStarted();
  mockOnline = true;
  mockPermission = 'granted';
  answers = {
    '/v1/commands/onboarding.send_link': {
      workspaceId: LONE_STAR,
      step: 'customers',
      email: 'dale@lonestarhvac.test',
      sent: true,
    },
  };
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
});

it('shows an owner the next step, and emails a link to a step that’s easier on a computer', async () => {
  await show(OWNER);
  expect(await screen.findByTestId('getting-started-count')).toHaveTextContent('3 of 9 done');
  // Asked of HandsFreeOS with what only the phone knows.
  expect(sent('/v1/queries/onboarding.status')[0]![1]).toEqual({
    body: { workspaceId: LONE_STAR, device: { app: true, notifications: true } },
  });
  const next = screen.getByTestId('getting-started-next');
  expect(next).toHaveTextContent('Bring in your customers', { exact: false });
  expect(next).toHaveTextContent(LINK_WORDS.easierDetail, { exact: false });

  await fireEvent.press(screen.getByTestId('getting-started-customers-link'));
  await waitFor(() => expect(sent('/v1/commands/onboarding.send_link')).toHaveLength(1));
  expect(sent('/v1/commands/onboarding.send_link')[0]![1]).toEqual({
    body: { workspaceId: LONE_STAR, step: 'customers' },
  });
  await waitFor(() =>
    expect(toast.show).toHaveBeenCalledWith(LINK_WORDS.sent('dale@lonestarhvac.test')),
  );
});

it('folds an owner’s list to a few rows, with the rest a press away', async () => {
  await show(OWNER);
  await screen.findByTestId('getting-started');
  expect(screen.queryByTestId('getting-started-sign_in')).toBeNull();
  // The number is with the carriers: its day, and no button.
  expect(screen.getByTestId('getting-started-number')).toHaveTextContent(
    'Business number & texting',
    { exact: false },
  );
  expect(screen.queryByTestId('getting-started-number-link')).toBeNull();
  await fireEvent.press(screen.getByTestId('getting-started-all'));
  expect(screen.getByTestId('getting-started-sign_in')).toBeTruthy();
});

it('turns on a teammate’s notifications on the phone itself, and takes them round the bottom bar', async () => {
  mockPermission = 'undetermined';
  await show(TEAMMATE);
  expect(await screen.findByText('Get set up')).toBeTruthy();
  expect(screen.getByTestId('getting-started-app')).toHaveTextContent(PHONE_GUIDE_WORDS.appDone, {
    exact: false,
  });
  expect(sent('/v1/queries/onboarding.status')[0]![1]).toEqual({
    body: { workspaceId: LONE_STAR, device: { app: true } },
  });

  await fireEvent.press(screen.getByTestId('getting-started-notifications-on'));
  await waitFor(() => expect(pushRegistration.ask).toHaveBeenCalled());

  // The tour: Home, Inbox, Pipeline, Calendar, then Done records it as taken.
  await fireEvent.press(screen.getByTestId('getting-started-tour'));
  expect(await screen.findByTestId('tour-stop-home')).toBeTruthy();
  for (const stop of ['inbox', 'pipeline', 'calendar']) {
    await fireEvent.press(screen.getByTestId('tour-next'));
    expect(screen.getByTestId(`tour-stop-${stop}`)).toBeTruthy();
  }
  await fireEvent.press(screen.getByTestId('tour-done'));
  await waitFor(() => expect(sent('/v1/commands/onboarding.set_view')).toHaveLength(1));
  expect(sent('/v1/commands/onboarding.set_view')[0]![1]).toEqual({
    body: { workspaceId: LONE_STAR, tourDone: true },
  });
});

it('says “You’re set up” once, and Done finishes it', async () => {
  await show({
    ...TEAMMATE,
    steps: TEAMMATE.steps.map((s) => ({ ...s, state: s.state === 'done' ? 'done' : 'skipped' })),
    done: 1,
    total: 1,
    skipped: 3,
    complete: true,
    next: null,
  });
  expect(await screen.findByTestId('getting-started-done')).toHaveTextContent('You’re set up', {
    exact: false,
  });
  await fireEvent.press(screen.getByTestId('getting-started-finish'));
  await waitFor(() => expect(sent('/v1/commands/onboarding.finish')).toHaveLength(1));
  expect(sent('/v1/commands/onboarding.finish')[0]![1]).toEqual({
    body: { workspaceId: LONE_STAR, device: { app: true, notifications: true } },
  });
});

it('shows nothing when an owner turned Getting started off for the business, even with it all done', async () => {
  await show({
    ...TEAMMATE,
    enabled: false,
    complete: true,
    next: null,
    view: { ...view, show: false },
  });
  await waitFor(() => expect(sent('/v1/queries/onboarding.status')).toHaveLength(1));
  expect(screen.queryByTestId('getting-started')).toBeNull();
  expect(screen.queryByTestId('getting-started-done')).toBeNull();
});

it('shows nothing when the guide is hidden, and asks nothing without signal', async () => {
  await show({ ...OWNER, view: { ...view, hidden: true, show: false } });
  await waitFor(() => expect(sent('/v1/queries/onboarding.status')).toHaveLength(1));
  expect(screen.queryByTestId('getting-started')).toBeNull();

  jest.clearAllMocks();
  forgetGettingStarted();
  mockOnline = false;
  await show(OWNER);
  expect(sent('/v1/queries/onboarding.status')).toHaveLength(0);
  expect(screen.queryByTestId('getting-started')).toBeNull();
});
