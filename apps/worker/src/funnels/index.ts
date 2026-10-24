/**
 * Teammate funnels in the worker (HANDSFREEOS_TEAMMATE_FUNNELS_IMPLEMENTATION_PLAN.md, "How it runs"): what a funnel
 * hears (events.ts) and the one job a person that takes them through it (tick.ts).
 */
import type { JobMap } from '../jobs';
import { FUNNEL_JOBS } from './constants';
import { addExistingJob } from './events';
import { funnelTickJob } from './tick';

export { withFunnels } from './events';
export { pokeFunnelPerson, pokeFunnel } from './tick';
export { FUNNEL_JOBS, tickJobKey } from './constants';

/** Job kind → handler, for scheduled.ts's jobs map. */
export const funnelJobs: JobMap = {
  [FUNNEL_JOBS.tick]: funnelTickJob,
  [FUNNEL_JOBS.addExisting]: addExistingJob,
};
