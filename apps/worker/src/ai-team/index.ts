/**
 * The AI teammate's runtime (Milestone 7): what starts a reply, the reply job, drafts going out, and the
 * scripted rules' contract (prompt.ts). What the worker's registries need is exported from here.
 */
import type { JobMap } from '../jobs';
import { TEAMMATE_JOBS } from './constants';
import { sendDraftJob } from './drafts';
import { teammateReplyJob } from './run';

export { withTeammate, scheduleReply, dropPendingDraft } from './triggers';
export { sendApprovedDraft } from './drafts';
export { teammateReplyJob, immediateHandOff } from './run';
export { TEAMMATE_JOBS, replyJobKey, sendDraftJobKey } from './constants';

/** Job kind → handler, for scheduled.ts's jobs map. */
export const teammateJobs: JobMap = {
  [TEAMMATE_JOBS.reply]: teammateReplyJob,
  [TEAMMATE_JOBS.sendDraft]: sendDraftJob,
};
