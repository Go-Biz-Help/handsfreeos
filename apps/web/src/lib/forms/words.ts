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
  CalendarCheck,
  CheckSquare,
  Circle,
  Clock,
  CreditCard,
  FileUp,
  Film,
  Hash,
  Heading,
  MapPin,
  MousePointerClick,
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
  booking: CalendarCheck,
  button: MousePointerClick,
};

export { QUESTION_LABELS, FORM_MODE_LABELS };

/** The question types offered in the "add a question" menu, in the order people reach for them. */
export const QUESTION_MENU: readonly { group: string; types: readonly QuestionType[] }[] = [
  { group: 'Asking', types: ['short_text', 'long_text', 'choice', 'checkboxes', 'yes_no'] },
  { group: 'Details', types: ['email', 'phone', 'address', 'date', 'time'] },
  { group: 'Numbers', types: ['number', 'money', 'rating', 'scale'] },
  { group: 'Other', types: ['content', 'video', 'booking', 'file', 'signature', 'payment'] },
];

/** A live poll's menu: what can pop up in a call (the owner's 9 and 17). */
export const POLL_MENU: readonly { group: string; types: readonly QuestionType[] }[] = [
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
