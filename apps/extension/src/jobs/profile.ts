/**
 * The person's own profile (docs/outreach.md, decision 64), asked from Get ready in HandsFreeOS:
 *
 * - **Read my profile** (`profile_read`): opens facebook.com/me in a window of its own, checks it's their own (it has
 *   **Edit profile**, a button or, from October 2026, a link), reads what a stranger sees first
 *   (src/networks/facebook/own-profile.ts) and sends it for the AI's check (`outreach.profile.check`). HandsFreeOS
 *   keeps only the AI's answer; what the page said goes no further.
 * - **Put this one in**, **Put these in** (`profile_edit`): the bio they picked, by **Edit bio**, or, on October 2026's
 *   profile that has none, on the About tab's editor **Edit profile** leads to; each new link on Contact and basic
 *   info, where **Edit links** leads (src/networks/facebook/links.ts); and the username and the name they picked, on
 *   Accounts Center's username and name pages for their Facebook profile (./accounts-center.ts,
 *   src/networks/accounts-center/). Then the profile is read again for a new check, for the new username in its address
 *   and the new name on it (decision 89).
 * - **A step it can't find is handed over**, saying where to press on the page it's on (**Carry on** once it's in),
 *   with a note of that page (decision 74): only that step, never what went in by itself. A password or code Facebook
 *   asks for, or its "Confirm it's you", is theirs to answer, never the extension's; it waits for them. A username
 *   Facebook says is taken, a name it won't take, or either it can't change yet, ends the ask saying so and what to do.
 * - **Only what shows is said to be in.** The profile is read again at the end: a part that went in but doesn't show
 *   there yet (the bio, a link, the new username in its address, the new name) is left out of what's in, and the end
 *   says where to check it. A name Facebook says it's looking at first is said to be under review, never in.
 * - **Older builds** hand over what they didn't put in (./profile-parts.ts): before 0.93.0 the username and the links,
 *   and before 0.94.0 the name. Core still says so for them (`partHowFor`).
 *
 * It stops when Facebook shows a warning (decision 25), but reads none on Accounts Center while Facebook asks the
 * person for something there: its "Confirm it's you" is no warning. The tab decides that (`askingHere`), what's asked
 * first.
 */
import {
  cleanUsername,
  PROFILE_CHECK_WORDS as P,
  type ProfileRead,
} from '@hfos/core/addons/outreach/profile-check';
import {
  hasEveryPart,
  hasNewProfileParts,
  profileEditDoneWords,
  type AskTask,
} from '@hfos/core/addons/outreach/asks';
import { PART_PAGE_ON, partHowOn, partStepsWords } from '@hfos/core/addons/outreach/profile-parts';
import type { CenterPart } from '../networks/accounts-center/pages';
import type { EditorSteps } from '../networks/facebook/editors';
import { sameLink } from '../networks/facebook/links';
import type { BioResult, OwnEditors } from '../networks/facebook/own-profile';
import type { ReadResult } from '../networks/facebook/types';
import { classifyUrl } from '../networks/facebook/urls';
import { clean } from '../networks/facebook/dom';
import {
  centerProfile,
  nameReviewWords,
  putNameIn,
  putUsernameIn,
  unseenWords as centerUnseenWords,
  type CenterProfile,
} from './accounts-center';
import {
  partSteps,
  putParts,
  shownParts,
  unseenParts,
  unseenPartsWords,
  type PartStep,
} from './own-parts';
import { putInByHand, type ByHandPart } from './profile-parts';
import { readIn, valueOf, warnedOn, type Job, type JobEnd } from './job';
import { editorNote, ownProfileNote, type ReportNote } from './report';

/** Facebook takes this to the person's own profile, whoever they are. */
export const OWN_PROFILE_URL = 'https://www.facebook.com/me';

type EditTask = Extract<AskTask, { kind: 'profile_edit' }>;

const failed = (line: string): JobEnd => ({ line, warned: false, failed: true });
const STOPPED: JobEnd = { line: 'Stopped.', warned: false, failed: true };
const isEnd = (got: object): got is JobEnd => 'warned' in got;

/** Opens their profile and checks it's theirs: the page as read. A warning, or someone else's profile, ends it. */
async function openOwn(job: Job): Promise<JobEnd | ReadResult> {
  await job.tab.open(OWN_PROFILE_URL);
  const page = await readIn(job.tab);
  const warned = await warnedOn(job, page);
  if (warned) return warned;
  if (page.kind !== 'profile' || page.profile?.friendship !== 'self')
    return failed(
      'Facebook didn’t open your own profile. Check you’re signed in to Facebook in this browser, then ask again.',
    );
  return page;
}

/**
 * Reads the profile the tab shows and has the AI check it; `after` looks at what was read first (the bio and links
 * that went in).
 */
async function readAndCheck(
  job: Job,
  after?: (read: ProfileRead) => Promise<void>,
): Promise<JobEnd> {
  job.progress('Reading your profile…');
  const answer = await job.tab.ask({ type: 'hfos-own-profile' });
  if (!answer.ok) return failed(answer.error);
  if (!('read' in answer)) return failed('Facebook didn’t show your profile.');
  // What was and wasn't read, noted (decision 74).
  await job.report?.(ownProfileNote(answer.read));
  await after?.(answer.read);
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
  const opened = await openOwn(job);
  return isEnd(opened) ? opened : readAndCheck(job);
}

/** A warning on the page the tab shows: noted, and the end. Null when there's none. */
async function warnedHere(job: Job): Promise<JobEnd | null> {
  return warnedOn(job, await readIn(job.tab));
}

/** Hands a step to the person, and waits for Carry on: null once they've pressed it, how it ended when they stopped. */
async function handed(job: Job, says: string, note?: ReportNote): Promise<JobEnd | null> {
  if (!job.handOver) return failed('Facebook didn’t let the extension change your profile.');
  const reply = await job.handOver(says, note);
  return reply === 'carry_on' ? null : STOPPED;
}

/** Opens a page for one of decision 99's parts: null once it's open, how it ended on a warning. */
async function openPart(job: Job, url: string): Promise<JobEnd | null> {
  const page = await openEditor(job, url);
  return isEnd(page) ? page : null;
}

/** Opens one of the profile's editors: the page as read. A warning ends it. */
async function openEditor(job: Job, url: string): Promise<JobEnd | ReadResult> {
  await job.tab.open(url);
  const page = await readIn(job.tab);
  return (await warnedOn(job, page)) ?? page;
}

/**
 * Put these in: the bio they picked, then each new link, then the username (after the links, as Edit links's address
 * holds the old one) and the name, on Accounts Center's pages for their Facebook profile, each put in by itself or
 * handed over; then the profile read again for a new check.
 */
export async function profileEdit(job: Job, task: EditTask): Promise<JobEnd> {
  const { bio } = task;
  const more = hasNewProfileParts(task);
  const every = hasEveryPart('facebook', task);
  if (!bio && !more && !every) return failed('Pick a bio to put in first.');
  job.progress('Opening your profile…');
  const opened = await openOwn(job);
  if (isEnd(opened)) return opened;
  const editors = await ownEditors(job);
  if (bio) {
    const put = await putBio(job, bio, editors);
    if (put) return put;
  }
  // Decision 99's parts: the links that don't fit taken off first, on Contact and basic info; the work and the post
  // after the rest.
  const steps = partSteps('facebook', task, {
    profile: OWN_PROFILE_URL,
    work: editors?.work ?? null,
    links: editors?.links ?? null,
  });
  const ways = { open: (url: string) => openPart(job, url) };
  const offs = await putParts(
    job,
    steps.filter((s) => s.write.kind === 'link_off'),
    ways,
  );
  if (!Array.isArray(offs)) return offs;
  // A link changed is taken off, then the new one added with the rest.
  const links = [
    ...task.links,
    ...task.linkChanges
      .map((c) => c.to)
      .filter((to): to is string => !!to && !task.links.some((l) => sameLink(l, to))),
  ];
  const done = new Set<ByHandPart>();
  if (links.length && partHowOn('facebook', 'links') === 'auto') {
    if (job.stopped()) return STOPPED;
    const put = await putLinks(job, links, editors);
    if (put) return put;
    done.add('links');
  }
  // What Facebook refused, in its words, by part; and a name it's looking at first.
  const refused = new Map<CenterPart, string>();
  let review = false;
  const username = task.username ? cleanUsername(task.username) : null;
  const name = task.name ? clean(task.name) : null;
  const putUsername = username !== null && partHowOn('facebook', 'username') === 'auto';
  const putName = name !== null && partHowOn('facebook', 'name') === 'auto';
  if (putUsername || putName) {
    if (job.stopped()) return STOPPED;
    // Their profile's number, from its Edit profile link; else the Facebook one among Accounts Center's Profiles, found
    // once for both.
    let center: CenterProfile | null =
      editors?.id && /^\d{1,20}$/.test(editors.id) ? { id: editors.id, why: null } : null;
    if (!center) {
      job.progress('Opening Accounts Center’s profiles…');
      const found = await centerProfile(job, 'facebook', putUsername ? 'username' : 'name');
      if (isEnd(found)) return found;
      center = found;
    }
    if (putUsername) {
      const put = await putUsernameIn(job, 'facebook', username, center);
      if (isEnd(put)) return put;
      if (put.refused) refused.set('username', put.refused);
      done.add('username');
    }
    if (putName) {
      if (job.stopped()) return STOPPED;
      const put = await putNameIn(job, 'facebook', name, center);
      if (isEnd(put)) return put;
      if (put.refused) refused.set('name', put.refused);
      review = put.review ?? false;
      done.add('name');
    }
  }
  if (more) {
    const byHand = await putInByHand(job, 'facebook', task, done);
    if (byHand) return byHand;
  }
  const rest: PartStep[] = steps.filter((s) => s.write.kind !== 'link_off');
  if (rest.length) {
    const put = await putParts(job, rest, ways);
    if (!Array.isArray(put)) return put;
  }
  const again = await openOwn(job);
  if (isEnd(again)) return again;
  // Their new username, in the address /me went to: Facebook leaves out dots when it matches one.
  const plain = (u: string) => u.toLowerCase().replace(/\./g, '');
  const at = classifyUrl(again.url).profile?.username ?? null;
  const usernameUnseen =
    username !== null && !refused.has('username') && (at === null || plain(at) !== plain(username));
  // What went in but doesn't show on the profile read after: never said to be in.
  let unseen: ShownPart[] = [];
  let unseenEvery = new Set<string>();
  const checked = await readAndCheck(job, async (read) => {
    unseenEvery = every ? unseenParts('facebook', task, read) : new Set();
    unseen = SHOWN_PARTS.filter((part) =>
      part === 'bio'
        ? bio !== null && clean(read.bio) !== clean(bio)
        : part === 'links'
          ? task.links.some((l) => !(read.links ?? []).some((r) => sameLink(r, l)))
          : part === 'name'
            ? name !== null && !refused.has('name') && !review && !nameShows(read.name, name)
            : usernameUnseen,
    );
    if (unseen.length || unseenEvery.size)
      await job.report?.({
        job: 'profile_edit.check',
        note: `Not shown on the profile after it went in: ${[...unseen, ...unseenEvery].map((p) => `the ${p}`).join(', ')}.`,
        outline: true,
      });
  });
  if (checked.failed) return checked;
  const shown = {
    ...shownParts(task, unseenEvery),
    bio: unseen.includes('bio') ? null : bio,
    links: unseen.includes('links') ? [] : task.links,
    username: refused.has('username') || unseen.includes('username') ? null : task.username,
    name: refused.has('name') || review || unseen.includes('name') ? null : task.name,
  };
  const anyIn = Boolean(
    shown.bio ||
    shown.name ||
    shown.username ||
    shown.links.length ||
    hasEveryPart('facebook', shown),
  );
  const doneLine = !anyIn
    ? null
    : shown.bio && !hasNewProfileParts(shown) && !hasEveryPart('facebook', shown)
      ? P.editDone(shown.bio)
      : profileEditDoneWords('facebook', shown);
  const after = [
    refused.get('username'),
    refused.get('name'),
    review && name ? nameReviewWords('facebook', name) : null,
    ...unseen.map((part) => unseenWords(part, task, username, name)),
    unseenPartsWords('facebook', unseenEvery),
  ];
  const line = [doneLine, ...after].filter((l): l is string => Boolean(l)).join(' ');
  return {
    line,
    warned: false,
    ...(refused.size || (!anyIn && !review) ? { failed: true } : {}),
  };
}

/**
 * Whether the profile shows the new name: with Facebook's other name after it in brackets or not, and in whichever
 * order Facebook shows it (the step after Review change keeps the order it had, which may put the last name first).
 */
function nameShows(read: string | null | undefined, name: string): boolean {
  const words = (text: string) =>
    text
      .split(/[\s,]+/)
      .filter(Boolean)
      .sort()
      .join(' ');
  const shown = clean(read).replace(/ \(.*\)$/, '');
  return shown !== '' && words(shown) === words(clean(name));
}

/** The parts read back on the profile after they went in, to be sure they show. */
const SHOWN_PARTS = ['bio', 'links', 'username', 'name'] as const;
type ShownPart = (typeof SHOWN_PARTS)[number];

/** What's said of a part that went in but doesn't show on the profile yet, and where to check it. */
function unseenWords(
  part: ShownPart,
  task: EditTask,
  username: string | null,
  name: string | null,
): string {
  if (part === 'bio')
    return `Facebook hasn’t shown your new bio on your profile yet. Check it there, and if it isn’t, press Edit bio (or Edit profile, then Bio), write “${task.bio ?? ''}”, and press Save.`;
  if (part === 'links')
    return task.links.length === 1
      ? `Facebook hasn’t shown your new link on your profile yet. Check your About tab under Contact and basic info, and if it isn’t there, press Add a website, paste “${task.links[0]}”, and press Save.`
      : `Facebook hasn’t shown all your new links on your profile yet. Check your About tab under Contact and basic info, and add any that aren’t there with Add a website and Save (${task.links.join(', ')}).`;
  return part === 'name'
    ? centerUnseenWords('facebook', 'name', name ?? '')
    : centerUnseenWords('facebook', 'username', username ?? '');
}

/** Where the profile is changed, as the tab finds it on their own profile; null when it can't. */
async function ownEditors(job: Job): Promise<OwnEditors | null> {
  const answer = await job.tab.ask({ type: 'hfos-own-editors' });
  return answer.ok ? answer.editors : null;
}

/** Asks the tab to put the bio in on the page it shows: how it went, step by step. */
async function writeBioHere(
  job: Job,
  bio: string,
): Promise<{ readonly result: BioResult; readonly steps?: EditorSteps }> {
  const wrote = await job.tab.ask({ type: 'hfos-write-bio', bio });
  return wrote.ok && 'result' in wrote
    ? { result: wrote.result as BioResult, steps: wrote.bioSteps }
    : { result: 'none' };
}

/** What the person is asked to do with the bio, by where it stopped. */
function bioWords(
  bio: string,
  onEditor: boolean,
  result: BioResult,
  steps: EditorSteps | undefined,
): string {
  if (result === 'not_saved')
    return `Facebook didn’t show your new bio after Save. On this page, check it says “${bio}” under Bio, and press Save if its box is still open. Then press Carry on.`;
  if (steps?.typed)
    return 'Your new bio is in its box on this page. Press Save under it, then press Carry on.';
  if (!onEditor)
    return `Put your new bio in: on your profile, press Edit bio (or Edit, then Bio), write “${bio}”, and press Save. Then press Carry on.`;
  return `Put your new bio in: on this page, press Edit by Bio (or Add bio), write “${bio}”, and press Save. Then press Carry on.`;
}

/**
 * The bio, on their profile by Edit bio; else on the About tab's editor Edit profile leads to, by the bio's own
 * control; else by the person, on the page it got to. Null once it's in.
 */
async function putBio(job: Job, bio: string, editors: OwnEditors | null): Promise<JobEnd | null> {
  job.progress('Putting your new bio in…');
  let wrote = await writeBioHere(job, bio);
  let onEditor = false;
  if (wrote.result === 'none' && !wrote.steps?.control && editors?.about) {
    // No Edit bio on the profile (October 2026): the About tab's editor, as Edit profile leads to it.
    const warned = await warnedHere(job);
    if (warned) return warned;
    job.progress('Opening where your bio is changed…');
    const page = await openEditor(job, editors.about);
    if (isEnd(page)) return page;
    onEditor = page.kind === 'profile';
    job.progress('Putting your new bio in…');
    wrote = await writeBioHere(job, bio);
  }
  if (wrote.result === 'done') return null;
  // Something wasn't as expected (a warning, maybe: nothing was pressed then); the person puts it in, and says when.
  const warned = await warnedHere(job);
  if (warned) return warned;
  return handed(
    job,
    bioWords(bio, onEditor, wrote.result, wrote.steps),
    editorNote('bio', wrote.steps),
  );
}

/** What the person is asked to do with the links still to add, by where it stopped. */
function linksWords(
  left: readonly string[],
  result: string,
  steps: EditorSteps | undefined,
): string {
  const each = left.length === 1 ? `“${left[0]}”` : `each one (${left.join(', ')})`;
  if (result === 'not_saved')
    return `Facebook didn’t show “${left[0]}” after Save. On this page, check it’s under Websites and social links, and add ${each} with Add a website and Save if not. Then press Carry on.`;
  if (steps?.typed)
    return left.length === 1
      ? 'Your new link is in its box on this page. Press Save under it, then press Carry on.'
      : `Your new link is in its box on this page. Press Save under it, then add the rest (${left.slice(1).join(', ')}) with Add a website and Save. Then press Carry on.`;
  return `Add your ${left.length === 1 ? 'link' : 'links'}: on this page, under Websites and social links, press Add a website, paste ${each}, and press Save. Then press Carry on.`;
}

/**
 * Each new link, on Contact and basic info where Edit links leads: added by itself, or what's left handed to the
 * person on that page. Links are only added; one there already stays. Null once they're in.
 */
async function putLinks(
  job: Job,
  links: readonly string[],
  editors: OwnEditors | null,
): Promise<JobEnd | null> {
  job.progress('Opening where your links are changed…');
  if (!editors?.links) {
    // Nowhere to go by: their profile, and the step handed over as it was before.
    const page = await openEditor(job, PART_PAGE_ON.facebook?.links ?? OWN_PROFILE_URL);
    if (isEnd(page)) return page;
    return handed(job, `${partStepsWords('facebook', 'links', links)} Then press Carry on.`, {
      job: 'profile_edit.links',
      note: 'No Edit links on the profile, so the links were handed to the person.',
    });
  }
  const page = await openEditor(job, editors.links);
  if (isEnd(page)) return page;
  for (const [i, link] of links.entries()) {
    if (job.stopped()) return STOPPED;
    job.progress(
      links.length > 1 ? `Adding your link ${i + 1} of ${links.length}…` : 'Adding your link…',
    );
    const wrote = await job.tab.ask({ type: 'hfos-write-link', link });
    const result = wrote.ok ? wrote.result : 'none';
    if (result === 'done' || result === 'already') continue;
    const steps = wrote.ok ? wrote.steps : undefined;
    const warned = await warnedHere(job);
    if (warned) return warned;
    return handed(job, linksWords(links.slice(i), result, steps), editorNote('links', steps));
  }
  return null;
}
