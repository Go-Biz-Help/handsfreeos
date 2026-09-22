/** Automations' own jobs (Settings → Automations): the ones that aren't the Action Center's or the AI teammate's. */
import type { JobMap } from '../jobs';
import { REENGAGE_JOB, reengageJob } from './reengage';

export { ensureReengage, nextReengageAt, REENGAGE_JOB, reengageJobKey } from './reengage';

export const automationJobs: JobMap = {
  [REENGAGE_JOB]: reengageJob,
};
