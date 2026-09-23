/**
 * The Action Center's pure core (Milestone 8): kinds, settings, signals, detectors, scoring, folding and the
 * follow-up nudge. Browser-safe, so Home, Settings, the worker and the Assistant read the same rules. The loaders
 * and `reconcile` are server-side.
 */
export * from './kinds';
export * from './types';
export { CHIP_ORDER, chipText, moneyLabel, sortChips } from './chips';
export {
  combineFingerprints,
  fingerprintOf,
  FINGERPRINT_MAX,
  FINGERPRINT_VERSION,
  type FingerprintFacts,
} from './fingerprint';
export * from './open-time';
export * from './money-draft';
export * from './settings';
export * from './signals';
export * from './facts';
export * from './nudge';
export * from './score';
export * from './folding';
export * from './registry';
export * from './wording';
export * from './view';
export * from './reach';
export * from './hint-facts';
export * from './synced';
export * from './home-words';
export type { AttentionDetector, Pending } from './detectors/define';
export type { AiApprovalFacts } from './detectors/ai-approval';
export { HANDOFF_OPEN_MINUTES, type CustomerWaitingFacts } from './detectors/customer-waiting';
export type { EstimateWaitingFacts } from './detectors/estimate-waiting';
export type { HotLeadFacts } from './detectors/hot-lead';
export type { InvoiceOverdueFacts } from './detectors/invoice-overdue';
export type { MissingNextActionFacts } from './detectors/missing-next-action';
export type { OverdueTaskFacts } from './detectors/overdue-task';
export type { StaleOpportunityFacts } from './detectors/stale-opportunity';
export type { UnansweredLeadFacts } from './detectors/unanswered-lead';
export type { UnconfirmedAppointmentFacts } from './detectors/unconfirmed-appointment';
export { THANK_YOU_CARD_DAYS, type JobNotThankedFacts } from './detectors/job-not-thanked';
export { REFERRAL_CARD_DAYS, type ReferralMentionedFacts } from './detectors/referral-mentioned';
