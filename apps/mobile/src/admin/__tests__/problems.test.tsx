import { DESK_PROBLEM_SECTION_WORDS, DESK_PROBLEM_WORDS, problemForClaude } from '@hfos/core';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Share } from 'react-native';

import { DESK_BUSINESS_PHONE_WORDS } from '@/admin/business-words';
import Problems from '@/app/app/admin/problems';
import { toast } from '@/components/ui/toast';
import { setTestOffline } from '@/lib/network';

import { agent, lastBody, sent, showDesk, type Answers } from './kit';

/**
 * Problem reports on the phone's Support desk (the web's /admin/problems): what our own tools saw when something
 * didn't go, from every business. The open ones as limits, apart, and what needs a fix by problem, each opening to its
 * reports; each marked handled, or shared for Claude with its outline. Only the roles that read Health see it.
 */

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
  usePathname: () => '/',
  useFocusEffect: () => undefined,
}));
jest.mock('@/components/shell/status-strip', () => ({ StatusStrip: () => null }));
jest.mock('@/lib/api', () => ({
  api: { POST: jest.fn() },
  errorMessage: (e: unknown) =>
    e instanceof Error ? e.message : 'Something went wrong. Try again.',
  unwrap: (result: { data?: unknown; error?: unknown }) => {
    if (result.error) throw new Error(String(result.error));
    return result.data;
  },
}));

const ID = '33333333-3333-4333-8333-333333333333';
const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROW = {
  reportId: ID,
  at: new Date(Date.now() - 30 * 60_000).toISOString(),
  workspaceId: WS,
  business: 'Lone Star HVAC',
  addonId: 'outreach',
  source: 'extension',
  area: 'linkedin',
  job: 'checkup',
  ref: null,
  version: '0.49.0',
  page: 'own-profile',
  path: '/in/{1}/',
  shown: true,
  note: 'Not read: Experience.',
  handledAt: null,
  hasOutline: true,
  helper: null,
  kind: 'fix',
  limitKind: null,
  cleared: null,
  fixedIn: null,
};
const LIMIT = {
  limitKind: 'ai_daily',
  workspaceId: WS,
  business: 'Lone Star HVAC',
  area: null,
  areas: ['instagram', 'linkedin'],
  job: 'draft',
  note: 'This business reached the $10 daily AI limit, so the AI is paused until midnight.',
  reports: 6,
  firstAt: new Date(Date.now() - 90 * 60_000).toISOString(),
  lastAt: new Date(Date.now() - 20 * 60_000).toISOString(),
  newestVersion: '0.126.0',
  reportId: '44444444-4444-4444-8444-444444444444',
};
const FIX = {
  area: 'linkedin',
  job: 'checkup',
  note: 'Not read: Experience.',
  businesses: 1,
  business: 'Lone Star HVAC',
  inTheWay: 0,
  moved: 0,
  notLooked: 0,
  reports: 1,
  firstAt: ROW.at,
  lastAt: ROW.at,
  newestVersion: '0.49.0',
  reportId: ID,
};
const FULL = {
  ...ROW,
  found: { roles: 0 },
  outline: 'body\n  h2 "Experience"',
  handledBy: null,
  helper: null,
};

/** Text somewhere in a card. */
const has = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

let answers: Answers;

beforeEach(() => {
  jest.clearAllMocks();
  setTestOffline(false);
  answers = {
    '/v1/queries/platform.problem_report.list': (body: { state: string }) => ({
      reports: body.state === 'handled' ? [] : [ROW],
      nextBefore: null,
      areas: [{ area: 'linkedin', open: 1 }],
      steps: [],
    }),
    '/v1/queries/platform.problem_report.get': FULL,
    '/v1/queries/platform.problem_report.groups': { limits: [LIMIT], fixes: [FIX] },
    '/v1/commands/problem_report.set_handled': { changed: [ID] },
  };
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
});

describe('problem reports', () => {
  it('shows the open ones as limits, apart, and what needs a fix by problem', async () => {
    await showDesk(<Problems />, () => answers);
    const limit = await screen.findByTestId('problems-limit-ai_daily');
    expect(limit).toHaveTextContent(has('Lone Star HVAC · Daily AI limit'));
    expect(limit).toHaveTextContent(has('Settings → Usage & balance'));
    expect(screen.getByTestId('problems-fix-linkedin-checkup')).toHaveTextContent(
      has('Not read: Experience.'),
    );
    expect(screen.getByText(DESK_PROBLEM_SECTION_WORDS.fixes)).toBeTruthy();
    expect(screen.queryByTestId(`problem-${ID}`)).toBeNull();
  });

  it('opens a problem to its reports, with where, whose business, what it said and what sent it', async () => {
    await showDesk(<Problems />, () => answers);
    fireEvent.press(await screen.findByTestId('problems-fix-linkedin-checkup'));
    const row = await screen.findByTestId(`problem-${ID}`);
    expect(lastBody('/v1/queries/platform.problem_report.list')).toEqual({
      state: 'open',
      area: 'linkedin',
      job: 'checkup',
      limit: 50,
    });
    expect(row).toHaveTextContent(has('linkedin · checkup · own-profile'));
    expect(row).toHaveTextContent(has('Lone Star HVAC'));
    expect(row).toHaveTextContent(has('Not read: Experience.'));
    expect(row).toHaveTextContent(has('Browser extension 0.49.0 (outreach)'));
  });

  it('marks one handled, and shows the handled ones on their own', async () => {
    await showDesk(<Problems />, () => answers);
    fireEvent.press(await screen.findByTestId('problems-fix-linkedin-checkup'));
    fireEvent.press(await screen.findByTestId(`problem-mark-${ID}`));
    await waitFor(() =>
      expect(lastBody('/v1/commands/problem_report.set_handled')).toEqual({
        reportIds: [ID],
        handled: true,
      }),
    );
    fireEvent.press(screen.getByTestId('problems-state-handled'));
    expect(await screen.findByText(DESK_PROBLEM_WORDS.none.handled)).toBeTruthy();
  });

  it('shares one for Claude, outline and all', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    await showDesk(<Problems />, () => answers);
    fireEvent.press(await screen.findByTestId('problems-fix-linkedin-checkup'));
    fireEvent.press(await screen.findByTestId(`problem-share-${ID}`));
    await waitFor(() =>
      expect(share).toHaveBeenCalledWith({ message: problemForClaude(FULL as never) }),
    );
    expect(sent('/v1/queries/platform.problem_report.get')).toHaveLength(1);
  });

  it('isn’t a support agent’s', async () => {
    await showDesk(<Problems />, () => answers, agent);
    expect(await screen.findByText(DESK_BUSINESS_PHONE_WORDS.notYourRole('problems'))).toBeTruthy();
    expect(sent('/v1/queries/platform.problem_report.list')).toHaveLength(0);
  });
});
