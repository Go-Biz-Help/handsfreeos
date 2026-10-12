/**
 * Doing what the person asks of this computer from HandsFreeOS (docs/outreach.md, decision 43), in the background
 * worker. They press a button on the Friends, Groups, Chats or Today tab; HandsFreeOS keeps the ask; the live channel
 * says so (../hfos/follow.ts), or the next beat's answer does (../hfos/live.ts); and the computer that works for them
 * takes it, the oldest first, and does it with the jobs it has (../jobs/):
 *
 * - **One at a time, never beside the runner:** an ask takes its turn on Facebook (../auto/turns.ts); the runner that
 *   works on its own waits for it, and carries on after.
 * - **Where:** the file's steps, and cancelling or unfriending, in a tab the person can see (they type their password
 *   there, and decision 17 has those pressed where they see it); the rest in a window of its own beside theirs.
 * - **How it's going** goes to HandsFreeOS as it goes, for the web to show live, and to the panel (`hfos.ask`).
 * - **A step it can't find** it hands to the person: the tab comes to the front, Chrome pops up, their phone hears it,
 *   and it waits for **Carry on** (or **Skip**, for one person ticked) from the panel, Waiting for you or the web,
 *   for half an hour at most.
 * - **Stops:** Stop pressed anywhere, Stop for today (pressed here, on the web or on the phone), another computer of
 *   theirs working now, or a sign-in, sign-out or business picked here ends it at its next page, with how far it got;
 *   nothing of it goes to HandsFreeOS while anyone else is signed in here. A Facebook warning that day, seen here (in
 *   any tab) or on another of their computers, ends it before it starts, or at its next page while it goes; all but
 *   bringing in the file, which doesn't open Facebook.
 * - **An end** is done only when the job did what was asked; stopped, warned or unable to (nothing to save, HandsFreeOS
 *   refusing a save, an error), it's failed, with the job's words.
 * - **Chrome closing mid-ask** leaves it under way; when the extension starts again it's ended as lost.
 */
import {
  ASK_CHATS,
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
  type AskReply,
  type AskResult,
  type AskTaken,
} from '@hfos/core/addons/outreach/asks';
import { CHECKS_PER_DAY } from '@hfos/core/addons/outreach/checks';
import { GROUP_CHECKS_ASKED } from '@hfos/core/addons/outreach/group-checks';
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
  reply,
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
import { checkFriends } from '../jobs/checks';
import { getFile } from '../jobs/file';
import { bringIn } from '../jobs/file-in';
import { saveGroups } from '../jobs/groups';
import { checkGroups } from '../jobs/groups-check';
import { joinGroups } from '../jobs/join';
import { postHelpful } from '../jobs/helpful';
import type { HandOverReply, Hfos, Job, JobEnd } from '../jobs/job';
import { lookupAndDraft } from '../jobs/lookup';
import { checkRequests, saveFriends, saveMembers } from '../jobs/people';
import { findPosts, groupsToWork, RUN_GROUPS } from '../jobs/posts';
import { tidy } from '../jobs/tidy';
import { WorkTab } from '../tab';

/** While a step waits for the person, HandsFreeOS is asked for their answer this often. */
const LOOK_MS = 20_000;
const STUCK_MS = ASK_STUCK_MINUTES * 60_000;

/** The ask under way here. */
interface Under {
  readonly place: Place;
  readonly ask: AskTaken;
  readonly tab: WorkTab;
  state: KeptAsk['state'];
  line: string | null;
  sentAt: number | null;
  sentState: KeptAsk['state'] | null;
  /** Ended from outside: the words it ends with. */
  halted: string | null;
  /** Ended by a Facebook warning seen while it went. */
  warned: boolean;
  /** A step handed to the person waits on this. */
  answered: ((reply: HandOverReply) => void) | null;
}

let under: Under | null = null;

/** The tab the ask under way works in: what the person sees there isn't theirs to note. */
export const askTabId = (): number | null => under?.tab.tabId ?? null;

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

/** A sign-in, a sign-out or a business picked here (`SIGN_INS` in ../background.ts): an ask under way may stop. */
export async function signInChanged(): Promise<void> {
  const u = under;
  if (u) await stillTheirs(u);
}

/** Says where it's got to: here at once, to HandsFreeOS as `lineDue` says (or now, with `now`). */
async function tell(u: Under, state: KeptAsk['state'], line: string, now = false): Promise<void> {
  u.state = state;
  u.line = line;
  await keepAsk({
    ...u.place,
    askId: u.ask.askId,
    kind: u.ask.kind,
    about: u.ask.about,
    state,
    line,
    at: Date.now(),
  });
  const changed = u.sentState !== state;
  if (!now && !lineDue(u.sentAt, Date.now(), changed)) return;
  if (!(await stillTheirs(u))) return;
  u.sentAt = Date.now();
  u.sentState = state;
  try {
    const said = await progress(u.place, u.ask.askId, state, line);
    if (said.cancelled && u.halted === null) halt(u, ASK_STOPPED_LINE);
    else if (said.reply && u.answered && state !== 'working') answerWith_(u, said.reply);
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

/** Ends what's under way at its next page, with these words. */
function halt(u: Under, line: string, warned = false): void {
  if (u.halted === null) {
    u.halted = line;
    u.warned = warned;
  }
  answerWith_(u, 'stop');
}

/** A Facebook warning seen while an ask goes ends it, unless it's one that doesn't open Facebook. */
function haltWarned(u: Under, words: string | null): void {
  if (under !== u || !onFacebook(u.ask.kind)) return;
  halt(u, askWarnedLine(words), true);
}

let hearingWarnings = false;
/**
 * A warning kept here as the ask goes, from any tab (the one in front of the person too): it ends the ask. Listened
 * for once, the first time an ask runs.
 */
function hearWarnings(): void {
  if (hearingWarnings) return;
  hearingWarnings = true;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(WARNED_KEY in changes) || !under) return;
    const u = under;
    void warnedNow().then((w) => w && haltWarned(u, w.words[0] ?? null));
  });
}

/**
 * Hands a step to the person: their tab to the front, a pop-up here and a push on their phone, and waits for Carry on
 * or Skip (or Stop), looking for their answer in HandsFreeOS every so often. Half an hour with no answer stops it.
 */
async function handOver(u: Under, says: string, how: 'stuck' | 'typing'): Promise<HandOverReply> {
  if (u.halted !== null) return 'stop';
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
    warn: (words, url) => noteWarnings(u.place.businessId, words, url),
    handOver: (says) => handOver(u, says, 'stuck'),
    typing: (line) => {
      if (line === null) return void tell(u, 'working', 'Carrying on…', true);
      void u.tab.focus().catch(() => undefined);
      const words = askStuckPushWords('typing', null);
      void popUp({ id: popUpId(u.ask.askId), title: words.title, message: words.body });
      void tell(u, 'typing', ASK_TYPING_WORDS, true);
    },
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

/** Does the ask with the job that does it. */
export async function runAsk(task: AskTaken['task'], job: Job): Promise<Ended> {
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
    default:
      // A kind HandsFreeOS knows and this build doesn't: it ends saying so, never left hanging at its start.
      return {
        line: 'This build of HandsFreeOS Social can’t do that yet. Download the newest one, unzip it over the old folder, press Reload on Chrome’s Extensions page, and ask again.',
        warned: false,
        failed: true,
      };
  }
}

/** Where an ask works: in view for the file's steps and tidying; else a window of its own. */
export const placeFor = (kind: AskKind) =>
  isFileKind(kind) || (TIDY_ASK_KINDS as readonly string[]).includes(kind) ? 'view' : 'window';

/** Facebook's warning today, seen here or on another of the person's computers: its words, or null. */
async function warnedToday(place: Place): Promise<{ words: string | null } | null> {
  const here = await warnedNow();
  if (here) return { words: here.words[0] ?? null };
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

/** One ask, from taking it to its end. */
async function runOne(place: Place, ask: AskTaken): Promise<void> {
  const u: Under = {
    place,
    ask,
    tab: new WorkTab(placeFor(ask.kind)),
    state: 'working',
    line: null,
    sentAt: null,
    sentState: null,
    halted: null,
    warned: false,
    answered: null,
  };
  under = u;
  hearWarnings();
  let end: Ended;
  try {
    const warned = onFacebook(ask.kind) ? await warnedToday(place) : null;
    if (warned) end = { line: askWarnedLine(warned.words), warned: true, failed: true };
    else {
      if (turnHeldBy() === 'runner')
        await tell(u, 'working', 'Waiting for the extension to finish a step first…', true);
      end = await inTurn('ask', async () => {
        if (u.halted !== null) return { line: u.halted, warned: false };
        await tell(u, 'working', 'Starting…', true);
        return runAsk(ask.task, jobFor(u));
      });
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
  await u.tab.close().catch(() => undefined);
  void chrome.notifications.clear(popUpId(ask.askId)).catch(() => undefined);
  // Whatever happens saying how it ended, the next ask can go.
  try {
    const ended = endOf(u, end);
    await endAsk(place, ask.askId, ended.state, ended.line, end.result ?? null);
  } finally {
    under = null;
    await keepAsk(null);
    waitingSoon();
  }
}

let running: Promise<void> | null = null;
let again = false;

/** Takes and does the asks waiting for this computer, one at a time, until there are none. */
async function runAsksOnce(): Promise<void> {
  const place = await savingTo().catch(() => null);
  if (!place) return;
  const kept = await keptFor(place);
  if (kept && !kept.working) return;
  const me = await computer();
  await sendWaitingEnds(place);
  for (;;) {
    // Signed in as someone else, or to another business, meanwhile: the look for them goes after this one.
    if (!samePlace(await savingTo().catch(() => null), place)) break;
    const got = await take(place, me.id, null).catch(() => null);
    if (!got?.ask) break;
    await runOne(place, got.ask);
  }
  // The runner gave way while these went: it carries on now.
  void tick();
}

/** One look at a time: one asked for while another goes follows it. */
export function runAsks(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = runAsksOnce()
    .catch((error: unknown) =>
      console.error('HandsFreeOS Social couldn’t do what you asked', error),
    )
    .finally(() => {
      running = null;
      if (again) {
        again = false;
        void runAsks();
      }
    });
  return running;
}

let soon: ReturnType<typeof setTimeout> | null = null;
/** A look in a moment: several heard close together go in one. */
export function askSoon(): void {
  if (soon) clearTimeout(soon);
  soon = setTimeout(() => ((soon = null), void runAsks()), 1_000);
}

/** A change heard on the live channel (../hfos/follow.ts): a new ask, or a stop or an answer to the one under way. */
export async function heardAsk(payload: Record<string, unknown>): Promise<void> {
  const place = await savingTo().catch(() => null);
  const what = askEventFor(payload, place?.userId ?? null, under?.ask.askId ?? null);
  if (what === 'take') return askSoon();
  // Its look has what was pressed: Stop ends it, Carry on or Skip answers the step handed over.
  if (what === 'under_way' && under) await tell(under, under.state, under.line ?? '…', true);
}

/** When the extension starts: an ask left under way means Chrome or the extension stopped mid-way. */
export async function recoverAsk(): Promise<void> {
  const left = await keptAsk();
  if (!left) return;
  await keepAsk(null);
  const place = { userId: left.userId, businessId: left.businessId };
  await endAsk(place, left.askId, 'failed', ASK_LOST_LINE).catch(() => undefined);
}

// A beat's answer that ends what's under way: the day stopped, or another computer works now.
onWake((halt_) => {
  const u = under;
  if (!halt_ || !u) return;
  void keptFor(u.place).then((kept) => {
    if (under !== u) return;
    const why =
      kept && !kept.working
        ? `Stopped: ${kept.workingName ?? 'another computer'} works for you now. Ask again, and it does it there.`
        : 'Stopped: you pressed Stop for today.';
    halt(u, why);
  });
});

// Each beat: ends not yet taken go with it, a warning on another of their computers ends what's under way, and asks
// waiting for this computer start.
onBeat((kept: Kept) => {
  void sendWaitingEnds(kept).catch(() => undefined);
  if (under && kept.day.why === 'warning') haltWarned(under, null);
  if (kept.working && kept.asks > 0 && !under) askSoon();
});

type AskAsk = Extract<HfosAsk, { readonly type: 'hfos-ask-reply' | 'hfos-ask-stop' }>;

/**
 * The panel's Carry on, Skip and Stop: for the ask under way here, at once; for one on another computer of the
 * person's (Waiting for you lists it everywhere), through HandsFreeOS. Never throws.
 */
export function answerAsk(ask: AskAsk): Promise<HfosAnswer<unknown>> {
  return answerWith(ask.type, async () => {
    const u = under;
    if (!u || (ask.askId && ask.askId !== u.ask.askId)) {
      const place = await savingTo();
      if (!place || !ask.askId)
        throw new Refused({
          message: 'Nothing is under way on this computer now.',
          rule: null,
          status: null,
          recheck: false,
        });
      if (ask.type === 'hfos-ask-stop') await cancel(place, ask.askId);
      else await reply(place, ask.askId, ask.reply);
      waitingSoon();
      return null;
    }
    if (ask.type === 'hfos-ask-stop') {
      halt(u, ASK_STOPPED_LINE);
      await cancel(u.place, u.ask.askId).catch(() => undefined);
      return null;
    }
    const got: AskReply = ask.reply;
    answerWith_(u, got);
    await reply(u.place, u.ask.askId, got).catch(() => undefined);
    return null;
  });
}
