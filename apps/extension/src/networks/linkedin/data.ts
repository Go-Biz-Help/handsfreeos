/**
 * LinkedIn's copy of the person's data (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "LinkedIn, part by part";
 * core's `ASK_KINDS_ON.linkedin`): the steps the extension takes on LinkedIn's own **Get a copy of your data** page,
 * in its Settings under Data privacy, in a tab the person can see, once they ask from HandsFreeOS. It asks for the
 * archive with their connections, invitations and messages (and their profile, whose name tells their own messages
 * from the other person's), and downloads it once it's ready. It never types: LinkedIn asks for their password before
 * it makes the archive, and they type it themselves.
 *
 * The steps are Facebook's way of finding and pressing (../facebook/fetch.ts), by LinkedIn's words on the page and its
 * roles and labels, never its class names; a step it can't find goes to the person ("Press Request archive"). It
 * presses only on this page (`dataPage`). Reading the zip is core's (@hfos/core/addons/outreach/linkedin-export).
 */
import type { FetchPlan, FetchStep } from '../facebook/fetch';

/** Get a copy of your data. */
export const DATA_PAGE = 'https://www.linkedin.com/mypreferences/d/download-my-data';

/** Whether an address is LinkedIn's Get a copy of your data, the only page the extension gets the file on. */
export function dataPage(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'www.linkedin.com') return false;
  // Its address now, and the one its settings had before.
  return /^\/(mypreferences\/d\/download-my-data|psettings\/member-data)(\/|$)/i.test(url.pathname);
}

/** What the page says while LinkedIn makes the archive: one asked for already, or the one just asked for. */
export const PREPARING = [
  'being prepared',
  'preparing your archive',
  'preparing your data',
  'request is in progress',
] as const;

const press = (words: readonly string[], says: string, more: Partial<FetchStep> = {}) =>
  ({ action: 'press', words, says, ...more }) as const satisfies FetchStep;

/** Asking for the archive, and downloading it when it's ready. */
export const LINKEDIN_FILE_PLANS: Readonly<Record<'request' | 'download', FetchPlan>> = {
  request: {
    job: 'request',
    url: DATA_PAGE,
    mode: 'steps',
    steps: [
      {
        action: 'stopIf',
        words: PREPARING,
        optional: true,
        says: 'LinkedIn is already making your copy. It emails you when it’s ready; then ask for Download my file.',
      },
      {
        action: 'pick',
        words: ['Want something in particular', 'Select the data files'],
        anywhere: true,
        says: 'Pick “Want something in particular?”.',
      },
      { action: 'tick', words: ['Connections'], exact: true, says: 'Tick “Connections”.' },
      { action: 'tick', words: ['Invitations'], exact: true, says: 'Tick “Invitations”.' },
      { action: 'tick', words: ['Messages'], exact: true, says: 'Tick “Messages”.' },
      {
        action: 'tick',
        words: ['Profile'],
        exact: true,
        optional: true,
        says: 'Tick “Profile”.',
      },
      press(['Request archive'], 'Press “Request archive”.', { exact: true, buttonsOnly: true }),
      {
        action: 'waitFor',
        words: PREPARING,
        says: 'If LinkedIn asks for your password, type it and press Done.',
      },
    ],
  },
  download: {
    job: 'download',
    url: DATA_PAGE,
    mode: 'steps',
    steps: [
      {
        action: 'stopIf',
        words: PREPARING,
        optional: true,
        says: 'LinkedIn is still making your copy. It emails you when it’s ready; then ask for Download my file again.',
      },
      press(['Download archive'], 'Press “Download archive”.', { exact: true }),
    ],
  },
};

/** Whether LinkedIn shows a password box: asked of the tab while it waits for the download to start. */
export const PASSWORD_CHECK: FetchStep = {
  action: 'waitFor',
  words: [],
  says: 'If LinkedIn asks for your password, type it and press Done.',
};

/**
 * LinkedIn's words on the way to the file, which its page outline (./outline.ts) shows rather than hides, so an
 * outline of a step it couldn't find says what the page calls things.
 */
export const DATA_WORDS: ReadonlySet<string> = new Set(
  [
    ...Object.values(LINKEDIN_FILE_PLANS).flatMap((plan) => plan.steps.flatMap((s) => s.words)),
    'Get a copy of your data',
    'Download your data',
    'Data privacy',
    'Want something in particular? Select the data files you’re most interested in.',
    "Want something in particular? Select the data files you're most interested in.",
    'Articles',
    'Imported Contacts',
    'Recommendations',
    'Registration',
    'Rich Media',
    'Learning',
    'Enter your password',
    'Password',
    'Done',
    'Cancel',
  ].map((word) => word.toLowerCase()),
);
