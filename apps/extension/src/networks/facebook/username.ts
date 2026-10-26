/**
 * The person's Facebook username, changed on Accounts Center's username page for their Facebook profile
 * (docs/outreach.md, decision 89), for a **Put these in** they pressed in HandsFreeOS. It's the one place in Accounts
 * Center the extension types, and it types only the new username they picked, only into the box named Username.
 *
 * - **Where:** `https://accountscenter.facebook.com/profiles/<their profile's number>/username/` (`usernamePage`), the
 *   number from their profile's Edit profile link (./own-profile.ts `ownEditorsOf`); without it, Accounts Center's
 *   Profiles, and the link there to the Facebook one (`facebookProfileOn`).
 * - **Facebook has the last word.** It types the username, waits for Facebook to say whether it's available, and
 *   presses **Done** only once Facebook allows it, then waits for it to save. Only words new since it typed count, so
 *   the page's own help ("can only contain letters…") is never taken for an answer. Taken, not allowed, or not now:
 *   said as Facebook said it, and Done is never pressed.
 * - **Never a password or a code.** A password, PIN or code box makes it wait for the person (./fetch.ts `askingFor`),
 *   before it types or after Done; nothing is typed in it, and the page's warnings aren't read while it shows, as
 *   Facebook's "Confirm it's you" there is no warning (decision 25). Otherwise a warning stops it before anything's
 *   typed, and the job notes it.
 *
 * Built from Facebook's usual words for this page, not yet from a page outline of it: Check Facebook sends its outline
 * (./tries.ts), so it can be tuned from the person's own.
 */
import { cleanUsername, usernameProblem } from '@hfos/core/addons/outreach/profile-check';
import { clean, labelOf, textLines } from './dom';
import { EDITOR_BUTTONS, EDITOR_LOOK_MS, fieldName, pause } from './editors';
import { askingFor, placesOf, shown, visible } from './fetch';
import { typeInto } from './join';
import { maskText } from './outline';
import { readWarnings } from './warnings';

export const ACCOUNTS_CENTER = 'https://accountscenter.facebook.com';
/** Accounts Center's Profiles: where the Facebook profile is picked when its number isn't known. */
export const ACCOUNTS_PROFILES = `${ACCOUNTS_CENTER}/profiles`;

const NUMBER = /^\d{1,20}$/;

/** The username page for a profile, by its number; null for anything that isn't one. */
export function usernameAddress(id: string | null | undefined): string | null {
  return id && NUMBER.test(id) ? `${ACCOUNTS_CENTER}/profiles/${id}/username/` : null;
}

/** An address on Accounts Center, whole: https, that host exactly, nothing else in it (no name, password or port). */
function accountsCenterUrl(href: string): URL | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  return url.hostname.toLowerCase() === 'accountscenter.facebook.com' ? url : null;
}

/** Whether an address is a profile's username page in Accounts Center: the only page there it types on. */
export function usernamePage(href: string): boolean {
  const url = accountsCenterUrl(href);
  return url !== null && /^\/profiles\/\d{1,20}\/username\/?$/.test(url.pathname);
}

/** Whether an address is Accounts Center's Profiles, or one profile there. */
export function profilesPage(href: string): boolean {
  const url = accountsCenterUrl(href);
  return url !== null && /^\/profiles(\/\d{1,20})?\/?$/.test(url.pathname);
}

/** The Facebook profile's link among Accounts Center's Profiles, as its username page: the one row that says Facebook. */
export function facebookProfileOn(doc: Document): string | null {
  const found = new Set<string>();
  for (const a of doc.querySelectorAll('a[href]')) {
    if (!visible(a)) continue;
    const href = a.getAttribute('href') ?? '';
    const match = /^(?:https:\/\/accountscenter\.facebook\.com)?\/profiles\/(\d{1,20})\/?(?:[?#].*)?$/i.exec(
      href,
    );
    if (!match) continue;
    const row = clean(a.textContent) || labelOf(a);
    if (/\bfacebook\b/i.test(row) && !/\binstagram\b/i.test(row)) found.add(match[1]!);
  }
  return found.size === 1 ? usernameAddress([...found][0]) : null;
}

/** Boxes a username might be typed in: plain ones only. */
const FIELDS =
  'input:not([type]), input[type="text"], input[type="search"], [role="textbox"]';
const USERNAME = /^username\s*\*?$/i;
/** Facebook's button that saves it. */
const DONE = /^(done|save|save changes)$/i;
/** Facebook's box to be sure, after Done: pressed once, only when it has no box to type in. */
const CONFIRM = /^(change username|confirm)$/i;

/** The boxes named Username in the box on top, shown: never a password's, a code's, or one beside a password. */
export function usernameBoxes(doc: Document): HTMLElement[] {
  const place = placesOf(doc)[0]!;
  return [...place.querySelectorAll<HTMLElement>(FIELDS)].filter(
    (field) =>
      shown(field) &&
      !field.matches('[autocomplete="one-time-code"], [inputmode="numeric"]') &&
      !field.closest('form')?.querySelector('input[type="password"]') &&
      USERNAME.test(fieldName(field)),
  );
}

/** Facebook's Done (or Save) in the box on top, in sight whether or not it's on yet. */
export function doneButtons(doc: Document): HTMLElement[] {
  const place = placesOf(doc)[0]!;
  return [...place.querySelectorAll<HTMLElement>(EDITOR_BUTTONS)].filter(
    (b) => DONE.test(labelOf(b)) && visible(b),
  );
}

/** What Facebook says of a username, from the lines in the box on top. */
export type UsernameVerdict = 'free' | 'taken' | 'invalid' | 'limit';

const LIMIT =
  /\b(can['’]?t|cannot|can not) change (your|this) username\b|\b(change|update) (your|this) username again (on|in|after)\b|\btoo many (times|changes)\b|\btry again later\b/i;
const TAKEN =
  /\b(isn['’]t|is not|not|un)available\b|\balready (been )?(taken|in use)\b|\bis taken\b|\btry (another|a different)\b/i;
const INVALID =
  /\bcan only (contain|use|have)\b|\bmust (be|have) at least\b|\btoo (short|long)\b|\b(isn['’]t|not) allowed\b|\b(isn['’]t|not) (a )?valid\b|\binvalid\b/i;
const FREE = /\bavailable\b/i;

/** The lines in the box on top: what's there before typing, so only Facebook's answer after counts. */
export function linesOnTop(doc: Document): Set<string> {
  return new Set(textLines(placesOf(doc)[0]!, 80));
}

/**
 * What Facebook said of what was typed: the first of its new lines that says it can't change now, that it's taken,
 * that it isn't allowed, or that it's free, in that order (a "not available" says "available" too); the box marked
 * wrong with no words is taken as not allowed. Null when it's said nothing yet.
 */
export function verdictOf(
  doc: Document,
  before: ReadonlySet<string>,
  box: Element | null,
): { readonly verdict: UsernameVerdict; readonly said: string | null } | null {
  const fresh = [...linesOnTop(doc)].filter((line) => !before.has(line) && line.length <= 300);
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

/** Words Facebook says once the username's saved. */
const SAVED = /\b(username (has been )?(updated|changed|saved)|changes saved)\b/i;

/**
 * What putting the username in found, step by step, for the job's note of the page (decision 74): never a word anyone
 * wrote, only counts, yes or no, and the names of the buttons there as the outline shows them.
 */
export interface UsernameSteps {
  /** What Facebook asked the person to type first: their password or a code. */
  readonly asking: 'password' | 'code' | null;
  /** How many boxes named Username: one is wanted. */
  readonly boxes: number;
  /** How many Dones (or Saves) in sight, and whether the one there was on. */
  readonly dones: number;
  readonly doneOn: boolean;
  readonly typed: boolean;
  /** What Facebook said of it, or none. */
  readonly answer: UsernameVerdict | 'none';
  /** Done pressed, and Facebook's box to be sure pressed after it. */
  readonly pressed: boolean;
  readonly confirmed: boolean;
  readonly saved: boolean;
  readonly names: readonly string[];
}

export const NO_USERNAME_STEPS: UsernameSteps = {
  asking: null,
  boxes: 0,
  dones: 0,
  doneOn: false,
  typed: false,
  answer: 'none',
  pressed: false,
  confirmed: false,
  saved: false,
  names: [],
};

/** What's missing, in the extension's own words, for a note: empty when it all went. */
export function usernameMissing(steps: UsernameSteps, tried = false): string[] {
  if (steps.asking) return [`Facebook asked for ${steps.asking === 'code' ? 'a code' : 'your password'}`];
  if (steps.boxes !== 1)
    return [steps.boxes === 0 ? 'no box named Username' : `${steps.boxes} boxes named Username`];
  if (steps.dones !== 1)
    return [steps.dones === 0 ? 'no Done by the Username box' : `${steps.dones} Dones by it`];
  if (!steps.typed) return ['writing in Username didn’t take'];
  if (tried) return [];
  if (!steps.pressed)
    return [
      steps.answer === 'none'
        ? 'Facebook said nothing about whether it’s available, and Done stayed off'
        : 'Done stayed off',
    ];
  return steps.saved ? [] : ['Done didn’t save it'];
}

/** How putting the username in went. */
export type UsernameResult =
  /** In: Facebook took it. */
  | 'done'
  /** Their username already. */
  | 'already'
  /** Facebook asks for their password or a code: the person types it, never the extension. */
  | 'waiting'
  /** Facebook says it's taken, isn't allowed, or can't change now: Done never pressed. */
  | 'taken'
  | 'invalid'
  | 'limit'
  /** A Facebook warning on the page: nothing typed. */
  | 'warned'
  /** Something wasn't as expected: the person does it. */
  | 'none'
  /** Done pressed, but it didn't save. */
  | 'not_saved';

export interface UsernameWrote {
  readonly result: UsernameResult;
  readonly steps: UsernameSteps;
  /** Facebook's own words for its answer, as it said them. */
  readonly said: string | null;
  /** Facebook's warnings, when one stopped it. */
  readonly warnings?: readonly string[];
}

/** How long the box is waited for, Facebook's answer, and the username saved. */
const WAIT_MS = 10_000;
const CHECK_MS = 10_000;
const SAVE_MS = 12_000;
/** With no words, Done that Facebook turns on after this long is its say-so. */
const SETTLED_MS = 2_000;

const valueOf = (box: HTMLElement): string =>
  clean('value' in box && typeof box.value === 'string' ? box.value : box.textContent);

/** The names of the buttons in the box on top, as the outline shows them. */
const namesOn = (doc: Document): string[] =>
  [...placesOf(doc)[0]!.querySelectorAll(EDITOR_BUTTONS)]
    .filter((b) => visible(b) && !b.closest('[role="banner"]'))
    .slice(0, 12)
    .map((b) => maskText(labelOf(b)).slice(0, 60) || `(${b.tagName.toLowerCase()})`);

/**
 * Puts the new username in on the username page the tab shows: the one Username box cleared and the username typed,
 * Facebook's answer waited for, Done pressed once Facebook allows it, and the username waited for. It types nothing
 * else, anywhere, and nothing at all while Facebook asks for a password or a code.
 */
export async function writeUsername(doc: Document, username: string): Promise<UsernameWrote> {
  const href = doc.location.href;
  const u = cleanUsername(username);
  let steps: UsernameSteps = NO_USERNAME_STEPS;
  const end = (result: UsernameResult, said: string | null = null): UsernameWrote => ({
    result,
    said,
    steps: result === 'done' || result === 'already' ? steps : { ...steps, names: namesOn(doc) },
  });
  if (usernameProblem('facebook', u)) return end('none');
  // The box, as the page draws it; or Facebook asking for the password first.
  let boxes: HTMLElement[] = [];
  for (let waited = 0; ; waited += EDITOR_LOOK_MS) {
    const asking = askingFor(doc);
    if (asking) {
      steps = { ...steps, asking };
      return end('waiting');
    }
    boxes = usernameBoxes(doc);
    if (boxes.length || waited >= WAIT_MS) break;
    await pause(EDITOR_LOOK_MS);
  }
  steps = { ...steps, boxes: boxes.length };
  // Facebook won't change it now: said before anything's typed.
  const limit = [...linesOnTop(doc)].find((line) => line.length <= 300 && LIMIT.test(line));
  if (limit) return end('limit', limit.slice(0, 150));
  const warnings = readWarnings(doc, href);
  if (warnings.length) return { ...end('warned'), warnings };
  if (boxes.length !== 1) return end('none');
  const box = boxes[0]!;
  if (box.hasAttribute('readonly') || box.getAttribute('aria-readonly') === 'true')
    return end('limit');
  if (valueOf(box).toLowerCase() === u) {
    steps = { ...steps, typed: true };
    return end('already');
  }
  const before = linesOnTop(doc);
  typeInto(doc, box, u, true);
  await pause(300);
  steps = { ...steps, typed: valueOf(box).toLowerCase() === u };
  if (!steps.typed) return end('none');
  // Facebook's answer: a refusal ends it, Done never pressed; Done goes once Facebook allows it.
  let done: HTMLElement | null = null;
  for (let waited = 0; ; waited += EDITOR_LOOK_MS) {
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
  const lateWarnings = readWarnings(doc, href);
  if (lateWarnings.length) return { ...end('warned'), warnings: lateWarnings };
  done.click();
  steps = { ...steps, pressed: true };
  const pressedAt = Date.now();
  let confirmed = false;
  for (let waited = 0; waited < SAVE_MS; waited += EDITOR_LOOK_MS) {
    await pause(EDITOR_LOOK_MS);
    const asking = askingFor(doc);
    if (asking) {
      steps = { ...steps, asking };
      return end('waiting');
    }
    const said = verdictOf(doc, before, box);
    if (said && said.verdict !== 'free') {
      steps = { ...steps, answer: said.verdict };
      return end(said.verdict, said.said);
    }
    // Facebook's box to be sure, drawn after Done: pressed once, when it has nowhere to type.
    const top = placesOf(doc)[0]!;
    if (!confirmed && top !== doc.body && !top.contains(box) && !top.querySelector(FIELDS)) {
      const sure = [...top.querySelectorAll<HTMLElement>(EDITOR_BUTTONS)].filter(
        (b) => CONFIRM.test(labelOf(b)) && shown(b),
      );
      if (sure.length === 1) {
        sure[0]!.click();
        confirmed = true;
        steps = { ...steps, confirmed };
        continue;
      }
    }
    const savedWords = [...linesOnTop(doc)].some((l) => !before.has(l) && SAVED.test(l));
    const closed = !box.isConnected || !visible(box) || !usernamePage(doc.location.href);
    // Its box still holding it with Done off a while after: Facebook took it. The job reads the profile to be sure.
    const settled =
      Date.now() - pressedAt >= 3_000 &&
      valueOf(box).toLowerCase() === u &&
      !doneButtons(doc).some((b) => shown(b));
    if (savedWords || closed || settled) {
      steps = { ...steps, saved: true };
      return end('done');
    }
  }
  return end('not_saved');
}
