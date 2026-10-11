/**
 * Asking to join a group (docs/outreach.md, decisions 31 and 48), in the window the extension works in: on the group's
 * page it presses **Join group**; when Facebook asks the group's questions in a box over the page, it reads them for
 * the AI, writes the AI's answers into their boxes, ticks that the person agrees to the group's rules, and presses
 * **Submit**. Nothing else is pressed. A question to pick from a list it leaves to the person: the ask fails, saying so.
 */
import { clean, labelOf } from './dom';
import { shown } from './fetch';

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** How long the questions are looked for after Join group is pressed, and the box is waited on to close. */
const WAIT_MS = 6_000;
const LOOK_MS = 300;

const JOIN = /^(join group|join)$/i;
const JOINED = /^joined$/i;
const ASKED = /^(cancel request|pending|requested)$/i;
const SUBMIT = /^(submit|submit answers|send|done)$/i;
const AGREE = /\bagree\b/i;
/** Words in a box to write in that say nothing about the question. */
const PLACEHOLDER = /^(write an answer|your answer|answer)\b/i;

const mainOf = (doc: Document): Element => doc.querySelector('[role="main"]') ?? doc.body;

/** The box over the page with the group's questions, while it's open. */
function questionsBox(doc: Document): Element | null {
  return (
    [...doc.querySelectorAll('[role="dialog"]')]
      .filter(shown)
      .reverse()
      .find((d) => d.querySelector('textarea, [role="textbox"], [contenteditable="true"]')) ?? null
  );
}

/** The boxes to write answers in, in order. */
function answerBoxes(box: Element): HTMLElement[] {
  return [
    ...box.querySelectorAll<HTMLElement>('textarea, [role="textbox"], [contenteditable="true"]'),
  ].filter(shown);
}

/** The question a box answers: its label when that says more than "Write an answer…", else the words just before it. */
function questionOf(answer: Element, box: Element): string | null {
  const label = clean(answer.getAttribute('aria-label'));
  if (label && !PLACEHOLDER.test(label)) return label;
  let found: string | null = null;
  const walker = box.ownerDocument.createTreeWalker(box, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || answer.contains(parent)) continue;
    if (answer.compareDocumentPosition(parent) & 4 /* FOLLOWING */) break;
    if (parent.closest('[role="button"], button, h1, h2')) continue;
    const text = clean(node.textContent);
    if (text && !PLACEHOLDER.test(text)) found = text;
  }
  return found;
}

/** What pressing Join group came to. */
export type JoinStep =
  /** Facebook asks these questions first. */
  | { readonly result: 'questions'; readonly questions: string[] }
  /** Asked: no questions, so it's done, joined or waiting for the admins. */
  | { readonly result: 'asked' }
  /** In it already, or asked already and waiting. */
  | { readonly result: 'already'; readonly joined: boolean }
  /** No Join group to press. */
  | { readonly result: 'none' }
  /** It asks something to pick from a list: the person answers that one. */
  | { readonly result: 'choices' };

/** Presses Join group on the group's page, and waits a moment for the questions Facebook asks first. */
export async function pressJoin(doc: Document): Promise<JoinStep> {
  const buttons = [...mainOf(doc).querySelectorAll('[role="button"], button')].filter(shown);
  if (buttons.some((b) => JOINED.test(labelOf(b)))) return { result: 'already', joined: true };
  if (buttons.some((b) => ASKED.test(labelOf(b)))) return { result: 'already', joined: false };
  const join = buttons.find((b) => JOIN.test(labelOf(b)));
  if (!join) return { result: 'none' };
  (join as HTMLElement).click();
  for (let waited = 0; waited < WAIT_MS; waited += LOOK_MS) {
    await pause(LOOK_MS);
    const box = questionsBox(doc);
    if (!box) continue;
    if (box.querySelector('[role="radio"], input[type="radio"]')) return { result: 'choices' };
    const questions = answerBoxes(box).map((a, i) => questionOf(a, box) ?? `Question ${i + 1}`);
    return { result: 'questions', questions };
  }
  return { result: 'asked' };
}

/** Writes into a box to write in, as typing would: a plain box's value, or the text a rich box holds. */
function typeInto(doc: Document, box: HTMLElement, text: string): void {
  box.focus();
  if (box instanceof doc.defaultView!.HTMLTextAreaElement || box.tagName === 'INPUT') {
    const proto = Object.getPrototypeOf(box) as object;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(box, text);
    else (box as HTMLTextAreaElement).value = text;
    box.dispatchEvent(new doc.defaultView!.Event('input', { bubbles: true }));
    return;
  }
  doc.execCommand('insertText', false, text);
}

/**
 * Answers the group's questions with these, in order, ticks that the person agrees to its rules, and presses Submit;
 * then waits for the box to close. `done` once it has; `not_sent` when it stayed open; `none` with no questions open.
 */
export async function answerJoin(
  doc: Document,
  answers: readonly string[],
): Promise<'done' | 'not_sent' | 'none'> {
  const box = questionsBox(doc);
  if (!box) return 'none';
  for (const [i, answer] of answerBoxes(box).entries()) {
    if (answers[i] === undefined) break;
    typeInto(doc, answer, answers[i]!);
    await pause(200);
  }
  // "I agree to the group rules": a box to tick, by the words beside it.
  for (const tick of box.querySelectorAll<HTMLElement>(
    '[role="checkbox"], input[type="checkbox"]',
  )) {
    const words = clean(tick.parentElement?.textContent) || labelOf(tick);
    const ticked =
      tick.getAttribute('aria-checked') === 'true' || (tick as HTMLInputElement).checked === true;
    if (AGREE.test(words) && !ticked) tick.click();
  }
  const submit = [...box.querySelectorAll('[role="button"], button')].find(
    (b) => SUBMIT.test(labelOf(b)) && shown(b),
  );
  if (!submit) return 'not_sent';
  (submit as HTMLElement).click();
  for (let waited = 0; waited < WAIT_MS; waited += LOOK_MS) {
    await pause(LOOK_MS);
    if (!questionsBox(doc)) return 'done';
  }
  return 'not_sent';
}
