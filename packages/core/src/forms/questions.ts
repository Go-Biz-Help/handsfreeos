/**
 * The question catalog: what a form can ask, with a zod config per type, and where an answer can be
 * written on the customer's record. One catalog serves all three modes — a form, a survey and a quiz ask
 * the same questions, they only differ in what happens with the answers. Browser-safe, so the editor, the
 * public page and the server all check a question the same way.
 */
import { z } from 'zod';
import { CalculationId, ChoiceId, QuestionId, ResultId } from './ids';

export const QUESTION_TYPES = [
  'short_text',
  'long_text',
  'choice',
  'checkboxes',
  'yes_no',
  'number',
  'money',
  'date',
  'time',
  'rating',
  'scale',
  'email',
  'phone',
  'address',
  'file',
  'signature',
  'content',
  'payment',
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const QUESTION_LABELS: Readonly<Record<QuestionType, string>> = {
  short_text: 'Short answer',
  long_text: 'Long answer',
  choice: 'Pick one',
  checkboxes: 'Pick any',
  yes_no: 'Yes or no',
  number: 'Number',
  money: 'Amount',
  date: 'Date',
  time: 'Time',
  rating: 'Rating',
  scale: 'Scale',
  email: 'Email',
  phone: 'Phone',
  address: 'Address',
  file: 'Upload',
  signature: 'Signature',
  content: 'Text on the page',
  payment: 'Payment',
};

// ---- Choices ----

/**
 * One choice on a pick-one or pick-any question. It carries everything the three modes need: `correct`
 * and `points` grade a quiz, `value` feeds calculations (a price, a number of rooms), and `resultId`
 * votes for an outcome.
 */
export const QuestionChoice = z.object({
  id: ChoiceId,
  label: z.string().trim().min(1, 'Name the choice.').max(160),
  /** Quiz mode: picking this is right. */
  correct: z.boolean().default(false),
  /** What picking it is worth, for a score. */
  points: z.number().min(-10_000).max(10_000).default(0),
  /** What picking it is worth in a calculation (dollars, hours, square feet). */
  value: z.number().min(-1_000_000_000).max(1_000_000_000).nullable().default(null),
  /** Outcome quizzes: the result this choice argues for. */
  resultId: ResultId.nullable().default(null),
});
export type QuestionChoice = z.infer<typeof QuestionChoice>;
export type QuestionChoiceInput = z.input<typeof QuestionChoice>;

export const MAX_CHOICES = 60;
const choices = z
  .array(QuestionChoice)
  .min(2, 'Add at least two choices.')
  .max(MAX_CHOICES)
  .refine((list) => new Set(list.map((c) => c.id)).size === list.length, {
    error: 'Each choice needs its own id.',
  });

const placeholder = z.string().trim().max(120).default('');

// ---- The config each type carries ----

export const QUESTION_CONFIGS = {
  short_text: z.object({ placeholder, maxLength: z.int().min(1).max(500).default(120) }),
  long_text: z.object({ placeholder, maxLength: z.int().min(1).max(5000).default(2000) }),
  choice: z.object({
    choices,
    display: z.enum(['list', 'dropdown', 'buttons']).default('list'),
    /** Show the choices in a different order each time (quizzes, honest surveys). */
    shuffle: z.boolean().default(false),
    /** Let them write their own answer instead. */
    allowOther: z.boolean().default(false),
  }),
  checkboxes: z.object({
    choices,
    shuffle: z.boolean().default(false),
    allowOther: z.boolean().default(false),
    /** How many they must pick; null is no limit. */
    min: z.int().min(1).max(MAX_CHOICES).nullable().default(null),
    max: z.int().min(1).max(MAX_CHOICES).nullable().default(null),
  }),
  yes_no: z.object({
    yesLabel: z.string().trim().min(1).max(40).default('Yes'),
    noLabel: z.string().trim().min(1).max(40).default('No'),
    /** Quiz mode: the right answer, or null when it isn't graded. */
    correct: z.enum(['yes', 'no']).nullable().default(null),
    points: z.number().min(-10_000).max(10_000).default(0),
  }),
  number: z.object({
    min: z.number().min(-1_000_000_000).max(1_000_000_000).nullable().default(null),
    max: z.number().min(-1_000_000_000).max(1_000_000_000).nullable().default(null),
    decimals: z.int().min(0).max(4).default(0),
    /** What the number counts, shown beside the box: "sq ft", "rooms", "miles". */
    unit: z.string().trim().max(24).default(''),
    placeholder,
  }),
  money: z.object({
    /** Whole dollars in the editor; the answer is kept in cents. */
    min: z.number().min(0).max(1_000_000_000).nullable().default(null),
    max: z.number().min(0).max(1_000_000_000).nullable().default(null),
    placeholder,
  }),
  date: z.object({
    /** Which days they may pick: any, only past ones (a birth date), only future ones (a start date). */
    range: z.enum(['any', 'past', 'future']).default('any'),
  }),
  time: z.object({}),
  rating: z.object({
    max: z.int().min(3).max(10).default(5),
    icon: z.enum(['star', 'heart', 'number']).default('star'),
  }),
  scale: z.object({
    min: z.int().min(0).max(1).default(1),
    max: z.int().min(3).max(10).default(10),
    minLabel: z.string().trim().max(40).default(''),
    maxLabel: z.string().trim().max(40).default(''),
  }),
  email: z.object({ placeholder }),
  phone: z.object({ placeholder }),
  address: z.object({
    /** Ask for the street, or just the town and postcode (a service-area check). */
    detail: z.enum(['full', 'city_postal']).default('full'),
  }),
  file: z.object({
    maxFiles: z.int().min(1).max(10).default(3),
    maxMb: z.int().min(1).max(25).default(10),
    accept: z.enum(['image', 'document', 'any']).default('any'),
  }),
  signature: z.object({
    /** What they are agreeing to, above the box. */
    statement: z.string().trim().min(1, 'Say what they are signing.').max(2000),
  }),
  content: z.object({
    body: z.string().trim().min(1, 'Write something.').max(5000),
  }),
  payment: z.object({
    /** Fixed cents, a calculation's answer, or an amount they were asked for. */
    amount: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('fixed'), cents: z.int().min(50).max(100_000_000) }),
      z.object({ kind: z.literal('calculation'), calculationId: CalculationId }),
      z.object({ kind: z.literal('question'), questionId: QuestionId }),
    ]),
    /** Take a share of it now (a deposit); null takes it all. */
    depositPercent: z.int().min(1).max(99).nullable().default(null),
    /** What the charge is for, on their card statement and the receipt. */
    description: z.string().trim().min(1, 'Say what the payment is for.').max(200),
  }),
} as const satisfies Record<QuestionType, z.ZodType>;

export type QuestionConfig<T extends QuestionType = QuestionType> = z.infer<
  (typeof QUESTION_CONFIGS)[T]
>;

/** Types whose answer is one of a listed set. */
export const CHOICE_TYPES: ReadonlySet<QuestionType> = new Set(['choice', 'checkboxes']);

/** Types that ask nothing, so they are never required and never hold an answer. */
export const UNANSWERED_TYPES: ReadonlySet<QuestionType> = new Set(['content']);

/** Types whose answer is a number the logic can do arithmetic with. */
export const NUMERIC_TYPES: ReadonlySet<QuestionType> = new Set([
  'number',
  'money',
  'rating',
  'scale',
]);

/** Types that can be graded right or wrong. */
export const GRADEABLE_TYPES: ReadonlySet<QuestionType> = new Set([
  'choice',
  'checkboxes',
  'yes_no',
]);

// ---- Where an answer can be written ----

/**
 * The customer's fields a question can fill in. There is no custom-field table yet, so an answer with no
 * target still lives on the response and is shown on the customer's timeline — nothing is lost, it just
 * isn't a column.
 */
export const ANSWER_TARGETS = {
  'person.first_name': { label: 'First name', accepts: ['short_text'] },
  'person.last_name': { label: 'Last name', accepts: ['short_text'] },
  'person.email': { label: 'Email', accepts: ['email', 'short_text'] },
  'person.phone': { label: 'Phone', accepts: ['phone', 'short_text'] },
  'person.phone_alt': { label: 'Other phone', accepts: ['phone', 'short_text'] },
  'person.address': { label: 'Address', accepts: ['address'] },
  'person.city': { label: 'City', accepts: ['short_text', 'address'] },
  'person.notes': { label: 'Notes', accepts: ['long_text', 'short_text'] },
  'person.source': { label: 'Where they came from', accepts: ['short_text', 'choice'] },
  'lead.title': { label: 'Lead title', accepts: ['short_text', 'choice'] },
  'lead.value': { label: 'Lead value', accepts: ['money', 'number'] },
} as const satisfies Record<string, { label: string; accepts: readonly QuestionType[] }>;
export type AnswerTargetKey = keyof typeof ANSWER_TARGETS;
export const ANSWER_TARGET_KEYS = Object.keys(ANSWER_TARGETS) as [
  AnswerTargetKey,
  ...AnswerTargetKey[],
];
export const AnswerTarget = z.enum(ANSWER_TARGET_KEYS);

/** Whether that question's answer can go in that field. */
export function targetAccepts(target: AnswerTargetKey, type: QuestionType): boolean {
  return (ANSWER_TARGETS[target].accepts as readonly QuestionType[]).includes(type);
}

// ---- Answers ----

/** One uploaded file on an answer. */
export const AnswerFile = z.object({
  fileId: z.uuid(),
  name: z.string().trim().min(1).max(260),
  bytes: z.int().min(0).max(26_214_400),
});
export type AnswerFile = z.infer<typeof AnswerFile>;

export const SignatureAnswer = z.object({
  /** They type their name; that plus the time and the statement is the signature (same as M9's Accept). */
  name: z.string().trim().min(1, 'Type your name.').max(120),
  signedAt: z.iso.datetime(),
});
export type SignatureAnswer = z.infer<typeof SignatureAnswer>;

export const AddressAnswer = z.object({
  line1: z.string().trim().max(200).default(''),
  line2: z.string().trim().max(200).default(''),
  city: z.string().trim().max(120).default(''),
  state: z.string().trim().max(60).default(''),
  postalCode: z.string().trim().max(20).default(''),
});
export type AddressAnswer = z.infer<typeof AddressAnswer>;

/**
 * What one answer looks like once it is given. `choice` keeps the choice id (so the wording can change
 * afterwards) and `other` keeps what they typed instead.
 */
export type AnswerValue =
  | string
  | number
  | boolean
  | readonly string[]
  | AddressAnswer
  | SignatureAnswer
  | readonly AnswerFile[]
  | null;

/** Nothing was answered: no value, an empty string, or an empty list. */
export function answerIsEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}
