/**
 * What the person asks of their computer on Alignable from HandsFreeOS (partners stage 6c, part 4; core's
 * `ASK_KINDS_ON.alignable`), each kind with the job that does it, in a window of its own at a person's pace, reading
 * only:
 *
 * - `friends`: their connections, all of them from My Network, scrolled slowly to the end and saved (./people.ts).
 * - `requests`: the connection requests they've got, from My Network's Requests, saved (./people.ts).
 * - `checks` and `research`: business pages opened and read for the AI's check, on Alignable's own day's count
 *   (./checks.ts).
 * - `lookup`: a business's page read before drafting: one page (./lookup.ts).
 * - `posts`: their town's posts and forum questions, a few screens, sent for the AI to check (./posts.ts).
 * - `checkup`, `profile_read` and `profile_edit`: Check Alignable, and their own profile read and its About Us put
 *   in, as before (../looking.ts).
 */
import { CHECKS_PER_DAY } from '@hfos/core/addons/outreach/checks';
import type { AskResult, AskTaken } from '@hfos/core/addons/outreach/asks';
import type { Job, JobEnd } from '../job';
import { lookingAsk } from '../looking';
import { checkConnections, researchOnAlignable } from './checks';
import { lookupOnAlignable } from './lookup';
import { checkRequests, saveConnections } from './people';
import { findPostsInTown } from './posts';

type Ended = JobEnd & { readonly result?: AskResult | null };

const looked = lookingAsk('alignable');

/** Does an ask on Alignable with the job that does it. */
export async function alignableAsk(task: AskTaken['task'], job: Job): Promise<Ended> {
  switch (task.kind) {
    case 'friends':
      return saveConnections(job);
    case 'requests':
      return checkRequests(job);
    case 'checks':
      return checkConnections(job, CHECKS_PER_DAY);
    case 'research':
      return researchOnAlignable(job, task);
    case 'lookup':
      return lookupOnAlignable(job, task);
    case 'posts':
      return findPostsInTown(job);
    default:
      return looked(task, job);
  }
}
