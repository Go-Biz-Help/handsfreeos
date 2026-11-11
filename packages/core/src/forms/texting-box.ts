/**
 * **A form never needs a texting box of its own** (2026-11-11). Every form that asks who they are already shows
 * ours under the questions (`smsConsentWords` in messaging/consent.ts): worded the way the carriers approved, quoted
 * word for word in the texting registration, never ticked for them, never required, and the only box whose yes is
 * saved on the customer (`recordSmsConsent`). A Single checkbox the business adds asking the same thing is just an
 * answer. Customers then see two boxes saying different things, and a reviewer sees words that don't match what the
 * registration quotes. Worse, the add menu starts a Single checkbox required, and carriers turn down a texting box
 * that has to be ticked to send the form.
 *
 * That happened: Shop Your Solar's contact form had a required box holding an older, weaker line the Texting page
 * once suggested copying, beside ours. So the editor (and the Assistant's get_form) points such a question out,
 * with a button to delete it. It's a warning, never a blocker: the words are only a guess at what a question means.
 *
 * Browser-safe: the editor works it out as they type.
 */
import { allQuestions, type FormDefinition, type Question } from './definition';

/** Words about texting: "texts", "text messages", "SMS", "text me". */
const TEXTING = /\b(texts?|texting|text messages?|sms|txts?)\b/i;
/** Words asking for permission, rather than asking about a text. */
const ASKING =
  /\b(agree|agrees|agreeing|consent|permission|receive|opt|opt-in|stop|ok|okay|allow|subscribe|sign me up|text me|(can|may) we)\b/i;

/** Whether this form shows our texting box: any form that asks who they are, except a live poll (no public page). */
export function showsOurTextingBox(definition: Pick<FormDefinition, 'mode' | 'settings'>): boolean {
  return definition.mode !== 'poll' && definition.settings.identity !== 'anonymous';
}

/** Whether a question reads like a box asking for permission to text: a yes or no that talks about texts and agreeing. */
export function looksLikeTextingBox(question: Pick<Question, 'type' | 'title' | 'help'>): boolean {
  if (question.type !== 'yes_no') return false;
  const words = `${question.title} ${question.help ?? ''}`;
  return TEXTING.test(words) && ASKING.test(words);
}

/** A question asking for permission to text on a form that already shows our box. */
export interface TextingBoxTwice {
  readonly questionId: string;
  readonly title: string;
  /** It must be checked to send the form, which carriers turn down for a texting box. */
  readonly required: boolean;
}

/** Every question on this form that asks for permission to text when our box already does. */
export function textingBoxesTwice(
  definition: Pick<FormDefinition, 'mode' | 'settings' | 'pages'>,
): TextingBoxTwice[] {
  if (!showsOurTextingBox(definition)) return [];
  return allQuestions(definition)
    .filter(looksLikeTextingBox)
    .map((q) => ({ questionId: q.id, title: q.title, required: q.required }));
}
