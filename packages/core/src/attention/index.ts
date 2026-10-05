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
export { MAINTENANCE_CARD_DAYS, type MaintenanceDueFacts } from './detectors/maintenance-due';
export {
  PIPELINE_MISMATCH_AFTER_MS,
  type PipelineMismatchFacts,
} from './detectors/pipeline-mismatch';
export {
  QUIET_AFTER_PRICE_DAYS,
  QUIET_AFTER_PRICE_UNTIL_DAYS,
  type QuietAfterPriceFacts,
} from './detectors/quiet-after-price';
export {
  JOB_CHECK_MORNING,
  JOB_NEVER_COMPLETED_DAYS,
  morningAfter,
  type JobFacts,
  type JobUnconfirmedFacts,
} from './detectors/job-unconfirmed';
export { JOB_NEVER_COMPLETED_UNTIL_DAYS } from './detectors/job-never-completed';
export { JOB_NO_ADDRESS_DAYS, type JobNoAddressFacts } from './detectors/job-no-address';
export {
  CLIENT_QUIET_CARD_DAYS,
  CLIENT_QUIET_MIN_DAYS,
  CLIENT_QUIET_MIN_VISITS,
  quietFrom,
  spanWords,
  type ClientQuietFacts,
} from './detectors/client-quiet';
export { PROMISE_CARD_DAYS, PROMISE_GRACE_MS, type PromiseDueFacts } from './detectors/promise-due';
export {
  REVENUE_MOVED_MIN_CENTS,
  REVENUE_MOVED_MIN_WEEKS,
  REVENUE_MOVED_SHARE,
  revenueChange,
  type RevenueMovedFacts,
} from './detectors/revenue-moved';
export { APPROVAL_EXPIRY_WARN_MS } from './detectors/ai-approval';
export {
  CHANNEL_QUIET_GAPS,
  CHANNEL_QUIET_MIN_COUNT,
  CHANNEL_WORDS,
  gapWords,
  type ChannelKind,
  type ChannelQuietFacts,
} from './detectors/channel-quiet';
export {
  CONNECTION_PROBLEM_WORDS,
  CONNECTION_SILENT_GAPS,
  CONNECTION_SILENT_MIN_MS,
  silentAt,
  type ConnectionFacts,
  type ConnectionProblem,
  type ConnectionSystem,
} from './detectors/connection';
export {
  AI_UNREVIEWED_DAYS,
  AI_UNREVIEWED_MIN_WORK,
  type AiUnreviewedFacts,
} from './detectors/ai-unreviewed';
export { type AiCorrectionsFacts } from './detectors/ai-corrections';
export { type WebsiteChangedFacts } from './detectors/website-changed';
export { OFFER_LAPSING_DAYS, type OfferLapsingFacts } from './detectors/offer-lapsing';
export { textingRejectedWords, type TextingRejectedFacts } from './detectors/texting-rejected';
export {
  ADDON_ALERT_SEVERITIES,
  ADDON_ALERT_SEVERITY,
  type AddonAlertFacts,
  type AddonAlertSeverity,
} from './detectors/addon-alert';
export { FAQ_SUGGESTION_MIN_ASKS, type FaqSuggestionsFacts } from './detectors/faq-suggestions';
