/**
 * An answer sheet in words: where it came from and what each answer says. The phone's answers list and answer sheet
 * show them, and the Assistant reads them out (get_form_response, list_form_responses). Browser-safe.
 */
import type { QuestionType } from './questions';

/** Where an answer sheet came from, as the line under it says it. */
export const FORM_SOURCE_WORDS: Readonly<Record<string, string>> = {
  link: 'from the link',
  qr: 'from the QR code',
  embed: 'on your website',
  chat: 'in a conversation',
  app: 'on the phone',
  api: 'from another app',
  video_call: 'in a video call',
};

/** One answer from `form.response_get`. */
export interface AnswerInput {
  readonly questionType: string;
  readonly value: unknown;
  readonly text: string | null;
  readonly labels: readonly string[];
}

/** Kinds of answer that are a thing to look at rather than read: a file, a signature, a card payment. */
export const ANSWERS_SHOWN_ON_THE_WEB: ReadonlySet<string> = new Set([
  'file',
  'signature',
  'payment',
]);

/**
 * An answer in words: the choices picked, else the words the server kept for it (`form_answers.text_value`), else
 * what the value plainly is. A file or a signature is a thing to look at rather than read, so it says where to.
 */
export function answerWords(answer: AnswerInput): string {
  if (answer.labels.length) return answer.labels.join(', ');
  if (answer.text?.trim()) return answer.text;
  if (ANSWERS_SHOWN_ON_THE_WEB.has(answer.questionType))
    return 'Open it on the web to see this one.';
  if (typeof answer.value === 'boolean') return answer.value ? 'Yes' : 'No';
  if (typeof answer.value === 'number') return String(answer.value);
  if (typeof answer.value === 'string' && answer.value.trim()) return answer.value;
  return 'No answer';
}

/**
 * Questions a teammate can't answer for a customer: on the phone's Fill it in, or by asking the Assistant. A signature
 * wants a canvas, a file the camera roll, a payment a card sheet, a video the player that tells how much was watched,
 * and a time to book the calendar's open times. A form with one showing is filled in on the web, or by the customer.
 */
export const NOT_FILLED_IN_FOR_THEM: readonly QuestionType[] = [
  'file',
  'signature',
  'payment',
  'video',
  'booking',
  'button',
];
