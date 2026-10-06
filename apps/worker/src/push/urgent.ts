/**
 * The urgent email's moment, on people's phones (M10): an urgent item, the urgent switch. attention/alerts.ts calls
 * this in the transaction that marks the moment as told, with the people the email picks before their email switch
 * is looked at, so a person with the email off and the push on still hears, and the moment is pushed once whichever
 * sender got there first.
 * - **A hot lead, or a new lead nobody answered** (`urgent_lead`): "Hot lead · Maria Lopez", what the lead is and
 *   what it's worth, and what they said; it opens the item on Home, with Call, Snooze 1 hour and Let HandsFreeOS
 *   handle.
 * - **A customer left waiting past the reply threshold** (`customer_waiting`): "Customer waiting · Mike Johnson", how
 *   they wrote, and their message; it opens the conversation, with Reply, Call and Let AI handle. It takes the place
 *   of the push their message brought when it arrived (arrival.ts), and buzzes again.
 * Handing over needs the AI teammate to answer the conversation (Let HandsFreeOS handle's only choice that needs no
 * typing is handing it to the teammate), so without that each is its `_no_ai` kind, without the button.
 */
import {
  ATTENTION_KIND_LABELS,
  loadTeammate,
  moneyRounded,
  teammateConfigOf,
  type AttentionItemRow,
  type AttentionKind,
  type PushCategory,
  type PushRefs,
} from '@hfos/core/server';
import { rows, sql, type Tx } from '@hfos/db/client';
import type { conversations } from '@hfos/db/schema';
import type { TenantScope } from '../services';
import { pushAudience, queuePush } from './queue';

type Conversation = typeof conversations.$inferSelect;
export type UrgentKind = 'hot_lead' | 'unanswered_lead' | 'customer_waiting';

/** How a conversation's channel reads before the business's name. */
export const CHANNEL_WORD: Readonly<Record<string, string>> = {
  sms: 'Text',
  email: 'Email',
  chat: 'Chat',
  portal: 'Portal',
  messenger: 'Messenger',
  instagram: 'Instagram',
};

/**
 * The channel a push's Reply sends on. A client's portal thread (Real Estate round two) carries none: the phones
 * people have now don't know it, and would drop the whole push over it, and their Reply falls back to a text, which
 * the server refuses on a portal thread rather than sending.
 */
export const pushChannel = (channel: string): PushRefs['channel'] =>
  channel === 'sms' || channel === 'email' || channel === 'chat' ? channel : undefined;

/** The channel as a push's refs carry it: `channel`, or for Messenger and Instagram `social`, which every build reads. */
export const channelRefs = (channel: string): Pick<PushRefs, 'channel' | 'social'> => {
  const known = pushChannel(channel);
  if (known) return { channel: known };
  return channel === 'messenger' || channel === 'instagram' ? { social: channel } : {};
};

/** The kind before the AI teammate is looked at (both share a switch with their `_no_ai` kind). */
const baseCategory = (kind: UrgentKind): PushCategory =>
  kind === 'customer_waiting' ? 'customer_waiting' : 'urgent_lead';

/** A conversation's notification: each push about it takes the place of the last. */
export const conversationCollapseId = (conversationId: string): string =>
  `conversation-${conversationId}`;

/** Whether anyone of these would get the push (their switch on, a phone on), before anything is written. */
export async function urgentPushListeners(
  tx: Tx,
  kind: UrgentKind,
  userIds: readonly string[],
): Promise<number> {
  return (await pushAudience(tx, baseCategory(kind), userIds)).length;
}

/**
 * The business's AI teammate could take this conversation: it is on, answers the conversation's channel, and isn't
 * answering it already. As attention.preview_handle words it, so a button offered here can do what it says.
 */
export async function aiCanTake(
  tx: Tx,
  workspaceId: string,
  conversation: Pick<Conversation, 'channel' | 'handledBy'> | null,
): Promise<boolean> {
  if (!conversation || conversation.handledBy === 'ai') return false;
  const channel = conversation.channel;
  if (channel !== 'sms' && channel !== 'email' && channel !== 'chat') return false;
  const teammate = await loadTeammate(tx, workspaceId);
  return !!teammate && teammate.status !== 'off' && !!teammateConfigOf(teammate).channels[channel];
}

/** "A. B": parts that are there, joined as sentences. */
const sentences = (...parts: (string | null | undefined)[]): string =>
  parts
    .map((p) => p?.replace(/\s+/g, ' ').trim())
    .filter((p): p is string => !!p)
    .map((p, i, all) => (i < all.length - 1 && !/[.!?…]$/.test(p) ? `${p}.` : p))
    .join(' ');

export interface UrgentPush {
  readonly kind: UrgentKind;
  readonly item: AttentionItemRow | null;
  readonly conversation: Conversation | null;
  /** The wait the alert is about: the push is kept to one per wait, as the email is. */
  readonly waitSince: Date | null;
  readonly userIds: readonly string[];
  readonly customer: string;
  /**
   * What the customer said last, never the business's own words ("Sent a photo." when it had only photos), or the
   * item's own line when they haven't said anything (alerts.ts).
   */
  readonly preview: string;
  readonly valueCents: number | null;
}

/** Queues the urgent alert's push; answers how many people it is for. */
export async function queueUrgentPush(tx: Tx, scope: TenantScope, u: UrgentPush): Promise<number> {
  const ws = scope.workspaceId;
  const conv = u.conversation;
  const key =
    conv && u.waitSince
      ? `urgent:wait:${conv.id}:${u.waitSince.toISOString()}`
      : `urgent:item:${u.item?.id ?? 'none'}:${u.item?.fingerprint ?? ''}`;
  const personId = u.item?.personId ?? conv?.personId ?? null;
  const refs: PushRefs = {
    ...(u.item ? { itemId: u.item.id } : {}),
    ...(u.item?.leadId ? { leadId: u.item.leadId } : {}),
    ...(personId ? { personId } : {}),
    ...(conv ? { conversationId: conv.id, ...channelRefs(conv.channel) } : {}),
  };
  const said = u.preview.trim();

  const ai = await aiCanTake(tx, ws, conv ?? null);
  if (u.kind === 'customer_waiting' && conv) {
    return queuePush(tx, scope, {
      key,
      category: ai ? 'customer_waiting' : 'customer_waiting_no_ai',
      userIds: u.userIds,
      title: `${ATTENTION_KIND_LABELS.customer_waiting} · ${u.customer}`,
      about: CHANNEL_WORD[conv.channel] ?? null,
      body: said || 'Waiting for a reply.',
      path: `/app/w/${ws}/inbox/${conv.id}`,
      refs,
      collapseId: conversationCollapseId(conv.id),
    });
  }

  const [lead] = u.item?.leadId
    ? await rows<{ title: string }>(
        tx,
        sql`select title from app.leads where id = ${u.item.leadId}`,
      )
    : [];
  const what = [lead?.title, u.valueCents ? moneyRounded(u.valueCents) : null]
    .filter(Boolean)
    .join(' · ');
  const label = u.item ? ATTENTION_KIND_LABELS[u.item.kind as AttentionKind] : 'Urgent';
  return queuePush(tx, scope, {
    key,
    category: ai ? 'urgent_lead' : 'urgent_lead_no_ai',
    userIds: u.userIds,
    title: `${label} · ${u.customer}`,
    body: sentences(what, said) || 'Waiting for someone to get back to them.',
    path:
      u.item || !conv
        ? `/app/w/${ws}${u.item ? `?item=${u.item.id}` : ''}`
        : `/app/w/${ws}/inbox/${conv.id}`,
    refs,
  });
}
