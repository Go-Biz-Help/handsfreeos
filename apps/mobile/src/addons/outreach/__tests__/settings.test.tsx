import {
  AUTOMATION_DEFAULTS,
  NETWORKS_DEFAULTS,
  type AutomationOutput,
  type AutomationSettings,
} from '@hfos/core/addons/outreach/automation';
import { outreachSettings, type OutreachSettings } from '@hfos/core/addons/outreach/chat-read';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import * as React from 'react';

import { toast } from '@/components/ui/toast';

import { SAVE_PAUSE_MS } from '../autosave';
import { phonePartOf, SettingsMenuBody, SettingsPartBody } from '../settings';
import { id, ME, TZ } from './mocks';

/**
 * Social Outreach's Settings on the phone, a page for each part (Chris, 2026-10-16; regrouped by decision 129): the
 * menu (You, each network with whether it's on, the networks still to come, Your computer, and Team for owners and
 * admins), You, Team with the business's people and For your team, and every change saved as it's made, with no Save
 * button: one save at a time, the line under the page saying how it went, and a refused save going back with the
 * server's words. A network's page is in ./networks.test.tsx.
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
  change: jest.fn(async () => ({ id: 'change-1', queued: true })),
  ChangeError: class extends Error {},
}));
jest.mock('@/home/open', () => ({ openWebPath: jest.fn() }));
jest.mock('@/lib/network', () => ({
  useNetwork: () => ({ online: true }),
  networkSnapshot: () => ({ online: true, lastOnlineAt: 0 }),
}));
jest.mock('@/components/ui/toast', () => ({
  toast: { show: jest.fn(), error: jest.fn() },
}));
jest.mock('@/components/shell/screen', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Screen: require('./mocks').TestScreen,
}));

afterEach(() => {
  jest.useRealTimers();
  jest.mocked(toast.show).mockClear();
});

const AUTOMATION: AutomationOutput = {
  settings: AUTOMATION_DEFAULTS,
  timezone: TZ,
  startedAt: null,
  saved: true,
  wheels: { on: false, from: null, ok: 0, daysLeft: 7, edits: 0 },
  networkWheels: {
    linkedin: { on: false, from: null, ok: 0, daysLeft: 7, edits: 0 },
    instagram: { on: false, from: null, ok: 0, daysLeft: 7, edits: 0 },
    alignable: { on: false, from: null, ok: 0, daysLeft: 7, edits: 0 },
  },
  fresh: {
    facebook: { on: false, from: null, until: null, days: 14 },
    linkedin: { on: false, from: null, until: null, days: 14 },
    instagram: { on: false, from: null, until: null, days: 14 },
    alignable: { on: false, from: null, until: null, days: 14 },
  },
  userId: ME,
  name: 'Dana Reyes',
  changedBy: null,
  rules: {
    sendingAllowed: ['off', 'steps', 'approve_all', 'everything'],
    repliesAllowed: ['draft', 'simple', 'everything'],
    postingAllowed: ['copy', 'after_ok', 'own'],
    dailyLimits: {},
    networksAllowed: ['facebook', 'linkedin'],
    networkLimits: {},
  },
};

const withLinkedIn = (on: boolean): AutomationSettings => ({
  ...AUTOMATION_DEFAULTS,
  networks: { ...NETWORKS_DEFAULTS, linkedin: { ...NETWORKS_DEFAULTS.linkedin, on } },
});

const menuProps = () => ({
  error: null,
  mine: true,
  online: true,
  onRetry: jest.fn(),
  onBackToYours: jest.fn(),
  onPart: jest.fn(),
  onOpen: jest.fn(),
});

describe('The Settings menu on the phone', () => {
  it('lists You, each network with whether it’s on for you, the networks to come, and the rest', async () => {
    const p = menuProps();
    await render(<SettingsMenuBody automation={AUTOMATION} {...p} />);
    expect(screen.getByTestId('settings-open-general')).toHaveTextContent(
      /You.*How it writes, hours and alerts/,
    );
    expect(screen.getByText('Networks')).toBeTruthy();
    expect(screen.getByText('This computer')).toBeTruthy();
    // Team is an owner's or admin's.
    expect(screen.queryByTestId('settings-open-team')).toBeNull();
    expect(screen.getByTestId('settings-open-facebook-badge')).toHaveTextContent('On');
    expect(screen.getByTestId('settings-open-linkedin-badge')).toHaveTextContent('Off');
    // A screen reader says it too.
    expect(screen.getByTestId('settings-open-linkedin')).toHaveAccessibleName('LinkedIn. Off');
    // The networks still to come, on one line nobody can open.
    expect(screen.getByTestId('settings-open-instagram-badge')).toHaveTextContent('Off');
    expect(screen.getByTestId('settings-open-alignable-badge')).toHaveTextContent('Off');
    expect(screen.getByTestId('settings-networks-coming')).toHaveTextContent(
      'Threads, X and TikTok are coming',
    );
    expect(screen.getByText('Changes save as you make them.')).toBeTruthy();
    // No Save button anywhere: each page saves as it's changed.
    expect(screen.queryByText('Save')).toBeNull();
  });

  it('opens each part as its own page, and Your computer; Playbooks are a page of their own', async () => {
    const p = menuProps();
    await render(<SettingsMenuBody automation={AUTOMATION} {...p} manages />);
    await fireEvent.press(screen.getByTestId('settings-open-general'));
    await fireEvent.press(screen.getByTestId('settings-open-facebook'));
    await fireEvent.press(screen.getByTestId('settings-open-linkedin'));
    expect(screen.getByText('Owners')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('settings-open-team'));
    expect(p.onPart.mock.calls.map(([part]) => part)).toEqual([
      'general',
      'facebook',
      'linkedin',
      'team',
    ]);
    expect(screen.queryByTestId('settings-open-playbooks')).toBeNull();
    await fireEvent.press(screen.getByTestId('settings-open-computer'));
    expect(p.onOpen.mock.calls.map(([view]) => view)).toEqual(['live']);
  });

  it('shows a network the business stopped allowing as off, whatever the person chose', async () => {
    await render(
      <SettingsMenuBody
        automation={{
          ...AUTOMATION,
          settings: withLinkedIn(true),
          rules: { ...AUTOMATION.rules, networksAllowed: ['facebook'] },
        }}
        {...menuProps()}
      />,
    );
    expect(screen.getByTestId('settings-open-linkedin-badge')).toHaveTextContent('Off');
    await render(
      <SettingsMenuBody
        automation={{ ...AUTOMATION, settings: withLinkedIn(true) }}
        {...menuProps()}
      />,
    );
    expect(screen.getByTestId('settings-open-linkedin-badge')).toHaveTextContent('On');
  });

  it('says whose it shows, opened from Team, with Back to yours', async () => {
    const p = menuProps();
    await render(
      <SettingsMenuBody
        automation={{ ...AUTOMATION, userId: id(7), name: 'Riley Member' }}
        {...p}
        mine={false}
      />,
    );
    expect(screen.getByTestId('screen-subtitle')).toHaveTextContent('Settings for Riley Member');
    expect(screen.getByTestId('settings-whose')).toHaveTextContent(
      /You’re looking at Riley Member’s settings\./,
    );
    await fireEvent.press(screen.getByTestId('settings-whose-back'));
    expect(p.onBackToYours).toHaveBeenCalled();
  });

  it('says it needs signal, and with no answer offers Try again', async () => {
    await render(<SettingsMenuBody automation={AUTOMATION} {...menuProps()} online={false} />);
    expect(
      screen.getByText('Settings needs signal. Try again when you’re back online.'),
    ).toBeTruthy();
    const p = menuProps();
    await render(
      <SettingsMenuBody
        automation={null}
        {...p}
        error="Settings needs signal. Try again when you’re back online."
      />,
    );
    await fireEvent.press(screen.getByTestId('outreach-retry'));
    expect(p.onRetry).toHaveBeenCalled();
  });

  it('opens the menu for an address with no part, as every link before the parts', () => {
    expect(phonePartOf(undefined)).toBeNull();
    expect(phonePartOf('')).toBeNull();
    expect(phonePartOf('computer')).toBeNull();
    expect(phonePartOf('linkedin')).toBe('linkedin');
    expect(phonePartOf('general')).toBe('general');
    expect(phonePartOf('team')).toBe('team');
    // The parts before these were My settings and Business settings, both on General now.
    expect(phonePartOf('mine')).toBe('general');
    expect(phonePartOf('business')).toBe('general');
  });
});

const partProps = () => ({
  error: null,
  mine: true,
  business: null,
  manages: false,
  online: true,
  onRetry: jest.fn(),
  onSaveMine: jest.fn(async (_settings: AutomationSettings): Promise<string | null> => null),
  onSaveBusiness: jest.fn(
    async (_edit: (now: OutreachSettings) => Partial<OutreachSettings>): Promise<string | null> =>
      null,
  ),
});

describe('You on the phone, saved as it’s changed', () => {
  it('saves a change by itself, saying so on the line under the page, with no toast', async () => {
    const p = partProps();
    await render(<SettingsPartBody part="general" automation={AUTOMATION} {...p} />);
    expect(screen.getByTestId('settings-general-autosaves')).toHaveTextContent(
      'Changes save as you make them.',
    );
    await fireEvent.press(screen.getByTestId('settings-my-pushes-each'));
    expect(p.onSaveMine).toHaveBeenCalledTimes(1);
    expect(p.onSaveMine).toHaveBeenLastCalledWith({ ...AUTOMATION_DEFAULTS, pushes: 'each' });
    expect(screen.getByTestId('settings-general-saved')).toHaveTextContent(
      'Saved. The extension follows it in a few seconds.',
    );
    expect(toast.show).not.toHaveBeenCalled();
    expect(screen.queryByText('Save')).toBeNull();
    // A day of the week at once too, and the voice.
    await fireEvent.press(screen.getByTestId('settings-my-day-6'));
    await fireEvent.press(screen.getByTestId('settings-my-voice-emoji'));
    expect(p.onSaveMine).toHaveBeenLastCalledWith({
      ...AUTOMATION_DEFAULTS,
      pushes: 'each',
      hours: { ...AUTOMATION_DEFAULTS.hours, days: [1, 2, 3, 4, 5, 6] },
      voice: { ...AUTOMATION_DEFAULTS.voice, emoji: true },
    });
  });

  it('saves the working hours once the stepper stops for a moment', async () => {
    jest.useFakeTimers();
    const p = partProps();
    await render(<SettingsPartBody part="general" automation={AUTOMATION} {...p} />);
    await fireEvent.press(screen.getByTestId('settings-my-start-up'));
    await fireEvent.press(screen.getByTestId('settings-my-start-up'));
    expect(screen.getByTestId('settings-my-start-value')).toHaveTextContent('11 AM');
    expect(p.onSaveMine).not.toHaveBeenCalled();
    expect(screen.getByTestId('settings-general-saving')).toHaveTextContent('Saving…');
    await act(async () => jest.advanceTimersByTime(SAVE_PAUSE_MS));
    expect(p.onSaveMine).toHaveBeenCalledTimes(1);
    expect(p.onSaveMine).toHaveBeenLastCalledWith({
      ...AUTOMATION_DEFAULTS,
      hours: { ...AUTOMATION_DEFAULTS.hours, start: 11 },
    });
    expect(screen.getByTestId('settings-general-saved')).toBeTruthy();
  });

  it('saves one at a time: a change made meanwhile goes next, from the latest', async () => {
    const p = partProps();
    let answer: (problem: string | null) => void = () => undefined;
    p.onSaveMine.mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          answer = resolve;
        }),
    );
    await render(<SettingsPartBody part="general" automation={AUTOMATION} {...p} />);
    await fireEvent.press(screen.getByTestId('settings-my-dayReport'));
    // While it saves, the next changes wait for it, and nothing is locked.
    await fireEvent.press(screen.getByTestId('settings-my-pushes-each'));
    await fireEvent.press(screen.getByTestId('settings-my-voice-split'));
    expect(p.onSaveMine).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('settings-general-saving')).toBeTruthy();
    await act(async () => answer(null));
    expect(p.onSaveMine).toHaveBeenCalledTimes(2);
    expect(p.onSaveMine).toHaveBeenLastCalledWith({
      ...AUTOMATION_DEFAULTS,
      dayReport: false,
      pushes: 'each',
      voice: { ...AUTOMATION_DEFAULTS.voice, split: false },
    });
    expect(screen.getByTestId('settings-general-saved')).toBeTruthy();
  });

  it('pushes who accepted only once switched on, off to start', async () => {
    const p = partProps();
    await render(<SettingsPartBody part="general" automation={AUTOMATION} {...p} />);
    const tick = screen.getByTestId('settings-my-acceptedPush');
    expect(tick).not.toBeChecked();
    expect(screen.getByText('When someone accepts')).toBeTruthy();
    await fireEvent.press(tick);
    expect(p.onSaveMine).toHaveBeenLastCalledWith({ ...AUTOMATION_DEFAULTS, acceptedPush: true });
  });

  it('goes back to what’s kept when a save is refused, saying why in the server’s words', async () => {
    const p = partProps();
    const refusal = 'Pick at least one day.';
    p.onSaveMine.mockResolvedValueOnce(refusal);
    await render(<SettingsPartBody part="general" automation={AUTOMATION} {...p} />);
    await fireEvent.press(screen.getByTestId('settings-my-pushes-each'));
    expect(screen.getByTestId('settings-general-problem')).toHaveTextContent(refusal);
    expect(screen.getByTestId('settings-my-pushes-each')).not.toBeChecked();
    expect(screen.getByTestId('settings-my-pushes-bundled')).toBeChecked();
    // The next change starts from what's kept, the refused one not with it.
    await fireEvent.press(screen.getByTestId('settings-my-dayReport'));
    expect(p.onSaveMine).toHaveBeenLastCalledWith({ ...AUTOMATION_DEFAULTS, dayReport: false });
  });

  it('starts again from a change saved somewhere else, unless one of its own is waiting', async () => {
    jest.useFakeTimers();
    const p = partProps();
    const { rerender } = await render(
      <SettingsPartBody part="general" automation={AUTOMATION} {...p} />,
    );
    // Saved on the web: the page shows it.
    await rerender(
      <SettingsPartBody
        part="general"
        automation={{ ...AUTOMATION, settings: { ...AUTOMATION_DEFAULTS, pushes: 'each' } }}
        {...p}
      />,
    );
    expect(screen.getByTestId('settings-my-pushes-each')).toBeChecked();
    // A stepper's change waits for its pause: another change saved elsewhere meanwhile doesn't undo it.
    await fireEvent.press(screen.getByTestId('settings-my-end-up'));
    await rerender(
      <SettingsPartBody
        part="general"
        automation={{ ...AUTOMATION, settings: { ...AUTOMATION_DEFAULTS, dayReport: false } }}
        {...p}
      />,
    );
    expect(screen.getByTestId('settings-my-end-value')).toHaveTextContent('6 PM');
    await act(async () => jest.advanceTimersByTime(SAVE_PAUSE_MS));
    expect(p.onSaveMine).toHaveBeenLastCalledWith({
      ...AUTOMATION_DEFAULTS,
      pushes: 'each',
      hours: { ...AUTOMATION_DEFAULTS.hours, end: 18 },
    });
  });

  it('needs signal: with none, every control waits and the line says why', async () => {
    const p = partProps();
    await render(
      <SettingsPartBody
        part="general"
        automation={AUTOMATION}
        {...p}
        manages
        business={{}}
        online={false}
      />,
    );
    expect(
      screen.getByText('Settings needs signal. Try again when you’re back online.'),
    ).toBeTruthy();
    for (const testID of [
      'settings-my-pushes-each',
      'settings-my-dayReport',
      'settings-my-acceptedPush',
      'settings-my-voice-emoji',
      'settings-my-day-1',
      'settings-my-start-up',
      'settings-my-start-down',
    ])
      expect(screen.getByTestId(testID)).toBeDisabled();
    await fireEvent.press(screen.getByTestId('settings-my-pushes-each'));
    expect(p.onSaveMine).not.toHaveBeenCalled();
    // Team's too.
    await render(
      <SettingsPartBody
        part="team"
        automation={AUTOMATION}
        {...p}
        manages
        business={{}}
        online={false}
      />,
    );
    for (const testID of [
      'settings-rules-sending-steps',
      'settings-contacts-everyone',
      'settings-weekly',
      'settings-morning-up',
      'settings-cancel-weeks-up',
      'settings-extension-link-save',
    ])
      expect(screen.getByTestId(testID)).toBeDisabled();
  });

  it('says who changed them, and who sets the rest for someone who isn’t an owner', async () => {
    await render(
      <SettingsPartBody
        part="general"
        automation={{ ...AUTOMATION, changedBy: 'Sam Owner' }}
        {...partProps()}
      />,
    );
    expect(screen.getByTestId('settings-changed-by')).toHaveTextContent('Changed by Sam Owner.');
    expect(screen.getByText(/An owner or admin of this business sets the choices/)).toBeTruthy();
    expect(screen.queryByText('For your team')).toBeNull();
  });

  it('points an owner or admin to Team, where the team’s say is now', async () => {
    const onTeam = jest.fn();
    await render(
      <SettingsPartBody
        part="general"
        automation={AUTOMATION}
        {...partProps()}
        manages
        business={BUSINESS}
        onTeam={onTeam}
      />,
    );
    expect(screen.queryByText('For your team')).toBeNull();
    expect(screen.getByTestId('settings-team-moved')).toHaveTextContent(/are on Team\./);
    await fireEvent.press(screen.getByTestId('settings-team-moved-open'));
    expect(onTeam).toHaveBeenCalled();
  });
});

/** The business's saved settings with LinkedIn's limits set, which For your team never changes. */
const BUSINESS = {
  contactsFromChats: 'tagged',
  weeklyReport: true,
  rules: { networkLimits: { linkedin: { friend_request: 9 } } },
};

/** What a save of the business's settings puts on what's kept now. */
const savedOn = (
  p: ReturnType<typeof partProps>,
  now: Record<string, unknown> = BUSINESS,
): Partial<OutreachSettings> => p.onSaveBusiness.mock.lastCall![0](outreachSettings(now));

describe('Team, for owners and admins', () => {
  it('lists the business’s people with their training wheels to end, and their settings to open', async () => {
    const onTheirs = jest.fn();
    const onEnd = jest.fn(async () => null);
    await render(
      <SettingsPartBody
        part="team"
        automation={AUTOMATION}
        {...partProps()}
        manages
        business={BUSINESS}
        myId={ME}
        people={{
          people: [
            {
              userId: ME,
              name: 'Dana Reyes',
              saved: true,
              sending: 'steps',
              replies: 'draft',
              wheels: false,
            },
            {
              userId: id(7),
              name: 'Riley Member',
              saved: false,
              sending: 'off',
              replies: 'draft',
              wheels: true,
            },
          ],
        }}
        wheels={{
          people: [
            {
              userId: id(7),
              name: 'Riley Member',
              platform: 'linkedin',
              wheels: { on: true, from: null, ok: 4, daysLeft: 3, edits: 0 },
            },
          ],
        }}
        onTheirs={onTheirs}
        onEndWheels={onEnd}
      />,
    );
    const [mine, theirs] = screen.getAllByTestId('settings-person');
    expect(mine).toHaveTextContent(/Dana Reyes \(you\)/);
    expect(theirs).toHaveTextContent(/Riley Member.*Hasn’t saved their own yet/);
    expect(within(theirs!).getByTestId('settings-person-wheels')).toHaveTextContent(
      /Training wheels on LinkedIn · 4 of 25 OK’d · 3 days to go/,
    );
    await fireEvent.press(within(theirs!).getByTestId('settings-person-wheels-end'));
    expect(onEnd).toHaveBeenCalledWith(id(7), 'linkedin');
    await fireEvent.press(within(theirs!).getByTestId('settings-person-open'));
    expect(onTheirs).toHaveBeenCalledWith(id(7));
    // Each network's say for everyone, in one place.
    expect(screen.getByTestId('settings-team-networks')).toHaveTextContent(
      /Each network, for everyone/,
    );
  });

  it('saves the business’s settings as they’re changed, keeping each network’s own', async () => {
    jest.useFakeTimers();
    const p = partProps();
    await render(
      <SettingsPartBody part="team" automation={AUTOMATION} {...p} manages business={BUSINESS} />,
    );
    expect(screen.getByText('For your team')).toBeTruthy();
    expect(screen.getAllByText('Owners and admins').length).toBeGreaterThan(0);
    expect(screen.queryByText(/An owner or admin of this business sets/)).toBeNull();
    await fireEvent.press(screen.getByTestId('settings-contacts-everyone'));
    expect(p.onSaveBusiness).toHaveBeenCalledTimes(1);
    expect(savedOn(p)).toMatchObject({ contactsFromChats: 'everyone', weeklyReport: true });
    expect(screen.getByTestId('settings-team-saved')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('settings-rules-sending-everything'));
    // LinkedIn's limits, set on its own page, stay as they're kept.
    expect(savedOn(p).rules).toMatchObject({
      sendingAllowed: ['off', 'steps', 'approve_all'],
      networkLimits: { linkedin: { friend_request: 9 } },
    });
    // The morning push after a pause.
    await fireEvent.press(screen.getByTestId('settings-morning-down'));
    expect(p.onSaveBusiness).toHaveBeenCalledTimes(2);
    await act(async () => jest.advanceTimersByTime(SAVE_PAUSE_MS));
    expect(p.onSaveBusiness).toHaveBeenCalledTimes(3);
    expect(savedOn(p)).toMatchObject({ morningPushHour: 7, contactsFromChats: 'everyone' });
    await fireEvent.press(screen.getByTestId('settings-weekly'));
    expect(savedOn(p)).toMatchObject({ weeklyReport: false });
  });

  it('folds where a new person starts to a line, and saves a change to it', async () => {
    const p = partProps();
    await render(
      <SettingsPartBody part="team" automation={AUTOMATION} {...p} manages business={BUSINESS} />,
    );
    expect(screen.getByText('You do everything · Every reply waits for you')).toBeTruthy();
    expect(screen.queryByTestId('settings-defaults-sending-steps')).toBeNull();
    await fireEvent.press(screen.getByTestId('settings-defaults-open'));
    await fireEvent.press(screen.getByTestId('settings-defaults-sending-steps'));
    expect(savedOn(p).rules?.defaults).toEqual({ ...AUTOMATION_DEFAULTS, sending: 'steps' });
  });

  it('goes back when the business’s save is refused, with the server’s words', async () => {
    const p = partProps();
    p.onSaveBusiness.mockResolvedValueOnce('Only owners and admins change these.');
    await render(
      <SettingsPartBody part="team" automation={AUTOMATION} {...p} manages business={BUSINESS} />,
    );
    await fireEvent.press(screen.getByTestId('settings-weekly'));
    expect(screen.getByTestId('settings-team-problem')).toHaveTextContent(
      'Only owners and admins change these.',
    );
    expect(screen.getByTestId('settings-weekly')).toBeChecked();
  });

  it('sets where the team gets the extension with its own button, checked as the save checks it', async () => {
    const p = partProps();
    await render(
      <SettingsPartBody
        part="team"
        automation={AUTOMATION}
        {...p}
        manages
        business={{ ...BUSINESS, extensionLink: 'http://old.example.test/x.zip' }}
      />,
    );
    const part = screen.getByTestId('settings-extension-link');
    expect(within(part).getByText('Where your team gets the extension')).toBeTruthy();
    // A stored link that stopped passing reads as none.
    expect(screen.getByTestId('settings-extension-link-input').props.value).toBe('');
    // Typing isn't saved at each letter.
    await fireEvent.changeText(
      screen.getByTestId('settings-extension-link-input'),
      'http://files.example.test/social.zip',
    );
    expect(p.onSaveBusiness).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('settings-extension-link-save'));
    expect(screen.getByTestId('settings-extension-link-problem')).toHaveTextContent(
      'That isn’t a whole link starting https://. Paste the https link to the extension’s zip.',
    );
    expect(p.onSaveBusiness).not.toHaveBeenCalled();
    await fireEvent.changeText(
      screen.getByTestId('settings-extension-link-input'),
      ' https://files.example.test/social.zip ',
    );
    await fireEvent.press(screen.getByTestId('settings-extension-link-save'));
    expect(savedOn(p)).toEqual({ extensionLink: 'https://files.example.test/social.zip' });
    expect(screen.getByTestId('settings-extension-link-saved')).toHaveTextContent(
      'Saved. Everyone’s setup shows the link.',
    );
  });
});
