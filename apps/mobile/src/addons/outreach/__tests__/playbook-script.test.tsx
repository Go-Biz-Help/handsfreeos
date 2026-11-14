import type {
  PlaybookTestInput,
  PlaybookTestOutput,
} from '@hfos/core/addons/outreach/playbook-test';
import { TEST_POSTS, TEST_START, TEST_WORDS } from '@hfos/core/addons/outreach/playbook-test';
import { blankPlaybook, type Playbook } from '@hfos/core/addons/outreach/playbooks';
import {
  LOCKED_RULES,
  STARTING_FIRST_MESSAGE,
  startingScript,
} from '@hfos/core/addons/outreach/script';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import * as React from 'react';

import { mergeSection, PlaybookBody, sectionWords } from '../playbook';
import { id } from './mocks';

/**
 * What a playbook says on the phone (decision 164): its own words for every message, starting from the owner's latest
 * way, changed a part at a time and saved as only the parts that differ; the rules no playbook changes, shown locked;
 * and Test it, which plays a chat out against the saved playbook with the real draft writer and sends nothing.
 */

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => ({}),
}));
jest.mock('@powersync/react-native', () => ({
  ...jest.requireActual<object>('@powersync/common'),
  useQuery: jest.fn(() => ({ data: [], isLoading: false, isFetching: false })),
}));
jest.mock('@/changes', () => ({
  change: jest.fn(),
  ChangeError: class extends Error {},
}));
jest.mock('@/home/open', () => ({ openWebPath: jest.fn() }));
jest.mock('@/lib/network', () => ({
  useNetwork: () => ({ online: true }),
  networkSnapshot: () => ({ online: true, lastOnlineAt: 0 }),
}));
jest.mock('@/components/ui/toast', () => ({
  ...jest.requireActual<object>('@/components/ui/toast'),
  toast: { show: jest.fn(), error: jest.fn() },
}));
jest.mock('@/components/shell/screen', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Screen: require('./mocks').TestScreen,
}));

const PLAYBOOK: Playbook = {
  id: id(31),
  name: 'Roofers',
  template: null,
  details: { ...blankPlaybook(), offer: 'A 20-minute demo', niche: 'Roofers' },
  archivedAt: null,
  createdAt: '2026-11-01T15:00:00.000Z',
  updatedAt: '2026-11-01T15:00:00.000Z',
};

type Over = Partial<React.ComponentProps<typeof PlaybookBody>>;
const body = (over: Over = {}) => {
  const onSave = jest.fn(async (..._a: unknown[]): Promise<string | null> => null);
  return {
    onSave,
    el: (
      <PlaybookBody
        playbook={PLAYBOOK}
        error={null}
        manages
        online
        onRetry={jest.fn()}
        onArchive={jest.fn()}
        onSave={onSave}
        {...over}
      />
    ),
  };
};
const saved = (onSave: jest.Mock) =>
  mergeSection(PLAYBOOK, onSave.mock.lastCall![1], onSave.mock.lastCall![2]).details;

const answer = (over: Partial<PlaybookTestOutput> = {}): PlaybookTestOutput => ({
  theirs: null,
  answer: null,
  read: null,
  kind: 'opener',
  label: 'First message',
  message:
    'Hey Sam, if I could get you more jobs for your roofing business, would you be interested?',
  others: [],
  note: null,
  next: 'If they stay quiet, the first follow-up goes in 2 days.',
  unanswered: null,
  state: { ...TEST_START, step: 'first' },
  about: null,
  aboutYou: false,
  ...over,
});

describe('What it says, on the phone', () => {
  it('shows the starting words for every part till the business changes one', async () => {
    const start = startingScript('demo');
    expect(sectionWords(PLAYBOOK.details, 'script')).toContain(
      `First message\n${STARTING_FIRST_MESSAGE}`,
    );
    expect(sectionWords(PLAYBOOK.details, 'script')).toContain(`When they say yes\n${start.yes}`);
    // Versions of the first message are numbered once there's more than one.
    expect(
      sectionWords({ ...PLAYBOOK.details, script: { first: ['One?', 'Two?'] } }, 'script'),
    ).toContain('First message\n1. One?\n2. Two?');
    await render(body().el);
    expect(screen.getByTestId('playbook-script')).toBeTruthy();
    expect(screen.getByText('What it says')).toBeTruthy();
  });

  it('saves only the parts that differ, and goes back to the starting words', async () => {
    const { onSave, el } = body();
    await render(el);
    await fireEvent.press(screen.getByTestId('playbook-edit-script'));
    const yes = screen.getByTestId('playbook-script-words-yes');
    expect(yes.props.value).toBe(startingScript('demo').yes);
    expect(screen.queryByTestId('playbook-script-changed-yes')).toBeNull();
    await fireEvent.changeText(yes, 'Great! When’s a good time this week for a quick demo?');
    expect(screen.getByTestId('playbook-script-changed-yes')).toBeTruthy();
    // A second version of the first message, to take turns with the first.
    await fireEvent.press(screen.getByTestId('playbook-script-first-add'));
    await fireEvent.changeText(
      screen.getByTestId('playbook-script-first-1'),
      'Hey [first name], open to more roofing jobs this month?',
    );
    await fireEvent.press(screen.getByTestId('playbook-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.lastCall![2]).toBe('script');
    expect(saved(onSave).script).toEqual({
      first: [STARTING_FIRST_MESSAGE, 'Hey [first name], open to more roofing jobs this month?'],
      yes: 'Great! When’s a good time this week for a quick demo?',
    });
    // Back to the starting words: the part is left out again, and follows them.
    await fireEvent.press(screen.getByTestId('playbook-edit-script'));
    await fireEvent.changeText(screen.getByTestId('playbook-script-words-no'), 'OK, bye.');
    await fireEvent.press(screen.getByTestId('playbook-script-starting-no'));
    expect(screen.getByTestId('playbook-script-words-no').props.value).toBe(
      startingScript('demo').no,
    );
    await fireEvent.press(screen.getByTestId('playbook-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(saved(onSave).script).toEqual({});
  });

  it('shows the rules no playbook changes, locked', async () => {
    await render(body().el);
    await fireEvent.press(screen.getByTestId('playbook-edit-script'));
    const locked = screen.getByTestId('playbook-locked-rules');
    expect(within(locked).getByText('Rules it always keeps')).toBeTruthy();
    for (const rule of LOCKED_RULES) expect(within(locked).getByText(rule)).toBeTruthy();
    expect(
      within(screen.getByTestId('playbook-script-blanks')).getByText('[first name]'),
    ).toBeTruthy();
  });
});

describe('Test it, on the phone', () => {
  it('plays a chat out against the saved playbook, a move at a time', async () => {
    const onTest = jest
      .fn<Promise<PlaybookTestOutput>, [PlaybookTestInput]>()
      .mockResolvedValueOnce(answer())
      .mockResolvedValueOnce(
        answer({
          theirs: 'Yes, I’d be interested',
          answer: 'yes',
          read: 'A yes. The ask for a time goes next.',
          kind: 'pitch',
          label: 'When they say yes',
          message: 'Awesome! When’s a good time for a quick demo?',
          others: ['Great! When could you do a quick demo?'],
          next: 'If they stay quiet, the first follow-up goes in 2 days.',
          state: { ...TEST_START, step: 'link', answer: 'yes' },
        }),
      );
    await render(body({ onTest }).el);
    await fireEvent.press(screen.getByTestId('playbook-test-open'));
    // Nobody made up yet: nothing to start.
    expect(screen.getByTestId('playbook-test-start')).toBeDisabled();
    expect(screen.queryByTestId('playbook-test-quick-yes')).toBeNull();
    await fireEvent.changeText(screen.getByTestId('playbook-test-name'), 'Sam Rivera');
    await fireEvent.changeText(
      screen.getByTestId('playbook-test-business'),
      'Owns a roofing company',
    );
    await fireEvent.press(screen.getByTestId('playbook-test-start'));
    await waitFor(() =>
      expect(onTest).toHaveBeenCalledWith(
        expect.objectContaining({
          playbookId: PLAYBOOK.id,
          move: 'start',
          chat: [],
          state: TEST_START,
          person: expect.objectContaining({ name: 'Sam Rivera', known: 'new' }),
        }),
      ),
    );
    expect(await screen.findByTestId('playbook-test-message')).toHaveTextContent(
      'Hey Sam, if I could get you more jobs for your roofing business, would you be interested?',
    );
    expect(screen.getByTestId('playbook-test-next')).toHaveTextContent(
      'What happens next: If they stay quiet, the first follow-up goes in 2 days.',
    );
    // A quick reply: the chat so far and where it stands go with it.
    await fireEvent.press(screen.getByTestId('playbook-test-quick-yes'));
    await waitFor(() => expect(onTest).toHaveBeenCalledTimes(2));
    expect(onTest.mock.lastCall![0]).toMatchObject({
      move: 'reply',
      text: 'Yes, I’d be interested',
      chat: [
        {
          fromMe: true,
          text: 'Hey Sam, if I could get you more jobs for your roofing business, would you be interested?',
        },
      ],
      state: { step: 'first' },
    });
    expect(await screen.findByTestId('playbook-test-theirs')).toHaveTextContent(
      'Yes, I’d be interested',
    );
    expect(screen.getByTestId('playbook-test-read')).toHaveTextContent(
      'What it read: A yes. The ask for a time goes next.',
    );
    expect(screen.getAllByTestId('playbook-test-message')[1]).toHaveTextContent(
      'Awesome! When’s a good time for a quick demo?',
    );
    // Only the newest "what happens next" stays.
    expect(screen.getAllByTestId('playbook-test-next')).toHaveLength(1);
    await fireEvent.press(screen.getByTestId('playbook-test-others'));
    expect(screen.getByText('Great! When could you do a quick demo?')).toBeTruthy();
  });

  it('tries a comment on what a post says, and says when there’d be none (decision 165)', async () => {
    const onTest = jest
      .fn<Promise<PlaybookTestOutput>, [PlaybookTestInput]>()
      .mockResolvedValueOnce(
        answer({
          kind: 'comment',
          label: 'Warm-up comment',
          message: 'Congrats on the second shop, big step!',
          others: ['A second shop already? Let’s go!'],
          next: TEST_WORDS.comment.next,
          state: TEST_START,
          about: 'our second shop on Main Street',
        }),
      )
      .mockResolvedValueOnce(
        answer({
          kind: null,
          label: null,
          message: null,
          note: TEST_WORDS.comment.none,
          next: TEST_WORDS.comment.next,
          state: TEST_START,
          aboutYou: true,
        }),
      );
    await render(body({ onTest }).el);
    await fireEvent.press(screen.getByTestId('playbook-test-open'));
    // Nothing to comment on yet.
    expect(screen.getByTestId('playbook-test-comment-go')).toBeDisabled();
    // An example fills the post in, with the kind of comment it's for.
    await fireEvent.press(screen.getByTestId('playbook-test-post-win'));
    const win = TEST_POSTS.find((p) => p.key === 'win')!;
    await fireEvent.press(screen.getByTestId('playbook-test-comment-go'));
    await waitFor(() =>
      expect(onTest).toHaveBeenCalledWith(
        expect.objectContaining({
          playbookId: PLAYBOOK.id,
          move: 'comment',
          post: win.text,
          comment: 'warm',
          // Nobody made up yet: it's written to a stand-in.
          person: expect.objectContaining({ name: TEST_WORDS.comment.person }),
        }),
      ),
    );
    expect(await screen.findByTestId('playbook-test-comment-text')).toHaveTextContent(
      'Congrats on the second shop, big step!',
    );
    expect(screen.getByTestId('playbook-test-comment-about')).toHaveTextContent(
      'It’s about: “our second shop on Main Street”',
    );
    expect(screen.getByTestId('playbook-test-comment-result')).toHaveTextContent(
      /About you is empty, so it reacts as a friendly outsider/,
    );
    // No chat started by it.
    expect(screen.queryByTestId('playbook-test-quick-yes')).toBeNull();
    // A caption that leans on its video: no comment, and it says why.
    await fireEvent.press(screen.getByTestId('playbook-test-post-video'));
    expect(screen.queryByTestId('playbook-test-comment-result')).toBeNull();
    await fireEvent.press(screen.getByTestId('playbook-test-comment-go'));
    expect(await screen.findByTestId('playbook-test-comment-note')).toHaveTextContent(
      TEST_WORDS.comment.none,
    );
    expect(screen.queryByTestId('playbook-test-comment-text')).toBeNull();
    expect(screen.getByTestId('playbook-test-comment-result')).toHaveTextContent(
      /It wrote this knowing what you said in About you/,
    );
  });

  it('is there for everyone who uses the add-on, and not on an archived playbook', async () => {
    const onTest = jest.fn<Promise<PlaybookTestOutput>, [PlaybookTestInput]>();
    await render(body({ onTest, manages: false }).el);
    expect(screen.getByTestId('playbook-test-open')).toBeTruthy();
    expect(screen.queryByTestId('playbook-edit-script')).toBeNull();
    await render(
      body({ onTest, playbook: { ...PLAYBOOK, archivedAt: '2026-11-02T00:00:00.000Z' } }).el,
    );
    expect(screen.queryByTestId('playbook-test-open')).toBeNull();
  });
});
