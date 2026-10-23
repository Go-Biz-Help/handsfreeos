/**
 * The person's own profile (docs/outreach.md, decision 64), asked from Get ready in HandsFreeOS:
 *
 * - **Read my profile** (`profile_read`): opens facebook.com/me in a window of its own, checks it's their own (it has
 *   **Edit profile**, a button or, from October 2026, a link), reads what a stranger sees first
 *   (src/networks/facebook/own-profile.ts) and sends it for the AI's check (`outreach.profile.check`). HandsFreeOS
 *   keeps only the AI's answer; what the page said goes no further.
 * - **Put this one in** (`profile_edit`): presses **Edit bio**, writes the bio they picked, presses **Save**, then
 *   reads the profile again for a new check. Where it can't find Edit bio it hands the step to them (**Carry on** once
 *   it's in), and reads it again after.
 *
 * - **Its name, username and links** (decision 84): Accounts Center and Contact info are opened for the person, and
 *   each step handed over with what to put in (./profile-parts.ts); then the profile is read again.
 *
 * It stops when Facebook shows a warning (decision 25).
 */
import { PROFILE_CHECK_WORDS as P } from '@hfos/core/addons/outreach/profile-check';
import {
  hasNewProfileParts,
  profileEditDoneWords,
  type AskTask,
} from '@hfos/core/addons/outreach/asks';
import { putInByHand } from './profile-parts';
import { readIn, valueOf, warnedOn, type Job, type JobEnd } from './job';
import { ownProfileNote } from './report';

/** Facebook takes this to the person's own profile, whoever they are. */
export const OWN_PROFILE_URL = 'https://www.facebook.com/me';

type EditTask = Extract<AskTask, { kind: 'profile_edit' }>;

const failed = (line: string): JobEnd => ({ line, warned: false, failed: true });

/** Opens their profile and checks it's theirs. A warning, or someone else's profile, ends it. */
async function openOwn(job: Job): Promise<JobEnd | null> {
  await job.tab.open(OWN_PROFILE_URL);
  const page = await readIn(job.tab);
  const warned = await warnedOn(job, page);
  if (warned) return warned;
  if (page.kind !== 'profile' || page.profile?.friendship !== 'self')
    return failed(
      'Facebook didn’t open your own profile. Check you’re signed in to Facebook in this browser, then ask again.',
    );
  return null;
}

/** Reads the profile the tab shows and has the AI check it. */
async function readAndCheck(job: Job): Promise<JobEnd> {
  job.progress('Reading your profile…');
  const answer = await job.tab.ask({ type: 'hfos-own-profile' });
  if (!answer.ok) return failed(answer.error);
  if (!('read' in answer)) return failed('Facebook didn’t show your profile.');
  // What was and wasn't read, noted (decision 74).
  await job.report?.(ownProfileNote(answer.read));
  if (job.stopped()) return { line: 'Stopped.', warned: false };
  job.progress('Checking it with the AI…');
  valueOf(
    await job.hfos({ type: 'hfos-profile-check', workspaceId: job.businessId, input: answer.read }),
  );
  return { line: P.readDone, warned: false };
}

/** Read my profile: open it, read it, and have the AI check it. */
export async function profileRead(job: Job): Promise<JobEnd> {
  job.progress('Opening your profile…');
  return (await openOwn(job)) ?? readAndCheck(job);
}

/**
 * Put these in: the bio they picked, on their profile, and the name, username and links they OK'd, each opened for
 * them; then read again for a new check.
 */
export async function profileEdit(job: Job, task: EditTask): Promise<JobEnd> {
  const bio = task.bio;
  const more = hasNewProfileParts(task);
  if (!bio && !more) return failed('Pick a bio to put in first.');
  job.progress('Opening your profile…');
  const opened = await openOwn(job);
  if (opened) return opened;
  if (bio) {
    const put = await putBio(job, bio);
    if (put) return put;
  }
  if (more) {
    const byHand = await putInByHand(job, 'facebook', task);
    if (byHand) return byHand;
    const again = await openOwn(job);
    if (again) return again;
  }
  const checked = await readAndCheck(job);
  if (checked.failed) return checked;
  return {
    line: bio && !more ? P.editDone(bio) : profileEditDoneWords('facebook', task),
    warned: false,
  };
}

/** The bio, on the profile the tab shows: by Edit bio, or by the person when it isn't there. Null once it's in. */
async function putBio(job: Job, bio: string): Promise<JobEnd | null> {
  job.progress('Putting your new bio in…');
  const wrote = await job.tab.ask({ type: 'hfos-write-bio', bio });
  const result = wrote.ok && 'result' in wrote ? wrote.result : 'none';
  if (result !== 'done') {
    // Edit bio wasn't there, or the bio didn't show after Save: the person puts it in, and says when.
    if (!job.handOver) return failed('Facebook didn’t let the extension change your bio.');
    const reply = await job.handOver(
      `Put your new bio in: on your profile, press Edit bio (or Edit, then Bio), write “${bio}”, and press Save. Then press Carry on.`,
    );
    if (reply !== 'carry_on') return { line: 'Stopped.', warned: false, failed: true };
    return openOwn(job);
  }
  return null;
}
