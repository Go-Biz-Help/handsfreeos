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
 * the boxes around things. It works only on the download pages (`fetchPage`), and never presses anything else; the
 * same way of finding and pressing serves cancelling requests and unfriending on profiles the person ticked (./tidy.ts).
 */
import { clean, isAfter, textPieces } from './dom';

/**
 * What a step does: press a button, link or menu row; tick a box that isn't ticked, or untick one that is; pick one of
 * a few choices; or, when the page says one of the words, stop there, as there's nothing to do (a file already asked
 * for).
 */
export type FetchAction = 'press' | 'tick' | 'untick' | 'pick' | 'stopIf';

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
  /** Press every one there is: Facebook's "Clear all", once for each part of the list. */
  readonly every?: boolean;
  /** Only a button, never a link or a tab: a profile's Friends button, not its Friends tab. */
  readonly buttonsOnly?: boolean;
  /** Only in a box Facebook shows over the page (a menu or a dialog), never on the page itself. */
  readonly inBox?: boolean;
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
  /** After a path, steps in order on the page it led to: the chat backup's own page, whose choices are all there at once. */
  readonly then?: readonly FetchStep[];
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
      {
        action: 'stopIf',
        words: ['Your information is being prepared'],
        optional: true,
        says: 'Facebook is already making your file. It emails you when it’s ready; then press Download my file.',
      },
      press(
        [
          'Create export',
          'Export your information',
          'Download or transfer information',
          'Download your information',
        ],
        'Press “Create export”.',
      ),
      press(['Facebook'], 'Press your Facebook profile.', { anywhere: true, optional: true }),
      press(['Export to device', 'Download to device'], 'Press “Export to device”.', {
        optional: true,
      }),
      press(
        [
          'Customize information',
          'Some of your information',
          'Specific types of information',
          'Select types of information',
        ],
        'Press “Customize information”.',
      ),
      press(['Clear all'], 'Press “Clear all” in each part of the list.', {
        exact: true,
        every: true,
        optional: true,
      }),
      { action: 'tick', words: ['Messages'], says: 'Tick “Messages”.' },
      {
        action: 'tick',
        words: ['Friends', 'Friends and followers'],
        exact: true,
        says: 'Tick “Friends”.',
      },
      {
        action: 'tick',
        words: ['Followers'],
        exact: true,
        optional: true,
        says: 'Tick “Followers”.',
      },
      press(SAVE, 'Press “Save”.', { exact: true }),
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
      press(['Media quality'], 'Set “Media quality” to “Lower quality”.', { optional: true }),
      {
        action: 'pick',
        words: ['Lower quality', 'Low'],
        afterPrevious: true,
        says: 'Pick “Lower quality”, then press “Save”.',
      },
      press(SAVE, 'Press “Save”.', { optional: true, afterPrevious: true, exact: true }),
      press(['Start export', 'Create files', 'Create export'], 'Press “Start export”.', {
        exact: true,
      }),
    ],
  },
  download: {
    job: 'download',
    url: DOWNLOAD_PAGE,
    mode: 'steps',
    steps: [
      press(
        ['Current activity', 'Available downloads', 'Available files'],
        'Open “Current activity”.',
        { optional: true },
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
        ['Download message storage data', 'Download secure storage data'],
        'Press “Download message storage data”.',
      ),
    ],
    then: [
      {
        action: 'pick',
        words: ['All time', 'From account creation'],
        says: 'Pick “All time”.',
      },
      { action: 'untick', words: ['Media'], exact: true, optional: true, says: 'Untick “Media”.' },
      press(['Download file', 'Download'], 'Press “Download file”.', { exact: true }),
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

/**
 * Whether an address is one of the download pages, the only ones the extension gets the file on. (It presses Cancel
 * request and Unfriend only on the profiles the person ticked: ./tidy.ts.)
 */
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
    return /^\/(messages|dyi|download|secure_storage)(\/|$)/.test(url.pathname);
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
const BUTTONS = 'button, [role="button"]';
const TICKS = 'input[type="checkbox"], [role="checkbox"], [role="switch"]';
const PICKS =
  'input[type="radio"], [role="radio"], [role="menuitemradio"], [role="option"], [role="menuitem"]';
/** Where a box's words are when it has none of its own: the row it's in. */
const ROWS = 'label, [role="listitem"], [role="row"], [role="option"], li';

/** Shown to the person: not hidden from screen readers, not hidden, not turned off. */
export function shown(element: Element): boolean {
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
  // Word by word, so a row's name and the line under it ("End-to-end encrypted chats" "Manage your…") stay apart.
  if (forIt) return clean(textPieces(forIt).join(' '));
  return clean(textPieces(element).join(' '));
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
 * Where to look, in order: the box on top when Facebook shows one (the last dialog or menu drawn), then any other menu
 * still open, as a menu's own menu (Privacy & safety's, say) isn't always drawn after it; else the whole page. Never
 * behind a dialog or menu on the page itself: a step that isn't in one is handed to the person rather than pressed on
 * the page underneath.
 */
function placesOf(doc: Document): Element[] {
  const over = [...doc.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"]')].filter(
    shown,
  );
  const top = over.at(-1);
  if (!top) return [doc.body];
  const menus = over.filter((box) => box !== top && box.getAttribute('role') === 'menu');
  return [top, ...menus.reverse()];
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

/** The elements a step would act on, the best fitting first; none when it isn't on the page. */
function candidatesFor(doc: Document, step: FetchStep): Element[] {
  const selector =
    step.action === 'press'
      ? step.buttonsOnly
        ? BUTTONS
        : PRESSES
      : step.action === 'pick'
        ? PICKS
        : TICKS;
  const name = step.action === 'press' ? nameOf : boxName;
  const places = placesOf(doc).filter((place) => !step.inBox || place !== doc.body);
  if (!places.length) return [];
  for (const place of places) {
    const candidates = [...place.querySelectorAll(selector)].filter(shown);
    for (const word of step.words) {
      const fits = candidates
        .map((element) => ({ element, fit: fit(name(element), word, step) }))
        .filter((c) => c.fit > 0);
      if (fits.length === 0) continue;
      const best = Math.max(...fits.map((c) => c.fit));
      return fits.filter((c) => c.fit === best).map((c) => c.element);
    }
  }
  const beside = step.beside ? besideHeading(places[0]!, step.beside) : null;
  return beside ? [beside] : [];
}

/** The element a step would act on, or null when it isn't on the page. The likeliest words win. */
export function findStep(doc: Document, step: FetchStep): Element | null {
  if (step.action === 'stopIf') return null;
  return candidatesFor(doc, step)[0] ?? null;
}

/** Whether the box on top (or the page) says one of the words. */
function says(doc: Document, words: readonly string[]): boolean {
  const text = clean(textPieces(placesOf(doc)[0]!).join(' ')).toLowerCase();
  return words.some((word) => text.includes(word.toLowerCase()));
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
  | 'waiting'
  /** The page says there's nothing to do: a `stopIf` step's words are there. */
  | 'stop';

/** Does one step on the page, when its button or box is there. */
export function doStep(doc: Document, step: FetchStep): StepResult {
  if (step.action === 'stopIf') return says(doc, step.words) ? 'stop' : 'missing';
  const found = candidatesFor(doc, step);
  const element = found[0];
  if (!element) return waitingForPerson(doc) ? 'waiting' : 'missing';
  if (step.action === 'untick') {
    if (!chosen(element)) return 'already';
  } else if (step.action !== 'press' && chosen(element)) return 'already';
  for (const each of step.every ? found : [element]) (each as HTMLElement).click();
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
