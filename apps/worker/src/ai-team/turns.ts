/**
 * The turns where the AI teammate writes first instead of answering (plan M7, "Other work"): a first message to
 * a new lead or to someone a workflow handed over, and a follow-up nudge. Also what a workflow's hand-over adds
 * to the context: its goal and the business's note. Customer data is quoted as data, as in prompt.ts. The
 * scripted stand-in (ai/scripted.ts) recognises these turns by their closing lines.
 */
import { quoteData, type AiTeammateGoal } from '@hfos/core/server';
import { clockLabel, dayLabel } from '../assistant/calendar-format';
import type { HistoryLine, RunContext } from './context';

/** How a first message's turn ends. */
export const FIRST_MESSAGE_ASK =
  'Write your first message to them now. End your turn with reply or no_reply.';
/** How a nudge's turn ends. */
export const NUDGE_ASK =
  'Write one short, friendly follow-up to your last message, or use no_reply when nothing needs following up. End your turn with reply or no_reply.';

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

function speaker(h: HistoryLine, name: string): string {
  if (h.who === 'customer') return 'Customer';
  if (h.who === 'ai') return `You (${quoteData(name)})`;
  if (h.who === 'person') return `${quoteData(h.name ?? 'Someone on the team')} (team)`;
  return 'Automatic message';
}

function history(rc: RunContext): string[] {
  const tz = rc.workspace.timeZone;
  const lines = rc.history.map(
    (h) =>
      `[${dayLabel(h.at, tz)}, ${clockLabel(h.at, tz)}] ${speaker(h, rc.config.identity.name)}: ${quoteData(h.text)}`,
  );
  return ['<history>', ...(lines.length ? lines : ['(no earlier messages)']), '</history>'];
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
    ...history(rc),
    why === 'new_lead'
      ? 'They just came in as a new lead, and nobody has written to them yet.'
      : 'The business asked you to write to them first.',
    ...lead,
    'Say who you are, thank them for getting in touch, and move toward what they need with one short question. Never call them a lead.',
    FIRST_MESSAGE_ASK,
  ].join('\n');
}

/** A follow-up nudge: they haven't answered the teammate's last message, sent at `lastAt`. */
export function nudgeTurn(rc: RunContext, n: number, max: number, lastAt: number): string {
  const tz = rc.workspace.timeZone;
  return [
    ...history(rc),
    `The customer hasn’t answered your last message (${dayLabel(lastAt, tz)}, ${clockLabel(lastAt, tz)}). This is follow-up ${n} of ${max}: one or two sentences, and don’t repeat your last message word for word.`,
    NUDGE_ASK,
  ].join('\n');
}
