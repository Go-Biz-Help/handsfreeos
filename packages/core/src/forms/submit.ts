/**
 * What a submitted form does to the business's records: who the answers say this is, which of their
 * fields the answers fill in, and the rows that make the Results screen quick.
 *
 * The rule throughout is that a form never overwrites something the business already knows with something
 * emptier. An answer fills a blank field and adds what wasn't there; it doesn't rub out a phone number
 * because the customer left that box empty this time.
 *
 * Reads the database, so it lives outside forms/index.ts (which stays browser-safe).
 */
import { sql as dsql } from 'drizzle-orm';
import { sql, type Tx } from '@hfos/db/client';
import { formAnswers } from '@hfos/db/schema';
import { normalizePhone } from '../crm/phone';
import { allQuestions, type FormDefinition, type Question } from './definition';
import type { AnswerSheet } from './logic';
import {
  customTargetFieldId,
  isCustomTarget,
  type AddressAnswer,
  type AnswerValue,
} from './questions';
import { isEmailAddress, type RecordedAnswer } from './render';
import { isBookingAnswer } from './booking';
import { watchedWords } from './video';

// ---- Who answered ----

export interface FormContact {
  readonly firstName: string;
  readonly lastName: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly address: AddressAnswer | null;
}

const text = (value: AnswerValue): string | null => {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return String(value);
  return null;
};

/**
 * The longest each of a customer's details can be (`schemas/person.ts`, `schemas/crm.ts`). A form's boxes allow
 * more (a short answer takes 120 characters, a town 120), and an answer that saves to the customer is cut to
 * fit rather than failing the whole submission over a few letters nobody will miss.
 */
export const PERSON_LIMITS = {
  name: 80,
  notes: 10_000,
  source: 80,
  line1: 200,
  line2: 200,
  city: 100,
  state: 50,
  postalCode: 20,
} as const;

/** Cut to fit, without leaving a space hanging off the end. */
export const fit = (value: string, max: number): string => value.slice(0, max).trim();

/** An address answer cut to fit the customer's address. */
function fitAddress(value: AddressAnswer): AddressAnswer {
  const part = (v: unknown, max: number) => (typeof v === 'string' ? fit(v, max) : '');
  return {
    line1: part(value.line1, PERSON_LIMITS.line1),
    line2: part(value.line2, PERSON_LIMITS.line2),
    city: part(value.city, PERSON_LIMITS.city),
    state: part(value.state, PERSON_LIMITS.state),
    postalCode: part(value.postalCode, PERSON_LIMITS.postalCode),
  };
}

const isAddress = (value: AnswerValue): value is AddressAnswer =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** What an answer says in words: a picked choice is its label (or what they typed under Other), not its id. */
function answerText(question: Question, value: AnswerValue): string | null {
  if (question.type === 'choice' && typeof value === 'string') {
    const choices = (question.config as { choices?: { id: string; label: string }[] }).choices;
    return choices?.find((c) => c.id === value)?.label ?? text(value);
  }
  return text(value);
}

/** The town an answer gives: a short answer's words, or the town out of an address. */
const cityOf = (value: AnswerValue): string | null =>
  isAddress(value) ? text((value as { city?: string }).city ?? null) : text(value);

/** The first answer to a question the business pointed at that field. */
function mapped(definition: FormDefinition, answers: AnswerSheet, target: string): AnswerValue {
  for (const question of allQuestions(definition))
    if (question.mapTo === target) {
      const value = answers[question.id];
      if (value !== undefined && value !== null && value !== '') return value;
    }
  return null;
}

/** The first answer to a question of that kind, for a business that mapped nothing. */
function firstOfType(
  definition: FormDefinition,
  answers: AnswerSheet,
  type: Question['type'],
): AnswerValue {
  for (const question of allQuestions(definition))
    if (question.type === type && !question.mapTo) {
      const value = answers[question.id];
      if (value !== undefined && value !== null && value !== '') return value;
    }
  return null;
}

/** The words of a short answer that asks for nothing but a name: "First name", "Your last name", "Full name:". */
const NAME_TITLES = {
  first: /^(your\s+)?first[\s-]*name\s*[?:*]?$/i,
  last: /^(your\s+)?(last|sur|family)[\s-]*name\s*[?:*]?$/i,
  whole: /^(your\s+)?(full\s+)?name\s*[?:*]?$/i,
} as const;

/** The first answer to a short answer nobody pointed anywhere whose words plainly ask for that name. */
function namedByTitle(
  definition: FormDefinition,
  answers: AnswerSheet,
  which: keyof typeof NAME_TITLES,
): AnswerValue {
  for (const question of allQuestions(definition))
    if (
      question.type === 'short_text' &&
      !question.mapTo &&
      NAME_TITLES[which].test(question.title.trim())
    ) {
      const value = answers[question.id];
      if (value !== undefined && value !== null && value !== '') return value;
    }
  return null;
}

/**
 * Who the answers say this is. The business's own mapping comes first; failing that, an email question is
 * an email address and a phone question is a phone number, because a business that drops an "Email" field
 * on a form plainly means it to reach the customer. A short answer called "First name" or "Last name" that
 * saves to nowhere is their name for the same reason.
 */
export function contactFromAnswers(definition: FormDefinition, answers: AnswerSheet): FormContact {
  const first = text(
    mapped(definition, answers, 'person.first_name') ??
      namedByTitle(definition, answers, 'first') ??
      namedByTitle(definition, answers, 'whole'),
  );
  const last = text(
    mapped(definition, answers, 'person.last_name') ?? namedByTitle(definition, answers, 'last'),
  );
  const email = text(
    mapped(definition, answers, 'person.email') ?? firstOfType(definition, answers, 'email'),
  );
  const typed = text(
    mapped(definition, answers, 'person.phone') ?? firstOfType(definition, answers, 'phone'),
  );
  // Matching is by E.164, so the number a customer typed in their own way finds the customer we have. Words
  // that aren't a number are no number at all: the page asks again before it gets here, and a customer's
  // record would refuse them.
  const phone = typed ? normalizePhone(typed) : null;
  const addressValue =
    mapped(definition, answers, 'person.address') ?? firstOfType(definition, answers, 'address');
  const answered = isAddress(addressValue) ? fitAddress(addressValue) : null;
  // A "City" box is their town, on its own or where the address left it out.
  const city = cityOf(mapped(definition, answers, 'person.city'));
  const address =
    city && !answered?.city
      ? fitAddress({ ...(answered ?? { line1: '', line2: '', state: '', postalCode: '' }), city })
      : answered;
  // "Dale Rivera" in one box is a first and a last name; one word is a first name.
  const whole = first && !last ? first.split(/\s+/) : null;
  return {
    firstName: fit(whole ? (whole[0] ?? '') : (first ?? ''), PERSON_LIMITS.name),
    lastName: fit(
      whole && whole.length > 1 ? whole.slice(1).join(' ') : (last ?? ''),
      PERSON_LIMITS.name,
    ),
    phone,
    // The page checks an email the same way the customer's record does, so this only drops one that slipped by.
    email: email && isEmailAddress(email) ? email : null,
    address,
  };
}

/** Whether a form that insists on knowing who somebody is has been told. */
export function hasIdentity(contact: FormContact): boolean {
  return Boolean(contact.phone || contact.email);
}

// ---- Filling in what the answers know ----

/** A customer's built-in fields an answer may fill, and what the answers said. */
export interface PersonPatch {
  readonly fields: Record<string, unknown>;
  /** The invented fields, by their id. */
  readonly custom: Record<string, unknown>;
}

/** The customer's own fields a short answer writes, and how long each can be. */
const PERSON_COLUMNS: Readonly<Record<string, { column: string; max: number }>> = {
  'person.first_name': { column: 'firstName', max: PERSON_LIMITS.name },
  'person.last_name': { column: 'lastName', max: PERSON_LIMITS.name },
  'person.email': { column: 'email', max: 254 },
  'person.phone': { column: 'phone', max: 40 },
  'person.phone_alt': { column: 'phoneAlt', max: 40 },
  'person.notes': { column: 'notes', max: PERSON_LIMITS.notes },
  'person.source': { column: 'source', max: PERSON_LIMITS.source },
};

/**
 * What the answers have to say about the customer and the lead, ready to be written. Every value fits the
 * record it's going on: words are cut to length, an email that isn't one is left out, a picked choice is its
 * label, and a town lands in their address, since that's where a customer's town is kept.
 */
export function patchesFromAnswers(
  definition: FormDefinition,
  answers: AnswerSheet,
): { person: PersonPatch; lead: PersonPatch } {
  const person: PersonPatch = { fields: {}, custom: {} };
  const lead: PersonPatch = { fields: {}, custom: {} };
  let city: string | null = null;
  for (const question of allQuestions(definition)) {
    const target = question.mapTo;
    if (!target) continue;
    const value = answers[question.id];
    if (value === undefined || value === null || value === '') continue;
    if (isCustomTarget(target)) {
      // Which record it belongs to is settled by the field itself; the caller knows which fields are leads'.
      person.custom[customTargetFieldId(target)] = value;
      lead.custom[customTargetFieldId(target)] = value;
      continue;
    }
    if (target === 'person.address') {
      if (isAddress(value as AnswerValue) && person.fields.address === undefined)
        person.fields.address = fitAddress(value as AddressAnswer);
      continue;
    }
    if (target === 'person.city') {
      city ??= cityOf(value as AnswerValue);
      continue;
    }
    if (target === 'lead.title') {
      const title = answerText(question, value as AnswerValue);
      if (title) lead.fields.title = title;
    } else if (target === 'lead.value') {
      const amount = Number(value);
      if (Number.isFinite(amount)) lead.fields.value = amount;
    } else {
      const known = PERSON_COLUMNS[target];
      const words = answerText(question, value as AnswerValue);
      if (!known || !words) continue;
      if (known.column === 'email' && !isEmailAddress(words)) continue;
      person.fields[known.column] = fit(words, known.max);
    }
  }
  if (city) {
    const address = (person.fields.address as AddressAnswer | undefined) ?? {
      line1: '',
      line2: '',
      city: '',
      state: '',
      postalCode: '',
    };
    if (!address.city) person.fields.address = fitAddress({ ...address, city });
  }
  return { person, lead };
}

/**
 * Writes the invented fields onto a record, merging rather than replacing: another form, or somebody
 * typing, keeps whatever it filled in. Only fields that belong to that kind of record are written.
 */
export async function writeCustomFields(
  tx: Tx,
  table: 'people' | 'leads',
  recordId: string,
  values: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): Promise<string[]> {
  const patch = Object.fromEntries(Object.entries(values).filter(([id]) => allowed.has(id)));
  const keys = Object.keys(patch);
  if (!keys.length) return [];
  await tx.execute(
    sql`update ${sql.raw(`app.${table}`)} set custom = custom || ${JSON.stringify(patch)}::jsonb
        where id = ${recordId}`,
  );
  return keys;
}

// ---- The rows behind the Results screen ----

/** One row per answer, with the question's wording as it read when they answered. */
export async function writeFormAnswers(
  tx: Tx,
  where: { workspaceId: string; responseId: string; formId: string },
  recorded: readonly RecordedAnswer[],
): Promise<number> {
  const rowsToWrite = recorded
    .filter((answer) => answer.value !== null && answer.value !== '')
    .map((answer) => ({
      workspaceId: where.workspaceId,
      responseId: where.responseId,
      formId: where.formId,
      questionId: answer.questionId,
      questionTitle: answer.title,
      questionType: answer.type,
      value: answer.value as never,
      numberValue: numberFor(answer),
      textValue: textFor(answer),
      choiceIds: answer.labels.length ? pickedIds(answer) : [],
      choiceLabels: [...answer.labels],
    }));
  if (!rowsToWrite.length) return 0;
  await tx
    .insert(formAnswers)
    .values(rowsToWrite)
    .onConflictDoUpdate({
      target: [formAnswers.responseId, formAnswers.questionId],
      set: {
        value: dsql`excluded.value`,
        numberValue: dsql`excluded.number_value`,
        textValue: dsql`excluded.text_value`,
        choiceIds: dsql`excluded.choice_ids`,
        choiceLabels: dsql`excluded.choice_labels`,
        questionTitle: dsql`excluded.question_title`,
        answeredAt: dsql`now()`,
      },
    });
  return rowsToWrite.length;
}

const pickedIds = (answer: RecordedAnswer): string[] =>
  Array.isArray(answer.value)
    ? answer.value.map(String)
    : typeof answer.value === 'string'
      ? [answer.value]
      : [];

/** The number a summary averages: the answer itself, or how many boxes were ticked. */
function numberFor(answer: RecordedAnswer): string | null {
  if (typeof answer.value === 'number') return String(answer.value);
  if (typeof answer.value === 'boolean') return answer.value ? '1' : '0';
  if (Array.isArray(answer.value)) return String(answer.value.length);
  if (typeof answer.value === 'string' && answer.value.trim() !== '') {
    const n = Number(answer.value);
    return Number.isFinite(n) ? String(n) : null;
  }
  return null;
}

/** The answer as words, for the text summaries and the export. */
function textFor(answer: RecordedAnswer): string | null {
  if (answer.labels.length) return answer.labels.join(', ');
  if (answer.type === 'video' && typeof answer.value === 'number')
    return watchedWords(answer.value);
  if (answer.type === 'booking' && isBookingAnswer(answer.value)) return answer.value.label;
  if (typeof answer.value === 'string') return answer.value.slice(0, 5000);
  if (typeof answer.value === 'number') return String(answer.value);
  if (typeof answer.value === 'boolean') return answer.value ? 'Yes' : 'No';
  if (answer.value && typeof answer.value === 'object' && !Array.isArray(answer.value)) {
    const parts = Object.values(answer.value as Record<string, unknown>)
      .filter((v) => typeof v === 'string' && v.trim() !== '')
      .join(', ');
    return parts.slice(0, 5000) || null;
  }
  return null;
}
