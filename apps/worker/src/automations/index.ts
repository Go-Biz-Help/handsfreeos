/** Automations' own jobs (Settings → Automations): the ones that aren't the Action Center's or the AI teammate's. */
import type { JobMap } from '../jobs';
import { INTAKE_JOB, intakeJob } from './intake';
import { MAINTENANCE_JOB, maintenanceJob } from './maintenance';
import { REENGAGE_JOB, reengageJob } from './reengage';
import { REFERRAL_JOB, referralJob } from './referrals';
import { THANK_YOU_JOB, thankYouJob } from './thank-you';

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
export { INTAKE_DELAY_MS, INTAKE_JOB, intakeJobKey, onBookedIntake } from './intake';

export const automationJobs: JobMap = {
  [REENGAGE_JOB]: reengageJob,
  [INTAKE_JOB]: intakeJob,
  [THANK_YOU_JOB]: thankYouJob,
  [REFERRAL_JOB]: referralJob,
  [MAINTENANCE_JOB]: maintenanceJob,
};
