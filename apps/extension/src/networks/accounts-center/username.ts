/**
 * The person's own username, changed on Accounts Center's username page for their own profile (docs/outreach.md,
 * decision 89), for a **Put these in** they pressed in HandsFreeOS: their Facebook profile's on Facebook's Accounts
 * Center, and from 0.94.0 their Instagram profile's on Instagram's (./pages.ts). It types only the new username they
 * picked, only into the box named Username.
 *
 * - **Where:** `https://accountscenter.facebook.com/profiles/<their profile's number>/username/` (`usernameAddress`),
 *   the number from their profile's Edit profile link (../facebook/own-profile.ts `ownEditorsOf`); without it,
 *   Accounts Center's Profiles, and the link there to the Facebook one (`facebookProfileOn`). On Instagram, the same
 *   page on accountscenter.instagram.com, by the Profiles row that shows the account they're signed in to; and it types
 *   only while the Username box holds that account's username (`was`) or the new one, never another's.
 * - **The network has the last word.** It types the username, waits for the network to say whether it's available,
 *   and presses **Done** only once it allows it, then waits for it to save. Only words new since it typed count, so the
 *   page's own help ("can only contain letters…", "You can only change your username twice within 14 days") is never
 *   taken for an answer, and only words where the Username box is. Taken, not allowed, or not now: said as the network
 *   said it, and Done is never pressed.
 * - **After Done**, the network's box to be sure (**Change username** or **Confirm**) is pressed once, only when it's
 *   on top, has nowhere to type and says nothing of the other network's profile (`othersToo`: a box offering to change
 *   that one too is never pressed, and the job hands it over); never read as a refusal. It's in on the network's word
 *   that it's saved, on leaving the page, or with the Username box on top again holding it and Done off. A box over
 *   the page it doesn't know is the person's to answer, and the job hands it over.
 * - **Never a password or a code** (./pages.ts `askingHere`): it waits for the person, before it types or after Done;
 *   nothing is typed in it, and the page's warnings aren't read while it asks, as that's no warning (decision 25).
 *   Otherwise a warning stops it (`centerWarnings`), before anything else is read or pressed, and the job notes it.
 *
 * Built from Meta's usual words for this page, not yet from a page outline of it: Check Facebook sends its outline
 * (../facebook/tries.ts), so it can be tuned from the person's own.
 */
import { PLATFORMS } from '@hfos/core/addons/outreach/networks';
import { cleanUsername, usernameProblem } from '@hfos/core/addons/outreach/profile-check';
import { textLines } from '../facebook/dom';
import { buttonsIn, EDITOR_LOOK_MS, pause } from '../facebook/editors';
import { placesOf, shown, visible } from '../facebook/fetch';
import { typeInto } from '../facebook/join';
import {
  ANY_BOX,
  askedNote,
  askingHere,
  boxesLabelled,
  centerAddress,
  centerHome,
  centerPageOf,
  centerWarnings,
  doneButtons,
  freshLines,
  heldBox,
  linesOnTop,
  namesOn,
  OTHER_NETWORK,
  othersToo,
  profileRowOn,
  profilesAddress,
  valueOf,
  type Asking,
  type CenterNetwork,
} from './pages';

export {
  askedNote,
  askingHere,
  doneButtons,
  linesOnTop,
  onAccountsCenter,
  profilesPage,
  type Asking,
} from './pages';

/** Facebook's Accounts Center, and its Profiles: where the Facebook profile is picked when its number isn't known. */
export const ACCOUNTS_CENTER = centerHome('facebook');
export const ACCOUNTS_PROFILES = profilesAddress('facebook');

/** The username page for a Facebook profile, by its number; null for anything that isn't one. */
export const usernameAddress = (id: string | null | undefined): string | null =>
  centerAddress('facebook', id, 'username');

/** The number of the Facebook profile whose username page an address is, or null for any other page. */
export const usernamePageOf = (href: string): string | null =>
  centerPageOf(href, 'facebook', 'username');

/** Whether an address is a Facebook profile's username page in Accounts Center. */
export const usernamePage = (href: string): boolean => usernamePageOf(href) !== null;

/** The Facebook profile's link among Accounts Center's Profiles, as its username page: the one row that says Facebook. */
export const facebookProfileOn = (doc: Document): string | null =>
  usernameAddress(profileRowOn(doc, 'facebook'));

const USERNAME = /^username\s*\*?$/i;
/** The network's box to be sure, after Done: pressed once, only when it has no box to type in. */
const CONFIRM = /^(change username|confirm)$/i;

/** The boxes named Username in the box on top, shown: never a password's, a code's, or one beside a password. */
export const usernameBoxes = (doc: Document): HTMLElement[] =>
  boxesLabelled(doc, USERNAME).filter(shown);

/** What the network says of a username, from the lines in the box on top. */
export type UsernameVerdict = 'free' | 'taken' | 'invalid' | 'limit';

/**
 * The network won't change it now, as the page says before anything's typed: kept strict, so its help ("You can only
 * change your username twice within 14 days") is never taken for one.
 */
const LIMIT_NOW =
  /\b(can['’]?t|cannot|can not) change (your|this) username\b|\b(change|update) (your|this) username again (on|in|after)\b|\btoo many (times|changes)\b|\btry again later\b/i;
/** The same, as a new line after typing or Done says it: there, "You can only change it twice…" is an answer. */
const LIMIT = new RegExp(
  `${LIMIT_NOW.source}|\\bcan only change your (user)?name (once|twice|\\d+ times)\\b`,
  'i',
);
const TAKEN =
  /\b(isn['’]t|is not|not) available\b|\bunavailable\b|\balready (been )?(taken|in use)\b|\bis taken\b|\btry (another|a different)\b/i;
const INVALID =
  /\bcan only (contain|use|have)\b|\bmust (be|have) at least\b|\btoo (short|long)\b|\b(isn['’]t|not) allowed\b|\b(isn['’]t|not) (a )?valid\b|\binvalid\b|\bcan['’]?t use (this|that) username\b/i;
const FREE = /\bavailable\b/i;

/**
 * What the network said of what was typed, in the box on top while it's the one with the Username box (never a box
 * over it): the first of its new lines that says it can't change now, that it's taken, that it isn't allowed, or that
 * it's free, in that order (a "not available" says "available" too); the box marked wrong with no words is taken as
 * not allowed. Null when it's said nothing yet.
 */
export function verdictOf(
  doc: Document,
  before: ReadonlySet<string>,
  box: Element | null,
): { readonly verdict: UsernameVerdict; readonly said: string | null } | null {
  const top = placesOf(doc)[0]!;
  return box && !top.contains(box) ? null : verdictIn(top, before, box);
}

/** What the network said of a username in one place: as `verdictOf` reads it. */
function verdictIn(
  place: Element,
  before: ReadonlySet<string>,
  box: Element | null,
): { readonly verdict: UsernameVerdict; readonly said: string | null } | null {
  const fresh = freshLines(place, before);
  for (const [verdict, words] of [
    ['limit', LIMIT],
    ['taken', TAKEN],
    ['invalid', INVALID],
    ['free', FREE],
  ] as const) {
    const line = fresh.find((l) => words.test(l));
    if (line) return { verdict, said: line.slice(0, 150) };
  }
  if (box?.getAttribute('aria-invalid') === 'true') return { verdict: 'invalid', said: null };
  return null;
}

/** Words the network says once the username's saved. */
const SAVED = /\b(username (has been )?(updated|changed|saved)|changes saved)\b/i;

/**
 * What putting the username in found, step by step, for the job's note of the page (decision 74): never a word anyone
 * wrote, only counts, yes or no, and the names of the buttons there as the outline shows them.
 */
export interface UsernameSteps {
  /** What the network asked the person for first: their password, a code, or to confirm it's them. */
  readonly asking: Asking | null;
  /** How many boxes named Username: one is wanted. */
  readonly boxes: number;
  /** The Username box held another account's username than theirs: nothing typed (Instagram's, from 0.94.0). */
  readonly other: boolean;
  /** How many Dones (or Saves) in sight, and whether the one there was on. */
  readonly dones: number;
  readonly doneOn: boolean;
  readonly typed: boolean;
  /** What the network said of it, or none. */
  readonly answer: UsernameVerdict | 'none';
  /** Done pressed, and the network's box to be sure pressed after it. */
  readonly pressed: boolean;
  readonly confirmed: boolean;
  /** The box after Done offered to change the other network's profile's username too: never pressed, handed over. */
  readonly sync: boolean;
  /** A box over the page after Done that it didn't know: left for the person to answer. */
  readonly over: boolean;
  readonly saved: boolean;
  readonly names: readonly string[];
}

export const NO_USERNAME_STEPS: UsernameSteps = {
  asking: null,
  boxes: 0,
  other: false,
  dones: 0,
  doneOn: false,
  typed: false,
  answer: 'none',
  pressed: false,
  confirmed: false,
  sync: false,
  over: false,
  saved: false,
  names: [],
};

/** What's missing, in the extension's own words, for a note: empty when it all went. */
export function usernameMissing(
  steps: UsernameSteps,
  tried = false,
  network: CenterNetwork = 'facebook',
): string[] {
  const name = PLATFORMS[network];
  if (steps.asking) return [askedNote(steps.asking, network)];
  if (steps.boxes !== 1)
    return [steps.boxes === 0 ? 'no box named Username' : `${steps.boxes} boxes named Username`];
  if (steps.other) return ['the Username box held another account’s username'];
  if (steps.dones !== 1)
    return [steps.dones === 0 ? 'no Done by the Username box' : `${steps.dones} Dones by it`];
  if (!steps.typed) return ['writing in Username didn’t take'];
  if (tried) return [];
  if (!steps.pressed)
    return [
      steps.answer === 'none'
        ? `${name} said nothing about whether it’s available, and Done stayed off`
        : 'Done stayed off',
    ];
  if (steps.sync)
    return [
      `the box after Done offered to change the username on ${PLATFORMS[OTHER_NETWORK[network]]} too, and wasn’t pressed`,
    ];
  if (steps.over) return [`${name} opened a box after Done that the extension doesn’t know`];
  return steps.saved ? [] : ['Done didn’t save it'];
}

/** How putting the username in went. */
export type UsernameResult =
  /** In: the network took it. */
  | 'done'
  /** Their username already. */
  | 'already'
  /** The network asks for their password, a code, or to confirm it's them: the person answers, never the extension. */
  | 'waiting'
  /** The network says it's taken, isn't allowed, or can't change now: Done never pressed. */
  | 'taken'
  | 'invalid'
  | 'limit'
  /** A warning of the network's on the page: nothing typed. */
  | 'warned'
  /** Something wasn't as expected: the person does it. */
  | 'none'
  /** Done pressed, but it didn't save, or the network opened a box it doesn't know (`steps.over`). */
  | 'not_saved';

export interface UsernameWrote {
  readonly result: UsernameResult;
  readonly steps: UsernameSteps;
  /** The network's own words for its answer, as it said them. */
  readonly said: string | null;
  /** The network's warnings, when one stopped it. */
  readonly warnings?: readonly string[];
}

/** How long the box is waited for, the network's answer, and the username saved. */
const WAIT_MS = 10_000;
const CHECK_MS = 10_000;
const SAVE_MS = 12_000;
/** With no words, Done that the network turns on after this long is its say-so. */
const SETTLED_MS = 2_000;
/** Done off and the username still in its box this long after Done, with no words against it: the network took it. */
const SAVED_SETTLED_MS = 4_000;
/** A box over the page after Done that it doesn't know, still there this long: the person's to answer. */
const OVER_MS = 3_000;

/** Whether the page shows this username, once the Username box is gone: as a line, `@` and all, or its address's end. */
function usernameShown(doc: Document, u: string): boolean {
  return textLines(doc.querySelector('[role="main"]') ?? doc.body, 200).some((line) => {
    const l = line.toLowerCase();
    return l === u || l === `@${u}` || l.endsWith(`/${u}`);
  });
}

/** Where a username goes in, and what's checked first. */
export interface UsernameOn {
  /** Whose Accounts Center: Facebook's unless said. */
  readonly network?: CenterNetwork;
  /**
   * The username the profile has now, when the job knows it (Instagram's, as instagram.com shows it): the Username box
   * must hold it, or the new one, before anything's typed, so it never types on another account's page.
   */
  readonly was?: string | null;
}

/**
 * Puts the new username in on the username page the tab shows: the one Username box cleared and the username typed,
 * the network's answer waited for, Done pressed once it allows it, and the username waited for. It types nothing
 * else, anywhere, and nothing at all while the network asks the person for something (`askingHere`); a warning stops
 * it before anything else is read or pressed.
 */
export async function writeUsername(
  doc: Document,
  username: string,
  on: UsernameOn = {},
): Promise<UsernameWrote> {
  const network = on.network ?? 'facebook';
  const u = cleanUsername(username);
  const was = on.was ? cleanUsername(on.was) : null;
  let steps: UsernameSteps = NO_USERNAME_STEPS;
  const end = (result: UsernameResult, said: string | null = null): UsernameWrote => ({
    result,
    said,
    steps: result === 'done' || result === 'already' ? steps : { ...steps, names: namesOn(doc) },
  });
  /** The network asking the person for something, or else a warning: how it ends then, or null. */
  const stopped = (): UsernameWrote | null => {
    const asking = askingHere(doc);
    if (asking) {
      steps = { ...steps, asking };
      return end('waiting');
    }
    const warnings = centerWarnings(doc, doc.location.href, network);
    return warnings.length ? { ...end('warned'), warnings } : null;
  };
  if (usernameProblem(network, u)) return end('none');
  // The box, as the page draws it; or the network asking for the password first, or a warning.
  let boxes: HTMLElement[] = [];
  for (let waited = 0; ; waited += EDITOR_LOOK_MS) {
    const stop = stopped();
    if (stop) return stop;
    boxes = usernameBoxes(doc);
    if (boxes.length || waited >= WAIT_MS) break;
    await pause(EDITOR_LOOK_MS);
  }
  steps = { ...steps, boxes: boxes.length };
  // The network won't change it now: said before anything's typed.
  const limit = [...linesOnTop(doc)].find((line) => line.length <= 300 && LIMIT_NOW.test(line));
  if (limit) return end('limit', limit.slice(0, 150));
  if (boxes.length !== 1) return end('none');
  let box = boxes[0]!;
  if (heldBox(box)) return end('limit');
  const now = valueOf(box).toLowerCase().replace(/^@/, '');
  if (now === u) {
    steps = { ...steps, typed: true };
    return end('already');
  }
  // Another account's page: never typed on.
  if (was && now !== was) {
    steps = { ...steps, other: true };
    return end('none');
  }
  const before = linesOnTop(doc);
  typeInto(doc, box, u, true);
  await pause(300);
  steps = { ...steps, typed: valueOf(box).toLowerCase() === u };
  if (!steps.typed) return end('none');
  // The network's answer: a refusal ends it, Done never pressed; Done goes once the network allows it.
  let done: HTMLElement | null = null;
  for (let waited = 0; ; waited += EDITOR_LOOK_MS) {
    const stop = stopped();
    if (stop) return stop;
    const said = verdictOf(doc, before, box);
    if (said) steps = { ...steps, answer: said.verdict };
    if (said && said.verdict !== 'free') return end(said.verdict, said.said);
    const dones = doneButtons(doc);
    const on = dones.length === 1 && shown(dones[0]!);
    steps = { ...steps, dones: dones.length, doneOn: on };
    if (on && (said?.verdict === 'free' || waited >= SETTLED_MS)) {
      done = dones[0]!;
      break;
    }
    if (waited >= CHECK_MS) return end('none');
    await pause(EDITOR_LOOK_MS);
  }
  const late = stopped();
  if (late) return late;
  done.click();
  steps = { ...steps, pressed: true };
  const saved = () => {
    steps = { ...steps, saved: true };
    return end('done');
  };
  let overSince: number | null = null;
  for (let waited = 0; waited < SAVE_MS; waited += EDITOR_LOOK_MS) {
    await pause(EDITOR_LOOK_MS);
    const stop = stopped();
    if (stop) return stop;
    // The network took it and left the username page.
    if (centerPageOf(doc.location.href, network, 'username') === null) return saved();
    let top = placesOf(doc)[0]!;
    if (!box.isConnected || !top.contains(box)) {
      // The Username box drawn again, where it's on top: it goes on as that one.
      const again = usernameBoxes(doc);
      if (again.length === 1 && again[0] !== box) {
        box = again[0]!;
        top = placesOf(doc)[0]!;
      }
    }
    if (box.isConnected && top.contains(box)) {
      // The Username box on top, nothing over it: the network's answer read there.
      overSince = null;
      if (freshLines(top, before).some((l) => SAVED.test(l))) return saved();
      const said = verdictIn(top, before, box);
      if (said && said.verdict !== 'free') {
        steps = { ...steps, answer: said.verdict };
        return end(said.verdict, said.said);
      }
      // Its box still holding it with Done off a while after: the network took it. The job reads the profile to be sure.
      if (
        waited >= SAVED_SETTLED_MS &&
        visible(box) &&
        valueOf(box).toLowerCase() === u &&
        !doneButtons(doc).some((b) => shown(b))
      )
        return saved();
      continue;
    }
    if (top === doc.body) {
      // Nothing over the page and no Username box: in once the page shows it.
      overSince = null;
      if (usernameShown(doc, u)) return saved();
      continue;
    }
    // A box over the page offering to change the other network's username too: never pressed, the person's to answer.
    if (othersToo(textLines(top, 40), network)) {
      steps = { ...steps, sync: true };
      return end('not_saved');
    }
    // A box over the page: the network's to be sure, pressed once when it has nowhere to type, never a refusal.
    const sure = buttonsIn(top, CONFIRM);
    if (sure.length === 1 && !top.querySelector(ANY_BOX)) {
      overSince = null;
      if (!steps.confirmed) {
        sure[0]!.click();
        steps = { ...steps, confirmed: true };
      }
      continue;
    }
    // One it doesn't know: what it says against the username, else the person's to answer.
    const said = verdictIn(top, before, null);
    if (said && said.verdict !== 'free') {
      steps = { ...steps, answer: said.verdict };
      return end(said.verdict, said.said);
    }
    if (freshLines(top, before).some((l) => SAVED.test(l))) return saved();
    overSince ??= waited;
    if (waited - overSince >= OVER_MS) {
      steps = { ...steps, over: true };
      return end('not_saved');
    }
  }
  // Still a box over the Username box: the person's to answer.
  const top = placesOf(doc)[0]!;
  if (top !== doc.body && !(box.isConnected && top.contains(box))) steps = { ...steps, over: true };
  return end('not_saved');
}
