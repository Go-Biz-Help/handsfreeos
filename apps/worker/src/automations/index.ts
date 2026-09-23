/** Automations' own jobs (Settings → Automations): the ones that aren't the Action Center's or the AI teammate's. */
import type { JobMap } from '../jobs';
import { EVENING_JOB, eveningBriefJob } from './evening';
import { INTAKE_JOB, intakeJob } from './intake';
import { EXPIRING_JOB, expiringJob } from './expiring';
import { HANDOFF_NUDGE_JOB, handoffNudgeJob } from './handoff';
import { JOB_CHECK_JOB, jobCheckJob } from './job-check';
import { PROMISE_JOB, promiseJob } from './promises';
import { MAINTENANCE_JOB, maintenanceJob } from './maintenance';
import { REENGAGE_JOB, reengageJob } from './reengage';
import { REFERRAL_JOB, referralJob } from './referrals';
import { THANK_YOU_JOB, thankYouJob } from './thank-you';

export { ensureEvening, EVENING_JOB, eveningJobKey, nextEveningAt } from './evening';
export {
  ensureMaintenance,
  MAINTENANCE_JOB,
  maintenanceJobKey,
  nextMaintenanceAt,
} from './maintenance';
export { ensureReengage, nextReengageAt, REENGAGE_JOB, reengageJobKey } from './reengage';
export {
  onCompletedThankYou,
  THANK_YOU_DELAY_MS,
  THANK_YOU_JOB,
  THANK_YOU_TRIGGER,
  thankYouJobKey,
} from './thank-you';
export {
  onCallReferral,
  onMessageReferral,
  REFERRAL_ASK,
  REFERRAL_JOB,
  referralJobKey,
} from './referrals';
export {
  eveningAfter,
  JOB_CHECK_DELAY_MS,
  JOB_CHECK_JOB,
  jobCheckJobKey,
  onArmJobCheck,
  onStillGoing,
} from './job-check';
export { moveDeals, onEngaged, onPipelineEvidence } from './pipeline';
export { EXPIRING_JOB, expiringJobKey, onExpiringArm } from './expiring';
export {
  HANDOFF_NUDGE_AFTER_MS,
  HANDOFF_NUDGE_JOB,
  handoffNudgeKey,
  onHandoffNudge,
} from './handoff';
export {
  dueFrom,
  onCallPromise,
  onMessagePromise,
  PROMISE_ASK,
  PROMISE_JOB,
  promiseJobKey,
  teamLines,
} from './promises';
export { INTAKE_DELAY_MS, INTAKE_JOB, intakeJobKey, onBookedIntake } from './intake';

export const automationJobs: JobMap = {
  [REENGAGE_JOB]: reengageJob,
  [INTAKE_JOB]: intakeJob,
  [THANK_YOU_JOB]: thankYouJob,
  [REFERRAL_JOB]: referralJob,
  [MAINTENANCE_JOB]: maintenanceJob,
  [EVENING_JOB]: eveningBriefJob,
  [JOB_CHECK_JOB]: jobCheckJob,
  [HANDOFF_NUDGE_JOB]: handoffNudgeJob,
  [PROMISE_JOB]: promiseJob,
  [EXPIRING_JOB]: expiringJob,
};
