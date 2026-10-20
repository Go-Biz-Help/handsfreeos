import { askCodeWords, type AskShown, type AsksOutput } from '@hfos/core/addons/outreach/asks';
import type { ChatsOutput } from '@hfos/core/addons/outreach/chat-read';
import type { GroupsOutput } from '@hfos/core/addons/outreach/groups';
import { fireEvent, render, renderHook, screen, within } from '@testing-library/react-native';
import * as React from 'react';

import { AskedPart, AskLine, type AskActions, useDoneReload } from '../asks';
import { ChatsBody } from '../chats';
import { GroupsBody } from '../groups';
import { id, TZ } from './mocks';

/**
 * Asking the computer from the phone (decisions 43 and 44): the Groups and Chats screens' buttons ask the person's
 * working computer, as the web's do, each with the line of its latest ask; a step handed over has Carry on, Skip and
 * Stop; one waiting on a code from their email has a box for it; and the Live screen lists what was asked.
 */

jest.mock('expo-router', () => ({ router: { push: jest.fn() }, useLocalSearchParams: () => ({}) }));
jest.mock('@powersync/react-native', () => ({
  ...jest.requireActual<object>('@powersync/common'),
  useQuery: jest.fn(() => ({ data: [], isLoading: false, isFetching: false })),
}));
jest.mock('@/changes', () => ({
  change: jest.fn(async () => ({ id: 'change-1', queued: false, output: {} })),
  ChangeError: class extends Error {},
}));
jest.mock('@/home/open', () => ({ openWebPath: jest.fn() }));
jest.mock('@/components/shell/screen', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Screen: require('./mocks').TestScreen,
}));

const NOW = '2026-10-10T15:00:00.000Z';

const COMPUTER = {
  computerId: id(1),
  name: 'Work laptop',
  online: true,
  signedOut: false,
  lastSeenAt: '2026-10-10T14:59:30.000Z',
  version: '0.25.0',
};

const asksOf = (asks: AskShown[] = [], over: Partial<AsksOutput> = {}): AsksOutput => ({
  now: NOW,
  timezone: TZ,
  computer: COMPUTER,
  warnedToday: false,
  asks,
  ...over,
});

const ask = (over: Partial<AskShown>): AskShown => ({
  askId: id(10),
  kind: 'groups',
  platform: 'facebook',
  target: '',
  about: null,
  via: 'mobile',
  state: 'working',
  line: 'Saving your groups: 12 so far.',
  result: null,
  reply: null,
  askedAt: '2026-10-10T14:50:00.000Z',
  startedAt: '2026-10-10T14:51:00.000Z',
  endedAt: null,
  computerName: 'Work laptop',
  ...over,
});

const actionsOf = (): AskActions & {
  ask: jest.Mock;
  reply: jest.Mock;
  stop: jest.Mock;
} => ({ busy: null, ask: jest.fn(), reply: jest.fn(), stop: jest.fn() });

const GROUP: GroupsOutput['groups'][number] = {
  groupId: id(20),
  name: 'Austin Small Business Owners',
  url: 'https://www.facebook.com/groups/austinsmallbiz',
  privacy: 'public',
  members: 12000,
  detail: null,
  joined: true,
  verdict: 'work',
  reasons: ['Says “small business”'],
  playbookName: 'CRM demos',
  people: 0,
  runsGroup: 0,
  adminsRead: false,
  requests: 0,
  replies: 0,
  demos: 0,
  seenAt: null,
  check: null,
  left: 0,
  join: null,
};

const groupsOf = (groups: GroupsOutput['groups']): GroupsOutput => ({
  counts: { work: groups.length, maybe: 0, skip: 0, all: groups.length },
  groups,
  prospects: { left: 0, perDay: 20, days: 0, low: true },
  joinsOnItsOwn: true,
  page: 1,
  pages: 1,
  total: groups.length,
});

const groupsBody = (over: Partial<React.ComponentProps<typeof GroupsBody>>) => (
  <GroupsBody
    view="work"
    onView={jest.fn()}
    search=""
    onSearch={jest.fn()}
    groups={groupsOf([])}
    error={null}
    onRetry={jest.fn()}
    onMore={jest.fn()}
    {...over}
  />
);

describe('Groups on the phone asks the computer', () => {
  it('asks to save the groups, find groups by words, save members and find posts', async () => {
    const actions = actionsOf();
    await render(groupsBody({ asks: asksOf(), actions }));
    expect(within(screen.getByTestId('groups-asks')).getByText('From Facebook')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('ask-groups'));
    expect(actions.ask).toHaveBeenLastCalledWith({ kind: 'groups' });
    // Find groups waits for words.
    expect(screen.getByTestId('ask-group-search').props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(screen.getByTestId('ask-group-search-words'), ' dog groomers ');
    await fireEvent.press(screen.getByTestId('ask-group-search'));
    expect(actions.ask).toHaveBeenLastCalledWith({ kind: 'group_search', words: 'dog groomers' });
    await fireEvent.press(screen.getByTestId('ask-members'));
    expect(actions.ask).toHaveBeenLastCalledWith({ kind: 'members' });
    await fireEvent.press(screen.getByTestId('ask-posts'));
    expect(actions.ask).toHaveBeenLastCalledWith({ kind: 'posts' });
    // With nothing saved yet, it says how to fill the list.
    expect(
      within(screen.getByTestId('groups-empty')).getByText('No groups to work yet'),
    ).toBeTruthy();
  });

  it('asks for one group’s members, and shows how an open ask goes, with Stop, while its button waits', async () => {
    const actions = actionsOf();
    const working = ask({});
    await render(groupsBody({ groups: groupsOf([GROUP]), asks: asksOf([working]), actions }));
    await fireEvent.press(screen.getByTestId('ask-group-members'));
    expect(actions.ask).toHaveBeenLastCalledWith({ kind: 'members', groupIds: [id(20)] });
    expect(screen.getByTestId('ask-groups').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByText('Saving your groups: 12 so far.')).toBeTruthy();
    expect(screen.getByText('Working on it')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('ask-stop'));
    expect(actions.stop).toHaveBeenCalledWith(working);
  });

  it('says why the buttons wait with no computer, and after a Facebook warning', async () => {
    const actions = actionsOf();
    const { rerender } = await render(
      groupsBody({ asks: asksOf([], { computer: null }), actions }),
    );
    expect(screen.getByTestId('ask-computer-note').props.children).toMatch(
      /^Install HandsFreeOS Social in Chrome/,
    );
    expect(screen.getByTestId('ask-groups').props.accessibilityState.disabled).toBe(true);
    await rerender(groupsBody({ asks: asksOf([], { warnedToday: true }), actions }));
    expect(screen.getByTestId('ask-computer-note').props.children).toMatch(
      /^Facebook warned you today/,
    );
    expect(screen.getByTestId('ask-posts').props.accessibilityState.disabled).toBe(true);
  });

  it('says an older extension can’t check groups, and how to update it', async () => {
    await render(
      groupsBody({
        groups: groupsOf([GROUP]),
        asks: asksOf([], { computer: { ...COMPUTER, version: '0.20.0' } }),
        actions: actionsOf(),
      }),
    );
    expect(screen.getByTestId('ask-group-checks').props.accessibilityState.disabled).toBe(true);
    expect(screen.getAllByTestId('outreach-ask-too-old')[0]!.props.children).toMatch(
      /older build \(0\.20\.0\).*Reload/,
    );
    // What every build does still asks.
    expect(screen.getByTestId('ask-groups').props.accessibilityState.disabled).toBe(false);
  });

  it('shows no buttons until HandsFreeOS says what was asked', async () => {
    await render(groupsBody({}));
    expect(screen.queryByTestId('groups-asks')).toBeNull();
  });
});

describe('Chats on the phone asks the computer', () => {
  it('reads the chats, and says how', async () => {
    const actions = actionsOf();
    const chats: ChatsOutput = {
      contactsFromChats: 'prospects',
      counts: { prospects: 0, tagged: 0, read: 0, waiting: 0 },
      tags: [],
      chats: [],
      page: 1,
      pages: 1,
      total: 0,
    };
    await render(
      <ChatsBody
        view="prospects"
        onView={jest.fn()}
        tag=""
        onTag={jest.fn()}
        search=""
        onSearch={jest.fn()}
        chats={chats}
        error={null}
        onRetry={jest.fn()}
        onMore={jest.fn()}
        onCustomer={jest.fn()}
        asks={asksOf()}
        actions={actions}
      />,
    );
    await fireEvent.press(screen.getByTestId('ask-chats'));
    expect(actions.ask).toHaveBeenLastCalledWith({ kind: 'chats' });
    expect(
      screen.getByText(/^Your computer opens your chats in Messenger one at a time/),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId('chats-empty')).getByText('No likely prospects yet'),
    ).toBeTruthy();
  });
});

describe('An ask’s line on the phone', () => {
  it('offers Carry on and Skip on a step handed over, and says what was said once answered', async () => {
    const actions = actionsOf();
    const stuck = ask({ kind: 'cancel', state: 'stuck', line: 'Couldn’t find Cancel request.' });
    const { rerender } = await render(
      <AskLine asks={asksOf()} ask={stuck} actions={actions} named />,
    );
    expect(screen.getByText('Cancel old friend requests')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('ask-skip'));
    expect(actions.reply).toHaveBeenCalledWith(stuck, 'skip');
    await rerender(<AskLine asks={asksOf()} ask={{ ...stuck, reply: 'skip' }} actions={actions} />);
    expect(screen.queryByTestId('ask-skip')).toBeNull();
    expect(screen.getByText('You said Skip.')).toBeTruthy();
  });

  it('says to type a password on the computer, and when a waiting one will start', async () => {
    const actions = actionsOf();
    const { rerender } = await render(
      <AskLine
        asks={asksOf()}
        ask={ask({ kind: 'file_request', state: 'typing', line: null })}
        actions={actions}
      />,
    );
    expect(screen.getByText(/^Facebook is asking for your password or PIN/)).toBeTruthy();
    await rerender(
      <AskLine
        asks={asksOf()}
        ask={ask({ state: 'waiting', line: null, startedAt: null })}
        actions={actions}
      />,
    );
    expect(screen.getByText('Work laptop starts on it in a moment.')).toBeTruthy();
  });

  it('takes the code a network emailed them, says it’s sent, and lets them type it again', async () => {
    const code = jest.fn(async () => true);
    const actions = { ...actionsOf(), code };
    const waiting = ask({ kind: 'profile_edit', state: 'code', line: askCodeWords('alignable') });
    await render(<AskLine asks={asksOf()} ask={waiting} actions={actions} />);
    expect(screen.getByText(askCodeWords('alignable'))).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('ask-code'), '482 913');
    await fireEvent.press(screen.getByTestId('ask-code-send'));
    expect(code).toHaveBeenCalledWith(waiting, '482 913');
    expect(await screen.findByText('Sent. Your computer is putting it in.')).toBeTruthy();
    await fireEvent.press(screen.getByText('Type it again'));
    expect(screen.getByTestId('ask-code')).toBeTruthy();
  });

  it('lists what was asked on the Live screen, or says nothing was', async () => {
    const actions = actionsOf();
    const { rerender } = await render(<AskedPart asks={asksOf()} actions={actions} />);
    expect(screen.getByTestId('live-asks-empty')).toBeTruthy();
    await rerender(
      <AskedPart
        asks={asksOf([ask({ state: 'done', line: 'Saved 40 groups.', endedAt: NOW })])}
        actions={actions}
      />,
    );
    expect(screen.getByText('Save your groups')).toBeTruthy();
    expect(screen.getByText('Saved 40 groups.')).toBeTruthy();
    expect(screen.queryByTestId('ask-stop')).toBeNull();
  });

  it('reloads the screen once when an ask has just ended done, not on the first answer', async () => {
    const reload = jest.fn();
    const { rerender } = await renderHook(
      ({ asks }: { asks: AsksOutput | null }) => useDoneReload(asks, reload),
      { initialProps: { asks: asksOf([ask({ state: 'done' })]) } },
    );
    expect(reload).not.toHaveBeenCalled();
    await rerender({ asks: asksOf([ask({ state: 'done' })]) });
    expect(reload).not.toHaveBeenCalled();
    await rerender({
      asks: asksOf([ask({ askId: id(11), state: 'done' }), ask({ state: 'done' })]),
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
