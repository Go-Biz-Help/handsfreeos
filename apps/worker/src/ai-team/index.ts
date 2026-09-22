/**
 * The AI teammate's runtime (Milestone 7): what starts a reply, the runs (replies, first messages, nudges),
 * drafts going out and expiring, hand-offs and what follows them, and the scripted rules' contract (prompt.ts,
 * turns.ts). What the worker's registries need is exported from here; its HTTP routes live in routes.ts and
 * test-routes.ts.
 */
import type { JobMap } from '../jobs';
import { TEAMMATE_JOBS } from './constants';
import { sendDraftJob } from './drafts';
import { handoffTextJob } from './escalation';
import { expireDraftsJob } from './expiry';
import { followUpJob } from './follow-up';
import { handoffLineJob } from './handoff';
import { outreachJob } from './outreach';
import { teammateReplyJob } from './run';

export { withTeammate, scheduleReply, dropPendingDraft } from './triggers';
export { sendApprovedDraft } from './drafts';
export { teammateReplyJob, immediateHandOff } from './run';
export { expireDueDrafts } from './expiry';
export {
  TEAMMATE_JOBS,
  replyJobKey,
  sendDraftJobKey,
  outreachJobKey,
  followUpJobKey,
  handoffLineJobKey,
  expireDraftsJobKey,
  handoffClientId,
} from './constants';

/** Job kind → handler, for scheduled.ts's jobs map. */
export const teammateJobs: JobMap = {
  [TEAMMATE_JOBS.reply]: teammateReplyJob,
  [TEAMMATE_JOBS.sendDraft]: sendDraftJob,
  [TEAMMATE_JOBS.outreach]: outreachJob,
  [TEAMMATE_JOBS.followUp]: followUpJob,
  [TEAMMATE_JOBS.handoffLine]: handoffLineJob,
  [TEAMMATE_JOBS.expireDrafts]: expireDraftsJob,
  [TEAMMATE_JOBS.handoffText]: handoffTextJob,
};
