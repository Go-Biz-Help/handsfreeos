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
import type { RecordedAnswer } from './render';
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

/**
 * Who the answers say this is. The business's own mapping comes first; failing that, an email question is
 * an email address and a phone question is a phone number, because a business that drops an "Email" field
 * on a form plainly means it to reach the customer.
 */
export function contactFromAnswers(definition: FormDefinition, answers: AnswerSheet): FormContact {
  const first = text(mapped(definition, answers, 'person.first_name'));
  const last = text(mapped(definition, answers, 'person.last_name'));
  const email = text(
    mapped(definition, answers, 'person.email') ?? firstOfType(definition, answers, 'email'),
  );
  const typed = text(
    mapped(definition, answers, 'person.phone') ?? firstOfType(definition, answers, 'phone'),
  );
  // Matching is by E.164, so the number a customer typed in their own way finds the customer we have.
  const phone = typed ? (normalizePhone(typed) ?? typed) : null;
  const addressValue =
    mapped(definition, answers, 'person.address') ?? firstOfType(definition, answers, 'address');
  const address =
    addressValue && typeof addressValue === 'object' && !Array.isArray(addressValue)
      ? (addressValue as AddressAnswer)
      : null;
  // "Dale Rivera" in one box is a first and a last name; one word is a first name.
  const whole = first && !last ? first.split(/\s+/) : null;
  return {
    firstName: whole ? (whole[0] ?? '') : (first ?? ''),
    lastName: whole && whole.length > 1 ? whole.slice(1).join(' ') : (last ?? ''),
    phone,
    email,
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

const PERSON_COLUMNS: Readonly<Record<string, string>> = {
  'person.first_name': 'firstName',
  'person.last_name': 'lastName',
  'person.email': 'email',
  'person.phone': 'phone',
  'person.phone_alt': 'phoneAlt',
  'person.city': 'city',
  'person.notes': 'notes',
};

/** What the answers have to say about the customer and the lead, ready to be written. */
export function patchesFromAnswers(
  definition: FormDefinition,
  answers: AnswerSheet,
): { person: PersonPatch; lead: PersonPatch } {
  const person: PersonPatch = { fields: {}, custom: {} };
  const lead: PersonPatch = { fields: {}, custom: {} };
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
    if (target === 'person.address' && typeof value === 'object') {
      person.fields.address = value;
      continue;
    }
    if (target === 'lead.title') lead.fields.title = text(value as AnswerValue);
    else if (target === 'lead.value') lead.fields.value = Number(value);
    else {
      const column = PERSON_COLUMNS[target];
      if (column) person.fields[column] = text(value as AnswerValue) ?? value;
    }
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
