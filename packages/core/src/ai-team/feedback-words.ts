/**
 * What feedback on the AI teammate's replies says, and where it stands, on the web and the phone alike
 * (HANDSFREEOS_AI_FEEDBACK_IMPLEMENTATION_PLAN.md). Browser-safe.
 */
import type {
  FeedbackRating,
  ReviewItemOut,
  TeammateFeedbackOut,
  TeammateInstructionOut,
} from '../schemas/teammate-feedback';

/** How often a screen asks again while the AI reads feedback, and how long it waits before saying it's slow. */
export const FEEDBACK_POLL_MS = 1500;
export const FEEDBACK_SLOW_MS = 45_000;

export const FEEDBACK_WORDS = {
  good: 'Good reply',
  bad: 'Not quite right',
  betterLabel: 'What should it have said?',
  betterHint: 'Change its reply to what you’d have sent.',
  noteLabel: 'Why?',
  notePlaceholder: 'Like “We don’t work Sundays”',
  send: 'Send feedback',
  cancel: 'Cancel',
  change: 'Change',
  needWords: 'Change the reply or say why, so it knows what to do differently.',
  thanksGood: 'Thanks. It’ll keep answering like this.',
  reading: 'Working out what to learn from this…',
  slow: 'This is taking longer than usual. Check back in a minute.',
  failed: 'It couldn’t work out what to learn just now.',
  tryAgain: 'Try again',
  questionTitle: 'Quick question',
  answerPlaceholder: 'Or write your own answer',
  answer: 'Answer',
  suggestedTitle: 'Save this rule for next time?',
  save: 'Save rule',
  edit: 'Edit',
  notNow: 'Not now',
  saved: 'Saved to its instructions. It follows it from its next reply.',
  dropped: 'Not saved. It won’t use this rule.',
  managerSaves:
    'Someone who manages the AI teammate needs to OK this. They’ll see it on Home under “Things to teach the AI”.',
  useNew: 'Use the new rule',
  keepOld: 'Keep what’s there',
  retry: 'Retry with the fix',
  seeInstructions: 'See its instructions',
} as const;

/** "Nothing new to learn: it only fits that one customer." */
export function nothingWords(why: string | null): string {
  const reason = why?.trim().replace(/\.$/, '');
  if (!reason) return 'Nothing new to learn from this one.';
  return `Nothing new to learn: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}.`;
}

/** What shows under a reply for the person looking: their own feedback, and what came of it. */
export type FeedbackStage =
  | { readonly kind: 'none' }
  /** A thumbs up, or a thumbs down with nothing to read. */
  | { readonly kind: 'rated'; readonly rating: FeedbackRating }
  | { readonly kind: 'reading' }
  | { readonly kind: 'asking'; readonly question: string; readonly choices: readonly string[] }
  | {
      readonly kind: 'suggested';
      readonly lessonId: string;
      readonly line: string;
      /** When it goes against what the AI knows: where, the words there, and the clash in plain words. */
      readonly clash: {
        readonly where: string;
        readonly existing: string;
        readonly explain: string;
      } | null;
      /** Whether this person may save it (ai_team.manage). */
      readonly canSave: boolean;
    }
  | { readonly kind: 'saved'; readonly line: string }
  | { readonly kind: 'dropped' }
  | { readonly kind: 'nothing'; readonly words: string }
  | { readonly kind: 'failed' };

export function feedbackStage(
  f: TeammateFeedbackOut | null | undefined,
  canSaveRules: boolean,
): FeedbackStage {
  if (!f) return { kind: 'none' };
  switch (f.learn) {
    case 'none':
      return { kind: 'rated', rating: f.rating };
    case 'reading':
      return { kind: 'reading' };
    case 'asking':
      return f.question
        ? { kind: 'asking', question: f.question, choices: f.choices }
        : { kind: 'reading' };
    case 'nothing':
      return { kind: 'nothing', words: nothingWords(f.learnWhy) };
    case 'failed':
      return { kind: 'failed' };
    case 'suggested': {
      const l = f.lesson;
      if (!l) return { kind: 'rated', rating: f.rating };
      if (l.status === 'applied') return { kind: 'saved', line: l.line };
      if (l.status === 'dismissed') return { kind: 'dropped' };
      return {
        kind: 'suggested',
        lessonId: l.id,
        line: l.line,
        clash: l.conflict
          ? { where: l.conflict.where, existing: l.conflict.existing, explain: l.conflict.explain }
          : null,
        canSave: canSaveRules,
      };
    }
  }
}

/** Whether a screen should ask again soon: the person's own feedback is still being read. */
export const feedbackPending = (list: readonly TeammateFeedbackOut[]): boolean =>
  list.some((f) => f.mine && f.learn === 'reading');

/** "Thumbs up from Dana" for someone else's feedback on a reply. */
export function othersFeedbackWords(list: readonly TeammateFeedbackOut[]): string | null {
  const others = list.filter((f) => !f.mine);
  if (!others.length) return null;
  const up = others.filter((f) => f.rating === 'good').map((f) => f.by?.name ?? 'Someone');
  const down = others.filter((f) => f.rating === 'bad').map((f) => f.by?.name ?? 'Someone');
  const parts = [
    ...(up.length ? [`Thumbs up from ${up.join(', ')}`] : []),
    ...(down.length ? [`Thumbs down from ${down.join(', ')}`] : []),
  ];
  return parts.join(' · ');
}

/** A message in a thread the AI teammate wrote (not its hand-off line), which takes feedback. */
export function aiWroteIt(item: {
  readonly type: string;
  readonly direction: string;
  readonly teammate: { readonly id: string } | null;
  readonly handoffLine: boolean;
}): boolean {
  return (
    item.type === 'message' && item.direction === 'outbound' && !!item.teammate && !item.handoffLine
  );
}

/** Why it wrote, in Review. */
export const REVIEW_WHY_WORDS: Readonly<Record<ReviewItemOut['why'], string>> = {
  answer: 'Answered',
  first_message: 'First message',
  follow_up: 'Follow-up',
  other: 'Message',
};

/** "From feedback" or "Added by Dana", under an instruction. */
export function instructionSourceWords(i: TeammateInstructionOut): string {
  if (i.source === 'lesson') return i.by ? `From feedback, saved by ${i.by.name}` : 'From feedback';
  return i.by ? `Added by ${i.by.name}` : 'Added by your team';
}
