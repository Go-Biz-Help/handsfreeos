/**
 * Microphone trouble in a call (docs/video-calls.md, "Microphone trouble"): why a microphone (or camera) didn't
 * start, in words someone can act on, with the steps for their own browser and device; what everyone else in the call
 * sees about it; and the two little judges the web's call screen runs on the microphone's sound (talking while muted,
 * and a microphone that sends nothing at all). Browser-safe and light: the web's call screens and the phone app read it.
 */

/** What didn't start. */
export type MediaKind = 'camera' | 'microphone';

/**
 * Why a camera or microphone didn't start:
 * - `blocked`: the browser said no for this page (someone pressed Block, or it was blocked before);
 * - `system`: the computer itself keeps the browser from it (a Mac's or Windows's privacy settings);
 * - `missing`: there's no such device (unplugged, or the one picked last time is gone);
 * - `busy`: the device is there but won't start, mostly because another app holds it;
 * - `failed`: anything else.
 */
export type MediaTrouble = 'blocked' | 'system' | 'missing' | 'busy' | 'failed';

function said(error: unknown): { name: string; message: string } {
  if (error && typeof error === 'object') {
    const e = error as { name?: unknown; message?: unknown };
    return { name: String(e.name ?? ''), message: String(e.message ?? '') };
  }
  return { name: '', message: String(error ?? '') };
}

/** Which trouble a browser's (or LiveKit's) error is, from its name and, for the computer's own block, its words. */
export function mediaTroubleOf(error: unknown): MediaTrouble {
  const { name, message } = said(error);
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError')
    // Chrome and Edge say "Permission denied by system" when a Mac's or Windows's privacy settings block the browser.
    return /system/i.test(message) ? 'system' : 'blocked';
  if (
    name === 'NotFoundError' ||
    name === 'DevicesNotFoundError' ||
    name === 'OverconstrainedError'
  )
    return 'missing';
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError')
    return 'busy';
  // LiveKit's own words when the browser had already said no (a microphone that ended and couldn't come back).
  if (/permission denied/i.test(message)) return /system/i.test(message) ? 'system' : 'blocked';
  return 'failed';
}

/** The computer or phone, and the browser on it, so the steps are the ones they'll see. */
export interface CallDevice {
  readonly os: 'ios' | 'android' | 'mac' | 'windows' | 'other';
  readonly browser: 'safari' | 'chrome' | 'edge' | 'firefox' | 'samsung' | 'other';
}

/**
 * The device from the browser's user agent. An iPad says it's a Mac, so a "Mac" with a touch screen
 * (`maxTouchPoints` above 1) is taken as an iPad, which works like an iPhone here.
 */
export function callDeviceOf(userAgent: string | null | undefined, touchPoints = 0): CallDevice {
  const ua = userAgent ?? '';
  const ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && touchPoints > 1);
  const os: CallDevice['os'] = ios
    ? 'ios'
    : /Android/i.test(ua)
      ? 'android'
      : /Macintosh|Mac OS X/i.test(ua)
        ? 'mac'
        : /Windows/i.test(ua)
          ? 'windows'
          : 'other';
  let browser: CallDevice['browser'];
  if (/EdgiOS|EdgA|Edg\//.test(ua)) browser = 'edge';
  else if (/FxiOS|Firefox\//.test(ua)) browser = 'firefox';
  else if (/SamsungBrowser/.test(ua)) browser = 'samsung';
  else if (/CriOS|Chrome\/|Chromium\//.test(ua)) browser = 'chrome';
  else if (/Safari\//.test(ua) || (ios && /AppleWebKit/.test(ua))) browser = 'safari';
  else browser = 'other';
  return { os, browser };
}

const BROWSER_NAMES: Record<CallDevice['browser'], string> = {
  safari: 'Safari',
  chrome: 'Chrome',
  edge: 'Edge',
  firefox: 'Firefox',
  samsung: 'Samsung Internet',
  other: 'your browser',
};

/** What to call what didn't start, in a sentence ("microphone", "camera and microphone") and in a setting's name. */
function named(what: readonly MediaKind[]): { words: string; setting: string } {
  const has = (k: MediaKind) => what.includes(k);
  if (has('camera') && has('microphone'))
    return { words: 'camera and microphone', setting: 'Camera and Microphone' };
  if (has('camera')) return { words: 'camera', setting: 'Camera' };
  return { words: 'microphone', setting: 'Microphone' };
}

/** What the call screen shows about a camera or microphone that didn't start: a title, the steps, and Try again. */
export interface MediaHelp {
  readonly title: string;
  readonly steps: readonly string[];
}

function blockedSteps(device: CallDevice, setting: string): string[] {
  const app = BROWSER_NAMES[device.browser];
  if (device.os === 'ios') {
    if (device.browser === 'safari')
      return [
        'Tap aA (or the page menu) at the left of the address bar.',
        `Tap Website Settings, then set ${setting} to Allow.`,
        'Reload this page.',
      ];
    return [
      `Open your iPhone’s Settings app, find ${app === 'your browser' ? 'this browser' : app} under Apps, and turn on ${setting}.`,
      'Come back here and reload this page.',
    ];
  }
  if (device.os === 'android')
    return [
      'Tap the icon at the left of the web address.',
      `Tap Permissions, then turn on ${setting}.`,
      `Still off? Open your phone’s Settings, then Apps, ${app === 'your browser' ? 'this browser' : app}, Permissions, and allow ${setting}. Then reload this page.`,
    ];
  if (device.browser === 'safari')
    return [
      'In the menu bar at the top of the screen, click Safari, then Settings for This Website.',
      `Set ${setting} to Allow.`,
      'Reload this page.',
    ];
  if (device.browser === 'firefox')
    return [
      'Click the crossed-out icon at the left of the web address.',
      'Click the X beside Blocked to clear it.',
      'Reload this page, and choose Allow when it asks.',
    ];
  if (device.browser === 'other')
    return [
      `Open your browser’s settings for this website and allow the ${setting.toLowerCase()}.`,
      'Reload this page.',
    ];
  return [
    'Click the icon at the left of the web address (two sliders, or a lock).',
    `Turn on ${setting}, or set it to Allow.`,
    'Reload this page.',
  ];
}

function systemSteps(device: CallDevice, setting: string): string[] | null {
  const app = BROWSER_NAMES[device.browser];
  if (device.os === 'mac')
    return [
      `Click the Apple menu, then System Settings, Privacy & Security, ${setting === 'Camera and Microphone' ? 'Camera (and then Microphone)' : setting}.`,
      `Turn on ${app === 'your browser' ? 'your browser' : app}.`,
      `Quit ${app === 'your browser' ? 'your browser' : app} and open it again, then open this link again.`,
    ];
  if (device.os === 'windows')
    return [
      `Click Start, then Settings, Privacy & security, ${setting === 'Camera and Microphone' ? 'Camera (and then Microphone)' : setting}.`,
      `Turn on ${setting.toLowerCase()} access, and Let desktop apps access your ${setting.toLowerCase()}.`,
      'Reload this page.',
    ];
  return null;
}

/**
 * The help for a camera or microphone that didn't start, for this device and browser. `what` is everything that
 * didn't start for the same reason (a blocked camera and microphone are fixed in the same place).
 */
export function mediaHelp(
  trouble: MediaTrouble,
  device: CallDevice,
  what: readonly MediaKind[] = ['microphone'],
): MediaHelp {
  const { words, setting } = named(what);
  const app = BROWSER_NAMES[device.browser];
  switch (trouble) {
    case 'system': {
      const steps = systemSteps(device, setting);
      if (steps)
        return {
          title: `Your ${device.os === 'mac' ? 'Mac' : 'computer'} is keeping ${app === 'your browser' ? 'your browser' : app} from your ${words}`,
          steps,
        };
      // Only computers say so; anywhere else it's fixed where any block is.
      return {
        title: `Your browser is blocking your ${words}`,
        steps: blockedSteps(device, setting),
      };
    }
    case 'blocked':
      return {
        title: `Your browser is blocking your ${words}`,
        steps: blockedSteps(device, setting),
      };
    case 'missing':
      return {
        title: `We couldn’t find a ${words}`,
        steps: [`Plug in a ${words} or a headset, or pick another one.`, 'Press Try again.'],
      };
    case 'busy':
      return {
        title: `Your ${words} didn’t start`,
        steps: [
          `Close any other app using it, like Zoom, Teams or FaceTime, then press Try again.`,
          ...(device.os === 'windows'
            ? [
                `Still not working? Click Start, then Settings, Privacy & security, ${setting === 'Camera and Microphone' ? 'Microphone' : setting}, and turn on its access.`,
              ]
            : []),
        ],
      };
    case 'failed':
      return {
        title: `Your ${words} didn’t start`,
        steps: ['Press Try again.', 'Still not working? Reload this page.'],
      };
  }
}

/** One short line for the same trouble, where there's only room for one (a note in passing). */
export function mediaTroubleLine(trouble: MediaTrouble, what: MediaKind): string {
  switch (trouble) {
    case 'blocked':
      return `Your browser is blocking your ${what}. Press the ${what} for the steps to allow it.`;
    case 'system':
      return `Your computer is keeping your browser from your ${what}. Press the ${what} for the steps.`;
    case 'missing':
      return `We couldn’t find a ${what}. Plug one in or pick another, or join without it.`;
    case 'busy':
      return `Another app is using your ${what}. Close it, then try again, or join without it.`;
    case 'failed':
      return `Your ${what} didn’t start. Try again, or join without it.`;
  }
}

/**
 * What someone's microphone is doing that everyone else in the call should know, carried as their attribute in the
 * room (`VIDEO_CALL_ATTRIBUTES.mic`): `blocked` (their browser or computer won't let it start) or `silent` (it's on
 * and sends nothing). Set by their own page, so it's a label for the screen and nothing more.
 */
export const MIC_STATES = ['blocked', 'silent'] as const;
export type MicState = (typeof MIC_STATES)[number];

export const micStateOf = (value: string | null | undefined): MicState | null =>
  (MIC_STATES as readonly string[]).includes(value ?? '') ? (value as MicState) : null;

export const MIC_WORDS = {
  tryAgain: 'Try again',
  microphone: 'Microphone',
  speaker: 'Speaker',
  pick: 'Microphone and speaker',
  /** Beside the list: what the bar under it is. */
  levelHint: 'The bar moves when the microphone hears you.',
  noMics: 'No microphone found. Plug one in, or allow this page to use it.',
  /** The team (or the Assistant for them) muted this person. */
  mutedByTeam: 'Someone on the team muted you. Press the microphone to talk again.',
  /** The microphone ended (unplugged, or taken by the computer) and couldn't come back on its own. */
  stopped: 'Your microphone stopped. Pick one, or press the microphone to try again.',
  /** A phone (or the computer) paused the microphone, as an iPhone does for a phone call or Siri. */
  paused: 'Your microphone was paused. Press it to turn it back on.',
  talkingMuted: 'You’re muted. Press the microphone to talk.',
  silent:
    'We can’t hear anything from your microphone. Check its mute switch, or pick another one.',
  pickAnother: 'Pick a microphone',
  /** On their tile and in People, for everyone else. */
  state: { blocked: 'Mic blocked', silent: 'No sound from their mic' } satisfies Record<
    MicState,
    string
  >,
  /** What the team can do about it, in People. */
  stateHint: {
    blocked:
      'Their browser or computer is blocking their microphone. The steps to allow it are on their screen.',
    silent:
      'Their microphone is on but sends no sound. Ask them to check its mute switch or pick another one.',
  } satisfies Record<MicState, string>,
} as const;

/**
 * Talking while muted (the owner's 3a): fed the muted microphone's loudness (its RMS, 0 to 1) every so often, it says
 * when to show "You're muted": once they've been talking for a moment, and then not again for a while. Talking near
 * a computer's microphone is about 0.05 to 0.2; a quiet room is under 0.01.
 */
export const MUTED_TALK_LEVEL = 0.03;
export const MUTED_TALK_MS = 600;
export const MUTED_TALK_AGAIN_MS = 30_000;

export function mutedTalkGate(
  level = MUTED_TALK_LEVEL,
  talkMs = MUTED_TALK_MS,
  againMs = MUTED_TALK_AGAIN_MS,
) {
  let since: number | null = null;
  let told: number | null = null;
  return {
    /** A loudness heard while muted; true when it's time to say so. */
    hear(loudness: number, now: number): boolean {
      if (loudness < level) {
        since = null;
        return false;
      }
      since ??= now;
      if (now - since < talkMs) return false;
      if (told !== null && now - told < againMs) return false;
      told = now;
      since = null;
      return true;
    },
    /** They unmuted, or the microphone changed: start listening afresh. */
    reset() {
      since = null;
    },
  };
}

/**
 * A microphone that sends nothing (the owner's 4a): fed whether each moment's sound was pure silence (every sample
 * exactly zero, which no working microphone sends, however quiet the room), it says `silent` once that's gone on for
 * a while, and `sound` the moment anything comes through.
 */
export const SILENT_MIC_MS = 3_000;

export function silentMicJudge(ms = SILENT_MIC_MS) {
  let since: number | null = null;
  let silent = false;
  return {
    hear(pureSilence: boolean, now: number): 'silent' | 'sound' | null {
      if (!pureSilence) {
        since = null;
        if (!silent) return null;
        silent = false;
        return 'sound';
      }
      since ??= now;
      if (silent || now - since < ms) return null;
      silent = true;
      return 'silent';
    },
    reset() {
      since = null;
      silent = false;
    },
  };
}
