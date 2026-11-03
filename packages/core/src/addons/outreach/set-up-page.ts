/**
 * Social Outreach's Set up page (docs/outreach.md, decision 129): how far the setup has come, each step opening the
 * setup itself, and each network's Get ready. It's first in the side menu, and on the phone's first screen, with how
 * many steps are done ("6 of 9") while anything's left and the reminder isn't hidden; then it's gone from there, and
 * Settings → You opens it. Today points to it while the person isn't ready on the network shown.
 *
 * Browser-safe and pure.
 */
import { adviceLeft, holdingCount, type ReadyItem, type ReadyState } from './readiness';
import { doneOf, setupStops, type SetupLaidOut } from './setup';

/** How far the whole setup has come: every step but the optional video, the main ones and each network's. */
export function setupDoneOf(got: SetupLaidOut): { done: number; of: number } {
  return doneOf(setupStops(got).filter((s) => !s.optional));
}

/**
 * Whether Set up is in the menu: something's left (`next`), and the reminder shows (`banner`: not hidden, and they
 * started the setup or never saved their own settings, so someone who has used it for weeks isn't reminded).
 */
export const setUpInMenu = (s: { readonly banner: boolean; readonly next: unknown }): boolean =>
  s.banner && s.next !== null;

/** What Today says of Get ready on the network shown, with Set up a press away: null when there's nothing to say. */
export function todayReadyWords(
  network: string,
  ready: boolean,
  items: readonly { readonly item: ReadyItem; readonly state: ReadyState }[],
): string | null {
  if (!ready) {
    const { done, of } = holdingCount(items);
    return SET_UP_PAGE_WORDS.todayNotReady(network, of - done);
  }
  return adviceLeft(items).length ? SET_UP_PAGE_WORDS.todayAdvice(network) : null;
}

export const SET_UP_PAGE_WORDS = {
  /** Beside Set up in the menu. */
  menuCount: (done: number, of: number) => `${done} of ${of}`,
  menuCountLabel: (done: number, of: number) => `${done} of ${of} setup steps done`,
  stepsTitle: 'The setup',
  stepsAbout: 'Each step where it stands. Press one to open it.',
  allDone: 'Everything’s set up.',
  getReadyTitle: 'Get ready on each network',
  getReadyAbout:
    'What’s left before the extension reaches anyone there: your messages and your goal, and your profile, which never holds your day.',
  readyOn: (network: string) => `You’re ready on ${network}.`,
  noNetworks: 'Turn a network on in Settings, and its Get ready shows here.',
  /** On Today, while the network shown holds the day. */
  todayNotReady: (network: string, left: number) =>
    left === 1
      ? `1 thing to do before the extension reaches anyone on ${network}.`
      : `${left} things to do before the extension reaches anyone on ${network}.`,
  /** On Today, once nothing holds the day and the profile there is left. */
  todayAdvice: (network: string) =>
    `Your ${network} profile is still worth finishing: people look at it before they answer.`,
  todayOpen: 'Open Set up',
  /** On Settings → You, which opens Set up once it's gone from the menu. */
  settingsAbout: 'How far the setup has come, and Get ready on each network.',
  settingsOpen: 'Open Set up',
} as const;
