/**
 * What the person asks of their computer on LinkedIn from HandsFreeOS (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md,
 * "LinkedIn, part by part", 4; core's `ASK_KINDS_ON.linkedin`), each kind with the job that does it, in a window of
 * its own at a person's pace, reading only unless the kind says to press:
 *
 * - `friends`: their connections, scrolled slowly to the end and saved (./people.ts).
 * - `requests`: their invitations, got and sent, saved (./people.ts).
 * - `checks` and `research`: profiles opened and read for the AI's check, on LinkedIn's own day's count (./checks.ts).
 * - `chats`: their conversations in LinkedIn messaging, opened one at a time and sent for the AI (../chats.ts).
 * - `lookup`: a profile and its company's page read before drafting: two pages (./lookup.ts).
 * - `profile_read` and `profile_edit`: their own profile read for the AI's check; the headline put in, typed only into
 *   Headline, anything unexpected handed to them (./profile.ts).
 * - `cancel`: the old invitations they ticked, withdrawn from Sent invitations in a tab they can see (./withdraw.ts).
 * - `posts`: LinkedIn's post search with the playbooks' words, the latest first (./posts.ts).
 * - `file_request`, `file_download` and `file_in`: their copy of their data asked for and downloaded on LinkedIn's Get a
 *   copy of your data, in a tab they can see, where they type their password; then brought in from their downloads
 *   (./file.ts).
 * - `post`: not yet (part 6): it ends at once saying so, and nothing is opened.
 */
import { ASK_CHATS, type AskResult, type AskTaken } from '@hfos/core/addons/outreach/asks';
import { CHECKS_PER_DAY } from '@hfos/core/addons/outreach/checks';
import { chatMemory, LINKEDIN_MESSAGING, readChats } from '../chats';
import type { Job, JobEnd } from '../job';
import { checkConnections, researchOnLinkedIn } from './checks';
import { bringInLinkedIn, getLinkedInFile } from './file';
import { lookupOnLinkedIn } from './lookup';
import { checkInvitations, saveConnections } from './people';
import { findPostsBySearch } from './posts';
import { linkedInHeadlineEdit, linkedInProfileRead } from './profile';
import { withdrawInvitations } from './withdraw';

type Ended = JobEnd & { readonly result?: AskResult | null };

/** Putting a post up on LinkedIn comes with part 6: till then, said plainly, with what to do instead. */
export const LINKEDIN_POST_LATER =
  'Your computer can’t put a post up on LinkedIn yet. Copy it from Today and post it on your LinkedIn feed yourself.';

/** Does an ask on LinkedIn with the job that does it. */
export async function linkedInAsk(task: AskTaken['task'], job: Job): Promise<Ended> {
  switch (task.kind) {
    case 'file_request':
      return getLinkedInFile(job, 'request');
    case 'file_download':
      return getLinkedInFile(job, 'download');
    case 'file_in':
      return bringInLinkedIn(job);
    case 'friends':
      return saveConnections(job);
    case 'requests':
      return checkInvitations(job);
    case 'checks':
      return checkConnections(job, CHECKS_PER_DAY);
    case 'research':
      return researchOnLinkedIn(job, task);
    case 'chats':
      return readChats(job, {
        most: ASK_CHATS,
        memory: chatMemory,
        again: 'Ask again to go on.',
        home: LINKEDIN_MESSAGING,
      });
    case 'lookup':
      return lookupOnLinkedIn(job, task);
    case 'profile_read':
      return linkedInProfileRead(job);
    case 'profile_edit':
      return linkedInHeadlineEdit(job, task);
    case 'cancel':
      return withdrawInvitations(job, task.profileIds);
    case 'posts':
      return findPostsBySearch(job, task.words);
    case 'post':
      return { line: LINKEDIN_POST_LATER, warned: false, failed: true };
    default:
      // A kind HandsFreeOS doesn't ask on LinkedIn, or one this build doesn't know: it ends saying so.
      return {
        line: 'This build of HandsFreeOS Social can’t do that on LinkedIn yet. Download the newest one, unzip it over the old folder, press Reload on Chrome’s Extensions page, and ask again.',
        warned: false,
        failed: true,
      };
  }
}
