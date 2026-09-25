/**
 * The AI keeps customers' tags and contact details up to date (0107): a look at a customer after something
 * happens with them (activity.ts), a pass over the whole list a person starts (sweep.ts), both through one look
 * (review.ts) that changes things only through commands and writes down every look it takes.
 */
import type { JobMap } from '../jobs';
import { CONTACT_AI_REVIEW_JOB, contactAiReviewJob } from './activity';
import { CONTACT_AI_SWEEP_JOB, contactAiSweepJob } from './sweep';

export {
  CONTACT_AI_COOLDOWN_MS,
  CONTACT_AI_EVENTS,
  CONTACT_AI_REVIEW_JOB,
  CONTACT_AI_SETTLE_MS,
  contactAiReviewKey,
  onContactActivity,
  peopleOf,
  withContactAi,
} from './activity';
export {
  CONTACT_AI_SWEEP_BATCH,
  CONTACT_AI_SWEEP_JOB,
  contactAiSweepKey,
  onSweepStarted,
} from './sweep';
export { reviewPerson, type ReviewOptions, type ReviewResult } from './review';
export { CONTACT_AI_ASK, CONTACT_AI_SYSTEM, contactAiPrompt } from './prompt';
export { loadContactProfile, type ContactProfile } from './profile';

export const contactAiJobs: JobMap = {
  [CONTACT_AI_REVIEW_JOB]: contactAiReviewJob,
  [CONTACT_AI_SWEEP_JOB]: contactAiSweepJob,
};
