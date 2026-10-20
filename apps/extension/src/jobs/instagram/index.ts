/**
 * What the person asks of their computer on Instagram from HandsFreeOS (the Instagram and Alignable plan's part 12;
 * core's `ASK_KINDS_ON.instagram`), each kind with the job that does it, at a person's pace:
 *
 * - `friends`: their followers, from the box over their own account, scrolled slowly to the end and saved
 *   (./people.ts). On Instagram a follow-back counts as accepting.
 * - `cancel`: those they ticked who didn't follow back, unfollowed in a tab they can see, 20 a day at most
 *   (./unfollow.ts). Nothing is unfollowed on its own.
 * - `checkup`, `profile_read` and `profile_edit`: Check Instagram, and their own profile read and its bio put in, as
 *   before (../looking.ts).
 */
import type { AskResult, AskTaken } from '@hfos/core/addons/outreach/asks';
import type { Job, JobEnd } from '../job';
import { lookingAsk } from '../looking';
import { saveFollowers } from './people';
import { unfollowTicked } from './unfollow';

type Ended = JobEnd & { readonly result?: AskResult | null };

const looked = lookingAsk('instagram');

/** Does an ask on Instagram with the job that does it. */
export async function instagramAsk(task: AskTaken['task'], job: Job): Promise<Ended> {
  switch (task.kind) {
    case 'friends':
      return saveFollowers(job);
    case 'cancel':
      return unfollowTicked(job, task.profileIds);
    default:
      return looked(task, job);
  }
}
