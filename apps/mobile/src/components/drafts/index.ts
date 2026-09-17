/**
 * The AI teammate's drafts on the phone, one card for every screen that shows them (the inbox's thread, Home,
 * Approvals): the card, deciding through `change('ai_teammate.decide_draft')`, and the drafts waiting with this phone's
 * decisions over them.
 */
export { useAiColors, type AiColors } from './ai-colors';
export { DraftButtons, DraftCard } from './draft-card';
export { useDraftDecision, type DraftDecision, type DraftMode } from './use-draft-decision';
export {
  DECIDE_DRAFT,
  decisionStands,
  useDraftDecisions,
  useWaitingDrafts,
  type DraftDecisionRow,
  type WaitingDraft,
} from './use-drafts';
