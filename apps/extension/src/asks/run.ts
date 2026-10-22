/**
 * Doing what the person asks of this computer from HandsFreeOS (docs/outreach.md, decision 43), in the background
 * worker. They press a button on the Friends, Groups, Chats or Today tab; HandsFreeOS keeps the ask; the live channel
 * says so (../hfos/follow.ts), or the next beat's answer does (../hfos/live.ts); and the computer that works for them
 * takes it, the oldest first, and does it with the jobs it has for its network (../jobs/, ../jobs/linkedin/):
 *
 * - **A line per network** (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "One runner, one turn"): each network
 *   takes its own asks (`take` with its `platform`), one at a time, and does them in its own window, in its own turn
 *   (../auto/turns.ts), so a LinkedIn ask never waits on Facebook's runner or on a Facebook step handed to the person,
 *   and the reverse. A network's line takes asks only while the network is on for the person and Chrome allows the
 *   extension there (../networks/on.ts). The computer that works stays one per person (decision 41).
 * - **Never beside the runner:** on Facebook an ask takes Facebook's turn; the runner that works on its own waits for
 *   it, and carries on after.
 * - **Where:** the file's steps, and cancelling or unfriending (withdrawing, on LinkedIn), in a tab the person can see
 *   (they type their password there, and decision 17 has those pressed where they see it); the rest in a window of its
 *   own beside theirs.
 * - **How it's going** goes to HandsFreeOS as it goes, for the web to show live, and to the panel (`hfos.ask`, and
 *   `hfos.ask.<network>` beside it for another network's).
 * - **A step it can't find** it hands to the person: the tab comes to the front, Chrome pops up, their phone hears it,
 *   and it waits for **Carry on** (or **Skip**, for one person ticked), pressed in HandsFreeOS's Needs you on the web
 *   or the phone (decision 72; the panel says so, with a link), for half an hour at most.
 * - **A code the network emailed them** (Alignable's, before a profile changes) it asks HandsFreeOS for: Chrome pops
 *   up, their phone says to look in their email, and they type it in Needs you; the live channel brings it here at
 *   once, or the next look does. It's handed over once and never kept here; none in `ASK_CODE_MINUTES`, and the job
 *   says so.
 * - **Stops:** Stop pressed anywhere, another computer of theirs working now, or a sign-in, sign-out or business picked
 *   here ends it at its next page, with how far it got; nothing of it goes to HandsFreeOS while anyone else is signed
 *   in here. Stop for today (pressed here, on the web or on the phone) ends Facebook's, whose day the beat carries. A
 *   network's warning that day, seen here (in any tab) or, for Facebook, on another of their computers, ends that
 *   network's ask before it starts, or at its next page while it goes; all but bringing in the file, which doesn't open
 *   Facebook. Another network's goes on (Chris's rule, "Each network on its own").
 * - **An end** is done only when the job did what was asked; stopped, warned or unable to (nothing to save, HandsFreeOS
 *   refusing a save, an error), it's failed, with the job's words.
 * - **Chrome closing mid-ask** leaves it under way; when the extension starts again it's ended as lost.
 * - **A network off here** (turned off, or not allowed by Chrome, since it was taken) ends its ask at once, saying how
 *   to turn it on, and nothing is opened for it.
 */
import {
  ASK_CHATS,
  ASK_CODE_MINUTES,
  ASK_LOST_LINE,
  ASK_STOPPED_LINE,
  ASK_STUCK_LINE,
  ASK_STUCK_MINUTES,
  ASK_TYPING_WORDS,
  askSignInLine,
  askStuckPushWords,
  askWarnedLine,
  isFileKind,
  onFacebook,
  TIDY_ASK_KINDS,
  type AskKind,
  type AskResult,
  type AskTaken,
} from '@hfos/core/addons/outreach/asks';
import { CHECKS_PER_DAY } from '@hfos/core/addons/outreach/checks';
import { GROUP_CHECKS_ASKED } from '@hfos/core/addons/outreach/group-checks';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { postSender } from '../auto/daily';
import { tick } from '../auto/run';
import { inTurn, turnHeldBy } from '../auto/turns';
import {
  askEventFor,
  cancel,
  endAsk,
  keepAsk,
  keptAsk,
  lineDue,
  progress,
  sendWaitingEnds,
  take,
  type KeptAsk,
} from '../hfos/asks';
import { computer, keptFor, onBeat, onWake, samePlace, type Kept } from '../hfos/live';
import { noteWarnings } from '../hfos/looked';
import type { HfosAnswer, HfosAsk } from '../hfos/messages';
import { answer, answerWith, Refused, savingTo, type Place } from '../hfos/session';
import { POPUP_ID, popUp, waitingSoon } from '../hfos/waiting';
import { WARNED_KEY, warnedNow } from '../hfos/warned';
import { chatMemory, readChats } from '../jobs/chats';
import { checkFriends, research } from '../jobs/checks';
import { checkFacebook } from '../jobs/checkup';
import { getFile } from '../jobs/file';
import { bringIn } from '../jobs/file-in';
import { saveGroups } from '../jobs/groups';
import { checkGroups } from '../jobs/groups-check';
import { joinGroups } from '../jobs/join';
import { postHelpful } from '../jobs/helpful';
import type { HandOverReply, Hfos, Job, JobEnd } from '../jobs/job';
import { reporter, type Reporter, type ReportNote } from '../jobs/report';
import { alignableAsk } from '../jobs/alignable';
import { instagramAsk } from '../jobs/instagram';
import { linkedInAsk } from '../jobs/linkedin';
import { lookupAndDraft } from '../jobs/lookup';
import { profileEdit, profileRead } from '../jobs/profile';
import { checkUsernames } from '../jobs/profile-parts';
import { checkRequests, saveFriends, saveMembers } from '../jobs/people';
import { findPosts, groupsToWork, RUN_GROUPS } from '../jobs/posts';
import { tidy } from '../jobs/tidy';
import { facebook, KIT_LIST, kitFor } from '../networks';
import { isWorking, statesNow, type NetworkStates } from '../networks/on';
import { WorkTab } from '../tab';

/** While a step waits for the person, HandsFreeOS is asked for their answer this often. */
const LOOK_MS = 20_000;
const STUCK_MS = ASK_STUCK_MINUTES * 60_000;
/** A code is looked for more often (it's late in a few minutes), though the live channel usually brings it first. */
const CODE_LOOK_MS = 10_000;
const CODE_MS = ASK_CODE_MINUTES * 60_000;

/** The network whose day the beat carries (a build of HandsFreeOS before networks had one day): Facebook's. */
const BEAT_DAY: Platform = facebook.platform;

/** An ask under way here, on its network's line. */
interface Under {
  readonly place: Place;
  readonly ask: AskTaken;
  /** Its network: the line it's on, its window, its turn and its warnings. */
  readonly platform: Platform;
  readonly tab: WorkTab;
  state: KeptAsk['state'];
  line: string | null;
  sentAt: number | null;
  sentState: KeptAsk['state'] | null;
  /** Ended from outside: the words it ends with. */
  halted: string | null;
  /** Ended by its network's warning seen while it went. */
  warned: boolean;
  /** A step handed to the person waits on this. */
  answered: ((reply: HandOverReply) => void) | null;
  /** A code from their email waits on this: the code, or null when it stopped. */
  coded: ((code: string | null) => void) | null;
}

/** Each network's ask under way here: one a network at most. */
const unders = new Map<Platform, Under>();

/** The tabs the asks under way work in: what the person sees there isn't theirs to note. */
export const askTabIds = (): number[] =>
  [...unders.values()].flatMap((u) => (u.tab.tabId === null ? [] : [u.tab.tabId]));

const popUpId = (askId: string) => `${POPUP_ID}-ask-${askId}`;

/**
 * Whether the extension is still signed in as the ask's person, to its business. If not (signed out, someone else
 * signed in, or another business picked), the ask stops, and nothing more of it goes to HandsFreeOS as anyone else.
 */
async function stillTheirs(u: Under): Promise<boolean> {
  const now = await savingTo().catch(() => null);
  if (samePlace(now, u.place)) return true;
  halt(u, askSignInLine(now, u.place));
  return false;
}

/** A sign-in, a sign-out or a business picked here (`SIGN_INS` in ../background.ts): the asks under way may stop. */
export async function signInChanged(): Promise<void> {
  await Promise.all([...unders.values()].map((u) => stillTheirs(u)));
}

/** Says where it's got to: here at once, to HandsFreeOS as `lineDue` says (or now, with `now`). */
async function tell(u: Under, state: KeptAsk['state'], line: string, now = false): Promise<void> {
  u.state = state;
  u.line = line;
  await keepAsk(
    {
      ...u.place,
      askId: u.ask.askId,
      platform: u.platform,
      kind: u.ask.kind,
      about: u.ask.about,
      state,
      line,
      at: Date.now(),
    },
    u.platform,
  );
  const changed = u.sentState !== state;
  if (!now && !lineDue(u.sentAt, Date.now(), changed)) return;
  if (!(await stillTheirs(u))) return;
  u.sentAt = Date.now();
  u.sentState = state;
  try {
    const said = await progress(u.place, u.ask.askId, state, line);
    if (said.cancelled && u.halted === null) halt(u, ASK_STOPPED_LINE);
    else if (said.reply && u.answered && state !== 'working') answerWith_(u, said.reply);
    else if (said.code && state === 'code') codeWith(u, said.code);
  } catch {
    // No connection: the next line, or the end, says it.
  }
  if (changed) waitingSoon();
}

function answerWith_(u: Under, got: HandOverReply): void {
  const then = u.answered;
  u.answered = null;
  then?.(got);
}

function codeWith(u: Under, code: string | null): void {
  const then = u.coded;
  u.coded = null;
  then?.(code);
}

/** Ends a network's ask under way here at its next page, with these words: LinkedIn's Stop for today. */
export function haltAsk(platform: Platform, line: string): void {
  const u = unders.get(platform);
  if (u) halt(u, line);
}

/** Ends what's under way at its next page, with these words. */
function halt(u: Under, line: string, warned = false): void {
  if (u.halted === null) {
    u.halted = line;
    u.warned = warned;
  }
  answerWith_(u, 'stop');
  codeWith(u, null);
}

/**
 * Its network's warning seen while an ask goes ends it, unless it's one that doesn't open the network (bringing in
 * Facebook's file).
 */
function haltWarned(u: Under | undefined, words: string | null): void {
  if (!u || unders.get(u.platform) !== u || !onFacebook(u.ask.kind)) return;
  halt(u, askWarnedLine(words, u.platform), true);
}

let hearingWarnings = false;
/**
 * A warning kept here as the asks go, from any tab (the one in front of the person too): it ends the ask on its own
 * network, and no other. Listened for once, the first time an ask runs.
 */
function hearWarnings(): void {
  if (hearingWarnings) return;
  hearingWarnings = true;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(WARNED_KEY in changes)) return;
    for (const u of unders.values())
      void warnedNow(u.platform).then((w) => w && haltWarned(u, w.words[0] ?? null));
  });
}

/**
 * Hands a step to the person: their tab to the front, a pop-up here and a push on their phone, and waits for Carry on
 * or Skip (or Stop), looking for their answer in HandsFreeOS every so often. Half an hour with no answer stops it.
 */
async function handOver(
  u: Under,
  says: string,
  how: 'stuck' | 'typing',
  note?: ReportNote,
): Promise<HandOverReply> {
  if (u.halted !== null) return 'stop';
  // What it couldn't find, noted with the page's outline before the person changes the page (decision 74), with the
  // job's own account of which step it was when it has one.
  if (how === 'stuck')
    await reporterFor(u)({
      ...note,
      note: note?.note ?? 'A step it couldn’t find was handed to the person.',
      outline: true,
    });
  const waited = new Promise<HandOverReply>((done) => (u.answered = done));
  await u.tab.focus().catch(() => undefined);
  const words = askStuckPushWords(how, how === 'typing' ? null : says);
  void popUp({ id: popUpId(u.ask.askId), title: words.title, message: words.body });
  await tell(u, how, says, true);
  const until = Date.now() + STUCK_MS;
  let got: HandOverReply | 'timeout' = 'timeout';
  while (Date.now() < until) {
    const next = await Promise.race([
      waited,
      new Promise<null>((done) => setTimeout(() => done(null), LOOK_MS)),
    ]);
    if (next !== null) {
      got = next;
      break;
    }
    // Pressed on the web or the phone: the look's answer has it.
    await tell(u, how, says, true);
  }
  u.answered = null;
  void chrome.notifications.clear(popUpId(u.ask.askId)).catch(() => undefined);
  if (got === 'timeout') {
    halt(u, ASK_STUCK_LINE);
    return 'stop';
  }
  if (got !== 'stop') await tell(u, 'working', 'Carrying on…', true);
  return got;
}

/**
 * Asks the person for a code the network emailed them: a pop-up here and a push on their phone, and waits for the code
 * they type in HandsFreeOS, looking for it every so often (the live channel usually brings it sooner). Null when none
 * came in `ASK_CODE_MINUTES`, or the ask stopped; the job says what that means.
 */
async function askCode(u: Under, says: string): Promise<string | null> {
  if (u.halted !== null) return null;
  const waited = new Promise<string | null>((done) => (u.coded = done));
  const words = askStuckPushWords('code', says);
  void popUp({ id: popUpId(u.ask.askId), title: words.title, message: words.body });
  await tell(u, 'code', says, true);
  const until = Date.now() + CODE_MS;
  let got: string | null = null;
  while (Date.now() < until && u.halted === null) {
    const next = await Promise.race([
      waited,
      new Promise<undefined>((done) => setTimeout(() => done(undefined), CODE_LOOK_MS)),
    ]);
    if (next !== undefined) {
      got = next;
      break;
    }
    await tell(u, 'code', says, true);
  }
  u.coded = null;
  void chrome.notifications.clear(popUpId(u.ask.askId)).catch(() => undefined);
  if (got !== null) await tell(u, 'working', 'Putting the code in…', true);
  return got;
}

/**
 * Notes the page the ask's tab shows (decision 74): never for a file kind, whose pages are Facebook's own download
 * and password ones.
 */
function reporterFor(u: Under, hfos: Hfos = answer as Hfos): Reporter {
  if (isFileKind(u.ask.kind)) return async () => undefined;
  return reporter(u.tab, hfos, {
    businessId: u.place.businessId,
    platform: u.platform,
    askId: u.ask.askId,
    job: u.ask.kind,
  });
}

/** The job's side of the ask: its tab, HandsFreeOS, and where it's got to. */
function jobFor(u: Under): Job {
  // Each call to HandsFreeOS checks first that it's still the ask's person signed in here, to its business.
  const hfos = (async (ask: Parameters<Hfos>[0]) =>
    (await stillTheirs(u))
      ? (answer as Hfos)(ask)
      : {
          ok: false,
          problem: { message: u.halted ?? '', rule: null, status: null, recheck: false },
        }) as Hfos;
  return {
    tab: u.tab,
    hfos,
    businessId: u.place.businessId,
    stopped: () => u.halted !== null,
    progress: (line) => void tell(u, 'working', line),
    warn: (words, url) => noteWarnings(u.place.businessId, words, url, u.platform),
    handOver: (says, note) => handOver(u, says, 'stuck', note),
    report: reporterFor(u, hfos),
    typing: (line) => {
      if (line === null) return void tell(u, 'working', 'Carrying on…', true);
      void u.tab.focus().catch(() => undefined);
      const words = askStuckPushWords('typing', null);
      void popUp({ id: popUpId(u.ask.askId), title: words.title, message: words.body });
      void tell(u, 'typing', ASK_TYPING_WORDS, true);
    },
    code: (line) => askCode(u, line),
  };
}

type Ended = JobEnd & { readonly result?: AskResult | null };

/** The groups an ask names, or the best ones to work, as the runner picks them; or why there are none. */
async function groupsFor(
  job: Job,
  named: Extract<AskTaken['task'], { kind: 'members' | 'posts' }>['groups'],
) {
  return named ?? groupsToWork(job, RUN_GROUPS);
}

/** Does an ask on Facebook with the job that does it. */
async function facebookAsk(task: AskTaken['task'], job: Job): Promise<Ended> {
  switch (task.kind) {
    case 'file_request':
      return getFile(job, 'request');
    case 'file_download':
      return getFile(job, 'download');
    case 'file_backup':
      return getFile(job, 'backup');
    case 'file_in':
      return bringIn(job);
    case 'requests':
      return checkRequests(job);
    case 'friends':
      return saveFriends(job);
    case 'groups':
      return saveGroups(job, null);
    case 'group_search':
      return saveGroups(job, task.words);
    case 'members':
    case 'posts': {
      const groups = await groupsFor(job, task.groups);
      if (typeof groups === 'string') return { line: groups, warned: false, failed: true };
      return task.kind === 'members'
        ? saveMembers(job, groups)
        : findPosts(job, groups, postSender(job));
    }
    case 'chats':
      return readChats(job, { most: ASK_CHATS, memory: chatMemory, again: 'Ask again to go on.' });
    case 'checks':
      return checkFriends(job, CHECKS_PER_DAY);
    case 'group_checks':
      return checkGroups(job, GROUP_CHECKS_ASKED);
    case 'join':
      return joinGroups(job, task.groupIds);
    case 'post':
      return postHelpful(job, task.helpfulId);
    case 'cancel':
      return tidy(job, 'cancel_request', task.profileIds);
    case 'unfriend':
      return tidy(job, 'unfriend', task.profileIds);
    case 'lookup':
      return lookupAndDraft(job, task);
    case 'research':
      return research(job, task);
    case 'profile_read':
      return profileRead(job);
    case 'profile_edit':
      return profileEdit(job, task);
    case 'username_check':
      return checkUsernames(job, 'facebook', task.usernames);
    case 'checkup':
      return checkFacebook(job);
    default:
      // A kind HandsFreeOS knows and this build doesn't: it ends saying so, never left hanging at its start.
      return {
        line: 'This build of HandsFreeOS Social can’t do that yet. Download the newest one, unzip it over the old folder, press Reload on Chrome’s Extensions page, and ask again.',
        warned: false,
        failed: true,
      };
  }
}

/** Each network's jobs: what an ask on it does. */
const JOBS_ON: Readonly<Record<Platform, (task: AskTaken['task'], job: Job) => Promise<Ended>>> = {
  facebook: facebookAsk,
  linkedin: linkedInAsk,
  // Its followers saved (part 12), beside its Check and profile.
  instagram: instagramAsk,
  alignable: alignableAsk,
};

/** Does the ask with the job that does it on its network (Facebook's unless said). */
export const runAsk = (
  task: AskTaken['task'],
  job: Job,
  platform: Platform = facebook.platform,
): Promise<Ended> => JOBS_ON[platform](task, job);

/** Where an ask works: in view for the file's steps and tidying; else a window of its own. */
export const placeFor = (kind: AskKind) =>
  isFileKind(kind) || (TIDY_ASK_KINDS as readonly string[]).includes(kind) ? 'view' : 'window';

/**
 * A network's warning today, seen here, or for the network whose day the beat carries, on another of the person's
 * computers: its words, or null. (HandsFreeOS ends another network's asks itself on a day it warned them there.)
 */
async function warnedToday(
  place: Place,
  platform: Platform,
): Promise<{ words: string | null } | null> {
  const here = await warnedNow(platform);
  if (here) return { words: here.words[0] ?? null };
  if (platform !== BEAT_DAY) return null;
  const kept = await keptFor(place);
  return kept?.day.why === 'warning' ? { words: null } : null;
}

/**
 * How an ask ended, for HandsFreeOS: done only when nothing stopped it and the job did it. Stopped, it says why and
 * how far the job got ("Stopped: you pressed Stop for today. Requests cancelled: 2 people."); a warning the job read
 * itself keeps the job's words.
 */
export function endOf(
  u: Pick<Under, 'halted' | 'warned'>,
  end: Pick<Ended, 'line' | 'warned' | 'failed'>,
): { state: 'done' | 'failed'; line: string } {
  const failed = u.halted !== null || u.warned || end.warned || end.failed === true;
  if (u.halted === null || end.warned) return { state: failed ? 'failed' : 'done', line: end.line };
  const sofar = end.line.startsWith(ASK_STOPPED_LINE)
    ? end.line.slice(ASK_STOPPED_LINE.length).trim()
    : '';
  return { state: 'failed', line: sofar ? `${u.halted} ${sofar}` : u.halted };
}

/**
 * Why an ask can't go on its network here, in words: the network is off for the person or Chrome hasn't let the
 * extension on it (since it was taken), or this build has no steps there. Null when it can.
 */
export function notHereWords(
  ask: Pick<AskTaken, 'platform'>,
  states: NetworkStates | null = null,
): string | null {
  // A build of HandsFreeOS before networks didn't say: Facebook, the only one it knew.
  const kit = kitFor(ask.platform ?? facebook.platform);
  const name = kit.network.name;
  if (!kit.work)
    return `This build of the extension can’t do that on ${name} yet. Download the newest one (the link is in Social Outreach’s setup, under Install the extension), unzip it over the old folder, and press Reload on Chrome’s Extensions page. Then ask again.`;
  const state = states?.[kit.platform];
  if (state && !state.on)
    return `${name} is off for you, so the extension does nothing on it. Turn it on under Social Outreach → Settings in HandsFreeOS, then ask again.`;
  if (state && !state.allowed)
    return `Chrome hasn’t let the extension on ${name} yet. Press Allow on ${name} in the extension’s panel, then ask again.`;
  return null;
}

/** One ask, from taking it to its end, on its own network's line. */
async function runOne(place: Place, ask: AskTaken): Promise<void> {
  const platform = ask.platform ?? facebook.platform;
  const kit = kitFor(platform);
  const u: Under = {
    place,
    ask,
    platform,
    tab: new WorkTab(placeFor(ask.kind), kit),
    state: 'working',
    line: null,
    sentAt: null,
    sentState: null,
    halted: null,
    warned: false,
    answered: null,
    coded: null,
  };
  unders.set(platform, u);
  hearWarnings();
  let end: Ended;
  let ran = false;
  try {
    const notHere = notHereWords(ask, await statesNow());
    const warned =
      notHere === null && onFacebook(ask.kind) ? await warnedToday(place, platform) : null;
    if (notHere !== null) end = { line: notHere, warned: false, failed: true };
    else if (warned)
      end = { line: askWarnedLine(warned.words, platform), warned: true, failed: true };
    else {
      if (turnHeldBy(platform) === 'runner')
        await tell(u, 'working', 'Waiting for the extension to finish a step first…', true);
      end = await inTurn(
        'ask',
        async () => {
          if (u.halted !== null) return { line: u.halted, warned: false };
          await tell(u, 'working', 'Starting…', true);
          ran = true;
          return runAsk(ask.task, jobFor(u), platform);
        },
        platform,
      );
    }
  } catch (error) {
    end = {
      line:
        error instanceof Refused
          ? error.problem.message
          : error instanceof Error
            ? error.message
            : 'Something went wrong. Ask again.',
      warned: false,
      failed: true,
    };
  }
  // A job that didn't finish: the page it ended on, outline and all, while its tab is still open (decision 74).
  if (ran && end.failed && !end.warned)
    await reporterFor(u)({ note: 'It didn’t finish on this page.', outline: true });
  await u.tab.close().catch(() => undefined);
  void chrome.notifications.clear(popUpId(ask.askId)).catch(() => undefined);
  // Whatever happens saying how it ended, the next ask can go.
  try {
    const ended = endOf(u, end);
    await endAsk(place, ask.askId, ended.state, ended.line, end.result ?? null);
  } finally {
    if (unders.get(platform) === u) unders.delete(platform);
    await keepAsk(null, platform);
    waitingSoon();
  }
}

/** Whether a network's line takes asks here now: on for the person, and allowed by Chrome. */
const lineOpen = async (platform: Platform) => isWorking(kitFor(platform), await statesNow());

/** Takes and does the asks waiting for this computer on a network's line, one at a time, until there are none. */
async function runLineOnce(platform: Platform): Promise<void> {
  const place = await savingTo().catch(() => null);
  if (!place) return;
  const kept = await keptFor(place);
  if (kept && !kept.working) return;
  if (!(await lineOpen(platform))) return;
  const me = await computer();
  await sendWaitingEnds(place);
  for (;;) {
    // Signed in as someone else, or to another business, meanwhile: the look for them goes after this one.
    if (!samePlace(await savingTo().catch(() => null), place)) break;
    // Turned off, or Chrome's leave taken back, meanwhile: what waits there waits.
    if (!(await lineOpen(platform))) break;
    const got = await take(place, me.id, null, platform).catch(() => null);
    if (!got?.ask) break;
    await runOne(place, got.ask);
  }
  // The runner gave way while these went: it carries on now.
  void tick();
}

const running = new Map<Platform, Promise<void>>();
const again = new Set<Platform>();

/** One look at a time on a network's line: one asked for while another goes follows it. */
function runLine(platform: Platform): Promise<void> {
  const going = running.get(platform);
  if (going) {
    again.add(platform);
    return going;
  }
  const run = runLineOnce(platform)
    .catch((error: unknown) =>
      console.error('HandsFreeOS Social couldn’t do what you asked', platform, error),
    )
    .finally(() => {
      running.delete(platform);
      if (again.delete(platform)) void runLine(platform);
    });
  running.set(platform, run);
  return run;
}

/** Each network's line looks for asks waiting for this computer, side by side. */
export async function runAsks(): Promise<void> {
  await Promise.all(KIT_LIST.map((kit) => runLine(kit.platform)));
}

let soon: ReturnType<typeof setTimeout> | null = null;
/** A look in a moment: several heard close together go in one. */
export function askSoon(): void {
  if (soon) clearTimeout(soon);
  soon = setTimeout(() => ((soon = null), void runAsks()), 1_000);
}

/** A change heard on the live channel (../hfos/follow.ts): a new ask, or a stop or an answer to one under way. */
export async function heardAsk(payload: Record<string, unknown>): Promise<void> {
  const place = await savingTo().catch(() => null);
  const userId = place?.userId ?? null;
  if (askEventFor(payload, userId, null) === 'take') return askSoon();
  // Its look has what was pressed: Stop ends it, Carry on or Skip answers the step handed over.
  for (const u of unders.values())
    if (askEventFor(payload, userId, u.ask.askId) === 'under_way')
      await tell(u, u.state, u.line ?? '…', true);
}

/** When the extension starts: an ask left under way on any network means Chrome or the extension stopped mid-way. */
export async function recoverAsk(): Promise<void> {
  for (const kit of KIT_LIST) {
    const left = await keptAsk(kit.platform);
    if (!left) continue;
    await keepAsk(null, kit.platform);
    const place = { userId: left.userId, businessId: left.businessId };
    await endAsk(place, left.askId, 'failed', ASK_LOST_LINE).catch(() => undefined);
  }
}

// A beat's answer that ends what's under way: another computer works now (every network's), or the day the beat
// carries stopped (that network's alone).
onWake((halt_) => {
  if (!halt_) return;
  for (const u of unders.values())
    void keptFor(u.place).then((kept) => {
      if (unders.get(u.platform) !== u) return;
      if (kept && !kept.working)
        halt(
          u,
          `Stopped: ${kept.workingName ?? 'another computer'} works for you now. Ask again, and it does it there.`,
        );
      else if (u.platform === BEAT_DAY) halt(u, 'Stopped: you pressed Stop for today.');
    });
});

// Each beat: ends not yet taken go with it, a warning on another of their computers ends what's under way on the
// network whose day it carries, and asks waiting for this computer start.
onBeat((kept: Kept) => {
  void sendWaitingEnds(kept).catch(() => undefined);
  if (kept.day.why === 'warning') haltWarned(unders.get(BEAT_DAY), null);
  if (kept.working && kept.asks > 0 && unders.size < KIT_LIST.length) askSoon();
});

type AskAsk = Extract<HfosAsk, { readonly type: 'hfos-ask-stop' }>;

/**
 * The ask under way here a Stop is for: the one it names; with none named (a panel before networks), the one waiting
 * on the person, else Facebook's.
 */
function underFor(askId: string | undefined): Under | null {
  const all = [...unders.values()];
  if (askId) return all.find((u) => u.ask.askId === askId) ?? null;
  return all.find((u) => u.answered !== null) ?? unders.get(facebook.platform) ?? all[0] ?? null;
}

/**
 * The panel's Stop: for an ask under way here, at once; for one that left here meanwhile, through HandsFreeOS. Carry
 * on and Skip are pressed in HandsFreeOS's Needs you, and reach the ask with its next look (decision 72). Never
 * throws.
 */
export function answerAsk(ask: AskAsk): Promise<HfosAnswer<unknown>> {
  return answerWith(ask.type, async () => {
    const u = underFor(ask.askId);
    if (!u) {
      const place = await savingTo();
      if (!place || !ask.askId)
        throw new Refused({
          message: 'Nothing is under way on this computer now.',
          rule: null,
          status: null,
          recheck: false,
        });
      await cancel(place, ask.askId);
      waitingSoon();
      return null;
    }
    halt(u, ASK_STOPPED_LINE);
    await cancel(u.place, u.ask.askId).catch(() => undefined);
    return null;
  });
}
