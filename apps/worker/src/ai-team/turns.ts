/**
 * The turns where the AI teammate writes first instead of answering (plan M7, "Other work"): a first message to
 * a new lead or to someone a workflow handed over, and a follow-up nudge. Also what a workflow's hand-over adds
 * to the context: its goal and the business's note. Customer data is quoted as data, as in prompt.ts. The
 * scripted stand-in (ai/scripted.ts) recognises these turns by their closing lines.
 */
import { quoteData, type AiTeammateGoal, type TestCoaching } from '@hfos/core/server';
import { clockLabel, dayLabel } from '../assistant/calendar-format';
import type { RunContext } from './context';
import { historyBlock } from './prompt';
import type { FunnelRunSpec, NudgeSpec, TaskSpec } from './run';

/** How a first message's turn ends. */
export const FIRST_MESSAGE_ASK =
  'Write your first message to them now. End your turn with reply or no_reply.';
/** How a nudge's turn ends. */
export const NUDGE_ASK =
  'Write one short, friendly follow-up to your last message, or use no_reply when nothing needs following up. End your turn with reply or no_reply.';

/** How a funnel message's turn ends. */
export const FUNNEL_ASK =
  'Write that message to them now, from the brief. End your turn with reply or no_reply.';

/** How a task's turn ends (a thank-you after a job). */
export const TASK_ASK = 'Write that one message now. End your turn with reply or no_reply.';

/** What a workflow step asked the teammate to aim for, and the business's note (rendered). */
export interface Handover {
  readonly goal: AiTeammateGoal;
  readonly note: string;
}

const GOALS: Readonly<Record<AiTeammateGoal, string>> = {
  respond: 'reply and help them with whatever they need',
  qualify:
    'ask the qualifying questions, one or two at a time, and save each answer with record_answers',
  book: 'get them booked: offer times from find_times, and book the one they pick',
};

/** The lines a workflow's hand-over adds to the context. */
export function handoverLines(h: Handover): string[] {
  return [
    `A workflow handed this customer to you. Your goal: ${GOALS[h.goal]}.`,
    ...(h.note.trim() ? [`The business’s note about them: ${quoteData(h.note.trim())}`] : []),
  ];
}

/** A person's "Try again" on a draft they rejected: their reason, and what the draft said. */
export interface Retry {
  readonly reason: string | null;
  readonly draft: string | null;
}

/**
 * The lines the test console's "Retry with the fix" adds: what the person said about the reply it gave this turn
 * before. Quoted as data, like a "Try again" reason; it holds for this turn only.
 */
export function coachingLines(c: TestCoaching | null): string[] {
  if (!c || (!c.better && !c.why)) return [];
  return [
    'A person testing you didn’t like how you answered this before. Answer again with their feedback in mind.',
    ...(c.reply ? [`What you said before: ${quoteData(c.reply)}`] : []),
    ...(c.better ? [`What they’d rather you said: ${quoteData(c.better)}`] : []),
    ...(c.why ? [`Why: ${quoteData(c.why)}`] : []),
  ];
}

/** The lines a "Try again" adds to the context. The reason and the old draft are quoted as data. */
export function retryLines(r: Retry): string[] {
  const reason = r.reason?.trim();
  return [
    reason
      ? `A person rejected your last draft: ${quoteData(reason)}. Write a better reply.`
      : 'A person rejected your last draft. Write a better reply.',
    ...(r.draft?.trim() ? [`Your rejected draft: ${quoteData(r.draft.trim())}`] : []),
  ];
}

/** A first message: to a new lead, or to someone a workflow handed over. */
export function firstMessageTurn(rc: RunContext, why: 'new_lead' | 'workflow'): string {
  const lead = rc.lead
    ? [
        '<new_lead>',
        `What they came in about: ${quoteData(rc.lead.title)} (stage ${quoteData(rc.lead.stageName)})`,
        '</new_lead>',
      ]
    : [];
  return [
    ...historyBlock(rc),
    why === 'new_lead'
      ? 'They just came in as a new lead, and nobody has written to them yet.'
      : 'The business asked you to write to them first.',
    ...lead,
    ...cameInWithBlock(rc),
    'Say who you are, thank them for getting in touch, and move toward what they need with one short question. Never call them a lead.',
    FIRST_MESSAGE_ASK,
  ].join('\n');
}

/** What they sent when they came in (their form's answers, or what the website sent), quoted as data. */
function cameInWithBlock(rc: RunContext): string[] {
  const sent = rc.lead?.cameInWith?.trim();
  if (!sent) return [];
  return [
    '<what_they_sent>',
    quoteData(sent),
    '</what_they_sent>',
    'Use what they sent to show you know what they need. Never quote it back word for word.',
  ];
}

/** The times the message they didn't answer offered, and which are still open. */
function offeredBlock(spec: NudgeSpec): string[] {
  if (!spec.offered.length) return [];
  const open = spec.offered.filter((o) => o.open);
  return [
    '<times_you_offered>',
    ...spec.offered.map((o) => `${o.label}: ${o.open ? 'still open' : 'taken or past'}`),
    '</times_you_offered>',
    open.length
      ? 'You offered them times. Offer the ones still open again, briefly. Never offer a time that is taken or past.'
      : 'The times you offered are gone. Call find_times for new ones and offer two or three.',
  ];
}

/** A follow-up: they haven't answered the teammate's message, sent at `spec.lastAt`. */
export function nudgeTurn(rc: RunContext, spec: NudgeSpec): string {
  const tz = rc.workspace.timeZone;
  const when = `${dayLabel(spec.lastAt, tz)}, ${clockLabel(spec.lastAt, tz)}`;
  return [
    ...historyBlock(rc),
    ...(spec.neverWrote ? cameInWithBlock(rc) : []),
    ...offeredBlock(spec),
    spec.neverWrote
      ? `They got in touch but never answered your first message (${when}).`
      : `The customer hasn’t answered your message (${when}).`,
    `This is follow-up ${spec.n} of ${spec.total}: one or two sentences, and don’t repeat an earlier message word for word.`,
    ...(spec.monthly
      ? [
          'It has been a while: a light, no-pressure check-in that says you’re here when they need you.',
        ]
      : []),
    NUDGE_ASK,
  ].join('\n');
}

/** A task from an automation: thanking the customer after a job was marked done. */
export function taskTurn(rc: RunContext, task: TaskSpec): string {
  if (task.purpose === 'webinar_hot') return webinarTurn(rc, task);
  const tz = rc.workspace.timeZone;
  const when = `${dayLabel(task.doneAt, tz)}, ${clockLabel(task.doneAt, tz)}`;
  return [
    ...historyBlock(rc),
    '<job_done>',
    `${quoteData(task.visit)}, marked done ${when}.`,
    '</job_done>',
    'The business finished a job for them. Thank them for choosing the business, in one or two warm sentences that mention the job.',
    'Ask for nothing: no review, no payment, no booking. No prices and no links. Use no_reply only if the conversation shows something went wrong with the job.',
    TASK_ASK,
  ].join('\n');
}

/**
 * Someone hot after a webinar (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md part 5): the business's live poll scored
 * them, and it has the teammate write to them within minutes of the end. Their answers and the reason are data.
 */
function webinarTurn(rc: RunContext, task: Extract<TaskSpec, { purpose: 'webinar_hot' }>): string {
  const tz = rc.workspace.timeZone;
  const when = `${dayLabel(task.endedAt, tz)}, ${clockLabel(task.endedAt, tz)}`;
  return [
    ...historyBlock(rc),
    '<webinar>',
    `${quoteData(task.webinar)}, which ended ${when}.`,
    ...(task.answers.length
      ? ['What they did in it:', ...task.answers.map((a) => `- ${quoteData(a)}`)]
      : []),
    ...(task.reason ? [`Why they look ready: ${quoteData(task.reason)}`] : []),
    '</webinar>',
    'They just watched the business’s webinar, and their answers say they’re interested. Thank them for coming, mention one thing they said or did, and ask one easy question toward the next step: usually a short call, or booking a time.',
    'Two or three short sentences. Never quote their points or say they were scored or rated. Use no_reply only if the conversation shows they already took the next step or said they’re not interested.',
    TASK_ASK,
  ].join('\n');
}

/**
 * A funnel's message (teammate funnels): the business's brief for this moment of the funnel, which the teammate
 * writes in its own words. The funnel, the stage's goal and what it should know are in the context (<funnel>).
 */
export function funnelTurn(rc: RunContext, f: FunnelRunSpec): string {
  return [
    ...historyBlock(rc),
    '<funnel_message>',
    quoteData(f.text),
    '</funnel_message>',
    `It’s time for this message in ${quoteData(f.funnelName)}, at ${quoteData(f.stageName)}. Write it from the brief above, in your own words: one or two short sentences, and never mention the funnel or its stages.`,
    ...(f.joinLink
      ? [
          'Their own Join link goes on its own line after your message: don’t write a link yourself.',
        ]
      : []),
    ...(f.late
      ? ['It’s going later than planned, so don’t say it’s on the dot or “in an hour”.']
      : []),
    'Use no_reply only when the conversation shows it no longer fits: they already did it, or said they’re not interested.',
    FUNNEL_ASK,
  ].join('\n');
}
