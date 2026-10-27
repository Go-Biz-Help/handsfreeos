import { MESSAGE_MOST } from '@hfos/core/addons/outreach/limits';
import { waitingOfCopy } from '@hfos/core/addons/outreach/views/waiting';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import * as React from 'react';
import { Linking } from 'react-native';

import { change } from '@/changes';

import { okAll, okSend, SEND_CHANGED_SQL, SEND_STATE_SQL, skipSend } from '../actions';
import { pendingSendIds } from '../copy';
import { PersonMenuScope } from '../person-menu';
import { WaitingBody, type WaitingFromServer } from '../waiting';
import { id, ME, sendRow, TZ } from './mocks';

/**
 * Waiting for you on the phone (decision 44): the person's messages come from the phone's own copy, so they read and
 * OK, change, skip and Approve all with no signal, each queued with what the screen shows written into the copy at
 * once. The steps and friend requests come from HandsFreeOS, and with no signal the screen says so. Each card's name
 * opens the person menu (decision 91), and each card keeps its own Open button.
 */

jest.mock('expo-router', () => ({ router: { push: jest.fn() }, useLocalSearchParams: () => ({}) }));
jest.mock('@powersync/react-native', () => ({
  ...jest.requireActual<object>('@powersync/common'),
  useQuery: jest.fn(() => ({ data: [], isLoading: false, isFetching: false })),
}));
jest.mock('@/changes', () => ({
  change: jest.fn(async () => ({ id: 'change-1', queued: true })),
  ChangeError: class extends Error {},
}));
jest.mock('@/home/open', () => ({ openWebPath: jest.fn() }));
jest.mock('@/components/shell/screen', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Screen: require('./mocks').TestScreen,
}));

const NOW = Date.parse('2026-10-10T15:00:00.000Z');

const handlers = () => ({
  onRetry: jest.fn(),
  onOk: jest.fn(),
  onSkip: jest.fn(),
  onOkAll: jest.fn(),
  onClear: jest.fn(),
  onLeave: jest.fn(),
  onSettings: jest.fn(),
});

const SERVER: WaitingFromServer = {
  recent: new Map(),
  asks: [],
  needs: [
    {
      needId: id(50),
      step: 'friend_request',
      profileId: id(150),
      postId: null,
      sendId: null,
      platform: 'facebook',
      name: 'Riley Member',
      url: 'https://www.facebook.com/riley.member',
      why: 'facebook showed a limit',
      text: null,
      threadKey: null,
      seenAt: '2026-10-10T14:00:00.000Z',
    },
  ],
  requests: [
    {
      profileId: id(60),
      name: 'Morgan Owner',
      url: 'https://www.facebook.com/morgan.owner',
      fit: 'maybe',
      why: ['Owner at a bakery'],
      held: null,
      since: '2026-10-09T14:00:00.000Z',
      mutualFriends: 3,
    },
  ],
  kinds: {
    ask: { count: 0, newestAt: null },
    need: { count: 1, newestAt: '2026-10-10T14:00:00.000Z' },
    request: { count: 1, newestAt: '2026-10-09T14:00:00.000Z' },
  },
  wheels: { on: false, from: null, ok: 0, daysLeft: 7, edits: 0 },
  pushes: 'bundled',
};

describe('Waiting for you on the phone', () => {
  it('lists the person’s messages from the phone’s copy, replies first, and theirs alone', async () => {
    const phone = waitingOfCopy(
      [
        sendRow(1, { name: 'Dana Reyes' }),
        sendRow(2, { handed_over: true, needs_you: 'they sound upset', kind: 'reply' }),
        sendRow(3, { user_id: id(999) }),
        sendRow(4, { state: 'approved' }),
      ],
      ME,
    );
    const h = handlers();
    await render(
      <WaitingBody
        phone={phone}
        server={null}
        serverError={null}
        online={false}
        timeZone={TZ}
        now={NOW}
        {...h}
      />,
    );
    // Only the phone's messages are known with no signal, so the count says messages.
    expect(screen.getByTestId('screen-subtitle').props.children).toBe(
      '2 messages wait for your OK',
    );
    expect(screen.getByTestId('waiting-offline')).toBeTruthy();
    const reply = screen.getByTestId('waiting-reply');
    expect(within(reply).getByText('Handed over')).toBeTruthy();
    expect(within(reply).getByText('Handed over to you: they sound upset.')).toBeTruthy();
    const messages = screen.getByTestId('waiting-message');
    expect(within(messages).getByText('Dana Reyes')).toBeTruthy();
    expect(screen.queryByText('Person 3')).toBeNull();
    expect(screen.queryByText('Person 4')).toBeNull();
    // One message that can go together: no Approve all.
    expect(screen.queryByTestId('waiting-approve-all')).toBeNull();
    // With no signal, nothing of the server's shows, and nothing says it failed.
    expect(screen.queryByTestId('waiting-need')).toBeNull();
    expect(screen.queryByTestId('waiting-server-error')).toBeNull();
  });

  it('shows the chat so far above a message, with signal', async () => {
    const phone = waitingOfCopy([sendRow(1, { name: 'Dana Reyes' })], ME);
    const recent = [
      { fromMe: false, text: 'Do you do demos?', at: '2026-09-19T14:00:00.000Z' },
      { fromMe: true, text: 'We do!', at: '2026-09-19T15:00:00.000Z' },
    ];
    await render(
      <WaitingBody
        phone={phone}
        server={{ ...SERVER, recent: new Map([[id(1), recent]]) }}
        serverError={null}
        online
        timeZone={TZ}
        now={NOW}
        {...handlers()}
      />,
    );
    const chat = screen.getByTestId('waiting-chat-so-far');
    expect(within(chat).getByText('Do you do demos?')).toBeTruthy();
    expect(within(chat).getByText('We do!')).toBeTruthy();
    // When, once for the day's run of messages.
    expect(within(chat).getAllByText('3 weeks ago')).toHaveLength(1);
  });

  it('OKs, changes and skips a message, and Approve all names those that can go together', async () => {
    const phone = waitingOfCopy(
      [
        sendRow(1, { name: 'Dana Reyes' }),
        sendRow(2),
        sendRow(3, { needs_you: 'they asked for you' }),
      ],
      ME,
    );
    const h = handlers();
    await render(
      <WaitingBody
        phone={phone}
        server={SERVER}
        serverError={null}
        online
        timeZone={TZ}
        now={NOW}
        {...h}
      />,
    );
    await fireEvent.press(screen.getByTestId('waiting-approve-all'));
    expect(h.onOkAll).toHaveBeenCalledWith([{ sendId: id(1) }, { sendId: id(2) }]);
    expect(screen.getByText('Approve all 2 messages')).toBeTruthy();

    const first = screen.getAllByTestId('waiting-send')[0]!;
    await fireEvent.press(within(first).getByTestId('waiting-ok'));
    expect(h.onOk).toHaveBeenCalledWith(expect.objectContaining({ sendId: id(1) }));
    await fireEvent.press(within(first).getByTestId('waiting-skip'));
    expect(h.onSkip).toHaveBeenCalledWith(expect.objectContaining({ sendId: id(1) }));

    await fireEvent.press(within(first).getByTestId('waiting-change'));
    await fireEvent.changeText(screen.getByTestId('waiting-change-text'), '  Hi Dana!  ');
    await fireEvent.press(screen.getByTestId('waiting-change-ok'));
    expect(h.onOk).toHaveBeenLastCalledWith(expect.objectContaining({ sendId: id(1) }), 'Hi Dana!');

    // Too long for HandsFreeOS: the sheet says so and stays open, and the message stays on the list.
    const okd = h.onOk.mock.calls.length;
    await fireEvent.press(within(first).getByTestId('waiting-change'));
    await fireEvent.changeText(
      screen.getByTestId('waiting-change-text'),
      'x'.repeat(MESSAGE_MOST + 1),
    );
    await fireEvent.press(screen.getByTestId('waiting-change-ok'));
    expect(h.onOk).toHaveBeenCalledTimes(okd);
    expect(screen.getByTestId('waiting-change-problem').props.children).toMatch(
      /^Keep a message under 2,000 characters/,
    );
  });

  it('shows the steps and friend requests HandsFreeOS has, with signal, and how the person hears of it', async () => {
    const h = handlers();
    await render(
      <WaitingBody
        phone={waitingOfCopy([], ME)}
        server={SERVER}
        serverError={null}
        online
        timeZone={TZ}
        now={NOW}
        {...h}
      />,
    );
    expect(screen.getByText('Send Riley Member a friend request yourself')).toBeTruthy();
    expect(screen.getByText('Morgan Owner')).toBeTruthy();
    expect(screen.getByText(/· 3 mutual$/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('waiting-need-done'));
    expect(h.onClear).toHaveBeenCalledWith(expect.objectContaining({ needId: id(50) }), 'done');
    await fireEvent.press(screen.getByTestId('waiting-request-leave'));
    expect(h.onLeave).toHaveBeenCalledWith(expect.objectContaining({ profileId: id(60) }));
    expect(screen.getByTestId('waiting-hear')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('waiting-settings'));
    expect(h.onSettings).toHaveBeenCalled();
  });

  it('marks each step with its own network, in its words, the name opening their menu, their page first', async () => {
    const opened = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const page = 'https://www.alignable.com/springfield-il/lane-landscaping-co';
    const lane = {
      ...SERVER.needs[0]!,
      needId: id(51),
      profileId: id(151),
      platform: 'alignable' as const,
      name: 'Lane Landscaping Co',
      url: page,
      why: 'couldn’t find Connect on their page',
    };
    await render(
      // With no signal, so the menu asks nothing: its Open items work all the same.
      <PersonMenuScope workspaceId={id(9)} online={false} writesContacts onChanged={jest.fn()}>
        <WaitingBody
          phone={waitingOfCopy([], ME)}
          server={{
            ...SERVER,
            needs: [lane],
            kinds: { ...SERVER.kinds, need: { count: 1, newestAt: lane.seenAt } },
          }}
          serverError={null}
          online
          timeZone={TZ}
          now={NOW}
          {...handlers()}
        />
      </PersonMenuScope>,
    );
    const step = within(screen.getByTestId('waiting-need-item'));
    // Alignable's words and name, never Facebook's.
    expect(step.getByTestId('waiting-need-title')).toHaveTextContent(
      'Send Lane Landscaping Co a connection request yourself',
    );
    expect(step.getByTestId('network-name').props.children).toBe('Alignable');
    expect(step.queryByText(/friend request/)).toBeNull();
    // The card's own Open button stays.
    expect(step.getByTestId('waiting-need-open')).toHaveTextContent('Open on Alignable');
    await fireEvent.press(step.getByTestId('waiting-need-open'));
    expect(opened).toHaveBeenLastCalledWith(page);
    // The name is a button that opens their menu, their page on Alignable first.
    const name = step.getByTestId('person-menu');
    expect(name.props.accessibilityLabel).toBe('Lane Landscaping Co');
    await fireEvent.press(name);
    const menu = within(screen.getByTestId('person-menu-sheet'));
    expect(menu.getAllByRole('button')[0]).toHaveTextContent('Open on Alignable');
    await fireEvent.press(menu.getByTestId('person-open-page'));
    expect(opened).toHaveBeenLastCalledWith(page);
    opened.mockRestore();
  });

  it('links nothing on a site the add-on doesn’t know', async () => {
    const odd = { ...SERVER.needs[0]!, url: 'https://example.com/riley' };
    await render(
      <WaitingBody
        phone={waitingOfCopy([], ME)}
        server={{ ...SERVER, needs: [odd] }}
        serverError={null}
        online
        timeZone={TZ}
        now={NOW}
        {...handlers()}
      />,
    );
    const step = within(screen.getByTestId('waiting-need-item'));
    expect(step.getByText('Send Riley Member a friend request yourself')).toBeTruthy();
    expect(step.getByTestId('network-name').props.children).toBe('Facebook');
    expect(step.queryByTestId('waiting-need-open')).toBeNull();
  });

  it('makes each card’s name a button that opens the person menu, keeping each card’s Open button', async () => {
    const phone = waitingOfCopy(
      [sendRow(1, { name: 'Dana Reyes' }), sendRow(2, { name: 'Quinn Harper', profile_id: null })],
      ME,
    );
    await render(
      <PersonMenuScope workspaceId={id(9)} online={false} writesContacts onChanged={jest.fn()}>
        <WaitingBody
          phone={phone}
          server={SERVER}
          serverError={null}
          online
          timeZone={TZ}
          now={NOW}
          {...handlers()}
        />
      </PersonMenuScope>,
    );
    const [dana, quinn] = screen.getAllByTestId('waiting-send');
    const send = within(dana!);
    expect(send.getByTestId('person-menu').props.accessibilityRole).toBe('button');
    expect(send.getByTestId('person-menu').props.accessibilityLabel).toBe('Dana Reyes');
    expect(send.getByTestId('waiting-open')).toBeTruthy();
    // A message whose profile the phone's copy doesn't know: the name is words alone.
    expect(within(quinn!).queryByTestId('person-menu')).toBeNull();
    expect(within(quinn!).getByText('Quinn Harper')).toBeTruthy();
    const need = within(screen.getByTestId('waiting-need-item'));
    expect(need.getByTestId('person-menu').props.accessibilityLabel).toBe('Riley Member');
    expect(need.getByTestId('waiting-need-open')).toBeTruthy();
    const request = within(screen.getByTestId('waiting-request-item'));
    expect(request.getByTestId('person-menu').props.accessibilityLabel).toBe('Morgan Owner');
    expect(request.getByTestId('waiting-request-open')).toBeTruthy();
    // Pressed with no signal: their page and chat work, and the rest say they need signal.
    await fireEvent.press(send.getByTestId('person-menu'));
    expect(screen.getByTestId('person-menu-sheet')).toBeTruthy();
    expect(screen.getByTestId('person-open-page')).toHaveTextContent('Open on Facebook');
    expect(screen.getByTestId('person-needs-signal')).toBeTruthy();
  });

  it('lists first what the person asked their computer that needs them there, with Carry on, Skip and Stop', async () => {
    const h = handlers();
    const askActions = { busy: null, ask: jest.fn(), reply: jest.fn(), stop: jest.fn() };
    const stuck = {
      askId: id(70),
      kind: 'unfriend' as const,
      platform: 'facebook' as const,
      target: '',
      about: '3 people',
      via: 'mobile' as const,
      state: 'stuck' as const,
      line: 'Couldn’t find Unfriend for Dana Reyes. Unfriend them yourself, then Carry on, or Skip them.',
      result: null,
      reply: null,
      askedAt: '2026-10-10T14:30:00.000Z',
      startedAt: '2026-10-10T14:31:00.000Z',
      endedAt: null,
      computerName: 'Work laptop',
    };
    await render(
      <WaitingBody
        phone={waitingOfCopy([], ME)}
        server={{
          ...SERVER,
          asks: [stuck],
          kinds: { ...SERVER.kinds, ask: { count: 1, newestAt: stuck.startedAt } },
        }}
        serverError={null}
        online
        timeZone={TZ}
        now={NOW}
        askActions={askActions}
        {...h}
      />,
    );
    const part = within(screen.getByTestId('waiting-ask'));
    expect(part.getByText(/^Your computer needs you/)).toBeTruthy();
    expect(part.getByText('Unfriend the ones you ticked · 3 people')).toBeTruthy();
    expect(part.getByText(/^Couldn’t find Unfriend for Dana Reyes/)).toBeTruthy();
    // Counted with the rest: 1 ask, 1 step, 1 request.
    expect(screen.getByTestId('screen-subtitle').props.children).toMatch(/^3 /);
    await fireEvent.press(part.getByTestId('ask-carry_on'));
    expect(askActions.reply).toHaveBeenCalledWith(
      expect.objectContaining({ askId: id(70) }),
      'carry_on',
    );
    await fireEvent.press(part.getByTestId('ask-skip'));
    expect(askActions.reply).toHaveBeenCalledWith(
      expect.objectContaining({ askId: id(70) }),
      'skip',
    );
    await fireEvent.press(part.getByTestId('ask-stop'));
    expect(askActions.stop).toHaveBeenCalledWith(expect.objectContaining({ askId: id(70) }));
  });

  it('says plainly when the server’s part couldn’t be asked, and that nothing waits once nothing does', async () => {
    const h = handlers();
    const { rerender } = await render(
      <WaitingBody
        phone={waitingOfCopy([], ME)}
        server={null}
        serverError="Something went wrong. Try again."
        online
        timeZone={TZ}
        now={NOW}
        {...h}
      />,
    );
    expect(screen.getByTestId('waiting-server-error')).toBeTruthy();
    await rerender(
      <WaitingBody
        phone={waitingOfCopy([], ME)}
        server={null}
        serverError={null}
        online={false}
        timeZone={TZ}
        now={NOW}
        {...h}
      />,
    );
    // Only the phone's messages are known with no signal: it says no messages wait, not that nothing does.
    expect(
      within(screen.getByTestId('waiting-empty')).getByText('No messages wait for your OK'),
    ).toBeTruthy();
    expect(screen.queryByText('Nothing waits for you')).toBeNull();
  });
});

describe('Waiting for you’s changes', () => {
  it('keeps a message off the list while its OK or skip hasn’t gone, so nobody OKs it twice', () => {
    const ids = pendingSendIds([
      {
        name: 'outreach.send.approve',
        input: JSON.stringify({
          workspaceId: id(9),
          sends: [{ sendId: id(1) }, { sendId: id(2) }],
        }),
      },
      { name: 'outreach.send.skip', input: JSON.stringify({ workspaceId: id(9), sendId: id(3) }) },
      { name: 'outreach.send.skip', input: 'not json' },
    ]);
    expect([...ids].sort()).toEqual([id(1), id(2), id(3)]);
  });

  const tx = { execute: jest.fn(async () => ({})) };
  const runOptimistic = async () => {
    const options = jest.mocked(change).mock.calls.at(-1)![2] as unknown as {
      optimistic: (t: typeof tx) => Promise<unknown>;
    };
    await options.optimistic(tx);
  };
  beforeEach(() => {
    jest.mocked(change).mockClear();
    tx.execute.mockClear();
  });

  it('OKs a message, and marks it OK’d on the phone at once', async () => {
    await okSend('ws', id(1));
    expect(change).toHaveBeenCalledWith(
      'outreach.send.approve',
      { workspaceId: 'ws', sends: [{ sendId: id(1) }] },
      expect.anything(),
    );
    await runOptimistic();
    expect(tx.execute).toHaveBeenCalledWith(SEND_STATE_SQL, ['approved', `sends:${id(1)}`]);
  });

  it('OKs a message changed, with its words', async () => {
    await okSend('ws', id(1), 'Hi Dana!');
    expect(change).toHaveBeenCalledWith(
      'outreach.send.approve',
      { workspaceId: 'ws', sends: [{ sendId: id(1), text: 'Hi Dana!' }] },
      expect.anything(),
    );
    await runOptimistic();
    expect(tx.execute).toHaveBeenCalledWith(SEND_CHANGED_SQL, [
      'approved',
      'Hi Dana!',
      `sends:${id(1)}`,
    ]);
  });

  it('sends Approve all as the messages it showed, passing over any handled meanwhile', async () => {
    await okAll('ws', [{ sendId: id(1) }, { sendId: id(2) }]);
    expect(change).toHaveBeenCalledWith(
      'outreach.send.approve',
      { workspaceId: 'ws', sends: [{ sendId: id(1) }, { sendId: id(2) }], partial: true },
      expect.anything(),
    );
    await runOptimistic();
    expect(tx.execute).toHaveBeenCalledTimes(2);
  });

  it('skips a message', async () => {
    await skipSend('ws', id(3));
    expect(change).toHaveBeenCalledWith(
      'outreach.send.skip',
      { workspaceId: 'ws', sendId: id(3) },
      expect.anything(),
    );
    await runOptimistic();
    expect(tx.execute).toHaveBeenCalledWith(SEND_STATE_SQL, ['skipped', `sends:${id(3)}`]);
  });
});
