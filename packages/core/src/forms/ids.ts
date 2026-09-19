/**
 * Stable ids inside a form: questions, pages, choices, calculations and results. An id is made once and
 * never changes, so answers already given, the Describe diff and agency template updates can all follow a
 * question that is renamed, re-worded or moved to another page. Browser-safe.
 */
import { z } from 'zod';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

const shape = (prefix: string) => new RegExp(`^${prefix}_[a-z0-9]{8}$`);
const idSchema = (prefix: string, what: string) =>
  z
    .string()
    .regex(shape(prefix), { error: `A ${what} id is ${prefix}_ and 8 lowercase letters or digits.` });

export const QUESTION_ID_RE = shape('q');
export const PAGE_ID_RE = shape('p');
export const CHOICE_ID_RE = shape('c');
export const CALCULATION_ID_RE = shape('k');
export const RESULT_ID_RE = shape('r');

export const QuestionId = idSchema('q', 'question');
export const PageId = idSchema('p', 'page');
export const ChoiceId = idSchema('c', 'choice');
export const CalculationId = idSchema('k', 'calculation');
export const ResultId = idSchema('r', 'result');

function randomChars(count: number, random?: () => number): string {
  let out = '';
  if (random) {
    for (let i = 0; i < count; i++) out += ALPHABET[Math.floor(random() * ALPHABET.length)];
    return out;
  }
  const bytes = crypto.getRandomValues(new Uint8Array(count));
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export function newQuestionId(random?: () => number): string {
  return `q_${randomChars(8, random)}`;
}

export function newPageId(random?: () => number): string {
  return `p_${randomChars(8, random)}`;
}

export function newChoiceId(random?: () => number): string {
  return `c_${randomChars(8, random)}`;
}

export function newCalculationId(random?: () => number): string {
  return `k_${randomChars(8, random)}`;
}

export function newResultId(random?: () => number): string {
  return `r_${randomChars(8, random)}`;
}
