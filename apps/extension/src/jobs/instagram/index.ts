/**
 * What the person asks of their computer on Instagram from HandsFreeOS (the Instagram and Alignable plan's parts 12 and
 * 13; core's `ASK_KINDS_ON.instagram`), each kind with the job that does it, in a window of its own at a person's pace,
 * reading only unless the kind says to press:
 *
 * - `friends`: their newest followers, from the box over their own account, scrolled slowly and saved: the newest 300
 *   the first time, then those new since (./people.ts); then the accounts they followed looked at for who follows them
 *   back (./follow-backs.ts). On Instagram a follow-back counts as accepting.
 * - `checks` and `research`: accounts opened and read for the AI's check, on Instagram's own day's count (./checks.ts).
 * - `chats`: their chats in their messages, opened one at a time by their rows and sent for the AI, noting who wrote
 *   last (./chats.ts).
 * - `lookup`: someone's account read before drafting: one page (./lookup.ts).
 * - `cancel`: those they ticked who didn't follow back, unfollowed in a tab they can see, 20 a day at most
 *   (./unfollow.ts). Nothing is unfollowed on its own.
 * - `checkup`, `profile_read` and `profile_edit`: Check Instagram, and their own profile read and its bio put in, as
 *   before (../looking.ts).
 */
import { ASK_CHATS, type AskResult, type AskTaken } from '@hfos/core/addons/outreach/asks';
import { CHECKS_PER_DAY } from '@hfos/core/addons/outreach/checks';
import { chatMemory } from '../chats';
import type { Job, JobEnd } from '../job';
import { lookingAsk } from '../looking';
import { readInstagramChats } from './chats';
import { checkFollowers, researchOnInstagram } from './checks';
import { lookupOnInstagram } from './lookup';
import { saveMyFollowers } from './people';
import { unfollowTicked } from './unfollow';

type Ended = JobEnd & { readonly result?: AskResult | null };

const looked = lookingAsk('instagram');

/** Does an ask on Instagram with the job that does it. */
export async function instagramAsk(task: AskTaken['task'], job: Job): Promise<Ended> {
  switch (task.kind) {
    case 'friends':
      return saveMyFollowers(job);
    case 'checks':
      return checkFollowers(job, CHECKS_PER_DAY);
    case 'research':
      return researchOnInstagram(job, task);
    case 'chats':
      return readInstagramChats(job, {
        most: ASK_CHATS,
        memory: chatMemory,
        again: 'Ask again to go on.',
      });
    case 'lookup':
      return lookupOnInstagram(job, task);
    case 'cancel':
      return unfollowTicked(job, task.profileIds);
    default:
      return looked(task, job);
  }
}
