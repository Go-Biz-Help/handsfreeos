import type {
  PlaybookAssistOutput,
  PlaybookAssistPart,
} from '@hfos/core/addons/outreach/playbook-assist';
import { blankPlaybook, type Playbook } from '@hfos/core/addons/outreach/playbooks';
import {
  VIDEO_PART_KEYS,
  type VideoScript,
  type VideoScriptInput,
} from '@hfos/core/addons/outreach/video';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import * as React from 'react';

import { toast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api';

import { assistDraftOf } from '../ai-help';
import { PlaybookBody } from '../playbook';
import { id } from './mocks';

/**
 * The AI in a playbook's sheet on the phone, as the web's builder has it (ai-help.tsx): Improve and Suggest more on
 * each part (Write it for me for words not written yet), what comes back only offered, to use in place of what's
 * there, to add a line at a time or use instead, or to add as questions; and the short video's script, written part
 * by part and one part again on Improve, changed as the business likes. Nothing is saved until the sheet's Save.
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

beforeEach(() => {
  jest.mocked(toast.show).mockClear();
  jest.mocked(toast.error).mockClear();
});

const PLAYBOOK: Playbook = {
  id: id(30),
  name: 'Bakery owners',
  template: null,
  details: {
    ...blankPlaybook(),
    offer: 'A 20-minute demo',
    niche: 'Bakeries with a shop front',
    tags: ['Hot'],
  },
  archivedAt: null,
  createdAt: '2026-10-01T15:00:00.000Z',
  updatedAt: '2026-10-01T15:00:00.000Z',
};

const offered = (over: Partial<PlaybookAssistOutput> = {}): PlaybookAssistOutput => ({
  options: [],
  questions: [],
  ...over,
});

type Over = Partial<Omit<React.ComponentProps<typeof PlaybookBody>, 'onSave' | 'onAssist'>>;

/** The playbook's page, with the AI to ask unless `assist` is false. */
const body = ({ assist = true, ...over }: Over & { assist?: boolean } = {}) => {
  const props = {
    onSave: jest.fn(async (..._a: unknown[]): Promise<string | null> => null),
    onAssist: jest.fn(async (_p: PlaybookAssistPart, _m: 'improve' | 'suggest', _d: unknown) =>
      offered(),
    ),
  };
  return {
    props,
    el: (
      <PlaybookBody
        playbook={PLAYBOOK}
        error={null}
        manages
        online
        onRetry={jest.fn()}
        onArchive={jest.fn()}
        {...over}
        onSave={props.onSave}
        onAssist={assist ? props.onAssist : undefined}
      />
    ),
  };
};

const saved = (onSave: jest.Mock) => onSave.mock.lastCall![1].details;

describe('AI help in a playbook’s sheet', () => {
  it('says AI help is on the web only where the phone can’t ask for it', async () => {
    await render(body().el);
    expect(screen.queryByText('AI help (Improve, Suggest more) is on the web.')).toBeNull();
    await render(body({ assist: false }).el);
    expect(screen.getByText('AI help (Improve, Suggest more) is on the web.')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('playbook-edit-audience'));
    expect(screen.queryByTestId('ai-help-audience')).toBeNull();
  });

  it('writes words not written yet, and improves them once they are, with the playbook as it stands', async () => {
    const { props, el } = body();
    props.onAssist.mockResolvedValueOnce(
      offered({ options: ['Owners of busy bakeries', 'Bakers who run a shop'] }),
    );
    await render(el);
    await fireEvent.press(screen.getByTestId('playbook-edit-audience'));
    expect(screen.queryByTestId('ai-improve-audience')).toBeNull();
    expect(screen.getByTestId('ai-suggest-audience')).toHaveTextContent('Write it for me');
    await fireEvent.press(screen.getByTestId('ai-suggest-audience'));
    await waitFor(() =>
      expect(props.onAssist).toHaveBeenCalledWith('audience', 'suggest', assistDraftOf(PLAYBOOK)),
    );
    const options = await screen.findByTestId('ai-help-audience-options');
    expect(within(options).getByText('Pick one to use, then change it as you like')).toBeTruthy();
    await fireEvent.press(within(options).getByText('Bakers who run a shop'));
    expect(screen.queryByTestId('ai-help-audience-options')).toBeNull();
    expect(screen.getByTestId('playbook-words').props.value).toBe('Bakers who run a shop');
    // Written now: Improve, and no Write it for me.
    expect(screen.getByTestId('ai-improve-audience')).toBeTruthy();
    expect(screen.queryByTestId('ai-suggest-audience')).toBeNull();
    await fireEvent.press(screen.getByTestId('playbook-save'));
    await waitFor(() => expect(props.onSave).toHaveBeenCalled());
    expect(saved(props.onSave).audience).toBe('Bakers who run a shop');
  });

  it('adds a suggested line at a time, and uses a rewritten list instead', async () => {
    const { props, el } = body();
    props.onAssist
      .mockResolvedValueOnce(offered({ options: ['Owns a bakery', 'Posts about new bakes'] }))
      .mockResolvedValueOnce(offered({ options: ['Owns a bakery with a shop front'] }));
    await render(el);
    await fireEvent.press(screen.getByTestId('playbook-edit-signs'));
    await fireEvent.press(screen.getByTestId('ai-suggest-signs'));
    const options = await screen.findByTestId('ai-help-signs-options');
    expect(within(options).getByText('Tap to add')).toBeTruthy();
    await fireEvent.press(within(options).getByText('Owns a bakery'));
    // Added, and gone from what's offered; the box shows it.
    expect(within(options).queryByText('Owns a bakery')).toBeNull();
    expect(screen.getByTestId('playbook-lines').props.value).toBe('Owns a bakery');
    await fireEvent.press(screen.getByTestId('ai-improve-signs'));
    await waitFor(() =>
      expect(props.onAssist).toHaveBeenLastCalledWith(
        'signs',
        'improve',
        expect.objectContaining({ signs: ['Owns a bakery'] }),
      ),
    );
    expect(await screen.findByText('Your list, rewritten')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('ai-replace-signs'));
    expect(screen.getByTestId('playbook-lines').props.value).toBe(
      'Owns a bakery with a shop front',
    );
    await fireEvent.press(screen.getByTestId('playbook-save'));
    await waitFor(() => expect(props.onSave).toHaveBeenCalled());
    expect(saved(props.onSave).signs).toEqual(['Owns a bakery with a shop front']);
  });

  it('says when a list is full, and when the AI has nothing new', async () => {
    const full: Playbook = {
      ...PLAYBOOK,
      details: { ...PLAYBOOK.details, openerStyles: ['Ask a question', 'Compliment', 'Be short'] },
    };
    const { props, el } = body({ playbook: full });
    props.onAssist
      .mockResolvedValueOnce(offered({ options: ['Mention their town'] }))
      .mockResolvedValueOnce(offered());
    await render(el);
    await fireEvent.press(screen.getByTestId('playbook-edit-openers'));
    await fireEvent.press(screen.getByTestId('ai-suggest-openerStyles'));
    await fireEvent.press(await screen.findByText('Mention their town'));
    expect(toast.error).toHaveBeenCalledWith('That’s 3, the most it takes. Take one out first.');
    // Still offered, to add once one's taken out.
    expect(screen.getByText('Mention their town')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('ai-suggest-ownOpeners'));
    await waitFor(() =>
      expect(toast.show).toHaveBeenCalledWith(
        'The AI had nothing new to add here. Try again, or write more first.',
      ),
    );
  });

  it('says what went wrong when the AI can’t be asked', async () => {
    const { props, el } = body();
    props.onAssist.mockRejectedValueOnce(
      new ApiError('Turn on Social Outreach to use this.', 403, 'forbidden', null),
    );
    await render(el);
    await fireEvent.press(screen.getByTestId('playbook-edit-tone'));
    await fireEvent.press(screen.getByTestId('ai-suggest-tone'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Turn on Social Outreach to use this.'),
    );
    expect(screen.queryByTestId('ai-help-tone-options')).toBeNull();
  });

  it('adds the questions that fit to the conversation', async () => {
    const { props, el } = body();
    props.onAssist.mockResolvedValueOnce(
      offered({
        questions: [
          {
            text: 'Do you take orders online?',
            answers: [
              { label: 'Yes', tag: 'Hot', next: 'continue' },
              { label: 'No', tag: null, next: 'continue' },
            ],
          },
        ],
      }),
    );
    await render(el);
    await fireEvent.press(screen.getByTestId('playbook-edit-questions'));
    expect(screen.queryAllByTestId('playbook-question')).toHaveLength(0);
    expect(screen.getByTestId('ai-suggest-questions')).toHaveTextContent('Suggest questions');
    await fireEvent.press(screen.getByTestId('ai-suggest-questions'));
    const question = await screen.findByTestId('ai-question');
    expect(within(question).getByText(/^“Yes” · .* · tags Hot$/)).toBeTruthy();
    await fireEvent.press(within(question).getByTestId('ai-question-add'));
    expect(screen.getAllByTestId('playbook-question')).toHaveLength(1);
    expect(screen.queryByTestId('ai-question')).toBeNull();
    await fireEvent.press(screen.getByTestId('playbook-save'));
    await waitFor(() => expect(props.onSave).toHaveBeenCalled());
    expect(saved(props.onSave).questions).toEqual([
      {
        id: expect.any(String),
        text: 'Do you take orders online?',
        answers: [
          { label: 'Yes', tag: 'Hot', next: 'continue' },
          { label: 'No', tag: null, next: 'continue' },
        ],
      },
    ]);
  });
});

const script = (version: number | null, say = (p: string) => `Say ${p}.`): VideoScript => ({
  parts: VIDEO_PART_KEYS.map((part) => ({ part, say: say(part), show: 'You, to camera' })),
  at: '2026-10-15T09:00:00.000Z',
  version,
});

describe('The short video’s script in the sheet', () => {
  it('writes the script from the main offer and the niche, and saves it with the link', async () => {
    const onScript = jest.fn(async (_i: VideoScriptInput) => script(2));
    const { props, el } = body({ onScript, liveVersion: 2 });
    await render(el);
    await fireEvent.press(screen.getByTestId('playbook-edit-video'));
    expect(
      screen.getByText(
        'No script yet. The AI writes one from your main offer and this playbook’s niche.',
      ),
    ).toBeTruthy();
    await fireEvent.press(screen.getByTestId('playbook-video-write'));
    await waitFor(() =>
      expect(onScript).toHaveBeenCalledWith({
        draft: expect.objectContaining({
          name: 'Bakery owners',
          niche: 'Bakeries with a shop front',
          offer: 'A 20-minute demo',
        }),
        mode: 'write',
      }),
    );
    expect(await screen.findByTestId('playbook-video-runs')).toHaveTextContent(
      'About 0.5 minutes · written for your main offer, version 2',
    );
    expect(screen.queryByTestId('playbook-video-older')).toBeNull();
    expect(screen.getByTestId('playbook-video-say-who').props.value).toBe('Say who.');
    await fireEvent.changeText(
      screen.getByTestId('playbook-video-say-who'),
      'Hi, bakery owners: this is for you.',
    );
    await fireEvent.changeText(
      screen.getByTestId('playbook-video-link'),
      'https://www.loom.com/share/abc123',
    );
    await fireEvent.press(screen.getByTestId('playbook-save'));
    await waitFor(() => expect(props.onSave).toHaveBeenCalled());
    const details = saved(props.onSave);
    expect(details.videoLink).toBe('https://www.loom.com/share/abc123');
    expect(details.videoScript.parts[0]).toEqual({
      part: 'who',
      say: 'Hi, bakery owners: this is for you.',
      show: 'You, to camera',
    });
    expect(props.onSave.mock.lastCall![2]).toBe('video');
  });

  it('writes one part again on Improve, and says when it was written for an older main offer', async () => {
    const kept = script(1);
    const onScript = jest.fn(async (_i: VideoScriptInput) =>
      script(1, (p) => (p === 'cost' ? 'What waiting costs you.' : `Say ${p}.`)),
    );
    const { el } = body({
      playbook: { ...PLAYBOOK, details: { ...PLAYBOOK.details, videoScript: kept } },
      onScript,
      liveVersion: 3,
    });
    await render(el);
    await fireEvent.press(screen.getByTestId('playbook-edit-video'));
    expect(screen.getByTestId('playbook-video-older')).toHaveTextContent(
      'Written for version 1 of your main offer. Write it again so it matches the live one.',
    );
    await fireEvent.press(screen.getByTestId('playbook-video-improve-cost'));
    await waitFor(() =>
      expect(onScript).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'improve', part: 'cost', script: kept }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId('playbook-video-say-cost').props.value).toBe(
        'What waiting costs you.',
      ),
    );
  });

  it('says what went wrong when the script can’t be written', async () => {
    const onScript = jest.fn(async (_i: VideoScriptInput): Promise<VideoScript> => {
      throw new TypeError('Network request failed');
    });
    await render(body({ onScript }).el);
    await fireEvent.press(screen.getByTestId('playbook-edit-video'));
    await fireEvent.press(screen.getByTestId('playbook-video-write'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('No signal. Try again when you’re back online.'),
    );
    expect(screen.getByTestId('playbook-video-write')).toBeTruthy();
  });
});
