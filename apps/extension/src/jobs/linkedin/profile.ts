/**
 * The person's own LinkedIn profile (docs/outreach.md, decision 64, LinkedIn's way), asked from Get ready in
 * HandsFreeOS:
 *
 * - **Read my profile** (`profile_read`): opens linkedin.com/in/me/ in a window of its own, checks it's their own
 *   (it has Edit intro, Add profile section and the like, never Connect), reads their headline, About, Experience,
 *   Featured and latest posts (src/networks/linkedin/own-profile.ts), and sends it for the AI's check
 *   (`outreach.profile.check`, as LinkedIn's). HandsFreeOS keeps only the AI's answer.
 * - **Put this one in** (`profile_edit`): opens the intro's box with Edit intro, types only into Headline, and presses
 *   Save; the About and the name the same way; then, from 0.98.0 (decision 99), its address, websites, work and what's
 *   featured, each on its own page (../own-parts.ts, src/networks/linkedin/parts.ts). Then it reads the profile again
 *   for a new check. Anything it doesn't expect, it hands to the person (**Carry on** once that part is in) and never
 *   guesses.
 *
 * It stops on any LinkedIn warning.
 */
import { hasEveryPart, profileEditDoneWords, type AskTask } from '@hfos/core/addons/outreach/asks';
import type { ProfileRead } from '@hfos/core/addons/outreach/profile-check';
import { partStepsWords } from '@hfos/core/addons/outreach/profile-parts';
import { partSteps, putParts, shownParts, unseenParts, unseenPartsWords } from '../own-parts';
import type { OwnProfileAnswer } from '../../messages';
import { PROFILE_CHECK_WORDS as P } from '@hfos/core/addons/outreach/profile-check';
import { valueOf, warnedOn, type Job, type JobEnd } from '../job';
import { aboutNote, headlineNote, loadNote, ownProfileNote, type ReportNote } from '../report';
import { LINKEDIN, OWN_PROFILE, readLinkedIn, SIGNED_IN } from './read';

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

/** Where decision 99's parts are put in: Public profile & URL, Contact info and their posts. */
const ADDRESS_PAGE = `${LINKEDIN}/public-profile/settings`;
const CONTACT_PAGE = `${LINKEDIN}/in/me/overlay/contact-info/`;
const POSTS_PAGE = `${LINKEDIN}/in/me/recent-activity/all/`;

/** Opens a page for one of decision 99's parts: null once it's open, how it ended on a warning. */
async function openPart(job: Job, url: string): Promise<JobEnd | null> {
  await job.tab.open(url);
  return warnedOn(job, await readLinkedIn(job.tab));
}

/**
 * Reads the profile the window shows and has the AI check it; `after` looks at what was read first (decision 99's
 * parts that went in).
 */
async function readAndCheck(
  job: Job,
  after?: (read: ProfileRead) => Promise<void>,
): Promise<JobEnd> {
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
  await after?.(answer.read);
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

/**
 * Puts one part in, on the profile the window shows: what the tab says of how it went, and, when it didn't, the person
 * puts it in by hand (**Carry on** once it's in) and the profile is opened again. A line to end on, when it ends.
 */
async function putIn(
  job: Job,
  part: 'headline' | 'About' | 'name',
  write: () => Promise<OwnProfileAnswer>,
  byHand: string,
  noteOf: (wrote: OwnProfileAnswer) => ReportNote = () => ({}),
): Promise<JobEnd | null> {
  job.progress(`Putting your new ${part} in…`);
  const wrote = await write();
  const result = wrote.ok && 'result' in wrote ? wrote.result : 'none';
  if (result === 'done') return null;
  // Something wasn't as expected: the person puts it in, and says when. The note of the page says which step it was.
  if (!job.handOver) return failed(`LinkedIn didn’t let the extension change your ${part}.`);
  const reply = await job.handOver(byHand, noteOf(wrote));
  if (reply !== 'carry_on') return { line: 'Stopped.', warned: false, failed: true };
  return openOwn(job);
}

/**
 * Put this one in, or Put them all in (decision 80): the headline they picked, the About they OK'd, or both, on their
 * profile, then read again for a new check.
 */
export async function linkedInProfileEdit(job: Job, task: EditTask): Promise<JobEnd> {
  job.progress('Opening your LinkedIn profile…');
  const opened = await openOwn(job);
  if (opened) return opened;
  const { bio, about } = task;
  if (bio) {
    const ended = await putIn(
      job,
      'headline',
      () => job.tab.ask({ type: 'hfos-write-bio', bio }),
      `Put your new headline in: press the pencil by your name on your LinkedIn profile, write “${bio}” under Headline, and press Save. Then press Carry on.`,
      (wrote) => headlineNote(wrote.ok && 'result' in wrote ? wrote.steps : undefined),
    );
    if (ended) return ended;
  }
  if (about) {
    if (job.stopped()) return { line: 'Stopped.', warned: false };
    const ended = await putIn(
      job,
      'About',
      () => job.tab.ask({ type: 'hfos-write-about', about }),
      'Put your new About in: press the pencil by About on your LinkedIn profile, paste the About from HandsFreeOS, and press Save. Then press Carry on.',
      (wrote) => aboutNote(wrote.ok && 'result' in wrote ? wrote.aboutSteps : undefined),
    );
    if (ended) return ended;
  }
  // Its name, in the intro's box (decision 84).
  const { name } = task;
  if (name) {
    if (job.stopped()) return { line: 'Stopped.', warned: false };
    const ended = await putIn(
      job,
      'name',
      () => job.tab.ask({ type: 'hfos-write-name', name }),
      `${partStepsWords('linkedin', 'name', name)} Then press Carry on.`,
    );
    if (ended) return ended;
  }
  // Decision 99's parts (from 0.98.0 its address and websites too, put in by itself): on their own pages.
  const steps = partSteps('linkedin', task, {
    profile: OWN_PROFILE,
    address: ADDRESS_PAGE,
    contact: CONTACT_PAGE,
    posts: POSTS_PAGE,
  });
  if (steps.length) {
    const put = await putParts(job, steps, { open: (url) => openPart(job, url) });
    if (!Array.isArray(put)) return put;
  }
  if (steps.length) {
    const again = await openOwn(job);
    if (again) return again;
  }
  let unseen = new Set<string>();
  const every = hasEveryPart('linkedin', task) || !!task.username || task.links.length > 0;
  const checked = await readAndCheck(job, async (read) => {
    unseen = every ? unseenParts('linkedin', task, read) : new Set();
    if (unseen.size)
      await job.report?.({
        job: 'profile_edit.check',
        note: `Not shown on the profile after it went in: ${[...unseen].map((p) => `the ${p}`).join(', ')}.`,
        outline: true,
      });
  });
  if (checked.failed) return checked;
  if (name || every) {
    const shown = shownParts(task, unseen);
    const words = [profileEditDoneWords('linkedin', shown), unseenPartsWords('linkedin', unseen)];
    return { line: words.filter(Boolean).join(' '), warned: false };
  }
  const said = [bio ? `Your headline now says “${bio}”.` : null, about ? P.editAboutDone : null];
  return { line: said.filter(Boolean).join(' '), warned: false };
}
