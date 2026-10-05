import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as React from 'react';

import { toast } from '@/components/ui/toast';
import { change } from '@/changes';

import { BuyerWantsBody, profileFromForm } from '../buyer';
import { HomeBody, HomesBody } from '../homes';
import { MatchesBody } from '../matches';
import { DEAL, DEAL_REF, home, id, LINH, match, NOW, TODAY, TZ, WS, AGENT } from './buyer-fixtures';

/**
 * The buyer's pages on the phone (board 82): what they want and the search, their homes and one home's facts marked
 * with where they came from, and new matches to send. Changes go through the phone's queue (mocked here): what can
 * wait does, and what needs signal says so with none.
 */

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
}));
jest.mock('@/changes', () => {
  const actual = jest.requireActual<{ ChangeError: unknown; NEEDS_SIGNAL: string }>(
    '@/changes/controller',
  );
  return {
    change: jest.fn(async () => ({ id: 'change-1', queued: true })),
    changes: { addPhoto: jest.fn(async () => ({ id: 'upload-1' })) },
    newId: jest.fn(() => '99999999-9999-4999-8999-999999999999'),
    ChangeError: actual.ChangeError,
    NEEDS_SIGNAL: actual.NEEDS_SIGNAL,
  };
});
let mockOnline = true;
jest.mock('@/lib/network', () => ({
  useNetwork: () => ({ online: mockOnline }),
  networkSnapshot: () => ({ online: mockOnline, lastOnlineAt: 0 }),
}));

const NEW_ID = '99999999-9999-4999-8999-999999999999';
const changed = () => jest.mocked(change).mock.calls.map(([name, input]) => ({ name, input }));

const PROFILE = {
  budgetMinCents: 38_000_000,
  budgetMaxCents: 43_000_000,
  areas: ['South Austin', 'Sunset Valley'],
  homeTypes: [],
  bedsMin: 3,
  bathsMin: 2,
  sqftMin: null,
  moveBy: '2026-12-01',
  mustHaves: ['Yard', 'garage', 'near MoPac'],
  dealBreakers: [],
  version: 3,
  updatedAt: '2026-10-01T15:00:00.000Z',
  updatedBy: null,
};
const memory = (n: number, kind: 'likes' | 'timing', words: string) => ({
  id: id(n),
  kind,
  words,
  quote: null,
  sourceKind: 'typed' as const,
  sourceId: null,
  status: 'confirmed' as const,
  suggestedBy: 'person' as const,
  createdBy: null,
  decidedBy: null,
  decidedAt: null,
  createdAt: '2026-10-01T15:00:00.000Z',
});

beforeEach(() => {
  // A toast stays 2.6 seconds; the tests read what it says instead.
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
  jest.mocked(change).mockClear();
  jest.mocked(router.push).mockClear();
  mockOnline = true;
});

describe('what they want', () => {
  const draw = (editable = true) =>
    render(
      <BuyerWantsBody
        workspaceId={WS}
        userId={AGENT}
        deal={DEAL_REF}
        profile={PROFILE}
        items={[memory(1, 'likes', 'Home office'), memory(2, 'likes', 'trees')]}
        search={{ on: true, supplier: 'Repliers', newToday: 2 }}
        today={TODAY}
        editable={editable}
      />,
    );

  it('says the buyer’s wants and the search as the board does', async () => {
    await draw();
    expect(screen.getByText('$380,000 – $430,000')).toBeTruthy();
    expect(screen.getByText('3+ · 2+')).toBeTruthy();
    expect(screen.getByText('South Austin, Sunset Valley')).toBeTruthy();
    expect(screen.getByText('Yard, garage, near MoPac')).toBeTruthy();
    expect(screen.getByText('Nice to have')).toBeTruthy();
    expect(screen.getByText('Home office, trees')).toBeTruthy();
    expect(screen.getByText('December')).toBeTruthy();
    expect(screen.getByText('Saved on Repliers')).toBeTruthy();
    expect(screen.getByText('Asked at once when it changes · 2 new today')).toBeTruthy();
    expect(screen.getByText('Change what they want')).toBeTruthy();
    expect(
      screen.getByText('Changes wait on this phone; the search runs again when they send.'),
    ).toBeTruthy();
  });

  it('opens the matches from the search', async () => {
    await draw();
    await fireEvent.press(screen.getByTestId('re-search'));
    expect(router.push).toHaveBeenCalledWith(`/app/w/${WS}/a/realestate/deals/${DEAL}/matches`);
  });

  it('saves what they want through the queue, with no signal too', async () => {
    mockOnline = false;
    await draw();
    await fireEvent.press(screen.getByTestId('re-buyer-change'));
    await fireEvent.changeText(screen.getByTestId('re-profile-max'), '450,000');
    await fireEvent.press(screen.getByTestId('re-profile-save'));
    await waitFor(() => expect(change).toHaveBeenCalled());
    const [name, input, options] = jest.mocked(change).mock.calls[0]!;
    expect(name).toBe('realestate.buyer_profile.save');
    expect(input).toMatchObject({
      workspaceId: WS,
      dealId: DEAL,
      profile: {
        budgetMinCents: 38_000_000,
        budgetMaxCents: 45_000_000,
        areas: ['South Austin', 'Sunset Valley'],
        bedsMin: 3,
        moveBy: '2026-12-01',
        mustHaves: ['Yard', 'garage', 'near MoPac'],
      },
    });
    expect(options?.optimistic).toEqual(expect.any(Function));
    expect(toast.show).toHaveBeenCalledWith('Saved. The search runs again when it sends.');
  });

  it('says what’s wrong with what was typed before anything is kept', () => {
    const form = {
      min: '500,000',
      max: '400,000',
      areas: '',
      types: [],
      beds: '',
      baths: '2',
      sqft: '',
      moveBy: '',
      must: '',
      never: '',
    };
    expect(profileFromForm(form)).toEqual({
      problem: 'The lowest price is more than the highest.',
    });
    expect(profileFromForm({ ...form, min: 'abc' })).toEqual({
      problem: 'Lowest price isn’t an amount. Type it like 450,000.',
    });
    expect(profileFromForm({ ...form, min: '', moveBy: 'Dec' })).toEqual({
      problem: 'Type the move-by date like 2026-12-01.',
    });
  });

  it('remembers something with the phone’s id', async () => {
    await draw();
    await fireEvent.press(screen.getByTestId('re-remember'));
    await fireEvent.changeText(screen.getByTestId('re-remember-sheet-text'), 'Needs a fenced yard');
    await fireEvent.press(screen.getByTestId('re-remember-sheet-submit'));
    await waitFor(() => expect(change).toHaveBeenCalled());
    expect(changed()[0]).toEqual({
      name: 'realestate.memory.add',
      input: {
        workspaceId: WS,
        dealId: DEAL,
        id: NEW_ID,
        kind: 'likes',
        words: 'Needs a fenced yard',
      },
    });
  });

  it('only reads a deal kept as its summary', async () => {
    await draw(false);
    expect(screen.queryByText('Change what they want')).toBeNull();
    expect(screen.queryByTestId('re-remember')).toBeNull();
  });
});

describe('homes', () => {
  const homes = [
    home({
      reactions: [
        {
          personId: LINH,
          name: 'Linh Nguyen',
          reaction: 'saved',
          note: null,
          at: '2026-10-01T15:00:00.000Z',
        },
      ],
    }),
    home({
      id: id(2),
      address: '5 Willow Bend, Austin, TX',
      source: 'client',
      mls: null,
      mlsState: 'none',
      facts: { price_cents: 41_500_000, beds: 3, baths: 2 },
      addedByClient: { id: LINH, name: 'Linh Nguyen' },
    }),
  ];

  it('lists each home with its facts, the MLS’s status, the client’s reaction and the credit line', async () => {
    await render(
      <HomesBody
        workspaceId={WS}
        userId={AGENT}
        deal={DEAL_REF}
        homes={homes}
        interest={new Map([[id(2), 'maybe' as const]])}
        newMatches={2}
        adding={false}
        editable
      />,
    );
    expect(screen.getByText('418 Maple Ave')).toBeTruthy();
    expect(screen.getByText('$409,000 · 3 bd · 2 ba · 1,780 sq ft')).toBeTruthy();
    expect(screen.getByText('For sale')).toBeTruthy();
    expect(screen.getByTestId(`re-home-reaction-${id(1)}`)).toHaveTextContent('Loved');
    expect(screen.getByText('Listing courtesy of Compass RE Texas.')).toBeTruthy();
    expect(screen.getByText('$415,000 · 3 bd · 2 ba · added by Linh')).toBeTruthy();
    expect(screen.getByTestId(`re-home-reaction-${id(2)}`)).toHaveTextContent('Maybe');
    expect(screen.getByText('New matches · 2')).toBeTruthy();
    await fireEvent.press(screen.getByTestId(`re-home-${id(1)}`));
    expect(router.push).toHaveBeenCalledWith(
      `/app/w/${WS}/a/realestate/deals/${DEAL}/homes?home=${id(1)}`,
    );
  });

  it('adds a home with no signal, with the phone’s id', async () => {
    mockOnline = false;
    await render(
      <HomesBody
        workspaceId={WS}
        userId={AGENT}
        deal={DEAL_REF}
        homes={homes}
        interest={new Map()}
        newMatches={0}
        adding
        editable
      />,
    );
    await fireEvent.changeText(
      screen.getByTestId('re-add-home-address'),
      '77 Birch Hollow, Austin, TX',
    );
    await fireEvent.press(screen.getByTestId('re-add-home-save'));
    await waitFor(() => expect(change).toHaveBeenCalled());
    expect(changed()[0]).toEqual({
      name: 'realestate.home.add',
      input: { workspaceId: WS, dealId: DEAL, id: NEW_ID, address: '77 Birch Hollow, Austin, TX' },
    });
  });

  it('marks each fact with where it came from and when', async () => {
    await render(
      <HomeBody
        workspaceId={WS}
        userId={AGENT}
        deal={DEAL_REF}
        home={homes[0]!}
        notes={[]}
        timeZone={TZ}
        editable
      />,
    );
    expect(screen.getByTestId('re-home-mls')).toHaveTextContent('For sale · MLS #ACT-6612408');
    expect(screen.getByTestId('re-fact-price_cents')).toHaveTextContent(
      'Price$409,000from the MLS · Repliers · 10:42 AM',
    );
    expect(screen.getByTestId('re-fact-beds')).toHaveTextContent('Beds · baths3 · 2from the MLS');
    expect(screen.getByTestId('re-fact-sqft')).toHaveTextContent('Size1,780 sq ftfrom the MLS');
    expect(screen.getByTestId('re-fact-hoa_monthly_cents')).toHaveTextContent(
      'HOA$35 a monthfrom the MLS',
    );
    expect(screen.getByTestId('re-home-notice')).toHaveTextContent(
      'Listing courtesy of Compass RE Texas. Information deemed reliable but not guaranteed; verify it. © 2026 Unlock MLS.',
    );
    expect(screen.getByTestId('re-home-photo-of')).toHaveTextContent('Front · 1 of 1');
    await fireEvent.press(screen.getByTestId('re-home-tour'));
    expect(router.push).toHaveBeenCalledWith(
      `/app/w/${WS}/a/realestate/deals/${DEAL}/tours?plan=1&home=${id(1)}`,
    );
  });

  it('notes a home and says where it stands, with no signal', async () => {
    mockOnline = false;
    await render(
      <HomeBody
        workspaceId={WS}
        userId={AGENT}
        deal={DEAL_REF}
        home={homes[0]!}
        notes={[]}
        timeZone={TZ}
        editable
      />,
    );
    await fireEvent.press(screen.getByTestId('re-home-status-shortlisted'));
    await fireEvent.press(screen.getByTestId('re-home-note'));
    await fireEvent.changeText(screen.getByTestId('re-home-note-sheet-text'), 'Big oak in front');
    await fireEvent.press(screen.getByTestId('re-home-note-sheet-submit'));
    await waitFor(() => expect(change).toHaveBeenCalledTimes(2));
    expect(changed()).toEqual([
      {
        name: 'realestate.home.set_status',
        input: { workspaceId: WS, homeId: id(1), status: 'shortlisted' },
      },
      {
        name: 'realestate.field_note.add',
        input: {
          workspaceId: WS,
          dealId: DEAL,
          id: NEW_ID,
          aboutKind: 'home',
          aboutId: id(1),
          body: 'Big oak in front',
          photoFileIds: [],
        },
      },
    ]);
  });

  it('looks a home up on the MLS only with signal', async () => {
    mockOnline = false;
    const bare = home({ id: id(3), mls: null, mlsState: 'none' });
    const drawn = await render(
      <HomeBody
        workspaceId={WS}
        userId={AGENT}
        deal={DEAL_REF}
        home={bare}
        notes={[]}
        timeZone={TZ}
        editable
      />,
    );
    expect(screen.getByTestId('re-home-lookup')).toHaveTextContent('Needs signal');
    expect(screen.getByTestId('re-home-lookup-why')).toHaveTextContent(
      'Looking a home up on the MLS needs signal. Try again when you have signal.',
    );
    mockOnline = true;
    await drawn.rerender(
      <HomeBody
        workspaceId={WS}
        userId={AGENT}
        deal={DEAL_REF}
        home={bare}
        notes={[]}
        timeZone={TZ}
        editable
      />,
    );
    await fireEvent.press(screen.getByTestId('re-home-lookup'));
    await waitFor(() => expect(change).toHaveBeenCalled());
    expect(changed()[0]).toEqual({
      name: 'realestate.home.lookup',
      input: { workspaceId: WS, homeId: id(3) },
    });
  });
});

describe('new matches', () => {
  const draw = () =>
    render(
      <MatchesBody
        workspaceId={WS}
        userId={AGENT}
        deal={DEAL_REF}
        matches={[
          match(),
          match({
            id: id(22),
            address: '9 Creekside Dr, Austin, TX',
            foundAt: '2026-10-02T20:00:00.000Z',
          }),
          match({ id: id(23), state: 'sent', address: '12 Sunset Ridge, Austin, TX' }),
        ]}
        searchOn
        suggestions={[]}
        now={NOW}
        today={TODAY}
        timeZone={TZ}
        editable
      />,
    );

  it('says what’s new and that sending reaches the client’s portal', async () => {
    await draw();
    expect(screen.getByText('New since yesterday')).toBeTruthy();
    expect(screen.getByText('31 Live Oak Ln')).toBeTruthy();
    expect(screen.getAllByText('$419,000 · 3 bd · 2 ba · 1,920 sq ft')).toHaveLength(2);
    expect(screen.getByText('New · 4 hours ago')).toBeTruthy();
    expect(screen.getByText('New · yesterday')).toBeTruthy();
    expect(screen.getAllByText('Send to Linh')).toHaveLength(2);
    expect(screen.getAllByText('Not for Linh')).toHaveLength(2);
    expect(
      screen.getByText(
        'Send to Linh reaches Linh’s portal; with no signal it waits and asks again after 30 minutes.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('12 Sunset Ridge')).toBeTruthy();
  });

  it('sends one and keeps another back, through the queue', async () => {
    mockOnline = false;
    await draw();
    await fireEvent.press(screen.getByTestId(`re-match-send-${id(21)}`));
    await fireEvent.press(screen.getByTestId(`re-match-skip-${id(22)}`));
    await waitFor(() => expect(change).toHaveBeenCalledTimes(2));
    expect(changed()).toEqual([
      { name: 'realestate.match.send', input: { workspaceId: WS, matchId: id(21) } },
      { name: 'realestate.match.dismiss', input: { workspaceId: WS, matchId: id(22) } },
    ]);
    expect(toast.show).toHaveBeenCalledWith('It goes to Linh when it sends.');
    expect(toast.show).toHaveBeenCalledWith('Skipped. Linh never saw it.');
  });
});
