/**
 * The person's own profile (docs/outreach.md, decision 64), asked from Get ready in HandsFreeOS:
 *
 * - **Read my profile** (`profile_read`): opens facebook.com/me in a window of its own, checks it's their own (it has
 *   **Edit profile**, a button or, from October 2026, a link), reads what a stranger sees first
 *   (src/networks/facebook/own-profile.ts) and sends it for the AI's check (`outreach.profile.check`). HandsFreeOS
 *   keeps only the AI's answer; what the page said goes no further.
 * - **Put this one in**, **Put these in** (`profile_edit`): the bio they picked, by **Edit bio**, or, on October 2026's
 *   profile that has none, on the About tab's editor **Edit profile** leads to; each new link on Contact and basic
 *   info, where **Edit links** leads (src/networks/facebook/links.ts); and the username they picked, on Accounts
 *   Center's username page for their Facebook profile (src/networks/facebook/username.ts). Then the profile is read
 *   again for a new check, and for the new username in its address (decision 89).
 * - **A step it can't find is handed over**, saying where to press on the page it's on (**Carry on** once it's in),
 *   with a note of that page (decision 74): only that step, never what went in by itself. A password or code Facebook
 *   asks for is theirs to type, never the extension's; it waits for them. A username Facebook says is taken, or can't
 *   change yet, ends the ask saying so and what to do.
 * - **Its name** (decision 84) stays theirs: Accounts Center is opened for them, and the step handed over with what to
 *   put in (./profile-parts.ts).
 *
 * It stops when Facebook shows a warning (decision 25), but reads none on Accounts Center's username page while Facebook
 * asks for a password there: its "Confirm it's you" is no warning. The tab decides that, password first.
 */
import {
  cleanUsername,
  PROFILE_CHECK_WORDS as P,
  type ProfileRead,
} from '@hfos/core/addons/outreach/profile-check';
import {
  hasNewProfileParts,
  profileEditDoneWords,
  type AskTask,
} from '@hfos/core/addons/outreach/asks';
import { PART_PAGE_ON, partHowOn, partStepsWords } from '@hfos/core/addons/outreach/profile-parts';
import type { EditorSteps } from '../networks/facebook/editors';
import { sameLink } from '../networks/facebook/links';
import type { BioResult, OwnEditors } from '../networks/facebook/own-profile';
import type { ReadResult } from '../networks/facebook/types';
import { classifyUrl } from '../networks/facebook/urls';
import { clean } from '../networks/facebook/dom';
import {
  ACCOUNTS_PROFILES,
  askedNote,
  usernameAddress,
  usernamePageOf,
  type Asking,
} from '../networks/facebook/username';
import { putInByHand, type ByHandPart } from './profile-parts';
import { readIn, valueOf, warnedLine, warnedOn, type Job, type JobEnd } from './job';
import { editorNote, ownProfileNote, usernameNote, type ReportNote } from './report';

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

/** Opens one of the profile's editors: the page as read. A warning ends it. */
async function openEditor(job: Job, url: string): Promise<JobEnd | ReadResult> {
  await job.tab.open(url);
  const page = await readIn(job.tab);
  return (await warnedOn(job, page)) ?? page;
}

/**
 * Put these in: the bio they picked, then each new link, then the username (last, as Edit links's address holds the
 * old one), each put in by itself or handed over; the name opened for them; then the profile read again for a new
 * check.
 */
export async function profileEdit(job: Job, task: EditTask): Promise<JobEnd> {
  const { bio } = task;
  const more = hasNewProfileParts(task);
  if (!bio && !more) return failed('Pick a bio to put in first.');
  job.progress('Opening your profile…');
  const opened = await openOwn(job);
  if (isEnd(opened)) return opened;
  const editors = await ownEditors(job);
  if (bio) {
    const put = await putBio(job, bio, editors);
    if (put) return put;
  }
  const done = new Set<ByHandPart>();
  if (task.links.length && partHowOn('facebook', 'links') === 'auto') {
    if (job.stopped()) return STOPPED;
    const put = await putLinks(job, task.links, editors);
    if (put) return put;
    done.add('links');
  }
  let refused: string | null = null;
  const username = task.username ? cleanUsername(task.username) : null;
  if (username && partHowOn('facebook', 'username') === 'auto') {
    if (job.stopped()) return STOPPED;
    const put = await putUsername(job, username, editors);
    if (isEnd(put)) return put;
    refused = put.refused;
    done.add('username');
  }
  if (more) {
    const byHand = await putInByHand(job, 'facebook', task, done);
    if (byHand) return byHand;
  }
  const again = await openOwn(job);
  if (isEnd(again)) return again;
  // Their new username, in the address /me went to: Facebook leaves out dots when it matches one.
  const plain = (u: string) => u.toLowerCase().replace(/\./g, '');
  const at = classifyUrl(again.url).profile?.username ?? null;
  const usernameUnseen =
    username !== null && !refused && (at === null || plain(at) !== plain(username));
  // What went in but doesn't show on the profile read after: never said to be in.
  let unseen: ShownPart[] = [];
  const checked = await readAndCheck(job, async (read) => {
    unseen = SHOWN_PARTS.filter((part) =>
      part === 'bio'
        ? bio !== null && clean(read.bio) !== clean(bio)
        : part === 'links'
          ? task.links.some((l) => !(read.links ?? []).some((r) => sameLink(r, l)))
          : usernameUnseen,
    );
    if (unseen.length)
      await job.report?.({
        job: 'profile_edit.check',
        note: `Not shown on the profile after it went in: ${unseen.map((p) => `the ${p}`).join(', ')}.`,
        outline: true,
      });
  });
  if (checked.failed) return checked;
  const shown = {
    ...task,
    bio: unseen.includes('bio') ? null : bio,
    links: unseen.includes('links') ? [] : task.links,
    username: refused || unseen.includes('username') ? null : task.username,
  };
  const anyIn = Boolean(shown.bio || shown.name || shown.username || shown.links.length);
  const doneLine = !anyIn
    ? null
    : shown.bio && !hasNewProfileParts(shown)
      ? P.editDone(shown.bio)
      : profileEditDoneWords('facebook', shown);
  const after = [refused, ...unseen.map((part) => unseenWords(part, task, username))];
  const line = [doneLine, ...after].filter((l): l is string => Boolean(l)).join(' ');
  return { line, warned: false, ...(refused || !anyIn ? { failed: true } : {}) };
}

/** The parts read back on the profile after they went in, to be sure they show. */
const SHOWN_PARTS = ['bio', 'links', 'username'] as const;
type ShownPart = (typeof SHOWN_PARTS)[number];

/** What's said of a part that went in but doesn't show on the profile yet, and where to check it. */
function unseenWords(part: ShownPart, task: EditTask, username: string | null): string {
  if (part === 'bio')
    return `Facebook hasn’t shown your new bio on your profile yet. Check it on your profile: press Edit profile, and put “${task.bio ?? ''}” in under Bio if it isn’t there.`;
  if (part === 'links')
    return `Facebook hasn’t shown ${task.links.length === 1 ? 'your new link' : 'all your new links'} on your profile yet. Check on your profile: press Edit links on the Links card, and add any that aren’t there with Add a website.`;
  return `Facebook hasn’t shown your new username on your profile yet. Check it in Accounts Center: press Profiles, then your Facebook profile, then Username, and put “${username ?? ''}” in if it isn’t there.`;
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

/** What Facebook asks before a username changes, which only the person answers. */
const ASKING_WORDS: Readonly<Record<Asking, string>> = {
  password:
    'Facebook wants your password to change your username. Type it in the Facebook window and press Continue there, then press Carry on.',
  code: 'Facebook sent you a code to change your username. Type it in the Facebook window and press Continue there, then press Carry on.',
  confirm:
    'Facebook wants to check it’s you before your username changes. In the Facebook window, pick how (your password, or a code it sends you), type it and press Continue there. Then press Carry on.',
};

/** Facebook still asking after the person carried on, each time: the username stays as it was. */
const KEPT_ASKING: Readonly<Record<Asking, string>> = {
  password: 'Facebook kept asking for your password',
  code: 'Facebook kept asking for a code',
  confirm: 'Facebook kept asking you to confirm it’s you',
};

/** Why the username stays as it was, as Facebook said it, and what to do. */
function refusedWords(
  result: 'taken' | 'invalid' | 'limit',
  u: string,
  said: string | null,
): string {
  const pickAgain =
    'Pick another under Username: in Social Outreach, go to Settings → Facebook and press Check your profile. Then press Put these in again.';
  if (result === 'taken')
    return `Facebook says “${said ?? `${u} isn’t available`}”, so your username stays as it was. ${pickAgain}`;
  if (result === 'invalid')
    return `Facebook won’t take “${u}” as your username${said ? `: it says “${said}”` : ''}. ${pickAgain}`;
  return `Facebook won’t change your username right now${said ? `: it says “${said}”` : ''}. Try again in a few days, or keep the one you have.`;
}

/**
 * Facebook's warnings on the page the tab shows, after the person carried on or something wasn't as expected: noted,
 * and the end. On Accounts Center none are read while Facebook asks the person for something (the tab decides).
 */
async function accountWarned(job: Job, at: string): Promise<JobEnd | null> {
  const here = await job.tab.ask({ type: 'hfos-account-warnings' });
  if (!here.ok || !here.warnings.length) return null;
  await job.warn(here.warnings, at);
  return { line: warnedLine(here.warnings), warned: true };
}

/**
 * On Accounts Center's Profiles, the Facebook profile's username page: once more after the person answers what
 * Facebook asks first. Null with why, for the note, when there's none.
 */
async function facebookProfileUrl(
  job: Job,
): Promise<JobEnd | { readonly url: string | null; readonly why: string }> {
  await job.tab.open(ACCOUNTS_PROFILES);
  for (let turn = 0; ; turn++) {
    const found = await job.tab.ask({ type: 'hfos-username-page' });
    if (!found.ok)
      return {
        url: null,
        why: 'Accounts Center’s Profiles didn’t open, so the username was handed to the person.',
      };
    if (found.warnings.length) {
      await job.warn(found.warnings, ACCOUNTS_PROFILES);
      return { line: warnedLine(found.warnings), warned: true };
    }
    if (!found.asking)
      return {
        url: found.url,
        why: 'No Facebook profile among Accounts Center’s Profiles, so the username was handed to the person.',
      };
    if (turn > 0)
      return {
        url: null,
        why: `${askedNote(found.asking)} on Accounts Center’s Profiles again, so the username was handed to the person.`,
      };
    // Theirs to answer, never the extension's; then Profiles is looked at again.
    const ended = await handed(job, ASKING_WORDS[found.asking], {
      job: 'profile_edit.username',
      note: `${askedNote(found.asking)} on Accounts Center’s Profiles.`,
      outline: true,
    });
    if (ended) return ended;
  }
}

/**
 * The username, on Accounts Center's username page for their Facebook profile: put in by itself, waited on while
 * Facebook asks the person for something, or handed over. What Facebook refused, said; null once it's in or handed
 * over. The page's warnings are the tab's to read, as it reads none while Facebook asks for something there; any
 * other page the tab ends up on has its warnings read before a step's handed over.
 */
async function putUsername(
  job: Job,
  u: string,
  editors: OwnEditors | null,
): Promise<JobEnd | { readonly refused: string | null }> {
  job.progress('Opening where your username is changed…');
  let url = usernameAddress(editors?.id);
  let why = '';
  if (!url) {
    // No number on their profile: Accounts Center's Profiles, and the Facebook one among them.
    const found = await facebookProfileUrl(job);
    if (isEnd(found)) return found;
    ({ url, why } = found);
  }
  const profile = url ? usernamePageOf(url) : null;
  if (!url || !profile) {
    const warned = await accountWarned(job, ACCOUNTS_PROFILES);
    if (warned) return warned;
    const ended = await handed(
      job,
      `${partStepsWords('facebook', 'username', u)} Then press Carry on.`,
      { job: 'profile_edit.username', note: why, outline: true },
    );
    return ended ?? { refused: null };
  }
  await job.tab.open(url);
  let asked: Asking = 'password';
  for (let turn = 0; turn < 3; turn++) {
    if (job.stopped()) return STOPPED;
    job.progress('Putting your new username in…');
    const wrote = await job.tab.ask({ type: 'hfos-write-username', username: u, profile });
    if (!wrote.ok) {
      // Facebook didn't open the username page: a warning there ends it; else the person goes there, as the step said.
      const warned = await accountWarned(job, url);
      if (warned) return warned;
      const ended = await handed(
        job,
        `${partStepsWords('facebook', 'username', u)} Then press Carry on.`,
        {
          job: 'profile_edit.username',
          note: 'Accounts Center’s username page didn’t open, so the username was handed to the person.',
          outline: true,
        },
      );
      return ended ?? { refused: null };
    }
    switch (wrote.result) {
      case 'done':
      case 'already':
        return { refused: null };
      case 'warned': {
        const words = wrote.warnings?.length ? wrote.warnings : ['Facebook showed a warning.'];
        await job.warn(words, url);
        return { line: warnedLine(words), warned: true };
      }
      case 'waiting': {
        // Their password, a code, or confirming it's them: theirs to answer, never the extension's.
        asked = wrote.steps.asking ?? 'password';
        const ended = await handed(job, ASKING_WORDS[asked], {
          ...usernameNote(wrote.steps),
          note: `${askedNote(asked)} before the username changed.`,
        });
        if (ended) return ended;
        // After Done, it's in once they've answered (the profile read after says); before, the username goes in now.
        if (wrote.steps.pressed) return { refused: null };
        continue;
      }
      case 'taken':
      case 'invalid':
      case 'limit':
        return { refused: refusedWords(wrote.result, u, wrote.said) };
      default: {
        const warned = await accountWarned(job, url);
        if (warned) return warned;
        const ended = await handed(
          job,
          wrote.steps.over
            ? `Facebook opened a box after Done. In the Facebook window, press its button to change your username to “${u}”, then press Carry on.`
            : wrote.result === 'not_saved'
              ? `Facebook didn’t show your new username after Done. On this page, check Username says “${u}”, and press Done if it’s still there. Then press Carry on.`
              : `Change your username: on this page, put “${u}” in Username, and press Done once Facebook says it’s available. Then press Carry on.`,
          usernameNote(wrote.steps),
        );
        return ended ?? { refused: null };
      }
    }
  }
  // Facebook asked again each time they carried on: Done was never pressed.
  return {
    refused: `${KEPT_ASKING[asked]}, so your username stays as it was. Change it in Accounts Center (press Profiles, then your Facebook profile, then Username), or press Put these in again.`,
  };
}
