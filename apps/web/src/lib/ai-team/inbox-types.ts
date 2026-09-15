/**
 * The AI teammate outside its own area (the inbox, Approvals, Home, the lead page): the API's draft shapes, and
 * small readers over what core returns for it: who handles a conversation, which thread messages the teammate
 * sent (who approved each, its draft, and whether it's the business's hand-off line), and a lead's qualifying
 * answers.
 */
import type { paths } from '@hfos/api-client';
import type { LeadQualification } from '@hfos/core';
import type { ConversationSummary, LeadGet, ThreadItem } from '@/lib/api/types';

type Ok<P extends keyof paths> = paths[P] extends {
  post: { responses: { 200: { content: { 'application/json': infer R } } } };
}
  ? R
  : never;

export type DraftList = Ok<'/v1/queries/ai_teammate.draft_list'>;
/** One of the teammate's drafts: a reply (the inbox's to decide) or an approval (a discount, a manager's). */
export type TeammateDraft = DraftList['items'][number];
export type DraftPreview = TeammateDraft['preview'];
export type DraftAction = DraftPreview['actions'][number];
export type DecideDraftOut = Ok<'/v1/commands/ai_teammate.decide_draft'>;
export type TeammateGetOut = Ok<'/v1/queries/ai_teammate.get'>;

/** Every inbox box, the teammate's two included. */
export type InboxBoxKey = 'mine' | 'unassigned' | 'all' | 'needs_person' | 'ai';
export const INBOX_BOXES: readonly InboxBoxKey[] = [
  'mine',
  'unassigned',
  'all',
  'needs_person',
  'ai',
];

type UserRef = { readonly id: string; readonly fullName: string };
type TeammateRef = { readonly id: string; readonly name: string };

/** Who answers a conversation: nobody in particular, the AI teammate, or a person. */
export type Handler = ConversationSummary['handledBy'];

/** Who handles a conversation, and why it went to a person. */
export type ConversationHandling = Pick<
  ConversationSummary,
  'handledBy' | 'teammate' | 'needsPersonSince' | 'handoffReason' | 'handoffNote' | 'takenOverBy'
>;

export const handlingOf = (c: ConversationSummary): ConversationHandling => c;

export interface TeammateMessage {
  readonly teammate: TeammateRef;
  /** The person whose OK sent it (a draft), or null when it went out on its own. */
  readonly approvedBy: UserRef | null;
  /** The draft it came from. */
  readonly draftId: string | null;
  /** The business's hand-off line, sent as the teammate handed the conversation to a person. */
  readonly handoffLine: boolean;
}

/** The teammate that sent this message, and who approved it (null for anyone else's). */
export function teammateMessageOf(item: ThreadItem): TeammateMessage | null {
  if (!item.teammate) return null;
  return {
    teammate: item.teammate,
    approvedBy: item.approvedBy,
    draftId: item.aiDraftId,
    handoffLine: item.handoffLine,
  };
}

/** The lead's qualifying answers (null when none are recorded, or on a board card, which doesn't carry them). */
export const leadQualificationOf = (
  lead: LeadGet['lead'] | Omit<LeadGet['lead'], 'qualification'>,
): LeadQualification | null => ('qualification' in lead ? lead.qualification : null);
