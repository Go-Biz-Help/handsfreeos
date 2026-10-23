import {
  FORM_MODE_LABELS,
  publicFormPath,
  QUESTION_LABELS,
  type FormMode,
  type QuestionType,
} from '@hfos/core';
import {
  AlignLeft,
  AtSign,
  Calendar,
  CheckSquare,
  Circle,
  Clock,
  CreditCard,
  FileUp,
  Film,
  Hash,
  Heading,
  MapPin,
  PenLine,
  Phone,
  SlidersHorizontal,
  Star,
  ToggleLeft,
  Type,
  type LucideIcon,
} from 'lucide-react';

/** What each kind of question is called and the icon that stands for it in the list. */
export const QUESTION_ICONS: Readonly<Record<QuestionType, LucideIcon>> = {
  short_text: Type,
  long_text: AlignLeft,
  choice: Circle,
  checkboxes: CheckSquare,
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
};

export { QUESTION_LABELS, FORM_MODE_LABELS };

/** The question types offered in the "add a question" menu, in the order people reach for them. */
export const QUESTION_MENU: readonly { group: string; types: readonly QuestionType[] }[] = [
  { group: 'Asking', types: ['short_text', 'long_text', 'choice', 'checkboxes', 'yes_no'] },
  { group: 'Details', types: ['email', 'phone', 'address', 'date', 'time'] },
  { group: 'Numbers', types: ['number', 'money', 'rating', 'scale'] },
  { group: 'Other', types: ['content', 'video', 'file', 'signature', 'payment'] },
];

export const MODE_BLURB: Readonly<Record<FormMode, string>> = {
  form: 'Collects answers and files them against the customer.',
  survey: 'Asks how you did. Can be answered without saying who they are.',
  quiz: 'Scores the answers, or points people at the right result.',
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
