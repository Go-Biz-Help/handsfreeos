import type { ProfileMarksOutput } from '@hfos/core/addons/outreach/person-menu';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import * as React from 'react';
import { Linking } from 'react-native';

import { change } from '@/changes';
import { toast } from '@/components/ui/toast';
import { openWebPath } from '@/home/open';
import { api } from '@/lib/api';

import { PersonMenuScope, PersonName, type MenuPerson } from '../person-menu';
import { id, WS } from './mocks';

/**
 * The person menu on someone's name, on the phone (decision 91), as the web's: the name is a button that opens it.
 * Their page first, which works with no signal; then Contacts (customers with the same name offered first), Mark as
 * client or Not a client after all, Demo booked, Don't pitch and Never contact, each as where they stand says
 * (`outreach.profile.marks`). With no signal only the Open items work, and nothing is sent.
 */

jest.mock('expo-router', () => ({ router: { push: jest.fn() }, useLocalSearchParams: () => ({}) }));
jest.mock('@/changes', () => ({
  change: jest.fn(async () => ({ id: 'change-1', queued: false, output: { addedPerson: true } })),
  ChangeError: class extends Error {},
}));
jest.mock('@/home/open', () => ({ openWebPath: jest.fn() }));
jest.mock('@/lib/api', () => ({
  api: { POST: jest.fn() },
  errorMessage: (e: unknown) =>
    e instanceof Error ? e.message : 'Something went wrong. Try again.',
  unwrap: (result: { data?: unknown; error?: unknown }) => {
    if (result.error) throw new Error(String(result.error));
    return result.data;
  },
}));
jest.mock('@/components/ui/toast', () => ({
  ...jest.requireActual<object>('@/components/ui/toast'),
  toast: { show: jest.fn(), error: jest.fn() },
}));

const PROFILE = id(50);
const CUSTOMER = id(60);
const PAGE = 'https://www.alignable.com/springfield-il/dana-reyes-design';
const DANA: MenuPerson = {
  profileId: PROFILE,
  name: 'Dana Reyes',
  url: PAGE,
  platform: 'alignable',
};

const marksOf = (over: Partial<ProfileMarksOutput> = {}): ProfileMarksOutput => ({
  profileId: PROFILE,
  name: 'Dana Reyes',
  platform: 'alignable',
  url: PAGE,
  personId: null,
  partner: false,
  demoBooked: false,
  laterUntil: null,
  client: { on: false, tagged: false, because: null },
  dontPitch: null,
  neverContact: null,
  canTakeOff: { dontPitch: true, neverContact: true },
  ...over,
});

/** HandsFreeOS's answers: where they stand, and the customers with the same name (some with a profile already). */
const answers = (marks: ProfileMarksOutput, sameName: { hasProfile: boolean }[] = []) =>
  (api.POST as unknown as jest.Mock).mockImplementation(async (path: string) => ({
    data:
      path === '/v1/queries/outreach.profile.marks'
        ? marks
        : {
            profiles: [],
            marks: [],
            threads: [],
            sameName: sameName.length
              ? [
                  {
                    name: 'Dana Reyes',
                    people: sameName.map((p, i) => ({
                      personId: i ? id(61 + i) : CUSTOMER,
                      name: 'Dana Reyes',
                      email: 'dana@example.com',
                      phone: null,
                      source: 'Website',
                      createdAt: '2026-03-02T15:00:00.000Z',
                      hasProfile: p.hasProfile,
                    })),
                  },
                ]
              : [],
          },
    response: { ok: true },
  }));

const changed = (output: object) =>
  jest.mocked(change).mockResolvedValueOnce({ id: 'change-1', queued: false, output } as never);

/** The name in a scope, pressed: the sheet open, and where they stand answered when there's signal. */
const open = async (
  who: MenuPerson = DANA,
  { online = true, writesContacts = true }: { online?: boolean; writesContacts?: boolean } = {},
) => {
  const onChanged = jest.fn();
  await render(
    <PersonMenuScope
      workspaceId={WS}
      online={online}
      writesContacts={writesContacts}
      onChanged={onChanged}
    >
      <PersonName who={who} />
    </PersonMenuScope>,
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Dana Reyes' }));
  if (online) await waitFor(() => expect(screen.queryByTestId('person-loading')).toBeNull());
  return onChanged;
};

/** The sheet's buttons and lines, in order, by test id. */
const shown = () => {
  const sheet = screen.getByTestId('person-menu-sheet');
  const ids: string[] = [];
  const walk = (node: { props: { testID?: unknown }; children?: unknown[] | null }) => {
    const t = node.props.testID;
    if (
      typeof t === 'string' &&
      t.startsWith('person-') &&
      t !== 'person-menu-sheet' &&
      ids.at(-1) !== t
    )
      ids.push(t);
    for (const c of node.children ?? []) if (c && typeof c === 'object') walk(c as typeof node);
  };
  walk(sheet as unknown as Parameters<typeof walk>[0]);
  return ids;
};

beforeEach(() => {
  jest.mocked(change).mockClear();
  (api.POST as unknown as jest.Mock).mockReset();
  jest.mocked(toast.show).mockClear();
  jest.mocked(toast.error).mockClear();
  jest.mocked(openWebPath).mockClear();
});

describe('The name on the phone', () => {
  it('is a button labelled with the name, saying what it opens', async () => {
    answers(marksOf());
    await render(
      <PersonMenuScope workspaceId={WS} online writesContacts onChanged={jest.fn()}>
        <PersonName who={DANA} />
      </PersonMenuScope>,
    );
    const name = screen.getByTestId('person-menu');
    expect(name.props.accessibilityRole).toBe('button');
    expect(name.props.accessibilityLabel).toBe('Dana Reyes');
    expect(name.props.accessibilityHint).toBe(
      'Opens everything about them: their page, Contacts, Client, Don’t pitch and more',
    );
    expect(name.props.accessibilityState).toEqual({ expanded: false });
    expect(screen.queryByTestId('person-menu-sheet')).toBeNull();
    await fireEvent.press(name);
    expect(screen.getByTestId('person-menu-sheet')).toBeTruthy();
    expect(screen.getByTestId('person-menu').props.accessibilityState).toEqual({ expanded: true });
  });

  it('is plain words with no scope, or no profile', async () => {
    const { rerender } = await render(<PersonName who={DANA} />);
    expect(screen.getByText('Dana Reyes')).toBeTruthy();
    expect(screen.queryByTestId('person-menu')).toBeNull();
    // The phone's copy of a message gives '' for a profile it doesn't know.
    await rerender(
      <PersonMenuScope workspaceId={WS} online writesContacts onChanged={jest.fn()}>
        <PersonName who={{ ...DANA, profileId: '' }} />
      </PersonMenuScope>,
    );
    expect(screen.getByText('Dana Reyes')).toBeTruthy();
    expect(screen.queryByTestId('person-menu')).toBeNull();
  });
});

describe('The person menu on the phone', () => {
  it('asks where they stand as it opens, and lists their page first', async () => {
    answers(marksOf());
    await open();
    expect(api.POST).toHaveBeenCalledWith('/v1/queries/outreach.profile.marks', {
      body: { workspaceId: WS, profileId: PROFILE },
    });
    expect(shown()).toEqual([
      'person-open-page',
      'person-add-contact',
      'person-client',
      'person-demo-mark',
      'person-partner',
      'person-later',
      'person-dont-pitch',
      'person-never-contact',
    ]);
    expect(screen.getByText('Open on Alignable')).toBeTruthy();
    expect(screen.getByText('Mark as client')).toBeTruthy();
  });

  it('opens their page, and their chat, with no signal, while the rest wait under the note', async () => {
    const opened = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await open(
      {
        ...DANA,
        platform: 'facebook',
        url: 'https://www.facebook.com/dana.reyes',
        threadKey: '42',
      },
      { online: false },
    );
    expect(shown().slice(0, 3)).toEqual([
      'person-open-page',
      'person-open-chat',
      'person-needs-signal',
    ]);
    expect(
      screen.getByText(
        'Contacts, Client, Demo booked, Potential partner, Later, Don’t pitch and Never contact need signal. Opening their page works now.',
      ),
    ).toBeTruthy();
    for (const t of [
      'person-add-contact',
      'person-client',
      'person-demo-mark',
      'person-later',
      'person-dont-pitch',
      'person-never-contact',
    ]) {
      expect(screen.getByTestId(t).props.accessibilityState.disabled).toBe(true);
      await fireEvent.press(screen.getByTestId(t));
    }
    expect(api.POST).not.toHaveBeenCalled();
    expect(change).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('person-open-page'));
    expect(opened).toHaveBeenLastCalledWith('https://www.facebook.com/dana.reyes');
    await fireEvent.press(screen.getByRole('button', { name: 'Dana Reyes' }));
    await fireEvent.press(screen.getByTestId('person-open-chat'));
    expect(opened).toHaveBeenLastCalledWith(expect.stringMatching(/42/));
    opened.mockRestore();
  });

  it('promises nothing to open with no signal when the row knows neither their page nor their chat', async () => {
    await open({ ...DANA, url: null }, { online: false });
    expect(screen.queryByTestId('person-open-page')).toBeNull();
    expect(screen.queryByTestId('person-open-chat')).toBeNull();
    expect(screen.getByTestId('person-needs-signal')).toHaveTextContent(
      'Contacts, Client, Demo booked, Potential partner, Later, Don’t pitch and Never contact need signal. Try again when you’re back online.',
    );
    expect(api.POST).not.toHaveBeenCalled();
  });

  it('marks them a client through the same-name pick, tied to the customer picked', async () => {
    answers(marksOf(), [{ hasProfile: false }]);
    changed({
      profileId: PROFILE,
      personId: CUSTOMER,
      client: true,
      tagged: true,
      because: null,
      addedPerson: false,
      skipped: 2,
    });
    const onChanged = await open();
    await fireEvent.press(screen.getByTestId('person-client'));
    expect(await screen.findByText('Is Dana Reyes one of these?')).toBeTruthy();
    expect(change).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('person-same-them'));
    await waitFor(() =>
      expect(change).toHaveBeenCalledWith('outreach.client.set', {
        workspaceId: WS,
        profileId: PROFILE,
        client: true,
        personId: CUSTOMER,
      }),
    );
    expect(toast.show).toHaveBeenCalledWith(
      'Dana Reyes is a client now. Nobody here sends them outreach, and their replies still come to Waiting for you.',
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it('marks someone in Contacts a client at once, and adds as new on Add as new', async () => {
    answers(marksOf({ personId: CUSTOMER }));
    await open();
    await fireEvent.press(screen.getByTestId('person-client'));
    await waitFor(() =>
      expect(change).toHaveBeenCalledWith('outreach.client.set', {
        workspaceId: WS,
        profileId: PROFILE,
        client: true,
      }),
    );
    expect(api.POST).not.toHaveBeenCalledWith('/v1/queries/outreach.lookup', expect.anything());

    jest.mocked(change).mockClear();
    answers(marksOf(), [{ hasProfile: false }]);
    await fireEvent.press(screen.getByRole('button', { name: 'Dana Reyes' }));
    await waitFor(() => expect(screen.queryByTestId('person-loading')).toBeNull());
    await fireEvent.press(screen.getByTestId('person-client'));
    await fireEvent.press(await screen.findByTestId('person-same-new'));
    await waitFor(() =>
      expect(change).toHaveBeenCalledWith('outreach.client.set', {
        workspaceId: WS,
        profileId: PROFILE,
        client: true,
      }),
    );
  });

  it('takes the Client tag off, and says when Contacts still counts them one', async () => {
    answers(marksOf({ personId: CUSTOMER, client: { on: true, tagged: true, because: null } }));
    changed({
      profileId: PROFILE,
      personId: CUSTOMER,
      client: true,
      tagged: false,
      because: 'paid',
      addedPerson: false,
      skipped: 0,
    });
    await open();
    expect(screen.getByText('Not a client after all')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('person-client'));
    await waitFor(() =>
      expect(change).toHaveBeenCalledWith('outreach.client.set', {
        workspaceId: WS,
        profileId: PROFILE,
        client: false,
      }),
    );
    expect(toast.show).toHaveBeenCalledWith(
      'The Client tag is off Dana Reyes, but Contacts still counts them a client: they paid a bill. To change that, open them in Contacts.',
    );
  });

  it('says in a whole sentence when the same name as a client keeps them one after the tag comes off', async () => {
    answers(marksOf({ personId: CUSTOMER, client: { on: true, tagged: true, because: null } }));
    changed({
      profileId: PROFILE,
      personId: CUSTOMER,
      client: true,
      tagged: false,
      because: null,
      addedPerson: false,
      skipped: 0,
    });
    await open();
    await fireEvent.press(screen.getByTestId('person-client'));
    await waitFor(() =>
      expect(toast.show).toHaveBeenCalledWith(
        'The Client tag is off Dana Reyes, but they have the same name on this network as a client in Contacts, so Social Outreach still leaves them alone. To change that, open that client in Contacts.',
      ),
    );
  });

  it('says why they’re a client where only Contacts can change it', async () => {
    answers(marksOf({ personId: CUSTOMER, client: { on: true, tagged: false, because: 'paid' } }));
    await open();
    expect(screen.queryByTestId('person-client')).toBeNull();
    expect(screen.getByTestId('person-client-line')).toHaveTextContent(
      'A client in Contacts: they paid a bill',
    );
  });

  it('offers no Add to Contacts or Client to someone who can’t add and edit customers', async () => {
    answers(marksOf());
    await open(DANA, { writesContacts: false });
    expect(screen.queryByTestId('person-add-contact')).toBeNull();
    expect(screen.queryByTestId('person-client')).toBeNull();
    expect(screen.getByTestId('person-dont-pitch')).toBeTruthy();
  });

  it('offers the customer with the same name before adding them to Contacts', async () => {
    answers(marksOf(), [{ hasProfile: false }]);
    const onChanged = await open();
    await fireEvent.press(screen.getByTestId('person-add-contact'));
    expect(api.POST).toHaveBeenCalledWith('/v1/queries/outreach.lookup', {
      body: { workspaceId: WS, names: ['Dana Reyes'] },
    });
    expect(await screen.findByText('Is Dana Reyes one of these?')).toBeTruthy();
    expect(screen.getByText('dana@example.com · Website · added Mar 2, 2026')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('person-same-them'));
    await waitFor(() =>
      expect(change).toHaveBeenCalledWith('outreach.profile.contact', {
        workspaceId: WS,
        profileId: PROFILE,
        personId: CUSTOMER,
      }),
    );
    expect(toast.show).toHaveBeenCalledWith('Dana Reyes is tied to them in Contacts now.');
    expect(onChanged).toHaveBeenCalled();
  });

  it('adds them at once when nobody else has the name, or only someone with a profile of their own', async () => {
    answers(marksOf(), [{ hasProfile: true }]);
    await open();
    await fireEvent.press(screen.getByTestId('person-add-contact'));
    await waitFor(() =>
      expect(change).toHaveBeenCalledWith('outreach.profile.contact', {
        workspaceId: WS,
        profileId: PROFILE,
        personId: null,
      }),
    );
    expect(toast.show).toHaveBeenCalledWith('Dana Reyes is in Contacts now.');
    expect(screen.queryByText('Is Dana Reyes one of these?')).toBeNull();
  });

  it('marks a demo booked, and puts them on Don’t pitch and Never contact', async () => {
    answers(marksOf());
    await open();
    await fireEvent.press(screen.getByTestId('person-demo-mark'));
    await waitFor(() =>
      expect(change).toHaveBeenCalledWith('outreach.demo.mark', {
        workspaceId: WS,
        profileId: PROFILE,
        booked: true,
      }),
    );
    expect(toast.show).toHaveBeenCalledWith('Marked: Dana Reyes booked a demo.');
    await fireEvent.press(screen.getByRole('button', { name: 'Dana Reyes' }));
    await waitFor(() => expect(screen.queryByTestId('person-loading')).toBeNull());
    await fireEvent.press(screen.getByTestId('person-dont-pitch'));
    await waitFor(() =>
      expect(change).toHaveBeenCalledWith('outreach.friend.set', {
        workspaceId: WS,
        profileId: PROFILE,
        dontPitch: true,
      }),
    );
    expect(toast.show).toHaveBeenCalledWith(
      'Dana Reyes is on Don’t pitch. Nobody here sends them outreach.',
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Dana Reyes' }));
    await waitFor(() => expect(screen.queryByTestId('person-loading')).toBeNull());
    await fireEvent.press(screen.getByTestId('person-never-contact'));
    await waitFor(() =>
      expect(change).toHaveBeenCalledWith('outreach.friend.set', {
        workspaceId: WS,
        profileId: PROFILE,
        neverContact: true,
      }),
    );
    expect(toast.show).toHaveBeenCalledWith(
      expect.stringMatching(/^Dana Reyes is on Never contact\./),
    );
  });

  it('takes them off a list they may, and says who put them on one they may not', async () => {
    answers(
      marksOf({
        dontPitch: { by: null, at: '2026-10-20T15:00:00.000Z', tagged: false },
        neverContact: { by: 'Riley Member', at: '2026-10-20T15:00:00.000Z' },
        canTakeOff: { dontPitch: true, neverContact: false },
      }),
    );
    await open();
    expect(screen.getByText('Take off Don’t pitch')).toBeTruthy();
    expect(screen.getByTestId('person-never-contact-line')).toHaveTextContent(
      'Riley Member put them on Never contact',
    );
    expect(screen.queryByTestId('person-never-contact')).toBeNull();
    await fireEvent.press(screen.getByTestId('person-dont-pitch'));
    await waitFor(() =>
      expect(change).toHaveBeenCalledWith('outreach.friend.set', {
        workspaceId: WS,
        profileId: PROFILE,
        dontPitch: false,
      }),
    );
    expect(toast.show).toHaveBeenCalledWith('Dana Reyes is off the Don’t pitch list.');
  });

  it('puts them on Later for 2 weeks, and takes them off it again', async () => {
    answers(marksOf());
    changed({ profileId: PROFILE, until: '2026-11-11T15:00:00.000Z', skipped: 1 });
    const onChanged = await open();
    expect(screen.getByText('Later: back in 2 weeks')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('person-later'));
    await waitFor(() =>
      expect(change).toHaveBeenCalledWith('outreach.later.set', {
        workspaceId: WS,
        profileId: PROFILE,
        later: true,
      }),
    );
    expect(toast.show).toHaveBeenCalledWith(
      'Dana Reyes is off your Today until Nov 11. Their replies still come.',
    );
    expect(onChanged).toHaveBeenCalled();

    answers(marksOf({ laterUntil: '2026-11-11T15:00:00.000Z' }));
    changed({ profileId: PROFILE, until: null, skipped: 0 });
    await fireEvent.press(screen.getByRole('button', { name: 'Dana Reyes' }));
    await waitFor(() => expect(screen.queryByTestId('person-loading')).toBeNull());
    expect(screen.getByText('Take off Later (back Nov 11)')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('person-later'));
    await waitFor(() =>
      expect(change).toHaveBeenCalledWith('outreach.later.set', {
        workspaceId: WS,
        profileId: PROFILE,
        later: false,
      }),
    );
    expect(toast.show).toHaveBeenCalledWith('Dana Reyes is back on your Today.');
  });

  it('marks them a potential partner under the AI’s word, and takes it back', async () => {
    answers(marksOf({ partnerHint: 'Runs a group of 3,000 homeowners' }));
    changed({ partnerId: id(80), stage: 'found', skipped: 1 });
    await open();
    expect(
      screen.getByText('Looks more like a partner: Runs a group of 3,000 homeowners'),
    ).toBeTruthy();
    await fireEvent.press(screen.getByTestId('person-partner'));
    await waitFor(() =>
      expect(change).toHaveBeenCalledWith('outreach.partner.potential', {
        workspaceId: WS,
        profileId: PROFILE,
        potential: true,
      }),
    );
    expect(toast.show).toHaveBeenCalledWith(
      'Dana Reyes is on your Partners list now. They get partner messages from here: a like first, then the ask a day later, each waiting for your OK.',
    );

    answers(marksOf({ partner: true, myPartner: { stage: 'found', marked: true } }));
    changed({ partnerId: id(80), stage: null, skipped: 0 });
    await fireEvent.press(screen.getByRole('button', { name: 'Dana Reyes' }));
    await waitFor(() => expect(screen.queryByTestId('person-loading')).toBeNull());
    expect(screen.getByText('Not a partner after all')).toBeTruthy();
    // Someone marked may still book a demo.
    expect(screen.getByText('Demo booked')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('person-partner'));
    await waitFor(() =>
      expect(change).toHaveBeenCalledWith('outreach.partner.potential', {
        workspaceId: WS,
        profileId: PROFILE,
        potential: false,
      }),
    );
    expect(toast.show).toHaveBeenCalledWith(
      'Dana Reyes is off your Partners list, and back on customer messages where they were.',
    );
  });

  it('opens them in Contacts once they’re there, and takes a demo back', async () => {
    answers(marksOf({ personId: CUSTOMER, demoBooked: true }));
    await open();
    expect(screen.queryByTestId('person-add-contact')).toBeNull();
    expect(screen.getByText('Not a demo after all')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('person-in-contacts'));
    expect(openWebPath).toHaveBeenCalledWith(`/app/w/${WS}/customers/people/${CUSTOMER}`);
  });

  it('says what a button does when it’s held, and to a screen reader, without pressing it', async () => {
    answers(marksOf());
    await open();
    expect(screen.getByTestId('outreach-hold-note')).toHaveTextContent(
      'Press and hold a button to see what it does.',
    );
    const later = screen.getByTestId('person-later');
    expect(later.props.accessibilityHint).toContain('Takes them off your Today for 2 weeks');
    expect(screen.queryByTestId('outreach-hint')).toBeNull();
    await fireEvent(later, 'longPress');
    expect(screen.getByTestId('outreach-hint')).toHaveTextContent(
      /^Takes them off your Today for 2 weeks/,
    );
    expect(change).not.toHaveBeenCalled();
    // Holding another moves the explainer there; holding it again hides it.
    await fireEvent(screen.getByTestId('person-dont-pitch'), 'longPress');
    expect(screen.getAllByTestId('outreach-hint')).toHaveLength(1);
    expect(screen.getByTestId('outreach-hint')).toHaveTextContent(/^Stops outreach to them/);
    await fireEvent(screen.getByTestId('person-dont-pitch'), 'longPress');
    expect(screen.queryByTestId('outreach-hint')).toBeNull();
  });

  it('waits for where they stand before its switches work, and says why it couldn’t ask', async () => {
    (api.POST as unknown as jest.Mock).mockResolvedValue({ error: 'That person isn’t kept here.' });
    await render(
      <PersonMenuScope workspaceId={WS} online writesContacts onChanged={jest.fn()}>
        <PersonName who={DANA} />
      </PersonMenuScope>,
    );
    await fireEvent.press(screen.getByTestId('person-menu'));
    expect(
      await within(screen.getByTestId('person-menu-sheet')).findByTestId('person-marks-problem'),
    ).toHaveTextContent('That person isn’t kept here.');
    expect(screen.getByTestId('person-dont-pitch').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId('person-open-page').props.accessibilityState.disabled).toBe(false);
  });
});

describe('Everything about them, under the actions (decision 128)', () => {
  const GROUP = id(70);
  const step = (kind: 'friend_request' | 'message', at: string) => ({
    kind,
    step: kind === 'message' ? ('first_message' as const) : null,
    at,
    auto: true,
    by: null,
    group:
      kind === 'friend_request' ? { name: 'Springfield Makers', url: 'https://x.test/g' } : null,
    postUrl: null,
  });

  it('shows why they fit, the next step, the chat, where they were found and every step', async () => {
    answers(
      marksOf({
        intro: ['Owner at Reyes Design'],
        mutualFriends: 4,
        journey: {
          stage: 'talking',
          why: ['Runs a design studio'],
          nextStep: 'Ask about their spring launch',
          groups: [{ groupId: GROUP, name: 'Springfield Makers', url: 'https://x.test/g' }],
          chat: {
            summary: 'Asked what the service costs.',
            nextStep: null,
            lastAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
            lastFromMe: false,
          },
          steps: [
            step('message', new Date(Date.now() - 86_400_000).toISOString()),
            step('friend_request', new Date(Date.now() - 2 * 86_400_000).toISOString()),
          ],
          moreSteps: 0,
          lead: null,
        },
      }),
    );
    await open();
    const panel = await screen.findByTestId('person-panel');
    expect(within(panel).getByTestId('person-panel-why')).toHaveTextContent(
      /Why they fitRuns a design studioOwner at Reyes Design4 mutual friends/,
    );
    expect(within(panel).getByTestId('person-panel-next')).toHaveTextContent(
      /Ask about their spring launch/,
    );
    expect(within(panel).getByTestId('person-panel-chat')).toHaveTextContent(
      /Asked what the service costs\.They wrote last, 3 h ago/,
    );
    expect(within(panel).getByTestId('person-panel-steps')).toHaveTextContent(
      /from Springfield Makers · 2 d ago/,
    );
    await fireEvent.press(within(panel).getByRole('link', { name: 'Springfield Makers' }));
    expect(openWebPath).toHaveBeenCalledWith(`/app/w/${WS}/a/outreach?view=groups&group=${GROUP}`);
  });

  it('waits for where they stand, and shows nothing more from a build before it', async () => {
    answers(marksOf());
    await open();
    expect(screen.queryByTestId('person-panel')).toBeNull();
  });
});
