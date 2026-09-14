/**
 * The workflow engine (Milestone 6): the trigger dispatcher, the run cursor job, schedules and date triggers,
 * webhooks in and out, and the AI seam. What the worker's registries need is exported from here.
 */
import type { ProcessorMap } from '../deliveries';
import type { JobMap } from '../jobs';
import { JOB } from './constants';
import { retentionJob, workflowStepJob } from './engine';
import { workflowReleaseJob } from './lifecycle';
import { workflowDateJob, workflowScheduleJob } from './triggers';
import { onWorkflowInbound } from './webhooks';

export { onWorkflowEvent, WATCHED_EVENTS, withWorkflows } from './dispatch';
export { registerWorkflowRoutes, signBody, verifyBody } from './webhooks';
export { unavailableAiRunner } from './ai-step';
export type { AiStepInput, AiStepResult, AiStepRunner } from './ai-step';
export {
  JOB as WORKFLOW_JOBS,
  runJobKey,
  dateJobKey,
  scheduleJobKey,
  retentionJobKey,
} from './constants';

/** Job kind → handler, for scheduled.ts's jobs map. */
export const workflowJobs: JobMap = {
  [JOB.step]: workflowStepJob,
  [JOB.schedule]: workflowScheduleJob,
  [JOB.date]: workflowDateJob,
  [JOB.release]: workflowReleaseJob,
  [JOB.retention]: retentionJob,
};

/** Stored webhook kind → processor, for processors/index.ts. */
export const workflowProcessors: ProcessorMap = {
  'workflow:inbound': onWorkflowInbound,
};
