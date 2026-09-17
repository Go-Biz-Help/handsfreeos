/**
 * The AI teammate outside its own area (the inbox, Approvals, Home, the lead page): the API's draft shapes, and
 * small readers over what core returns for it: who handles a conversation, which thread messages the teammate
 * sent (who approved each, its draft, and whether it's the business's hand-off line), and a lead's qualifying
 * answers.
 */
import type { paths } from '@hfos/api-client';
import type { LeadQualification } from '@hfos/core';
import type { ConversationSummary, LeadGet } from '@/lib/api/types';

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

/** The inbox's boxes and the teammate's messages live in core (shared with the phone app, M10). */
export { INBOX_BOXES, teammateMessageOf, type InboxBoxKey, type TeammateMessage } from '@hfos/core';

/** Who answers a conversation: nobody in particular, the AI teammate, or a person. */
export type Handler = ConversationSummary['handledBy'];

/** Who handles a conversation, and why it went to a person. */
export type ConversationHandling = Pick<
  ConversationSummary,
  'handledBy' | 'teammate' | 'needsPersonSince' | 'handoffReason' | 'handoffNote' | 'takenOverBy'
>;

export const handlingOf = (c: ConversationSummary): ConversationHandling => c;

/** The lead's qualifying answers (null when none are recorded, or on a board card, which doesn't carry them). */
export const leadQualificationOf = (
  lead: LeadGet['lead'] | Omit<LeadGet['lead'], 'qualification'>,
): LeadQualification | null => ('qualification' in lead ? lead.qualification : null);
