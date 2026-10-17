/**
 * The person's own LinkedIn profile (docs/outreach.md, decision 64, LinkedIn's way), asked from Get ready in
 * HandsFreeOS:
 *
 * - **Read my profile** (`profile_read`): opens linkedin.com/in/me/ in a window of its own, checks it's their own
 *   (it has Edit intro, Add profile section and the like, never Connect), reads their headline, About, Experience,
 *   Featured and latest posts (src/networks/linkedin/own-profile.ts), and sends it for the AI's check
 *   (`outreach.profile.check`, as LinkedIn's). HandsFreeOS keeps only the AI's answer.
 * - **Put this one in** (`profile_edit`): opens the intro's box with Edit intro, types only into Headline, and presses
 *   Save; then reads the profile again for a new check. Anything it doesn't expect, it hands to the person (**Carry
 *   on** once the headline is in) and never guesses; it reads the profile again after.
 *
 * It stops on any LinkedIn warning.
 */
import type { AskTask } from '@hfos/core/addons/outreach/asks';
import { PROFILE_CHECK_WORDS as P } from '@hfos/core/addons/outreach/profile-check';
import { valueOf, warnedOn, type Job, type JobEnd } from '../job';
import { loadNote, ownProfileNote } from '../report';
import { OWN_PROFILE, readLinkedIn, SIGNED_IN } from './read';

type EditTask = Extract<AskTask, { kind: 'profile_edit' }>;

const failed = (line: string): JobEnd => ({ line, warned: false, failed: true });

/** Opens their profile and checks it's theirs. A warning, or someone else's profile, ends it. */
async function openOwn(job: Job): Promise<JobEnd | null> {
  await job.tab.open(OWN_PROFILE);
  const page = await readLinkedIn(job.tab);
  const warned = await warnedOn(job, page);
  if (warned) return warned;
  if (
    (page.kind !== 'profile' && page.kind !== 'own-profile') ||
    page.profile?.connection !== 'self'
  )
    return failed(`LinkedIn didn’t open your own profile. ${SIGNED_IN}`);
  return null;
}

/** Reads the profile the window shows and has the AI check it. */
async function readAndCheck(job: Job): Promise<JobEnd> {
  job.progress('Reading your profile…');
  // In front while it's read: LinkedIn draws Experience and the rest only as they come into view on screen. Noted
  // there too, with what was and wasn't read (decision 74).
  const read = async () => {
    const answer = await job.tab.ask({ type: 'hfos-own-profile' });
    if (answer.ok && 'read' in answer)
      await job.report?.(loadNote(ownProfileNote(answer.read), answer.load));
    return answer;
  };
  const answer = await (job.tab.inFront ? job.tab.inFront(read) : read());
  if (!answer.ok) return failed(answer.error);
  if (!('read' in answer)) return failed('LinkedIn didn’t show your profile.');
  if (job.stopped()) return { line: 'Stopped.', warned: false };
  job.progress('Checking it with the AI…');
  valueOf(
    await job.hfos({ type: 'hfos-profile-check', workspaceId: job.businessId, input: answer.read }),
  );
  return { line: P.readDone, warned: false };
}

/** Read my profile: open it, read it, and have the AI check it. */
export async function linkedInProfileRead(job: Job): Promise<JobEnd> {
  job.progress('Opening your LinkedIn profile…');
  return (await openOwn(job)) ?? readAndCheck(job);
}

/** Put this one in: the headline they picked, on their profile, then read again for a new check. */
export async function linkedInHeadlineEdit(job: Job, task: EditTask): Promise<JobEnd> {
  job.progress('Opening your LinkedIn profile…');
  const opened = await openOwn(job);
  if (opened) return opened;
  job.progress('Putting your new headline in…');
  const wrote = await job.tab.ask({ type: 'hfos-write-bio', bio: task.bio });
  const result = wrote.ok && 'result' in wrote ? wrote.result : 'none';
  if (result !== 'done') {
    // Something wasn't as expected: the person puts it in, and says when.
    if (!job.handOver) return failed('LinkedIn didn’t let the extension change your headline.');
    const reply = await job.handOver(
      `Put your new headline in: press the pencil by your name on your LinkedIn profile, write “${task.bio}” under Headline, and press Save. Then press Carry on.`,
    );
    if (reply !== 'carry_on') return { line: 'Stopped.', warned: false, failed: true };
    const again = await openOwn(job);
    if (again) return again;
  }
  const checked = await readAndCheck(job);
  return checked.failed
    ? checked
    : { line: `Your headline now says “${task.bio}”.`, warned: false };
}
