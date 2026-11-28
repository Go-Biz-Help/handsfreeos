/**
 * Social Outreach's home-screen widget (docs/phone-widgets.md; the owner's pick of all six widgets, 28 Nov 2026):
 * today's first messages against the day's goal on every network the person works (decision 126's goal), and what
 * waits for their OK. The phone gathers the numbers (`outreach.today` for each network, and the messages in its copy);
 * this words them for the widget, which shows them with no app running.
 */
import type { AddonWidgetFacts } from '../../widgets/data';

export const OUTREACH_WIDGET_WORDS = {
  goal: 'First messages',
  goalValue: (done: number, most: number) => `${done} of ${most}`,
  noGoal: 'No goal today',
  replies: 'Replies to OK',
  messages: 'To OK',
  allClear: 'Nothing waiting for your OK.',
  waiting: (n: number) =>
    n === 1 ? '1 message waits for your OK.' : `${n} messages wait for your OK.`,
  /** Before the goal could be asked for (no signal yet): the waiting messages still show, from the phone's copy. */
  goalUnknown: '–',
} as const;

export interface OutreachWidgetInput {
  /** Each network's goal today (`outreach.today`'s `goal`), or null while it couldn't be asked for. */
  readonly goals: readonly { readonly done: number; readonly most: number }[] | null;
  /** Replies the AI wrote that wait for the person's OK, from the phone's copy. */
  readonly replies: number;
  /** First messages, comments and answers that wait for their OK. */
  readonly messages: number;
}

/** Where a tap opens: Social Outreach's Needs you. */
export const OUTREACH_WIDGET_PATH = 'a/outreach?view=waiting';

export function outreachWidgetFacts(input: OutreachWidgetInput): AddonWidgetFacts {
  const W = OUTREACH_WIDGET_WORDS;
  const done = input.goals?.reduce((n, g) => n + g.done, 0) ?? 0;
  const most = input.goals?.reduce((n, g) => n + g.most, 0) ?? 0;
  const waiting = input.replies + input.messages;
  return {
    figures: [
      {
        label: W.goal,
        value: input.goals === null ? W.goalUnknown : most ? W.goalValue(done, most) : W.noGoal,
        tone: most && done >= most ? 'good' : null,
      },
      { label: W.replies, value: String(input.replies), tone: input.replies ? 'accent' : null },
      { label: W.messages, value: String(input.messages), tone: input.messages ? 'accent' : null },
    ],
    note: waiting ? W.waiting(waiting) : W.allClear,
    path: OUTREACH_WIDGET_PATH,
  };
}
