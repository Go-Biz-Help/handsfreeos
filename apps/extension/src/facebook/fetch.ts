/**
 * Getting Facebook's download file for the person (docs/outreach.md, decision 16): the buttons the extension presses
 * on Facebook's own download pages, in a tab the person can see, once they press **Get my Facebook file** in the
 * panel. It asks Facebook for the file, downloads it when it's ready, and gets the chat backup. It never types:
 * Facebook asks for the person's password before it hands the file over, and for their PIN for the chat backup, and
 * the person types those themselves.
 *
 * Facebook draws these pages differently for different accounts and changes their words, so each step lists the words
 * it may go by, and a step it can't find is handed to the person ("Press Create files"), who presses it and lets the
 * panel carry on. Like the readers, it goes by roles, labels and Facebook's own words, never class names, and never by
 * the boxes around things. It works only on the download pages (`fetchPage`), and never presses anything else.
 */
import { clean, isAfter, textPieces } from './dom';

/** What a step does: press a button, link or menu row; tick a box that isn't ticked; or pick one of a few choices. */
export type FetchAction = 'press' | 'tick' | 'pick';

export interface FetchStep {
  readonly action: FetchAction;
  /** The words it goes by, the likeliest first: a label that's one of them, or starts with one ("Format JSON"). */
  readonly words: readonly string[];
  /** For the person, when they're to do it themselves. */
  readonly says: string;
  /** Left out when it isn't there: a screen some accounts don't get. */
  readonly optional?: boolean;
  /** Done only when the step before it was: the Next after ticking a profile, the Save after picking JSON. */
  readonly afterPrevious?: boolean;
  /** Only a label that's exactly one of the words, not one that starts with it ("Download", not "Download file"). */
  readonly exact?: boolean;
  /** Its row says one of the words somewhere: the Facebook profile among the accounts to download from. */
  readonly anywhere?: boolean;
  /**
   * Else the button that opens a menu next to a heading with one of these words: the ⋯ beside Chats, whose label
   * isn't the same on every account.
   */
  readonly beside?: readonly string[];
}

/**
 * The three jobs. `steps` go in order; a `path` is a way through menus that differ from one account to the next, so
 * each time the furthest step along that's on the page is pressed, and the ones before it are skipped.
 */
export type FetchJob = 'request' | 'download' | 'backup';

export interface FetchPlan {
  readonly job: FetchJob;
  /** Where it starts. */
  readonly url: string;
  readonly mode: 'steps' | 'path';
  readonly steps: readonly FetchStep[];
}

/** Accounts Center's "Download your information", where the file is asked for and downloaded. */
export const DOWNLOAD_PAGE = 'https://accountscenter.facebook.com/info_and_permissions/dyi/';
/** The chats, whose settings hold the chat backup. */
export const CHATS_PAGE = 'https://www.facebook.com/messages/';

const press = (words: readonly string[], says: string, more: Partial<FetchStep> = {}) =>
  ({ action: 'press', words, says, ...more }) as const satisfies FetchStep;
const SAVE = ['Save', 'Done', 'Confirm'];

export const FETCH_PLANS: Readonly<Record<FetchJob, FetchPlan>> = {
  request: {
    job: 'request',
    url: DOWNLOAD_PAGE,
    mode: 'steps',
    steps: [
      press(
        [
          'Download or transfer information',
          'Export your information',
          'Create export',
          'Download your information',
        ],
        'Press “Download or transfer information”.',
      ),
      {
        action: 'tick',
        words: ['Facebook'],
        anywhere: true,
        optional: true,
        says: 'Tick your Facebook profile.',
      },
      press(['Next'], 'Press “Next”.', { optional: true, afterPrevious: true }),
      press(
        [
          'Some of your information',
          'Specific types of information',
          'Select types of information',
          'Choose types of information',
        ],
        'Press “Some of your information”.',
      ),
      {
        action: 'tick',
        words: ['Friends and followers', 'Friends'],
        says: 'Tick “Friends and followers”.',
      },
      { action: 'tick', words: ['Messages'], says: 'Tick “Messages”.' },
      press(['Next'], 'Press “Next”.'),
      press(['Download to device'], 'Press “Download to device”.', { optional: true }),
      press(['Next'], 'Press “Next”.', { optional: true, afterPrevious: true }),
      press(['Date range'], 'Set “Date range” to “All time”.', { optional: true }),
      {
        action: 'pick',
        words: ['All time'],
        afterPrevious: true,
        says: 'Pick “All time”, then press “Save”.',
      },
      press(SAVE, 'Press “Save”.', { optional: true, afterPrevious: true, exact: true }),
      press(['Format'], 'Set “Format” to “JSON”.'),
      {
        action: 'pick',
        words: ['JSON'],
        afterPrevious: true,
        says: 'Pick “JSON”, then press “Save”.',
      },
      press(SAVE, 'Press “Save”.', { optional: true, afterPrevious: true, exact: true }),
      press(['Media quality'], 'Set “Media quality” to “Low”.', { optional: true }),
      {
        action: 'pick',
        words: ['Low', 'Lower quality'],
        afterPrevious: true,
        says: 'Pick “Low”, then press “Save”.',
      },
      press(SAVE, 'Press “Save”.', { optional: true, afterPrevious: true, exact: true }),
      press(
        ['Create files', 'Start export', 'Create export', 'Submit request'],
        'Press “Create files”.',
        {
          exact: true,
        },
      ),
    ],
  },
  download: {
    job: 'download',
    url: DOWNLOAD_PAGE,
    mode: 'steps',
    steps: [
      press(
        ['Available downloads', 'Available files', 'Available exports'],
        'Open “Available files”.',
        {
          optional: true,
        },
      ),
      press(['Download'], 'Press “Download” beside your file.', { exact: true }),
    ],
  },
  backup: {
    job: 'backup',
    url: CHATS_PAGE,
    mode: 'path',
    steps: [
      press(
        ['Settings, help and more', 'Options', 'Chat settings', 'Messenger settings'],
        'Press the ⋯ button next to Chats.',
        { exact: true, beside: ['Chats'] },
      ),
      press(['Privacy & safety', 'Privacy and safety'], 'Press “Privacy & safety”.'),
      press(['End-to-end encrypted chats'], 'Press “End-to-end encrypted chats”.'),
      press(['Message storage', 'Chat history'], 'Press “Message storage”.'),
      press(
        ['Download secure storage data', 'Last backup'],
        'Press “Download secure storage data”.',
      ),
      press(['Download chat backup', 'Download file'], 'Press “Download file”.'),
      press(['Download'], 'Press “Download”.', { exact: true }),
    ],
  },
};

/**
 * Facebook's words on the way to the file, which the page outline (./outline.ts) shows rather than hides, so an
 * outline of a step it couldn't find says what the buttons there are called: each plan's words, and the rest of the
 * chats' settings menu.
 */
export const FETCH_WORDS: ReadonlySet<string> = new Set(
  [
    ...Object.values(FETCH_PLANS).flatMap((plan) => plan.steps.flatMap((step) => step.words)),
    'Preferences',
    'Message requests',
    'Archived chats',
    'Restricted accounts',
    'Blocked accounts',
    'Help',
    'Who can message you',
    'Message delivery',
    'Read receipts',
    'Active status',
    'End-to-end encryption',
    'Secure storage',
    'Logins',
    'Security alerts',
    'Turn off secure storage',
    'Reset PIN',
    'Change PIN',
    'Your information',
    'Export your information',
  ].map((word) => word.toLowerCase()),
);

/** Whether an address is one of the download pages, the only ones the extension presses anything on. */
export function fetchPage(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (host === 'accountscenter.facebook.com')
    return url.pathname.startsWith('/info_and_permissions');
  if (host === 'www.facebook.com' || host === 'web.facebook.com')
    return /^\/(messages|dyi|download)(\/|$)/.test(url.pathname);
  return false;
}

// ---- Finding what a step goes by ----

const PRESSES = [
  'button',
  'a[href]',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="option"]',
  '[role="listitem"][tabindex]',
].join(', ');
const TICKS = 'input[type="checkbox"], [role="checkbox"], [role="switch"]';
const PICKS =
  'input[type="radio"], [role="radio"], [role="menuitemradio"], [role="option"], [role="menuitem"]';
/** Where a box's words are when it has none of its own: the row it's in. */
const ROWS = 'label, [role="listitem"], [role="row"], [role="option"], li';

/** Shown to the person: not hidden from screen readers, not hidden, not turned off. */
function shown(element: Element): boolean {
  if (element.closest('[aria-hidden="true"], [hidden], [inert]')) return false;
  if (element.getAttribute('aria-disabled') === 'true' || element.hasAttribute('disabled'))
    return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return !style || (style.display !== 'none' && style.visibility !== 'hidden');
}

/** What an element is called: its label for screen readers, what labels it, or its own text. */
function nameOf(element: Element): string {
  const label = clean(element.getAttribute('aria-label'));
  if (label) return label;
  const doc = element.ownerDocument;
  const by = (element.getAttribute('aria-labelledby') ?? '')
    .split(/\s+/)
    .map((id) => (id ? clean(doc.getElementById(id)?.textContent) : ''))
    .filter(Boolean)
    .join(' ');
  if (by) return by;
  const id = element.getAttribute('id');
  const forIt = id
    ? [...doc.querySelectorAll('label[for]')].find((l) => l.getAttribute('for') === id)
    : null;
  if (forIt) return clean(forIt.textContent);
  return clean(element.textContent);
}

/** A box's words: its own, or else its row's. */
function boxName(element: Element): string {
  const row = element.closest(ROWS);
  return nameOf(element) || (row ? clean(textPieces(row).join(' ')) : '');
}

/** How well a name fits one of the words: 2 exactly, 1 starting with it, 0 not at all. */
function fit(name: string, word: string, step: FetchStep): number {
  const a = name.toLowerCase();
  const b = word.toLowerCase();
  if (a === b) return 2;
  if (step.exact) return 0;
  if (a.startsWith(b) && /^[\s:,.·–—-]/.test(a.slice(b.length))) return 1;
  if (step.anywhere && new RegExp(`\\b${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(a))
    return 1;
  return 0;
}

/**
 * Where to look: the box on top when Facebook shows one (the last dialog or menu drawn), else the whole page. Never
 * behind the box: a step that isn't in it is handed to the person rather than pressed on the page underneath.
 */
function placeOf(doc: Document): Element {
  const over = [...doc.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"]')].filter(
    shown,
  );
  return over.at(-1) ?? doc.body;
}

/**
 * The button that opens a menu next to a heading with one of the words: the first one after the heading, in the
 * nearest box around the heading that has one.
 */
function besideHeading(place: Element, headings: readonly string[]): Element | null {
  const wanted = headings.map((h) => h.toLowerCase());
  const found = [...place.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')].filter(
    (h) => shown(h) && wanted.includes(clean(h.textContent).toLowerCase()),
  );
  for (const heading of found) {
    let box = heading.parentElement;
    for (let up = 0; box && up < 8 && place.contains(box); up++, box = box.parentElement) {
      const opener = [...box.querySelectorAll('[aria-expanded], [aria-haspopup]')].find(
        (element) => element.matches(PRESSES) && shown(element) && isAfter(element, heading),
      );
      if (opener) return opener;
    }
  }
  return null;
}

/** The element a step would act on, or null when it isn't on the page. The likeliest words win. */
export function findStep(doc: Document, step: FetchStep): Element | null {
  const selector = step.action === 'press' ? PRESSES : step.action === 'tick' ? TICKS : PICKS;
  const name = step.action === 'press' ? nameOf : boxName;
  const place = placeOf(doc);
  const candidates = [...place.querySelectorAll(selector)].filter(shown);
  for (const word of step.words) {
    let best: Element | null = null;
    let bestFit = 0;
    for (const element of candidates) {
      const f = fit(name(element), word, step);
      if (f > bestFit) {
        best = element;
        bestFit = f;
        if (f === 2) break;
      }
    }
    if (best) return best;
  }
  return step.beside ? besideHeading(place, step.beside) : null;
}

/** Whether a box is ticked, or a choice picked, already. */
function chosen(element: Element): boolean {
  if (element instanceof element.ownerDocument.defaultView!.HTMLInputElement)
    return element.checked;
  return (
    element.getAttribute('aria-checked') === 'true' ||
    element.getAttribute('aria-selected') === 'true'
  );
}

/**
 * Whether Facebook is waiting for the person to type: a password, a PIN, or a code it sent. The extension never
 * types these, so the step waits for the person.
 */
export function waitingForPerson(doc: Document): boolean {
  return [
    ...doc.querySelectorAll(
      'input[type="password"], input[autocomplete="one-time-code"], input[inputmode="numeric"]',
    ),
  ].some(shown);
}

export type StepResult =
  /** Pressed, ticked or picked. */
  | 'done'
  /** Ticked or picked already, so left as it was. */
  | 'already'
  /** Not on the page. */
  | 'missing'
  /** Not on the page, and Facebook is asking the person to type something first. */
  | 'waiting';

/** Does one step on the page, when its button or box is there. */
export function doStep(doc: Document, step: FetchStep): StepResult {
  const element = findStep(doc, step);
  if (!element) return waitingForPerson(doc) ? 'waiting' : 'missing';
  if (step.action !== 'press' && chosen(element)) return 'already';
  (element as HTMLElement).click();
  return 'done';
}

/**
 * Along a path, the furthest step from `from` on that's on the page, pressed: its place in the path, or what's
 * keeping it from going on.
 */
export function doPath(
  doc: Document,
  steps: readonly FetchStep[],
  from: number,
): { readonly at: number } | { readonly result: 'missing' | 'waiting' } {
  for (let i = steps.length - 1; i >= from; i--) {
    const element = findStep(doc, steps[i]!);
    if (!element) continue;
    (element as HTMLElement).click();
    return { at: i };
  }
  return { result: waitingForPerson(doc) ? 'waiting' : 'missing' };
}
