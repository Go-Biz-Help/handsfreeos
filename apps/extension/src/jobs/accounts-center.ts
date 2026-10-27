/**
 * Put these in's steps on Accounts Center (docs/outreach.md, decision 89; the owner, 26 Oct 2026: "1a 2a 3a"): the
 * username and the name of the person's own Facebook profile (./profile.ts), and of their own Instagram profile
 * (./looking.ts), each on its own network's Accounts Center, in that network's window (src/networks/accounts-center/).
 *
 * - **Their own profile, by its number.** On Facebook, the number on their profile's Edit profile link, or else the
 *   Facebook row among Profiles; on Instagram, only the row that shows the account they're signed in to on
 *   instagram.com, never another Instagram row (`centerProfile`). Found once, for both parts. None found: the step is
 *   handed over, saying why and which row to press. Chrome keeping the extension off Instagram's Accounts Center
 *   (`centerAllowed`) hands both over too, saying how to let it on.
 * - **Put in by itself, waited on, or handed over.** The tab types only on that profile's own page. A password, a code
 *   or "Confirm it's you" is the person's to answer: the step waits for them, and goes on once they press Carry on
 *   (three times at most). Anything else not as expected is handed over on the page it's on, with a note of the page.
 * - **The network's answer, said.** A username taken or not allowed, a name it won't take, or a change it won't make
 *   now ends that part with the network's own words and what to do; a name it looks at first is said to be under
 *   review, never in. A warning on the page stops the network for the day (decision 25); none is read while it asks
 *   the person for something, and its answer about the name or username is never one. A username it won't change with
 *   "Try again later" (`later`) leaves the name for another day on Instagram, so nothing more is pressed after it.
 * - **One network's profile only.** An offer to change the other network's username or name too is never taken up:
 *   the step is handed over, saying to change only this one.
 */
import { PLATFORMS } from '@hfos/core/addons/outreach/networks';
import { nameProblem, splitName } from '@hfos/core/addons/outreach/profile-check';
import { partStepsWords } from '@hfos/core/addons/outreach/profile-parts';
import type { NameSteps, NameWrote } from '../networks/accounts-center/name';
import {
  askedNote,
  centerAddress,
  centerHome,
  OTHER_NETWORK,
  profilesAddress,
  type Asking,
  type CenterNetwork,
  type CenterPart,
} from '../networks/accounts-center/pages';
import type { UsernameWrote } from '../networks/accounts-center/username';
import { warnedLine, type Job, type JobEnd } from './job';
import { nameNote, usernameNote, type ReportNote } from './report';

const STOPPED: JobEnd = { line: 'Stopped.', warned: false, failed: true };
const isEnd = (got: object): got is JobEnd => 'warned' in got;

/**
 * How a part went that didn't end the job: the network's refusal in words, a name it looks at first, and whether the
 * network said "Try again later" (`later`), after which nothing more is pressed there in the same ask.
 */
export interface CenterPut {
  readonly refused: string | null;
  readonly review?: boolean;
  readonly later?: boolean;
}

/** The network saying "Try again later" with its refusal. */
const LATER = /\btry again later\b/i;

/** Hands a step to the person, and waits for Carry on: null once they've pressed it, how it ended when they stopped. */
export async function handed(
  job: Job,
  network: CenterNetwork,
  says: string,
  note?: ReportNote,
): Promise<JobEnd | null> {
  if (!job.handOver)
    return {
      line: `${PLATFORMS[network]} didn’t let the extension change your profile.`,
      warned: false,
      failed: true,
    };
  const reply = await job.handOver(says, note);
  return reply === 'carry_on' ? null : STOPPED;
}

/** What the network asks before a part changes, which only the person answers. */
export function askingWords(network: CenterNetwork, part: CenterPart, asking: Asking): string {
  const n = PLATFORMS[network];
  // A name's password may be asked on the step after Review change, by its Done.
  const press =
    part === 'name' ? 'press its button there (Continue or Done)' : 'press Continue there';
  if (asking === 'code')
    return `${n} sent you a code to change your ${part}. Type it in the ${n} window and ${press}, then press Carry on.`;
  if (asking === 'confirm')
    return `${n} wants to check it’s you before your ${part} changes. In the ${n} window, pick how (your password, or a code it sends you), type it and press Continue there. Then press Carry on.`;
  return `${n} wants your password to change your ${part}. Type it in the ${n} window and ${press}, then press Carry on.`;
}

/** The network still asking after the person carried on, each time: the part stays as it was. */
export function keptAskingWords(network: CenterNetwork, part: CenterPart, asking: Asking): string {
  const n = PLATFORMS[network];
  const kept =
    asking === 'code'
      ? `${n} kept asking for a code`
      : asking === 'confirm'
        ? `${n} kept asking you to confirm it’s you`
        : `${n} kept asking for your password`;
  const Part = part === 'name' ? 'Name' : 'Username';
  return `${kept}, so your ${part} stays as it was. Change it in Accounts Center (press Profiles, then your ${n} profile, then ${Part}), or press Put these in again.`;
}

/** Where to pick another in HandsFreeOS, and to try again. */
const pickAgain = (network: CenterNetwork, part: CenterPart): string =>
  `Pick another under ${part === 'name' ? 'Name' : 'Username'}: in Social Outreach, go to Settings → ${PLATFORMS[network]} and press Check your profile. Then press Put these in again.`;

/** How often each network lets a part change, as its help says it. */
const HOW_OFTEN: Readonly<Record<CenterNetwork, Readonly<Record<CenterPart, string | null>>>> = {
  facebook: { username: null, name: 'it lets you change your name once in 60 days' },
  instagram: {
    username: 'it lets you change your username twice in 14 days',
    name: 'it lets you change your name twice in 14 days',
  },
};

/** Why a username stays as it was, as the network said it, and what to do. */
export function usernameRefusedWords(
  network: CenterNetwork,
  result: 'taken' | 'invalid' | 'limit',
  u: string,
  said: string | null,
): string {
  const n = PLATFORMS[network];
  if (result === 'taken')
    return `${n} says “${said ?? `${u} isn’t available`}”, so your username stays as it was. ${pickAgain(network, 'username')}`;
  if (result === 'invalid')
    return `${n} won’t take “${u}” as your username${said ? `: it says “${said}”` : ''}. ${pickAgain(network, 'username')}`;
  const often = HOW_OFTEN[network].username;
  return `${n} won’t change your username right now${said ? `: it says “${said}”` : ''}. Try again in a few days, or keep the one you have.${often ? ` ${n} ${often.replace(/^it /, '')}.` : ''}`;
}

/** Why a name stays as it was, as the network said it, and what to do. */
export function nameRefusedWords(
  network: CenterNetwork,
  result: 'invalid' | 'limit',
  name: string,
  said: string | null,
): string {
  const n = PLATFORMS[network];
  // The network's own words, whole, in brackets: they end with their own full stop.
  const says = said ? ` (it says “${said}”)` : '';
  if (result === 'invalid')
    return `${n} won’t take “${name}” as your name${says}.${network === 'facebook' ? ' Use your real first and last name, in letters only.' : ''} ${pickAgain(network, 'name')}`;
  return `${n} won’t change your name right now${says}. Keep the name you have, and press Put these in again once ${n} lets you (${HOW_OFTEN[network].name}).`;
}

/** A name the network looks at before it shows: never said to be in, and nothing to do now. */
export const nameReviewWords = (network: CenterNetwork, name: string): string =>
  `${PLATFORMS[network]} is looking at your new name, “${name}”, before it shows on your profile. There’s nothing to do now: check your profile again in a day or two.`;

/** A part that went in but doesn't show on the profile read after, and where to check it. */
export function unseenWords(network: CenterNetwork, part: CenterPart, value: string): string {
  const n = PLATFORMS[network];
  const Part = part === 'name' ? 'Name' : 'Username';
  const may =
    part === 'name' && network === 'facebook' ? ', and it may look at a new name first' : '';
  return `${n} hasn’t shown your new ${part} on your profile yet${may}. Check it in Accounts Center: press Profiles, then your ${n} profile, then ${Part}, and put “${value}” in if it isn’t there.`;
}

/** Why Accounts Center's page for their profile wasn't opened, for the person and for the note. */
type NotFound = 'closed' | 'none' | Asking;

/** Their own profile among Accounts Center's Profiles: its number, or why there's none. */
export interface CenterProfile {
  readonly id: string | null;
  readonly why: NotFound | null;
  /** The username the profile has now, when the job knows it (Instagram's). */
  readonly was?: string | null;
}

const NOT_FOUND_NOTE: Readonly<Record<'closed' | 'none', string>> = {
  closed: 'Accounts Center’s Profiles didn’t open',
  none: 'No profile of theirs among Accounts Center’s Profiles',
};

/** Why the part wasn't changed by itself, and what to do, in the person's words. */
function notFoundWords(
  network: CenterNetwork,
  part: CenterPart,
  value: string,
  center: CenterProfile,
): string {
  const n = PLATFORMS[network];
  const didnt = `so the extension didn’t change your ${part}`;
  const steps = `${partStepsWords(network, part, value)} Then press Carry on.`;
  if (center.why === 'closed') return `Accounts Center’s Profiles didn’t open, ${didnt}. ${steps}`;
  if (center.why === 'none' && network === 'instagram') {
    // Instagram's own Accounts Center always holds the account signed in to it: the row is there, but not as expected.
    const account = center.was ? `your Instagram account @${center.was}` : 'your Instagram account';
    const Part = part === 'name' ? 'Name' : 'Username';
    const often = part === 'name' ? ' Instagram lets you change it twice in 14 days.' : '';
    return `The extension couldn’t tell which profile under Profiles is ${account}, so it didn’t change your ${part}. In Accounts Center’s Profiles, press ${center.was ? `@${center.was}` : 'your Instagram account'}, then ${Part}, put in “${value}” and press Done.${often} Then press Carry on.`;
  }
  if (center.why === 'none')
    return `Accounts Center didn’t show which of its profiles is your ${n} one, ${didnt}. ${steps}`;
  if (center.why)
    return `${keptAskingWords(network, part, center.why).split(',')[0]}, ${didnt}. ${steps}`;
  return steps;
}

/**
 * Opens Accounts Center's Profiles and finds the person's own profile there: once more after the person answers what
 * the network asks first. On Instagram, `username` is the account they're signed in to, whose row it is.
 */
export async function centerProfile(
  job: Job,
  network: CenterNetwork,
  part: CenterPart,
  username?: string | null,
): Promise<JobEnd | CenterProfile> {
  const at = profilesAddress(network);
  const was = username ?? null;
  await job.tab.open(at);
  for (let turn = 0; ; turn++) {
    const found = await job.tab.ask({
      type: 'hfos-username-page',
      ...(username ? { username } : {}),
    });
    if (!found.ok) return { id: null, why: 'closed', was };
    if (found.warnings.length) {
      await job.warn(found.warnings, at);
      return { line: warnedLine(found.warnings, PLATFORMS[network]), warned: true };
    }
    if (!found.asking) {
      const id = found.profile ?? null;
      return { id, why: id ? null : 'none', was };
    }
    if (turn > 0) return { id: null, why: found.asking, was };
    // Theirs to answer, never the extension's; then Profiles is looked at again.
    const ended = await handed(job, network, askingWords(network, part, found.asking), {
      job: `profile_edit.${part}`,
      note: `${askedNote(found.asking, network)} on Accounts Center’s Profiles.`,
      outline: true,
    });
    if (ended) return ended;
  }
}

/**
 * The network's warnings on the page the tab shows, after the person carried on or something wasn't as expected:
 * noted, and the end. On Accounts Center none are read while the network asks them for something (the tab decides).
 */
async function accountWarned(job: Job, network: CenterNetwork, at: string): Promise<JobEnd | null> {
  const here = await job.tab.ask({ type: 'hfos-account-warnings' });
  if (!here.ok || !here.warnings.length) return null;
  await job.warn(here.warnings, at);
  return { line: warnedLine(here.warnings, PLATFORMS[network]), warned: true };
}

/** A part handed over from Profiles, when the profile's page wasn't found: why, and the steps. */
async function notFound(
  job: Job,
  network: CenterNetwork,
  part: CenterPart,
  value: string,
  center: CenterProfile,
): Promise<JobEnd | CenterPut> {
  const warned = await accountWarned(job, network, profilesAddress(network));
  if (warned) return warned;
  const why =
    center.why === 'closed' || center.why === 'none'
      ? NOT_FOUND_NOTE[center.why]
      : center.why
        ? `${askedNote(center.why, network)} on Accounts Center’s Profiles again`
        : 'No profile number';
  const ended = await handed(job, network, notFoundWords(network, part, value, center), {
    job: `profile_edit.${part}`,
    note: `${why}, so the ${part} was handed to the person.`,
    outline: true,
  });
  return ended ?? { refused: null };
}

/**
 * Whether Chrome lets the extension on a network's Accounts Center: a person who keeps the extension to some sites
 * in Chrome may not have let it on Instagram's, which joined its sites in 0.94.0. Taken as yes where Chrome can't say.
 */
export async function centerAllowed(network: CenterNetwork): Promise<boolean> {
  const permissions = typeof chrome === 'undefined' ? undefined : chrome.permissions;
  if (!permissions) return true;
  try {
    return await permissions.contains({ origins: [`${centerHome(network)}/*`] });
  } catch {
    return true;
  }
}

/**
 * A part handed over because Chrome keeps the extension off the network's Accounts Center: why, the steps, and how to
 * let it on.
 */
export async function chromeKeepsOff(
  job: Job,
  network: CenterNetwork,
  part: CenterPart,
  value: string,
): Promise<JobEnd | CenterPut> {
  const host = new URL(centerHome(network)).host;
  const ended = await handed(
    job,
    network,
    `Chrome is keeping the extension off ${PLATFORMS[network]}’s Accounts Center, so it didn’t change your ${part}. ${partStepsWords(network, part, value)} Then press Carry on. To let it do this next time, open Chrome’s Extensions, press Details on HandsFreeOS Social, and allow ${host} under Site access.`,
    {
      job: `profile_edit.${part}`,
      note: `Chrome keeps the extension off ${host}, so the ${part} was handed to the person.`,
      outline: false,
    },
  );
  return ended ?? { refused: null };
}

/** The page didn't open for the tab: a warning there ends it; else the person goes there, as the step says. */
async function pageNotOpen(
  job: Job,
  network: CenterNetwork,
  part: CenterPart,
  value: string,
  url: string,
): Promise<JobEnd | CenterPut> {
  const warned = await accountWarned(job, network, url);
  if (warned) return warned;
  const ended = await handed(
    job,
    network,
    `${partStepsWords(network, part, value)} Then press Carry on.`,
    {
      job: `profile_edit.${part}`,
      note: `Accounts Center’s ${part} page didn’t open, so the ${part} was handed to the person.`,
      outline: true,
    },
  );
  return ended ?? { refused: null };
}

/** What the person is asked to do with the username, on its page, by where it stopped. */
export function usernameWords(
  network: CenterNetwork,
  u: string,
  wrote: Pick<UsernameWrote, 'result' | 'steps'>,
  was: string | null,
): string {
  const n = PLATFORMS[network];
  if (wrote.steps.sync) {
    const other = PLATFORMS[OTHER_NETWORK[network]];
    // In the box after Done; on the page, its box typed already; or before anything was typed.
    if (wrote.steps.pressed)
      return `${n} offers to change your username on ${other} too, so the extension didn’t press its button. In the ${n} window, change only your ${n} username to “${u}”: untick ${other} there if you can, or press Cancel. Then press Carry on.`;
    if (wrote.steps.typed)
      return `Accounts Center offers to change your username on ${other} too, so the extension stopped before saving. On this page, untick ${other} so only your ${n} username changes, check Username says “${u}”, and press Done. Then press Carry on.`;
    return `Accounts Center offers to change your username on ${other} too, so the extension typed nothing. On this page, untick ${other} so only your ${n} username changes, put “${u}” in Username, and press Done. Then press Carry on.`;
  }
  if (wrote.steps.over)
    return `${n} opened a box after Done. In the ${n} window, press its button to change your username to “${u}”, then press Carry on.`;
  if (wrote.result === 'not_saved')
    return `${n} didn’t show your new username after Done. On this page, check Username says “${u}”, and press Done if it’s still there. Then press Carry on.`;
  if (wrote.steps.other && was)
    return `This page shows another account’s username, not @${was}, so the extension typed nothing. Go back to Profiles, press your account @${was}, then Username, put in “${u}” and press Done. Then press Carry on.`;
  return `Change your username: on this page, put “${u}” in Username, and press Done once ${n} says it’s available. Then press Carry on.`;
}

/**
 * The username, on Accounts Center's username page for their own profile: put in by itself, waited on while the
 * network asks the person for something, or handed over. What the network refused, said; null once it's in or handed
 * over. The page's warnings are the tab's to read, as it reads none while the network asks for something there.
 */
export async function putUsernameIn(
  job: Job,
  network: CenterNetwork,
  u: string,
  center: CenterProfile,
): Promise<JobEnd | CenterPut> {
  job.progress('Opening where your username is changed…');
  const url = centerAddress(network, center.id, 'username');
  if (!url || !center.id) return notFound(job, network, 'username', u, center);
  const was = center.was ?? null;
  await job.tab.open(url);
  let asked: Asking = 'password';
  for (let turn = 0; turn < 3; turn++) {
    if (job.stopped()) return STOPPED;
    job.progress('Putting your new username in…');
    const wrote = await job.tab.ask({
      type: 'hfos-write-username',
      username: u,
      profile: center.id,
      ...(was ? { was } : {}),
    });
    if (!wrote.ok) return pageNotOpen(job, network, 'username', u, url);
    switch (wrote.result) {
      case 'done':
      case 'already':
        return { refused: null };
      case 'warned': {
        const words = wrote.warnings?.length
          ? wrote.warnings
          : [`${PLATFORMS[network]} showed a warning.`];
        await job.warn(words, url);
        return { line: warnedLine(words, PLATFORMS[network]), warned: true };
      }
      case 'waiting': {
        // Their password, a code, or confirming it's them: theirs to answer, never the extension's.
        asked = wrote.steps.asking ?? 'password';
        const ended = await handed(job, network, askingWords(network, 'username', asked), {
          ...usernameNote(wrote.steps, network),
          note: `${askedNote(asked, network)} before the username changed.`,
        });
        if (ended) return ended;
        // After Done, it's in once they've answered (the profile read after says); before, the username goes in now.
        if (wrote.steps.pressed) return { refused: null };
        continue;
      }
      case 'taken':
      case 'invalid':
      case 'limit':
        return {
          refused: usernameRefusedWords(network, wrote.result, u, wrote.said),
          ...(wrote.result === 'limit' && LATER.test(wrote.said ?? '') ? { later: true } : {}),
        };
      default: {
        const warned = await accountWarned(job, network, url);
        if (warned) return warned;
        const ended = await handed(
          job,
          network,
          usernameWords(network, u, wrote, was),
          usernameNote(wrote.steps, network),
        );
        return ended ?? { refused: null };
      }
    }
  }
  // The network asked again each time they carried on: Done was never pressed.
  return { refused: keptAskingWords(network, 'username', asked) };
}

/** What the person is asked to do with the name, on its page, by where it stopped. */
export function nameWords(
  network: CenterNetwork,
  name: string,
  wrote: { readonly result: NameWrote['result']; readonly steps: NameSteps },
): string {
  const n = PLATFORMS[network];
  const { first, last } = splitName(name);
  const facebook = network === 'facebook';
  const boxes = facebook
    ? `put “${first}” in First name and “${last}” in Last name, leave Middle name empty`
    : `put “${name}” in Name`;
  const presses = facebook ? 'press Review change, then Done' : 'press Done';
  const steps = wrote.steps;
  if (steps.sync) {
    const other = PLATFORMS[OTHER_NETWORK[network]];
    // In the box after Done; on the step before it, its boxes typed already; or before anything was typed.
    if (steps.pressed)
      return `${n} offers to change your name on ${other} too, so the extension didn’t press its button. In the ${n} window, change only your ${n} name to “${name}”: untick ${other} there if you can, or press Cancel. Then press Carry on.`;
    if (steps.typed)
      return `Accounts Center offers to change your name on ${other} too, so the extension stopped before saving. On this page, untick ${other} so only your ${n} name changes, check it reads “${name}”, and press Done. Then press Carry on.`;
    return `Accounts Center offers to change your name on ${other} too, so the extension typed nothing. On this page, untick ${other} so only your ${n} name changes, ${boxes}, and ${presses}. Then press Carry on.`;
  }
  if (steps.over)
    return `${n} opened a box after Done. In the ${n} window, press its button to change your name to “${name}”, then press Carry on.`;
  if (wrote.result === 'not_saved')
    return `${n} didn’t show your new name after Done. On this page, check ${facebook ? `First name says “${first}” and Last name says “${last}”` : `Name says “${name}”`}, and press Done if it’s still there. Then press Carry on.`;
  if (steps.order === 'unpicked')
    return `${n} asks how your name is shown. On this page, pick the one that reads “${name}”, then press Done. Then press Carry on.`;
  if (steps.reviewed && !steps.pressed)
    return `Your new name is ready to save on this page. Check it reads “${name}”, and press Done. Then press Carry on.`;
  if (steps.typed)
    return `Your new name is in its ${facebook ? 'boxes' : 'box'} on this page. ${facebook ? 'Press Review change, then Done' : 'Press Done'} once ${n} allows it. Then press Carry on.`;
  return `Change your name: on this page, ${boxes}, and ${presses}. Then press Carry on.`;
}

/**
 * The name, on Accounts Center's name page for their own profile: put in by itself, waited on while the network asks
 * the person for something, or handed over. What the network refused, said, and whether it's looking at the name
 * first; neither once it's in or handed over.
 */
export async function putNameIn(
  job: Job,
  network: CenterNetwork,
  name: string,
  center: CenterProfile,
): Promise<JobEnd | CenterPut> {
  // HandsFreeOS refuses such a name before it asks (`profileEditWords`); one that came anyway is said, never typed.
  const problem = nameProblem(network, name);
  if (problem) return { refused: problem };
  job.progress('Opening where your name is changed…');
  const url = centerAddress(network, center.id, 'name');
  if (!url || !center.id) return notFound(job, network, 'name', name, center);
  await job.tab.open(url);
  let asked: Asking = 'password';
  for (let turn = 0; turn < 3; turn++) {
    if (job.stopped()) return STOPPED;
    job.progress('Putting your new name in…');
    const wrote = await job.tab.ask({ type: 'hfos-write-center-name', name, profile: center.id });
    if (!wrote.ok) return pageNotOpen(job, network, 'name', name, url);
    switch (wrote.result) {
      case 'done':
      case 'already':
        return { refused: null };
      case 'review':
        return { refused: null, review: true };
      case 'warned': {
        const words = wrote.warnings?.length
          ? wrote.warnings
          : [`${PLATFORMS[network]} showed a warning.`];
        await job.warn(words, url);
        return { line: warnedLine(words, PLATFORMS[network]), warned: true };
      }
      case 'waiting': {
        asked = wrote.steps.asking ?? 'password';
        const ended = await handed(job, network, askingWords(network, 'name', asked), {
          ...nameNote(wrote.steps, network),
          note: `${askedNote(asked, network)} before the name changed.`,
        });
        if (ended) return ended;
        // After Review change they were told to press Done there, and after Done it's in once they've answered: the
        // profile read after says, as the page then holds the next change. Before, the name goes in now.
        if (wrote.steps.pressed || wrote.steps.reviewed) return { refused: null };
        continue;
      }
      case 'invalid':
      case 'limit':
        return { refused: nameRefusedWords(network, wrote.result, name, wrote.said) };
      default: {
        const warned = await accountWarned(job, network, url);
        if (warned) return warned;
        const ended = await handed(
          job,
          network,
          nameWords(network, name, wrote),
          nameNote(wrote.steps, network),
        );
        return ended ?? { refused: null };
      }
    }
  }
  return { refused: keptAskingWords(network, 'name', asked) };
}

export { isEnd };
