import { NO_MESSAGE_NOTES, type MessageSamples } from '@hfos/core/addons/outreach/conversation';
import type { ReadinessOutput } from '@hfos/core/addons/outreach/readiness';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import * as React from 'react';

import { GetReadyCard } from '../ready';
import type { MessageActions } from '../ready-messages';

/**
 * Your messages on the phone (decisions 63 and 87), as the web's: samples the AI writes for the person's playbook,
 * written right here, each to change in their own words or to have written again with what's not quite right, the
 * notes the AI then keeps each to forget, and They read right once they're for the main offer live now. Samples for
 * an earlier main offer are written again whole before anything else.
 */

jest.mock('@/changes', () => ({
  change: jest.fn(),
  ChangeError: class extends Error {},
}));

const SAMPLES: MessageSamples = {
  playbookId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  playbookName: 'Bakery owners',
  first: ['Hi Sam! Open to more weekend orders, on a 30-day guarantee?'],
  video: null,
  link: 'Here’s my link to book a quick call: [booking link]',
  followUps: ['Just making sure this didn’t get buried.'],
  followUpGaps: [2],
  checkIn: null,
  at: '2026-10-15T09:00:00.000Z',
  version: 2,
  mine: ['followUps.0'],
};

const readiness = (
  samples: MessageSamples | null,
  over: Partial<ReadinessOutput> = {},
): ReadinessOutput => ({
  ready: false,
  next: 'messages',
  changed: [],
  items: [
    { item: 'offer', state: 'done', whose: 'business', left: null },
    { item: 'playbook', state: 'done', whose: 'business', left: null },
    {
      item: 'messages',
      state: 'todo',
      whose: 'person',
      left: 'See sample messages for your playbook, and OK how they read.',
    },
  ],
  offer: { version: 2, line: 'We help bakeries fill their weekend orders.' },
  profile: {},
  profileCheck: null,
  messages: {
    at: null,
    version: null,
    samples,
    notes: { ...NO_MESSAGE_NOTES, followUps: ['Less pushy.'] },
  },
  numbers: {
    goal: 8,
    at: null,
    days: [1, 2, 3, 4, 5],
    canSend: 15,
    networks: [{ platform: 'facebook', canSend: 15 }],
    more: [],
  },
  ...over,
});

const actions = () => ({
  write: jest.fn(async () => true),
  edit: jest.fn(async (_s: unknown, _t: string) => true),
  rewrite: jest.fn(async (_s: unknown, _c: readonly string[], _n: string) => true),
  forget: jest.fn(async () => {}),
  playbooks: jest.fn(),
});

const card = (
  r: ReadinessOutput,
  a: MessageActions | null,
  onMessages = jest.fn(async () => true),
) => (
  <GetReadyCard
    readiness={r}
    onTick={jest.fn()}
    onMessages={onMessages}
    messageActions={a}
    onNumbers={jest.fn()}
  />
);

const open = () => fireEvent.press(screen.getByTestId('ready-open-messages'));

describe('Your messages on the phone', () => {
  it('writes the samples right here, once the main offer is live', async () => {
    const a = actions();
    await render(card(readiness(null), a));
    await open();
    expect(screen.getByTestId('ready-messages-none')).toHaveTextContent(
      'Write samples to see what goes out in your name, before anything does.',
    );
    expect(
      screen.queryByText(
        'Write your samples on your computer, under Get ready in HandsFreeOS. Then OK them there or here.',
      ),
    ).toBeNull();
    await fireEvent.press(screen.getByTestId('ready-messages-write'));
    await waitFor(() => expect(a.write).toHaveBeenCalled());
    // With no main offer live, there's nothing to write them for.
    await render(card(readiness(null, { offer: null }), actions()));
    await open();
    expect(screen.getByTestId('ready-messages-write')).toBeDisabled();
  });

  it('says where to write them where the phone can’t', async () => {
    await render(card(readiness(null), null));
    await open();
    expect(
      screen.getByText(
        'Write your samples on your computer, under Get ready in HandsFreeOS. Then OK them there or here.',
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId('ready-messages-write')).toBeNull();
  });

  it('changes one in the person’s own words', async () => {
    const a = actions();
    await render(card(readiness(SAMPLES), a));
    await open();
    expect(
      screen.getByText(
        'Change any message, or tell the AI what’s not quite right. Your real messages follow what you say.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('The ones in your words stay as you wrote them.')).toBeTruthy();
    expect(screen.getByTestId('ready-messages-write')).toHaveTextContent('Write them again');
    const [first] = screen.getAllByTestId('ready-message');
    await fireEvent.press(within(first!).getByTestId('ready-message-change'));
    // Nothing changed yet: nothing to save.
    expect(within(first!).getByTestId('ready-message-save')).toBeDisabled();
    await fireEvent.changeText(
      within(first!).getByTestId('ready-message-text'),
      'Hi Sam! Want more weekend orders?',
    );
    await fireEvent.press(within(first!).getByTestId('ready-message-save'));
    await waitFor(() =>
      expect(a.edit).toHaveBeenCalledWith(
        { part: 'first', index: 0 },
        'Hi Sam! Want more weekend orders?',
      ),
    );
    await waitFor(() => expect(screen.queryByTestId('ready-message-text')).toBeNull());
  });

  it('has one written again with what’s not quite right, and stays open to try again', async () => {
    const a = actions();
    await render(card(readiness(SAMPLES), a));
    await open();
    const link = screen.getAllByTestId('ready-message')[1]!;
    await fireEvent.press(within(link).getByTestId('ready-message-more'));
    const panel = within(link).getByTestId('ready-message-more-panel');
    expect(within(panel).getByText('What should change?')).toBeTruthy();
    await fireEvent.press(within(panel).getByText('Shorter'));
    await fireEvent.changeText(within(panel).getByTestId('ready-message-note'), 'Say it’s free');
    await fireEvent.press(within(panel).getByTestId('ready-message-rewrite'));
    await waitFor(() =>
      expect(a.rewrite).toHaveBeenCalledWith(
        { part: 'link', index: 0 },
        ['Shorter'],
        'Say it’s free',
      ),
    );
    await waitFor(() =>
      expect(within(link).getByTestId('ready-message-note').props.value).toBe(''),
    );
    expect(within(link).getByTestId('ready-message-more-panel')).toBeTruthy();
  });

  it('forgets a note the AI keeps, and opens the playbooks to change how many follow-ups', async () => {
    const a = actions();
    await render(card(readiness(SAMPLES), a));
    await open();
    const notes = screen.getByTestId('ready-message-notes-followUps');
    expect(within(notes).getByText('You told the AI')).toBeTruthy();
    await fireEvent.press(within(notes).getByLabelText('Forget “Less pushy.”'));
    await waitFor(() => expect(a.forget).toHaveBeenCalledWith('followUps', 'Less pushy.'));
    await fireEvent.press(screen.getByTestId('ready-messages-how-many'));
    expect(a.playbooks).toHaveBeenCalled();
  });

  it('writes samples for an earlier main offer again before they’re changed or OK’d', async () => {
    const onMessages = jest.fn(async () => true);
    await render(card(readiness({ ...SAMPLES, version: 1 }), actions(), onMessages));
    await open();
    expect(screen.getByTestId('ready-messages-older')).toHaveTextContent(
      'These were written for an earlier version of your main offer. Write them again to OK them.',
    );
    expect(screen.queryByTestId('ready-message-change')).toBeNull();
    expect(screen.queryByTestId('ready-message-more')).toBeNull();
    expect(screen.queryByTestId('ready-messages-ok')).toBeNull();
    // For the live one: They read right.
    await render(card(readiness(SAMPLES), actions(), onMessages));
    await open();
    await fireEvent.press(screen.getByTestId('ready-messages-ok'));
    await waitFor(() => expect(onMessages).toHaveBeenCalled());
  });
});
