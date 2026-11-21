import {
  FORM_MODE_LABELS,
  isSingleCheckbox,
  NAME_QUESTIONS,
  nameQuestionOf,
  publicFormPath,
  QUESTION_LABELS,
  SINGLE_CHECKBOX_LABEL,
  type FormMode,
  type QuestionType,
} from '@hfos/core';
import {
  AlignLeft,
  AtSign,
  Calendar,
  CalendarCheck,
  Circle,
  Clock,
  CreditCard,
  FileUp,
  Film,
  Hash,
  Heading,
  ListChecks,
  ListOrdered,
  MapPin,
  MousePointerClick,
  PenLine,
  Phone,
  SlidersHorizontal,
  SquareCheck,
  Star,
  ToggleLeft,
  Type,
  UserRound,
  type LucideIcon,
} from 'lucide-react';

/** What each kind of question is called and the icon that stands for it in the list. */
export const QUESTION_ICONS: Readonly<Record<QuestionType, LucideIcon>> = {
  short_text: Type,
  long_text: AlignLeft,
  choice: Circle,
  checkboxes: ListChecks,
  yes_no: ToggleLeft,
  number: Hash,
  money: CreditCard,
  date: Calendar,
  time: Clock,
  rating: Star,
  scale: SlidersHorizontal,
  email: AtSign,
  phone: Phone,
  address: MapPin,
  file: FileUp,
  signature: PenLine,
  content: Heading,
  payment: CreditCard,
  video: Film,
  booking: CalendarCheck,
  button: MousePointerClick,
  quantities: ListOrdered,
};

export { QUESTION_LABELS, FORM_MODE_LABELS };

/** The icon for a question in the list: a yes or no shown as one box gets the box, a name box the person. */
export const questionIcon = (question: {
  type: QuestionType;
  config?: unknown;
  mapTo?: string | null;
}): LucideIcon =>
  isSingleCheckbox(question)
    ? SquareCheck
    : nameQuestionOf(question)
      ? UserRound
      : QUESTION_ICONS[question.type];

/**
 * A row in the "add a question" menu: a kind of question; `single_checkbox`, which is a yes or no shown as one
 * box to check ("I agree to the terms"); or `first_name` and `last_name`, short answers saved as the customer's name
 * (`NAME_QUESTIONS`). They have rows of their own because that's what people look for.
 */
export type QuestionMenuItem = QuestionType | 'single_checkbox' | 'first_name' | 'last_name';

export const menuItemLabel = (item: QuestionMenuItem): string =>
  item === 'single_checkbox'
    ? SINGLE_CHECKBOX_LABEL
    : item === 'first_name' || item === 'last_name'
      ? NAME_QUESTIONS[item].label
      : QUESTION_LABELS[item];

export const menuItemIcon = (item: QuestionMenuItem): LucideIcon =>
  item === 'single_checkbox'
    ? SquareCheck
    : item === 'first_name' || item === 'last_name'
      ? UserRound
      : QUESTION_ICONS[item];

/** The question types offered in the "add a question" menu, in the order people reach for them. */
export const QUESTION_MENU: readonly { group: string; types: readonly QuestionMenuItem[] }[] = [
  {
    group: 'Asking',
    types: ['short_text', 'long_text', 'choice', 'checkboxes', 'single_checkbox', 'yes_no'],
  },
  {
    group: 'Details',
    types: ['first_name', 'last_name', 'email', 'phone', 'address', 'date', 'time'],
  },
  { group: 'Numbers', types: ['number', 'money', 'quantities', 'rating', 'scale'] },
  { group: 'Other', types: ['content', 'video', 'booking', 'file', 'signature', 'payment'] },
];

/** A live poll's menu: what can pop up in a call (the owner's 9 and 17). */
export const POLL_MENU: readonly { group: string; types: readonly QuestionMenuItem[] }[] = [
  { group: 'Asking', types: ['choice', 'checkboxes', 'yes_no', 'short_text'] },
  { group: 'Numbers', types: ['rating', 'scale'] },
  { group: 'Buttons', types: ['button'] },
];

/** The menu for a form of this kind. */
export const questionMenu = (mode: FormMode) => (mode === 'poll' ? POLL_MENU : QUESTION_MENU);

export const MODE_BLURB: Readonly<Record<FormMode, string>> = {
  form: 'Collects answers and files them against the customer.',
  survey: 'Asks how you did. Can be answered without saying who they are.',
  quiz: 'Scores the answers, or points people at the right result.',
  poll: 'Questions and buttons that pop up during a HandsFreeOS video call or webinar.',
};

export const STATUS_WORDS: Readonly<
  Record<string, { label: string; tone: 'live' | 'quiet' | 'draft' }>
> = {
  draft: { label: 'Draft', tone: 'draft' },
  live: { label: 'Taking answers', tone: 'live' },
  closed: { label: 'Closed', tone: 'quiet' },
  archived: { label: 'Archived', tone: 'quiet' },
};

/** "23 answers" · "No answers yet". */
export function answersLine(count: number): string {
  if (count === 0) return 'No answers yet';
  return count === 1 ? '1 answer' : `${count} answers`;
}

/** 0.62 → "62% finish it". */
export function completionLine(rate: number | null): string | null {
  if (rate === null) return null;
  return `${Math.round(rate * 100)}% finish it`;
}

export const PUBLIC_FORM_PATH = publicFormPath;
