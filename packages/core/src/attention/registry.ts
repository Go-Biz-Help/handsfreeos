/**
 * Every kind's detector, keyed by kind. Milestone 9's money kinds are one line each here (plus their kind in
 * kinds.ts and their detector file).
 */
import * as aiApproval from './detectors/ai-approval';
import * as customerWaiting from './detectors/customer-waiting';
import * as estimateWaiting from './detectors/estimate-waiting';
import * as hotLead from './detectors/hot-lead';
import * as invoiceOverdue from './detectors/invoice-overdue';
import * as maintenanceDue from './detectors/maintenance-due';
import * as jobNeverCompleted from './detectors/job-never-completed';
import * as jobNoAddress from './detectors/job-no-address';
import * as jobNotThanked from './detectors/job-not-thanked';
import * as jobUnconfirmed from './detectors/job-unconfirmed';
import * as missingNextAction from './detectors/missing-next-action';
import * as overdueTask from './detectors/overdue-task';
import * as pipelineMismatch from './detectors/pipeline-mismatch';
import * as quietAfterPrice from './detectors/quiet-after-price';
import * as referralMentioned from './detectors/referral-mentioned';
import * as staleOpportunity from './detectors/stale-opportunity';
import * as unansweredLead from './detectors/unanswered-lead';
import * as unconfirmedAppointment from './detectors/unconfirmed-appointment';
import { walletCardDeclined, walletEmpty, walletLow } from './detectors/wallet';
import type { AttentionKind } from './kinds';
import type { AttentionSettings } from './settings';
import type { Detection } from './types';

interface DetectorModule<F> {
  readonly detect: (facts: F, settings: AttentionSettings, now: Date) => Detection | null;
  readonly wakeAt: (facts: F, settings: AttentionSettings, now: Date) => string | null;
}

export const DETECTORS = {
  hot_lead: hotLead,
  unanswered_lead: unansweredLead,
  stale_opportunity: staleOpportunity,
  missing_next_action: missingNextAction,
  unconfirmed_appointment: unconfirmedAppointment,
  ai_approval: aiApproval,
  customer_waiting: customerWaiting,
  overdue_task: overdueTask,
  estimate_waiting: estimateWaiting,
  invoice_overdue: invoiceOverdue,
  // The wallet's three share one file: they read the same facts and only one of them ever holds at a time.
  wallet_low: walletLow,
  wallet_empty: walletEmpty,
  wallet_card_declined: walletCardDeclined,
  job_not_thanked: jobNotThanked,
  referral_mentioned: referralMentioned,
  maintenance_due: maintenanceDue,
  pipeline_mismatch: pipelineMismatch,
  quiet_after_price: quietAfterPrice,
  job_unconfirmed: jobUnconfirmed,
  job_never_completed: jobNeverCompleted,
  job_no_address: jobNoAddress,
} as const satisfies { readonly [K in AttentionKind]: DetectorModule<never> };

/** The facts one kind's detector reads. */
export type AttentionFacts<K extends AttentionKind> = Parameters<
  (typeof DETECTORS)[K]['detect']
>[0];

const moduleOf = <K extends AttentionKind>(kind: K) =>
  DETECTORS[kind] as unknown as DetectorModule<AttentionFacts<K>>;

/** What holds for one kind now, or null. */
export function detectAttention<K extends AttentionKind>(
  kind: K,
  facts: AttentionFacts<K>,
  settings: AttentionSettings,
  now: Date,
): Detection | null {
  return moduleOf(kind).detect(facts, settings, now);
}

/** While nothing holds for one kind: when it will by time alone, or null. */
export function attentionWakeAt<K extends AttentionKind>(
  kind: K,
  facts: AttentionFacts<K>,
  settings: AttentionSettings,
  now: Date,
): string | null {
  return moduleOf(kind).wakeAt(facts, settings, now);
}
