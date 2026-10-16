/**
 * The person's own profile (docs/outreach.md, decision 64), asked from Get ready in HandsFreeOS:
 *
 * - **Read my profile** (`profile_read`): opens facebook.com/me in a window of its own, checks it's their own (it has
 *   **Edit profile**), reads what a stranger sees first (src/networks/facebook/own-profile.ts) and sends it for the AI's check
 *   (`outreach.profile.check`). HandsFreeOS keeps only the AI's answer; what the page said goes no further.
 * - **Put this one in** (`profile_edit`): presses **Edit bio**, writes the bio they picked, presses **Save**, then
 *   reads the profile again for a new check. Where it can't find Edit bio it hands the step to them (**Carry on** once
 *   it's in), and reads it again after.
 *
 * It stops when Facebook shows a warning (decision 25).
 */
import { PROFILE_CHECK_WORDS as P } from '@hfos/core/addons/outreach/profile-check';
import type { AskTask } from '@hfos/core/addons/outreach/asks';
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

/** Put this one in: the bio they picked, on their profile, then read again for a new check. */
export async function profileEdit(job: Job, task: EditTask): Promise<JobEnd> {
  job.progress('Opening your profile…');
  const opened = await openOwn(job);
  if (opened) return opened;
  job.progress('Putting your new bio in…');
  const wrote = await job.tab.ask({ type: 'hfos-write-bio', bio: task.bio });
  const result = wrote.ok && 'result' in wrote ? wrote.result : 'none';
  if (result !== 'done') {
    // Edit bio wasn't there, or the bio didn't show after Save: the person puts it in, and says when.
    if (!job.handOver) return failed('Facebook didn’t let the extension change your bio.');
    const reply = await job.handOver(
      `Put your new bio in: press Edit bio on your profile, write “${task.bio}”, and press Save. Then press Carry on.`,
    );
    if (reply !== 'carry_on') return { line: 'Stopped.', warned: false, failed: true };
    const again = await openOwn(job);
    if (again) return again;
  }
  const checked = await readAndCheck(job);
  return checked.failed ? checked : { line: P.editDone(task.bio), warned: false };
}
