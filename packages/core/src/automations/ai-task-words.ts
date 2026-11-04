/**
 * Settings → Automations' "Add tasks from what you say" (20261027023200, owner 4 Nov: "it should just create the
 * task"): the AI reads a call's words once they're in (a phone call on the business number, a HandsFreeOS video
 * call, an appointment's), and the texts, emails and chats someone on the team writes, and adds a task for each
 * thing the team said it would do. Nobody approves it first: a task nobody needed is deleted in a tap, a needed one
 * that was never made costs a customer.
 *
 * The words each task carries, saying where it came from, live here so the web, the phone and the demo player say
 * what the worker writes. Browser-safe and pure.
 */

/** Where an AI-made task came from: a call of some kind, or the channel of the message someone wrote. */
export type AiTaskSource =
  'phone_call' | 'video_call' | 'sms' | 'email' | 'chat' | 'portal' | 'messenger' | 'instagram';

const FROM: Readonly<Record<AiTaskSource, { readonly what: string; readonly join: string }>> = {
  phone_call: { what: 'your call', join: 'with' },
  video_call: { what: 'your video call', join: 'with' },
  sms: { what: 'your text', join: 'to' },
  email: { what: 'your email', join: 'to' },
  chat: { what: 'your website chat', join: 'with' },
  portal: { what: 'your portal message', join: 'to' },
  messenger: { what: 'your Messenger message', join: 'to' },
  instagram: { what: 'your Instagram message', join: 'to' },
};

/** The source a message's channel reads as; anything else reads as a message. */
export function aiTaskSourceOf(channel: string): AiTaskSource | null {
  return channel in FROM && channel !== 'phone_call' && channel !== 'video_call'
    ? (channel as AiTaskSource)
    : null;
}

/** "Added by the AI from your call with Mike Johnson." */
export function aiTaskFromLine(from: AiTaskSource | null, customer: string | null): string {
  const f = from ? FROM[from] : { what: 'your message', join: 'to' };
  const who = customer?.trim();
  return `Added by the AI from ${f.what}${who ? ` ${f.join} ${who}` : ''}.`;
}

/** A task's notes: what the AI noted, then where it came from. */
export function aiTaskNotes(
  notes: string | null | undefined,
  from: AiTaskSource | null,
  customer: string | null,
): string {
  const said = notes?.trim();
  return [said, aiTaskFromLine(from, customer)].filter(Boolean).join('\n\n');
}

/** What a call's review shows for each thing it made or suggested, on the web and the phone. */
export const CALL_REVIEW_WORDS = {
  /** A task the AI added on its own. */
  taskAdded: 'Task added',
  /** One waiting for an OK: while "Add tasks from what you say" is off, or from before it was on. */
  task: 'Suggested task',
  follow_up: 'Suggested follow-up email',
  record_change: 'Suggested update to their record',
  approve: { task: 'Add task', follow_up: 'Send email', record_change: 'Update record' },
  done: ' · Done',
  dismissed: ' · Dismissed',
  openTask: 'Open task',
  /** A phone call's words, under what the AI made of them. */
  said: 'What was said',
  /** A phone call's notes before its words are in. */
  saidSoon: 'The call’s words show here a few minutes after it ends.',
  notes: 'Notes from the call',
} as const;

/** The label over one of a call's suggestions, as it stands now. */
export function callReviewLabel(
  kind: 'task' | 'follow_up' | 'record_change',
  status: 'pending' | 'approved' | 'dismissed',
): string {
  if (kind === 'task' && status === 'approved') return CALL_REVIEW_WORDS.taskAdded;
  const base = CALL_REVIEW_WORDS[kind];
  return status === 'pending'
    ? base
    : `${base}${status === 'approved' ? CALL_REVIEW_WORDS.done : CALL_REVIEW_WORDS.dismissed}`;
}
