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
 *   the page's own help ("can only contain letters…") is never taken for an answer, and only words where the Username
 *   box is. Taken, not allowed, or not now: said as Facebook said it, and Done is never pressed.
 * - **After Done**, Facebook's box to be sure (**Change username** or **Confirm**) is pressed once, only when it's on
 *   top and has nowhere to type; never read as a refusal. It's in on Facebook's word that it's saved, on leaving the
 *   page, or with the Username box on top again holding it and Done off. A box over the page it doesn't know is the
 *   person's to answer, and the job hands it over.
 * - **Never a password or a code.** Facebook asking the person for something (`askingHere`: a password box, a box for
 *   a code or a PIN, or its "Confirm it's you" with a way to pick) makes it wait for the person, before it types or
 *   after Done; nothing is typed in it, and the page's warnings aren't read while it asks, as that's no warning
 *   (decision 25). Otherwise a warning stops it, before anything else is read or pressed, and the job notes it.
 *
 * Built from Facebook's usual words for this page, not yet from a page outline of it: Check Facebook sends its outline
 * (./tries.ts), so it can be tuned from the person's own.
 */
import { cleanUsername, usernameProblem } from '@hfos/core/addons/outreach/profile-check';
import { clean, labelOf, textLines } from './dom';
import { buttonsIn, EDITOR_BUTTONS, EDITOR_LOOK_MS, fieldName, pause } from './editors';
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

/** Whether an address is on Accounts Center at all. */
export const onAccountsCenter = (href: string): boolean => accountsCenterUrl(href) !== null;

/** Whether an address is a profile's username page in Accounts Center: the only page there it types on. */
export function usernamePage(href: string): boolean {
  return usernamePageOf(href) !== null;
}

/** The number of the profile whose username page an address is, or null for any other page. */
export function usernamePageOf(href: string): string | null {
  const url = accountsCenterUrl(href);
  return url ? (/^\/profiles\/(\d{1,20})\/username\/?$/.exec(url.pathname)?.[1] ?? null) : null;
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
    const match =
      /^(?:https:\/\/accountscenter\.facebook\.com)?\/profiles\/(\d{1,20})\/?(?:[?#].*)?$/i.exec(
        href,
      );
    if (!match) continue;
    const row = clean(a.textContent) || labelOf(a);
    if (/\bfacebook\b/i.test(row) && !/\binstagram\b/i.test(row)) found.add(match[1]!);
  }
  return found.size === 1 ? usernameAddress([...found][0]) : null;
}

/** Boxes a username might be typed in: plain ones only. */
const FIELDS = 'input:not([type]), input[type="text"], input[type="search"], [role="textbox"]';
const USERNAME = /^username\s*\*?$/i;
/** Facebook's button that saves it. */
const DONE = /^(done|save|save changes)$/i;
/** Facebook's box to be sure, after Done: pressed once, only when it has no box to type in. */
const CONFIRM = /^(change username|confirm)$/i;
/** Anything in a box over the page that could be typed in: Facebook's box to be sure has none. */
const ANY_BOX =
  'input:not([type="hidden"]), textarea, select, [contenteditable="true"], [role="textbox"]';

/** What Facebook asks the person for on Accounts Center before it goes on: only they answer it. */
export type Asking = 'password' | 'code' | 'confirm';

/** Facebook asking to be sure it's them, with a way to pick (a password, a code) and Continue, before any box. */
const CONFIRM_YOU = /\b(confirm|verify) (your identity|it['’]s you|that this is your account)\b/i;
const PASSWORD_FIELD = /\bpassword\b/i;
const CODE_FIELD = /\b(code|pin|passcode)\b/i;
/** Where Facebook asks it: a box over the page, or a heading. */
const ASKED_IN = '[role="dialog"], [role="alertdialog"], h1, h2, h3, [role="heading"]';

/**
 * What Facebook asks the person for on Accounts Center, when it does: their password (a password box, or one named for
 * it), a code (a box for one, a PIN's, a phone keypad's or a number box), or to confirm it's them ("Confirm it's you",
 * with ways to pick and Continue, before any box shows). The extension types none of these, and its words aren't read
 * as a warning while it asks (decision 25). Null when it asks nothing.
 */
export function askingHere(doc: Document): Asking | null {
  const first = askingFor(doc);
  if (first) return first;
  for (const field of doc.querySelectorAll<HTMLElement>('input:not([type="hidden"]), textarea')) {
    const type = (field.getAttribute('type') ?? 'text').toLowerCase();
    if (['radio', 'checkbox', 'submit', 'button', 'search'].includes(type) || !visible(field))
      continue;
    const named = fieldName(field);
    if (USERNAME.test(named)) continue;
    const says = [named, field.getAttribute('name'), field.getAttribute('id')].join(' ');
    if (PASSWORD_FIELD.test(says)) return 'password';
    if (type === 'tel' || type === 'number' || CODE_FIELD.test(says)) return 'code';
  }
  for (const place of doc.querySelectorAll(ASKED_IN))
    if (visible(place) && textLines(place, 20).some((line) => CONFIRM_YOU.test(line)))
      return 'confirm';
  return null;
}

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
  /\b(isn['’]t|is not|not) available\b|\bunavailable\b|\balready (been )?(taken|in use)\b|\bis taken\b|\btry (another|a different)\b/i;
const INVALID =
  /\bcan only (contain|use|have)\b|\bmust (be|have) at least\b|\btoo (short|long)\b|\b(isn['’]t|not) allowed\b|\b(isn['’]t|not) (a )?valid\b|\binvalid\b/i;
const FREE = /\bavailable\b/i;

/** The lines in the box on top: what's there before typing, so only Facebook's answer after counts. */
export function linesOnTop(doc: Document): Set<string> {
  return new Set(textLines(placesOf(doc)[0]!, 80));
}

/**
 * What Facebook said of what was typed, in the box on top while it's the one with the Username box (never a box over
 * it): the first of its new lines that says it can't change now, that it's taken, that it isn't allowed, or that it's
 * free, in that order (a "not available" says "available" too); the box marked wrong with no words is taken as not
 * allowed. Null when it's said nothing yet.
 */
export function verdictOf(
  doc: Document,
  before: ReadonlySet<string>,
  box: Element | null,
): { readonly verdict: UsernameVerdict; readonly said: string | null } | null {
  const top = placesOf(doc)[0]!;
  return box && !top.contains(box) ? null : verdictIn(top, before, box);
}

/** What Facebook said of a username in one place: as `verdictOf` reads it. */
function verdictIn(
  place: Element,
  before: ReadonlySet<string>,
  box: Element | null,
): { readonly verdict: UsernameVerdict; readonly said: string | null } | null {
  const fresh = textLines(place, 80).filter((line) => !before.has(line) && line.length <= 300);
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
  /** What Facebook asked the person for first: their password, a code, or to confirm it's them. */
  readonly asking: Asking | null;
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
  /** A box over the page after Done that it didn't know: left for the person to answer. */
  readonly over: boolean;
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
  over: false,
  saved: false,
  names: [],
};

/** What Facebook asked the person for, in a note's words. */
export const askedNote = (asking: Asking): string =>
  asking === 'code'
    ? 'Facebook asked for a code'
    : asking === 'confirm'
      ? 'Facebook asked them to confirm it’s them'
      : 'Facebook asked for the password';

/** What's missing, in the extension's own words, for a note: empty when it all went. */
export function usernameMissing(steps: UsernameSteps, tried = false): string[] {
  if (steps.asking) return [askedNote(steps.asking)];
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
  if (steps.over) return ['Facebook opened a box after Done that the extension doesn’t know'];
  return steps.saved ? [] : ['Done didn’t save it'];
}

/** How putting the username in went. */
export type UsernameResult =
  /** In: Facebook took it. */
  | 'done'
  /** Their username already. */
  | 'already'
  /** Facebook asks for their password, a code, or to confirm it's them: the person answers, never the extension. */
  | 'waiting'
  /** Facebook says it's taken, isn't allowed, or can't change now: Done never pressed. */
  | 'taken'
  | 'invalid'
  | 'limit'
  /** A Facebook warning on the page: nothing typed. */
  | 'warned'
  /** Something wasn't as expected: the person does it. */
  | 'none'
  /** Done pressed, but it didn't save, or Facebook opened a box it doesn't know (`steps.over`). */
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
/** Done off and the username still in its box this long after Done, with no words against it: Facebook took it. */
const SAVED_SETTLED_MS = 4_000;
/** A box over the page after Done that it doesn't know, still there this long: the person's to answer. */
const OVER_MS = 3_000;

const valueOf = (box: HTMLElement): string =>
  clean('value' in box && typeof box.value === 'string' ? box.value : box.textContent);

/** The names of the buttons in the box on top, as the outline shows them. */
const namesOn = (doc: Document): string[] =>
  [...placesOf(doc)[0]!.querySelectorAll(EDITOR_BUTTONS)]
    .filter((b) => visible(b) && !b.closest('[role="banner"]'))
    .slice(0, 12)
    .map((b) => maskText(labelOf(b)).slice(0, 60) || `(${b.tagName.toLowerCase()})`);

/** Whether the page shows this username, once the Username box is gone: as a line, or as its address's end. */
function usernameShown(doc: Document, u: string): boolean {
  return textLines(doc.querySelector('[role="main"]') ?? doc.body, 200).some((line) => {
    const l = line.toLowerCase();
    return l === u || l.endsWith(`/${u}`);
  });
}

/**
 * Puts the new username in on the username page the tab shows: the one Username box cleared and the username typed,
 * Facebook's answer waited for, Done pressed once Facebook allows it, and the username waited for. It types nothing
 * else, anywhere, and nothing at all while Facebook asks the person for something (`askingHere`); a Facebook warning
 * stops it before anything else is read or pressed.
 */
export async function writeUsername(doc: Document, username: string): Promise<UsernameWrote> {
  const u = cleanUsername(username);
  let steps: UsernameSteps = NO_USERNAME_STEPS;
  const end = (result: UsernameResult, said: string | null = null): UsernameWrote => ({
    result,
    said,
    steps: result === 'done' || result === 'already' ? steps : { ...steps, names: namesOn(doc) },
  });
  /** Facebook asking the person for something, or else a warning: how it ends then, or null. */
  const stopped = (): UsernameWrote | null => {
    const asking = askingHere(doc);
    if (asking) {
      steps = { ...steps, asking };
      return end('waiting');
    }
    const warnings = readWarnings(doc, doc.location.href);
    return warnings.length ? { ...end('warned'), warnings } : null;
  };
  if (usernameProblem('facebook', u)) return end('none');
  // The box, as the page draws it; or Facebook asking for the password first, or a warning.
  let boxes: HTMLElement[] = [];
  for (let waited = 0; ; waited += EDITOR_LOOK_MS) {
    const stop = stopped();
    if (stop) return stop;
    boxes = usernameBoxes(doc);
    if (boxes.length || waited >= WAIT_MS) break;
    await pause(EDITOR_LOOK_MS);
  }
  steps = { ...steps, boxes: boxes.length };
  // Facebook won't change it now: said before anything's typed.
  const limit = [...linesOnTop(doc)].find((line) => line.length <= 300 && LIMIT.test(line));
  if (limit) return end('limit', limit.slice(0, 150));
  if (boxes.length !== 1) return end('none');
  let box = boxes[0]!;
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
    // Facebook took it and left the username page.
    if (!usernamePage(doc.location.href)) return saved();
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
      // The Username box on top, nothing over it: Facebook's answer read there.
      overSince = null;
      const fresh = textLines(top, 80).filter((l) => !before.has(l) && l.length <= 300);
      if (fresh.some((l) => SAVED.test(l))) return saved();
      const said = verdictIn(top, before, box);
      if (said && said.verdict !== 'free') {
        steps = { ...steps, answer: said.verdict };
        return end(said.verdict, said.said);
      }
      // Its box still holding it with Done off a while after: Facebook took it. The job reads the profile to be sure.
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
    // A box over the page: Facebook's to be sure, pressed once when it has nowhere to type, never read as a refusal.
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
    if (textLines(top, 80).some((l) => !before.has(l) && SAVED.test(l))) return saved();
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
