import { assistantCoverage, coverageGapsForClaude, DESK_COVERAGE_WORDS } from '@hfos/core';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Share } from 'react-native';

import { DESK_BUSINESS_PHONE_WORDS } from '@/admin/business-words';
import AssistantCoverage from '@/app/app/admin/assistant';
import { setTestOffline } from '@/lib/network';

import { agent, post, showDesk } from './kit';

/**
 * Assistant coverage on the phone's Support desk (the web's /admin/assistant): what Ask HandsFreeOS can't do yet,
 * page by page, shared for Claude. It's read from the code, so it asks the API nothing. Only the roles that read
 * Health see it.
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

/** Text somewhere in a section. */
const has = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

beforeEach(() => {
  jest.clearAllMocks();
  setTestOffline(false);
});

describe('assistant coverage', () => {
  it('lists the pages still to do, in menu order, and asks the API nothing', async () => {
    await showDesk(<AssistantCoverage />, () => ({}));
    const c = assistantCoverage();
    // The gaps change as they're closed: the first one left, or the words for none.
    expect(await screen.findByTestId('coverage-not-yet')).toHaveTextContent(
      has(c.notYet[0]?.page ?? DESK_COVERAGE_WORDS.notYetNone),
    );
    expect(screen.getByTestId('coverage-settings')).toHaveTextContent(
      has(c.settingsToCheck[0]?.label ?? DESK_COVERAGE_WORDS.settingsNone),
    );
    expect(post).not.toHaveBeenCalled();
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
