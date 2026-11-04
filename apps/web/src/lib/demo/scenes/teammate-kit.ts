import type { DemoDraft, DemoMessage, DemoPerson, DemoWorld } from '../world';
import { conversationIn } from './kit';
import type { DemoPlayer } from './types';

/** Small pieces the AI teammate's scenes (12 to 21) share. */

/** Somebody new: not a customer yet, with a 555 number near Houston, like the demo business. */
export function newPerson(
  id: string,
  first: string,
  last: string,
  phoneTail: number,
  city: string,
  email?: string,
): DemoPerson {
  return {
    id,
    firstName: first,
    lastName: last,
    phone: `+1832555${String(phoneTail).padStart(4, '0')}`,
    city,
    tags: [],
    customerSince: null,
    ...(email ? { email } : {}),
  };
}

/** A customer the business has worked for before. */
export const regular = (p: DemoPerson, at: number, years = 2): DemoPerson => ({
  ...p,
  tags: ['Customer'],
  customerSince: at - years * 365 * 24 * 3600_000,
});

/** The customer writes again, in the conversation that's open on screen. */
export function customerSays(
  w: DemoWorld,
  conversationId: string,
  m: Pick<DemoMessage, 'id' | 'at' | 'body' | 'media' | 'subject'>,
): void {
  const c = conversationIn(w, conversationId);
  c.unread = 0;
  c.messages.push({ ...m, direction: 'inbound' });
}

/** The teammate replies on its own, past its training. */
export function teammateSays(
  w: DemoWorld,
  conversationId: string,
  m: Pick<DemoMessage, 'id' | 'at' | 'body' | 'subject'>,
): void {
  conversationIn(w, conversationId).messages.push({ ...m, direction: 'outbound', teammate: true });
}

/** The teammate's reply, waiting for the presenter's OK while it's still in training. */
export function draftReply(
  w: DemoWorld,
  conversationId: string,
  d: Omit<DemoDraft, 'status'>,
): void {
  conversationIn(w, conversationId).drafts.push({ ...d, status: 'pending' });
}

/** Approve: the draft goes out as the teammate wrote it, or as the presenter changed it. */
export function approveDraft(
  w: DemoWorld,
  conversationId: string,
  draftId: string,
  sentId: string,
  at: number,
): DemoDraft {
  const c = conversationIn(w, conversationId);
  const d = c.drafts.find((x) => x.id === draftId);
  if (!d) throw new Error('The scene’s draft is missing.');
  d.status = 'approved';
  d.decidedAt = at;
  c.messages.push({
    id: sentId,
    at,
    direction: 'outbound',
    body: d.edited ?? d.body,
    subject: d.subject,
    teammate: true,
    approved: true,
    draftId: d.id,
  });
  return d;
}

/**
 * Changes the end of what's in a box, as a person would: the old words go back a few letters at a time, then the new
 * ones are typed. `from` is where the change starts.
 */
export async function changeWords(
  p: DemoPlayer,
  target: string,
  from: string,
  to: string,
): Promise<void> {
  const box = await p.waitFor(target);
  if (!(box instanceof HTMLTextAreaElement)) throw new Error(`${target} isn’t a box to type in.`);
  await p.point(target);
  // React keeps the box's value: set it the way the browser would, so the box's own change handler runs.
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  const put = (value: string) => {
    set?.call(box, value);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const start = box.value.lastIndexOf(from);
  if (start < 0) throw new Error('The words to change aren’t in the box.');
  const keep = box.value.slice(0, start);
  for (let end = box.value.length; end > start; end -= 3) {
    put(box.value.slice(0, Math.max(start, end - 3)));
    await p.wait(14);
  }
  for (let i = 1; i <= to.length; i++) {
    put(keep + to.slice(0, i));
    await p.wait(to[i - 1] === ' ' ? 45 : 22 + Math.random() * 24);
  }
  await p.wait(300);
}

/** What a step that approves a draft tells the screens. */
export const APPROVED = ['ai_teammate_draft', 'message', 'conversation'] as const;
/** What a step that adds a message tells the screens. */
export const NEW_MESSAGE = ['message', 'conversation'] as const;
