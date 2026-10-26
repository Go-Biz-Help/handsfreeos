/**
 * The person's own name, changed on Accounts Center's name page for their own profile (docs/outreach.md, decision 89;
 * the owner, 26 Oct 2026: "1a 2a 3a"), for a **Put these in** they pressed in HandsFreeOS: their Facebook profile's on
 * Facebook's Accounts Center, their Instagram profile's on Instagram's (./pages.ts), each by the profile's number in
 * the address. It types only the name they picked, only into the boxes named for it.
 *
 * - **Facebook:** `…/profiles/<number>/name/`, with **First name**, **Middle name** and **Last name**, each found by its
 *   label: the name's first word in First name and the rest in Last name, Middle name left empty (core's `splitName`),
 *   so the name shown is exactly the one picked. Then **Review change**, once Facebook allows it; on the step after it,
 *   how the name is shown is left as Facebook has it (a choice it picked already is kept, and none picked is handed
 *   over, never picked by the extension), and **Done** (or **Save changes**) pressed once Facebook allows it.
 * - **Instagram:** the same page on accountscenter.instagram.com, with its one **Name** box, then **Done**.
 * - **One network's name only.** An offer on the page to change the other profile's name too, when it's on, is never
 *   ticked or unticked, and a box after Done that speaks of the other network or of more than one profile is never
 *   pressed (`othersToo`): the step is handed over, so Facebook's name never lands on Instagram, or Instagram's on
 *   Facebook.
 * - **The network has the last word.** Only lines new since it typed count: the page's own help ("you can't change it
 *   again for 60 days", "You can only change your name twice within 14 days") is never taken for an answer. Its name
 *   standards, or a change made too recently ("You can't change your name right now", "try again in 30 days"), end it
 *   with the network's words, and Done is never pressed; a name it reviews first is said to be under review, never in.
 * - **After Done**, its box to be sure (**Change name** or **Confirm**) is pressed once, only when it's on top, has
 *   nowhere to type and says nothing of the other network's profile. A box over the page it doesn't know is the
 *   person's to answer, and the job hands it over.
 * - **Never a password or a code** (./pages.ts `askingHere`), before it types, on the step after Review change, or
 *   after Done: it waits for the person, nothing typed in it. Otherwise a warning stops it (`centerWarnings`).
 *
 * Built from Meta's usual words for these pages, not yet from a page outline of them.
 */
import { PLATFORMS } from '@hfos/core/addons/outreach/networks';
import { nameProblem, splitName } from '@hfos/core/addons/outreach/profile-check';
import { clean, textLines } from '../facebook/dom';
import { buttonsIn, EDITOR_LOOK_MS, fieldName, pause } from '../facebook/editors';
import { placesOf, shown, visible } from '../facebook/fetch';
import { typeInto } from '../facebook/join';
import {
  ANY_BOX,
  askedNote,
  askingHere,
  boxesLabelled,
  buttonsOnTop,
  centerPageOf,
  centerWarnings,
  doneButtons,
  freshLines,
  heldBox,
  linesOnTop,
  namesOn,
  othersToo,
  OTHER_NETWORK,
  valueOf,
  type Asking,
  type CenterNetwork,
} from './pages';

/** Facebook's boxes for a name, by their labels; Instagram's one. */
const FIRST = /^first name\s*\*?$/i;
const MIDDLE = /^middle name( \(optional\))?\s*\*?$/i;
const LAST = /^(last name|surname)\s*\*?$/i;
const NAME = /^name\s*\*?$/i;
/** Facebook's button that shows the change before it's made. */
const REVIEW = /^review changes?$/i;
/** The network's box to be sure, after Done: pressed once, only when it has no box to type in. */
const CONFIRM = /^(change name|confirm)$/i;
/** An offer to change a profile's name on the other network too, as a tick or a switch. */
const TICKS = '[role="checkbox"], [role="switch"], input[type="checkbox"]';
/** How the name is shown, as Facebook asks it on the step after Review change. */
const RADIOS = '[role="radio"], input[type="radio"]';

/**
 * The network won't change the name now, as the page says before anything's typed: kept strict, so its help ("If you
 * change your name, you can't change it again for 60 days") is never taken for one.
 */
const LIMIT_NOW =
  /\b(can['’]?t|cannot|can not) (change|update) your name (right )?now\b|\b(change|update) your name again (on|in|after)\b|\btry again (in|after) \d+ (days?|weeks?)\b|\bchanged your name (recently|in the last \d+ days)\b|\bname was changed (recently|in the last)\b/i;
/** The same, as a new line after typing, Review change or Done says it. */
const LIMIT = new RegExp(
  `${LIMIT_NOW.source}|\\bcan only change your name (once|twice|\\d+ times)\\b|\\btoo many (times|changes)\\b|\\btry again later\\b|\\bchanged your name too (often|recently|many times)\\b`,
  'i',
);
/** Its name standards, as a new line says it: never the page's own advice ("Don't add any unusual…"). */
const INVALID =
  /\b(doesn['’]t|does not|may not|didn['’]t) (follow|meet)\b|\bunusual (capitali[sz]ation|characters|punctuation)\b|\btoo many (characters|words|periods)\b|\b(aren['’]t|isn['’]t|not) allowed\b|\binvalid\b|\b(isn['’]t|not) (a )?valid\b|\bcan['’]?t (include|contain) (symbols|numbers|characters)\b|\bcan['’]?t use (this|that) name\b/i;
const ADVICE = /^(don['’]t|do not|please note|learn more|note:)/i;
/** The network looks at the new name before it shows: never said to be in. */
const REVIEWING =
  /\b(being reviewed|under review|we['’]re reviewing|we['’]ll review|we will review|in review)\b|\bname change is pending\b/i;
const SAVED = /\b(your )?name (has been |was )?(updated|changed|saved)\b|\bchanges saved\b/i;

/** What the network said of the name, from new lines. */
export type NameAnswer = 'invalid' | 'limit' | 'review';

/**
 * What putting the name in found, step by step, for the job's note of the page (decision 74): never a word anyone
 * wrote, only counts, yes or no, and the names of the buttons there as the outline shows them.
 */
export interface NameSteps {
  /** What the network asked the person for first: their password, a code, or to confirm it's them. */
  readonly asking: Asking | null;
  /** How many boxes of each: on Facebook one First name, one Last name and at most one Middle name; on Instagram one Name. */
  readonly firstBoxes: number;
  readonly middleBoxes: number;
  readonly lastBoxes: number;
  readonly nameBoxes: number;
  /**
   * An offer to change the other network's profile's name too, never pressed and handed over: on the page, ticked, or
   * (with `pressed`) in the box after Done.
   */
  readonly sync: boolean;
  readonly typed: boolean;
  /** Facebook's Review change: how many, whether the one there was on, and whether it was pressed. */
  readonly reviews: number;
  readonly reviewOn: boolean;
  readonly reviewed: boolean;
  /** How the name is shown, on the step after Review change: a choice there kept, none picked, or no choice asked. */
  readonly order: 'kept' | 'unpicked' | 'none';
  readonly dones: number;
  readonly doneOn: boolean;
  /** What the network said of it, or none. */
  readonly answer: NameAnswer | 'none';
  /** Done pressed, and the network's box to be sure pressed after it. */
  readonly pressed: boolean;
  readonly confirmed: boolean;
  /** A box over the page after Done that it didn't know: left for the person to answer. */
  readonly over: boolean;
  readonly saved: boolean;
  readonly names: readonly string[];
}

export const NO_NAME_STEPS: NameSteps = {
  asking: null,
  firstBoxes: 0,
  middleBoxes: 0,
  lastBoxes: 0,
  nameBoxes: 0,
  sync: false,
  typed: false,
  reviews: 0,
  reviewOn: false,
  reviewed: false,
  order: 'none',
  dones: 0,
  doneOn: false,
  answer: 'none',
  pressed: false,
  confirmed: false,
  over: false,
  saved: false,
  names: [],
};

/** What's missing, in the extension's own words, for a note: empty when it all went. */
export function nameMissing(steps: NameSteps, network: CenterNetwork = 'facebook'): string[] {
  const name = PLATFORMS[network];
  if (steps.asking) return [askedNote(steps.asking, network)];
  if (network === 'facebook' && (steps.firstBoxes !== 1 || steps.lastBoxes !== 1))
    return [
      `${steps.firstBoxes} boxes named First name and ${steps.lastBoxes} named Last name, where one of each is wanted`,
    ];
  if (network === 'facebook' && steps.middleBoxes > 1)
    return [`${steps.middleBoxes} boxes named Middle name`];
  if (network === 'instagram' && steps.nameBoxes !== 1)
    return [steps.nameBoxes === 0 ? 'no box named Name' : `${steps.nameBoxes} boxes named Name`];
  if (steps.sync)
    return [
      steps.pressed
        ? `the box after Done offered to change the name on ${PLATFORMS[OTHER_NETWORK[network]]} too, and wasn’t pressed`
        : `an offer to change the name on ${PLATFORMS[OTHER_NETWORK[network]]} too was on, and left as it was`,
    ];
  if (!steps.typed) return ['writing the name in its boxes didn’t take'];
  if (network === 'facebook' && !steps.reviewed && !steps.pressed)
    return [steps.reviews === 1 ? 'Review change stayed off' : 'no Review change by the boxes'];
  if (steps.order === 'unpicked') return ['no choice picked of how the name is shown'];
  if (!steps.pressed)
    return [steps.dones === 1 ? 'Done stayed off' : `${steps.dones} Dones on the page`];
  if (steps.over) return [`${name} opened a box after Done that the extension doesn’t know`];
  return steps.saved || steps.answer === 'review' ? [] : ['Done didn’t save it'];
}

/** How putting the name in went. */
export type NameResult =
  /** In: the network took it. */
  | 'done'
  /** Their name already. */
  | 'already'
  /** Taken, but the network looks at it before it shows: never said to be in. */
  | 'review'
  /** The network asks for their password, a code, or to confirm it's them: the person answers, never the extension. */
  | 'waiting'
  /** The network won't take it (its name standards), or won't change it now: Done never pressed. */
  | 'invalid'
  | 'limit'
  /** A warning of the network's on the page: nothing typed. */
  | 'warned'
  /** Something wasn't as expected: the person does it. */
  | 'none'
  /** Done pressed, but it didn't save, or the network opened a box it doesn't know (`steps.over`). */
  | 'not_saved';

export interface NameWrote {
  readonly result: NameResult;
  readonly steps: NameSteps;
  /** The network's own words for its answer, as it said them. */
  readonly said: string | null;
  /** The network's warnings, when one stopped it. */
  readonly warnings?: readonly string[];
}

/** How long the boxes are waited for, the network's answer, each step's button, and the name saved. */
const WAIT_MS = 10_000;
const CHECK_MS = 10_000;
const SAVE_MS = 12_000;
/** A button on this long, with nothing said against the name: the network's say-so. */
const SETTLED_MS = 1_200;
/** The boxes on top again holding the new name this long after Done, with Done off: the network took it. */
const SAVED_SETTLED_MS = 4_000;
/** A box over the page after Done that it doesn't know, still there this long: the person's to answer. */
const OVER_MS = 3_000;

/** The name's boxes in the box on top, by their labels. */
interface Boxes {
  readonly first: readonly HTMLElement[];
  readonly middle: readonly HTMLElement[];
  readonly last: readonly HTMLElement[];
  readonly name: readonly HTMLElement[];
}

const boxesOf = (doc: Document): Boxes => ({
  first: boxesLabelled(doc, FIRST),
  middle: boxesLabelled(doc, MIDDLE),
  last: boxesLabelled(doc, LAST),
  name: boxesLabelled(doc, NAME),
});

/** Whether a tick or a choice is on. */
const isOn = (element: Element): boolean =>
  element.getAttribute('aria-checked') === 'true' ||
  (element.tagName === 'INPUT' && (element as HTMLInputElement).checked);

/** What a tick says it's for: its label, or the short line around it. */
function tickWords(tick: Element): string {
  const own = fieldName(tick);
  if (own) return own;
  for (let up = tick.parentElement, steps = 0; up && steps < 3; up = up.parentElement, steps++) {
    const words = clean(up.textContent);
    if (words && words.length <= 200) return words;
  }
  return '';
}

/** An offer on the page, on, to change the other network's profile's name too. */
function syncOn(doc: Document, network: CenterNetwork): boolean {
  return [...placesOf(doc)[0]!.querySelectorAll(TICKS)].some(
    (tick) => visible(tick) && isOn(tick) && othersToo([tickWords(tick)], network),
  );
}

/** What the network said of the name in these lines: the first that says it won't now, won't take it, or will look. */
function answerIn(
  lines: readonly string[],
): { readonly answer: NameAnswer; readonly said: string } | null {
  for (const [answer, words] of [
    ['limit', LIMIT],
    ['invalid', INVALID],
    ['review', REVIEWING],
  ] as const) {
    const line = lines.find((l) => words.test(l) && !ADVICE.test(l));
    if (line) return { answer, said: line.slice(0, 150) };
  }
  return null;
}

/** Whether the page shows this name, once its boxes are gone. */
const nameShown = (doc: Document, name: string): boolean =>
  textLines(doc.querySelector('[role="main"]') ?? doc.body, 200).some((line) => line === name);

/**
 * Puts the new name in on the name page the tab shows: its boxes filled in place of what was there, Facebook's Review
 * change pressed once it's on and the step after it left as Facebook has it, Done pressed once it's on, and the name
 * waited for. It types nothing else, anywhere, and nothing at all while the network asks the person for something
 * (`askingHere`); a warning stops it before anything else is read or pressed.
 */
export async function writeName(
  doc: Document,
  name: string,
  network: CenterNetwork = 'facebook',
): Promise<NameWrote> {
  const wanted = clean(name);
  const facebook = network === 'facebook';
  const parts = splitName(wanted);
  let steps: NameSteps = NO_NAME_STEPS;
  const end = (result: NameResult, said: string | null = null): NameWrote => ({
    result,
    said,
    steps: result === 'done' || result === 'already' ? steps : { ...steps, names: namesOn(doc) },
  });
  /** The network asking the person for something, or else a warning: how it ends then, or null. */
  const stopped = (): NameWrote | null => {
    const asking = askingHere(doc);
    if (asking) {
      steps = { ...steps, asking };
      return end('waiting');
    }
    const warnings = centerWarnings(doc, doc.location.href, network);
    return warnings.length ? { ...end('warned'), warnings } : null;
  };
  /** What the network said against the name in new lines on top: how it ends then, or null. */
  const refused = (seen: ReadonlySet<string>): NameWrote | null => {
    const said = answerIn(freshLines(placesOf(doc)[0]!, seen));
    if (!said || said.answer === 'review') return null;
    steps = { ...steps, answer: said.answer };
    return end(said.answer, said.said);
  };
  if (!wanted || /[\r\n]/.test(name) || nameProblem(network, wanted)) return end('invalid');
  // The boxes, as the page draws them; or the network asking for the password first, or a warning.
  let boxes = boxesOf(doc);
  for (let waited = 0; ; waited += EDITOR_LOOK_MS) {
    const stop = stopped();
    if (stop) return stop;
    boxes = boxesOf(doc);
    const found = facebook ? boxes.first.length + boxes.last.length : boxes.name.length;
    if (found || waited >= WAIT_MS) break;
    await pause(EDITOR_LOOK_MS);
  }
  steps = {
    ...steps,
    firstBoxes: boxes.first.length,
    middleBoxes: boxes.middle.length,
    lastBoxes: boxes.last.length,
    nameBoxes: boxes.name.length,
  };
  // The network won't change it now: said before anything's typed.
  const limit = [...linesOnTop(doc)].find((line) => line.length <= 300 && LIMIT_NOW.test(line));
  if (limit) return end('limit', limit.slice(0, 150));
  const fits = facebook
    ? boxes.first.length === 1 && boxes.last.length === 1 && boxes.middle.length <= 1
    : boxes.name.length === 1;
  if (!fits) return end('none');
  const writes: readonly (readonly [HTMLElement, string])[] = facebook
    ? [
        [boxes.first[0]!, parts.first],
        ...(boxes.middle[0] ? [[boxes.middle[0], ''] as const] : []),
        [boxes.last[0]!, parts.last],
      ]
    : [[boxes.name[0]!, wanted]];
  if (writes.some(([box]) => heldBox(box))) return end('limit');
  // An offer to change the other network's name too, on: never pressed, so the person decides.
  if (syncOn(doc, network)) {
    steps = { ...steps, sync: true };
    return end('none');
  }
  const holds = () => writes.every(([box, value]) => box.isConnected && valueOf(box) === value);
  if (holds()) {
    steps = { ...steps, typed: true };
    return end('already');
  }
  const before = linesOnTop(doc);
  for (const [box, value] of writes) typeInto(doc, box, value, true);
  await pause(300);
  steps = { ...steps, typed: holds() };
  if (!steps.typed) return end('none');

  // Facebook's Review change, once it's on and nothing's said against the name; Instagram has none.
  if (facebook) {
    let review: HTMLElement | null = null;
    for (let waited = 0; ; waited += EDITOR_LOOK_MS) {
      const stop = stopped() ?? refused(before);
      if (stop) return stop;
      const reviews = buttonsOnTop(doc, REVIEW);
      const on = reviews.length === 1 && shown(reviews[0]!);
      steps = { ...steps, reviews: reviews.length, reviewOn: on };
      if (on && waited >= SETTLED_MS) {
        review = reviews[0]!;
        break;
      }
      // No Review change at all, and Done on: the page saves it at once.
      if (!reviews.length && waited >= SETTLED_MS && doneButtons(doc).filter(shown).length === 1)
        break;
      if (waited >= CHECK_MS) return end('none');
      await pause(EDITOR_LOOK_MS);
    }
    if (review) {
      const late = stopped();
      if (late) return late;
      review.click();
      steps = { ...steps, reviewed: true };
    }
  }

  // Done, once it's on and nothing's said against the name; on Facebook's step after Review change, how the name is
  // shown left as it is, and none picked handed over.
  let done: HTMLElement | null = null;
  // The step after Review change, as Facebook draws it.
  if (steps.reviewed) await pause(EDITOR_LOOK_MS);
  for (let waited = 0; ; waited += EDITOR_LOOK_MS) {
    const stop = stopped() ?? refused(before);
    if (stop) return stop;
    if (syncOn(doc, network)) {
      steps = { ...steps, sync: true };
      return end('none');
    }
    const dones = doneButtons(doc);
    const on = dones.length === 1 && shown(dones[0]!);
    steps = { ...steps, dones: dones.length, doneOn: on };
    if (on && waited >= SETTLED_MS) {
      const radios = [...placesOf(doc)[0]!.querySelectorAll(RADIOS)].filter(visible);
      const order = !radios.length ? 'none' : radios.some(isOn) ? 'kept' : 'unpicked';
      steps = { ...steps, order };
      if (order === 'unpicked') return end('none');
      done = dones[0]!;
      break;
    }
    if (waited >= CHECK_MS) return end('none');
    await pause(EDITOR_LOOK_MS);
  }
  // Every line on top before Done: what the network says after it is new.
  const seen = new Set([...before, ...linesOnTop(doc)]);
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
    // The network took it and left the name page.
    if (centerPageOf(doc.location.href, network, 'name') === null) return saved();
    const top = placesOf(doc)[0]!;
    const fresh = freshLines(top, seen);
    const said = answerIn(fresh);
    if (said) {
      steps = { ...steps, answer: said.answer };
      return end(said.answer, said.said);
    }
    if (fresh.some((l) => SAVED.test(l))) return saved();
    // The name page again, its boxes holding the new name and its buttons off: the network took it. The job reads the
    // profile to be sure.
    const again = boxesOf(doc);
    const shownAgain = facebook
      ? again.first.length === 1 &&
        again.last.length === 1 &&
        valueOf(again.first[0]!) === parts.first &&
        valueOf(again.last[0]!) === parts.last
      : again.name.length === 1 && valueOf(again.name[0]!) === wanted;
    if (shownAgain) {
      overSince = null;
      const buttonsOn = [...buttonsOnTop(doc, REVIEW), ...doneButtons(doc)].some(shown);
      if (waited >= SAVED_SETTLED_MS && !buttonsOn) return saved();
      continue;
    }
    // Still the step Done is on, while it saves.
    if (done.isConnected && top.contains(done)) {
      overSince = null;
      continue;
    }
    if (top === doc.body) {
      // Nothing over the page and no boxes: in once the page shows it.
      overSince = null;
      if (nameShown(doc, wanted)) return saved();
      continue;
    }
    // A box over the page offering to change the other network's name too: never pressed, the person's to answer.
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
    overSince ??= waited;
    if (waited - overSince >= OVER_MS) {
      steps = { ...steps, over: true };
      return end('not_saved');
    }
  }
  // Still a box over the page it doesn't know: the person's to answer.
  const top = placesOf(doc)[0]!;
  if (top !== doc.body && !(done.isConnected && top.contains(done)))
    steps = { ...steps, over: true };
  return end('not_saved');
}
