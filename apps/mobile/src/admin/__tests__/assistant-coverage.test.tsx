import {
  assistantCoverage,
  coverageGapsForClaude,
  DESK_COVERAGE_WORDS,
  DESK_LEDGER_WORDS,
} from '@hfos/core';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Share } from 'react-native';

import { DESK_BUSINESS_PHONE_WORDS } from '@/admin/business-words';
import AssistantCoverage from '@/app/app/admin/assistant';
import { setTestOffline } from '@/lib/network';

import { agent, lastBody, post, sent, showDesk } from './kit';

/**
 * Assistant coverage on the phone's Support desk (the web's /admin/assistant): what Ask HandsFreeOS can't do yet,
 * page by page, shared for Claude, read from the code; and the checklist of every item, which it asks the API for. Only
 * the roles that read Health see it.
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

const LEDGER = '/v1/queries/platform.assistant_ledger';

const counts = {
  items: 2,
  yes: 1,
  partly: 1,
  no: 0,
  never: 0,
  person: 0,
  changed: 0,
  unmarked: 1,
  gapsOpen: 1,
  gapsFixed: 0,
};
const ledger = {
  totals: { ...counts, newScreens: 3, goneFiles: 0 },
  areas: [
    { ...counts, key: 'money', title: 'Money: estimates and invoices', checkedOn: '2026-11-06' },
  ],
  total: 1,
  items: [
    {
      area: 'money',
      path: 'Money → an invoice → Copy link',
      kind: 'see',
      file: 'apps/web/src/components/money/invoice-page.tsx:120',
      covered: 'partly',
      by: 'get_money_document gives the page, not the customer’s link',
      changed: false,
    },
  ],
  gaps: [
    {
      area: 'money',
      id: 'money-1',
      severity: 'high',
      kind: 'read',
      where: 'Money → an invoice',
      gap: 'No tool gives the customer’s own link.',
      fix: 'Add it.',
      status: 'open',
      pr: null,
    },
  ],
  screens: [],
};

/** Text somewhere in a section. */
const has = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

beforeEach(() => {
  jest.clearAllMocks();
  setTestOffline(false);
});

describe('assistant coverage', () => {
  it('lists the pages still to do, in menu order, and asks the API only for the checklist', async () => {
    await showDesk(<AssistantCoverage />, () => ({}));
    const c = assistantCoverage();
    // The gaps change as they're closed: the first one left, or the words for none.
    expect(await screen.findByTestId('coverage-not-yet')).toHaveTextContent(
      has(c.notYet[0]?.page ?? DESK_COVERAGE_WORDS.notYetNone),
    );
    expect(screen.getByTestId('coverage-settings')).toHaveTextContent(
      has(c.settingsToCheck[0]?.label ?? DESK_COVERAGE_WORDS.settingsNone),
    );
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls.every(([path]) => path === LEDGER)).toBe(true);
  });

  it('lists the items not marked off, and filters them like a table', async () => {
    await showDesk(<AssistantCoverage />, () => ({ [LEDGER]: ledger }));
    expect(await screen.findByText('Money → an invoice → Copy link')).toBeTruthy();
    expect(screen.getByTestId('ledger-cards')).toHaveTextContent(has('1 of 2'));
    expect(lastBody(LEDGER)).toMatchObject({ view: 'items', itemState: 'unmarked', area: null });

    fireEvent.press(screen.getByTestId('ledger-area-money'));
    await waitFor(() => expect(lastBody(LEDGER)).toMatchObject({ area: 'money' }));
    fireEvent.press(screen.getByTestId('ledger-item-state-changed'));
    await waitFor(() => expect(lastBody(LEDGER)).toMatchObject({ itemState: 'changed' }));
    fireEvent.press(screen.getByTestId('ledger-view-gaps'));
    await waitFor(() => expect(lastBody(LEDGER)).toMatchObject({ view: 'gaps', gapState: 'open' }));
    expect(await screen.findByText('Money → an invoice')).toBeTruthy();
    expect(screen.getByText(DESK_LEDGER_WORDS.severity.high)).toBeTruthy();
    expect(sent(LEDGER).length).toBeGreaterThanOrEqual(4);
  });

  it('shares the gaps for Claude', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    await showDesk(<AssistantCoverage />, () => ({}));
    fireEvent.press(await screen.findByTestId('coverage-share'));
    await waitFor(() =>
      expect(share).toHaveBeenCalledWith({ message: coverageGapsForClaude(assistantCoverage()) }),
    );
    expect(screen.getByText(DESK_COVERAGE_WORDS.share)).toBeTruthy();
  });

  it('isn’t a support agent’s', async () => {
    await showDesk(<AssistantCoverage />, () => ({}), agent);
    expect(
      await screen.findByText(DESK_BUSINESS_PHONE_WORDS.notYourRole('assistant')),
    ).toBeTruthy();
  });
});
