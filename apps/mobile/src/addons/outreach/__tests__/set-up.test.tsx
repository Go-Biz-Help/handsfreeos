import type { AsksOutput } from '@hfos/core/addons/outreach/asks';
import type { OpenerResult, OpenersOutput } from '@hfos/core/addons/outreach/openers';
import type { SetupOutput } from '@hfos/core/addons/outreach/setup';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import * as React from 'react';

import { openWebPath } from '@/home/open';

import { RunNowPart, type AskActions } from '../asks';
import { OutreachHomeBody } from '../home';
import { OpenersPart } from '../results';
import { SetupBody } from '../setup';
import { id, TZ, WS } from './mocks';

/**
 * Social Outreach rearranged on the phone, part 3 (decision 129): Set up first on its first screen with its count
 * while anything's left, the Set up screen with each step and each network's Get ready, Run now on Your computer with
 * every job, and which openers work on Results.
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
  change: jest.fn(async () => ({ id: 'change-1', queued: false, output: {} })),
  ChangeError: class extends Error {},
}));
jest.mock('@/home/open', () => ({ openWebPath: jest.fn() }));
jest.mock('@/components/shell/screen', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Screen: require('./mocks').TestScreen,
}));

beforeEach(() => jest.mocked(openWebPath).mockClear());

const step = <S extends string>(s: S, state: 'done' | 'todo', optional = false) => ({
  step: s,
  state,
  left: state === 'done' ? null : 'Left',
  optional,
});

const SETUP: SetupOutput = {
  steps: ['offer', 'playbook', 'video', 'rules', 'extension', 'messages', 'networks', 'numbers'],
  states: [
    step('offer', 'done'),
    step('playbook', 'done'),
    step('video', 'todo', true),
    step('rules', 'done'),
    step('extension', 'done'),
    step('messages', 'todo'),
    step('networks', 'done'),
    step('numbers', 'todo'),
  ],
  business: [],
  networks: [
    {
      platform: 'facebook',
      steps: [step('profile', 'done'), step('choices', 'done'), step('start', 'todo')],
    },
  ],
  next: { net: null, step: 'messages' },
  reached: null,
  startedAt: '2026-10-10T15:00:00.000Z',
  finishedAt: null,
  extensionAt: '2026-10-10T15:00:00.000Z',
  computer: 'Work laptop',
  settingsSaved: true,
  firstTime: false,
  banner: true,
  canManage: true,
  sendingAllowedMore: true,
  playbooks: [],
  noVideo: false,
  groups: { mine: 0, business: 0, latest: [] },
  extensionLink: null,
};

describe('Set up on the first screen', () => {
  it('comes first with how far it’s come, and opens the Set up screen', async () => {
    await render(<OutreachHomeBody workspaceId={WS} messages={0} setupLeft={{ done: 6, of: 9 }} />);
    const pages = within(screen.getByTestId('outreach-pages'));
    const row = screen.getByTestId('outreach-page-setup');
    expect(row).toHaveTextContent(/Set up/);
    expect(row).toHaveTextContent(/6 of 9/);
    expect(pages.getAllByTestId(/^outreach-page-/)[0]).toBe(row);
    await fireEvent.press(row);
    expect(openWebPath).toHaveBeenCalledWith(`/app/w/${WS}/a/outreach?view=setup`);
  });

  it('is gone once everything’s done or the reminder was hidden', async () => {
    await render(<OutreachHomeBody workspaceId={WS} messages={0} setupLeft={null} />);
    expect(screen.queryByTestId('outreach-page-setup')).toBeNull();
  });
});

describe('The Set up screen', () => {
  const props = () => ({
    error: null,
    onRetry: jest.fn(),
    onCarryOn: jest.fn(),
    ready: jest.fn((platform: string) => <React.Fragment key={platform} />),
  });

  it('says what’s next and how far it’s come, carries on at that step, and lists every step', async () => {
    const p = props();
    await render(<SetupBody setup={SETUP} {...p} />);
    expect(screen.getByTestId('setup-count')).toHaveTextContent('7 of 10 done');
    await fireEvent.press(screen.getByTestId('setup-carry-on'));
    expect(p.onCarryOn).toHaveBeenLastCalledWith({ step: { net: null, step: 'messages' } });
    await fireEvent.press(screen.getByTestId('setup-again'));
    expect(p.onCarryOn).toHaveBeenLastCalledWith({ again: true });
    const steps = within(screen.getByTestId('setup-steps'));
    expect(steps.getByTestId('setup-step-video')).toHaveTextContent(/Optional/);
    expect(steps.getByTestId('setup-step-facebook')).toHaveTextContent(/2 of 3 done/);
    // Get ready, for each network they work.
    expect(p.ready).toHaveBeenCalledWith('facebook');
    expect(screen.queryByTestId('setup-no-networks')).toBeNull();
  });

  it('says when everything’s set up, with no Carry on, and when no network is picked', async () => {
    await render(
      <SetupBody setup={{ ...SETUP, next: null, networks: [], banner: false }} {...props()} />,
    );
    expect(screen.getByTestId('setup-all-done')).toHaveTextContent('Everything’s set up.');
    expect(screen.queryByTestId('setup-carry-on')).toBeNull();
    expect(screen.getByTestId('setup-no-networks')).toBeTruthy();
  });

  it('says plainly it needs signal when there’s nothing to show', async () => {
    const p = props();
    await render(<SetupBody setup={null} {...p} error="Social Outreach needs signal." />);
    expect(screen.getByTestId('setup-needs-signal')).toBeTruthy();
  });
});

describe('Run now on Your computer', () => {
  const ASKS: AsksOutput = {
    now: '2026-10-10T15:00:00.000Z',
    timezone: TZ,
    computer: {
      computerId: id(1),
      name: 'Work laptop',
      online: true,
      signedOut: false,
      lastSeenAt: '2026-10-10T14:59:30.000Z',
      version: '9.0.0',
    },
    warnedToday: false,
    asks: [],
  };
  const actions = (): AskActions & { ask: jest.Mock } => ({
    busy: null,
    ask: jest.fn(),
    reply: jest.fn(),
    stop: jest.fn(),
  });

  it('lists every job on each network they work, and asks the computer on that network', async () => {
    const a = actions();
    await render(<RunNowPart asks={ASKS} actions={a} networks={['facebook', 'linkedin']} />);
    expect(screen.getByTestId('run-now-all-facebook')).toBeTruthy();
    expect(screen.getByTestId('run-now-all-linkedin')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('run-now-all-linkedin-requests'));
    expect(a.ask).toHaveBeenCalledWith({ kind: 'requests' }, 'linkedin');
  });

  it('shows nothing when they work no network', async () => {
    await render(<RunNowPart asks={ASKS} actions={actions()} networks={[]} />);
    expect(screen.queryByTestId('run-now-all')).toBeNull();
  });
});

describe('Which openers work, on Results', () => {
  const opener = (text: string, sent: number, replies: number, current = true): OpenerResult => ({
    kind: 'own',
    text,
    current,
    sent,
    replies,
    demos: 1,
  });
  const openers = (list: OpenerResult[]): OpenersOutput => ({
    everyone: false,
    playbooks: [{ playbookId: id(30), name: 'Roofers', openers: list }],
  });

  it('lists each opener with how it did, marking the best once two have had a fair try', async () => {
    await render(
      <OpenersPart
        openers={openers([opener('Hi there', 10, 4), opener('Quick question', 6, 1)])}
      />,
    );
    const rows = screen.getAllByTestId('results-opener');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent(/4 of 10 wrote back \(40%\)/);
    expect(within(rows[0]!).getByTestId('results-opener-best')).toBeTruthy();
    expect(within(rows[1]!).queryByTestId('results-opener-best')).toBeNull();
  });

  it('shows nothing until a playbook has openers', async () => {
    await render(<OpenersPart openers={openers([])} />);
    expect(screen.queryByTestId('results-openers')).toBeNull();
  });
});
