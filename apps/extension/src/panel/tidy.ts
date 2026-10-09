/**
 * Tidy up your friends, in the side panel (docs/outreach.md, decisions 10, 12, 15 and 17): the sent requests nobody
 * answered in the business's wait, and the friends HandsFreeOS suggests unfriending to make room under Facebook's
 * cap (packages/core/src/addons/outreach/tidy.ts). The person ticks the ones to go; the extension opens each one's
 * profile in a tab they can see, checks it's them and where things stand, presses Cancel request or Unfriend
 * (src/facebook/tidy.ts), checks it worked, and notes it in HandsFreeOS. It goes slowly, stops at today's limit, and
 * stops for the day on any Facebook warning. A step it can't find, it hands to the person.
 */
import { warningNote } from '@hfos/core/addons/outreach/tidy';
import { FRIENDSHIP_WORDS, TIDY_PLANS, sameProfile, type TidyJob } from '../facebook/tidy';
import type { FetchStep } from '../facebook/fetch';
import type { ReadResult } from '../facebook/types';
import type { Account, Tidy, TidyCandidate } from '../hfos/messages';
import { ask } from './ask';
import { button, chip, counted, h, hfosLink, link, type Child } from './dom';
import { WorkTab } from '../tab';
import { noteWarnings, onWarning, warnedToday } from './warnings';

/** Between people, a steady pace like a person's: never the same twice. */
const PACE_MS = [20_000, 40_000] as const;
/** While Facebook draws what a press opened. */
const SETTLE_MS = 1_500;
/** How long a step is looked for before it's handed to the person; the box asking to be sure, less. */
const WAIT_MS = 8_000;
const WAIT_OPTIONAL_MS = 3_000;
/** The most of each listed with a tick box. */
const SHOWN = 50;

const WORDS: Record<TidyJob, { title: string; button: string; doing: string; done: string }> = {
  cancel_request: {
    title: 'Old friend requests',
    button: 'Cancel the ticked requests',
    doing: 'Cancelling the request to',
    done: 'Request cancelled',
  },
  unfriend: {
    title: 'Friends to unfriend',
    button: 'Unfriend the ticked',
    doing: 'Unfriending',
    done: 'Unfriended',
  },
};

/** What became of someone ticked. */
type Outcome = 'done' | 'already' | { readonly skipped: string };

type Run =
  | { readonly state: 'idle' }
  | { readonly state: 'going' | 'stuck'; readonly job: TidyJob; readonly line: string }
  | { readonly state: 'over'; readonly line: string };

let box: HTMLElement;
let account: Account | null = null;
let tidy: { readonly businessId: string; readonly value: Tidy } | null = null;
let problem: string | null = null;
let warned: readonly string[] | null = null;
let run: Run = { state: 'idle' };
let stopped = false;
let carryOn: ((go: boolean) => void) | null = null;
const ticked: Record<TidyJob, Set<string>> = { cancel_request: new Set(), unfriend: new Set() };
const outcomes = new Map<string, Outcome>();
const tab = new WorkTab();

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const paced = () => PACE_MS[0] + Math.random() * (PACE_MS[1] - PACE_MS[0]);
const listOf = (value: Tidy, job: TidyJob) =>
  job === 'cancel_request' ? value.cancel : value.unfriend;
const busyNow = () => run.state === 'going' || run.state === 'stuck';
const left = (value: Tidy, job: TidyJob) =>
  Math.max(0, value.limits[job].most - value.limits[job].done);

function set(next: Run): void {
  run = next;
  draw();
}

/** Asks HandsFreeOS for the lists, in the business the extension saves to. */
export async function refreshTidy(): Promise<void> {
  const answer = await ask({ type: 'hfos-account' });
  account = answer.ok ? answer.value : null;
  warned = await warnedToday();
  const businessId = account?.signedIn ? account.businessId : null;
  if (!businessId) {
    [tidy, problem] = [null, null];
    return draw();
  }
  const got = await ask({ type: 'hfos-tidy', workspaceId: businessId });
  if (got.ok) [tidy, problem] = [{ businessId, value: got.value }, null];
  else problem = got.problem.message;
  draw();
}

// ---- Going through them ----

async function read(): Promise<ReadResult> {
  const answer = await tab.ask({ type: 'hfos-read' });
  if (!answer.ok) throw new Error(answer.error);
  return answer.result;
}

/** Hands a step to the person: Carry on once they've done it, or Skip this one. */
function handOver(job: TidyJob, who: string, says: string): Promise<boolean> {
  set({
    state: 'stuck',
    job,
    line: `Couldn’t find that on ${who}’s profile. ${says} Then press Carry on, or Skip.`,
  });
  return new Promise((done) => (carryOn = done));
}

/** Presses the way along a path: the furthest step on the page each time. Whether it got to the end. */
async function byPath(job: TidyJob, who: string, steps: readonly FetchStep[]): Promise<boolean> {
  let from = 0;
  while (from < steps.length && !stopped) {
    const answer = await tab.ask({
      type: 'hfos-fetch-path',
      steps,
      from,
      waitMs: WAIT_MS,
      tidy: true,
    });
    if (!answer.ok) throw new Error(answer.error);
    if (answer.at !== undefined) {
      from = answer.at + 1;
      await pause(SETTLE_MS);
      continue;
    }
    if (!(await handOver(job, who, steps[from]!.says))) return false;
    // The person pressed it, or a step past it: the box asking to be sure is all that's left.
    return true;
  }
  return !stopped;
}

/** The box asking to be sure, when Facebook shows one. */
async function sure(steps: readonly FetchStep[]): Promise<void> {
  for (const step of steps) {
    if (stopped) return;
    const answer = await tab.ask({
      type: 'hfos-fetch-step',
      step,
      waitMs: step.optional ? WAIT_OPTIONAL_MS : WAIT_MS,
      tidy: true,
    });
    if (!answer.ok) throw new Error(answer.error);
    if (answer.result === 'done') await pause(SETTLE_MS);
  }
}

/** Stops for the day on a warning on the page: true when there was one. */
async function warnedOn(page: ReadResult): Promise<boolean> {
  if (!page.warnings.length) return false;
  await noteWarnings(page.warnings, page.url);
  stopped = true;
  set({
    state: 'over',
    line: `Stopped: Facebook says “${page.warnings[0]}”. The extension stops for today, and your daily limits are halved for a week.`,
  });
  return true;
}

/** One person: open, check, press, check again, note. */
async function one(job: TidyJob, who: TidyCandidate, businessId: string): Promise<Outcome | null> {
  const plan = TIDY_PLANS[job];
  await tab.open(who.url);
  let page = await read();
  if (await warnedOn(page)) return null;
  if (!page.profile || !sameProfile(page.profile.profile, who))
    return { skipped: 'Facebook showed a different page' };
  const end = async (already: boolean) => {
    const answer = await ask({
      type: 'hfos-friend-end',
      input: {
        workspaceId: businessId,
        platform: 'facebook',
        kind: job,
        profile: { id: who.platformId, username: who.username, url: who.url },
        name: who.name,
        already,
      },
    });
    if (!answer.ok) throw new Error(answer.problem.message);
  };
  if (page.profile.friendship === 'not_friends') {
    await end(true);
    return 'already';
  }
  if (page.profile.friendship !== plan.before)
    return { skipped: `Facebook says ${FRIENDSHIP_WORDS[page.profile.friendship]}` };

  if (!(await byPath(job, who.name, plan.path))) return stopped ? null : { skipped: 'Skipped' };
  await sure(plan.then);
  if (stopped) return null;
  await pause(SETTLE_MS);
  page = await read();
  if (await warnedOn(page)) return null;
  if (page.profile?.friendship !== 'not_friends') {
    // Not gone yet: the person finishes it, or skips them.
    const says =
      job === 'cancel_request'
        ? 'Press “Cancel request” yourself.'
        : 'Press “Friends”, then “Unfriend”, yourself.';
    if (!(await handOver(job, who.name, says))) return { skipped: 'Skipped' };
    page = await read();
    if (page.profile?.friendship !== 'not_friends')
      return { skipped: 'Facebook still shows them as before' };
  }
  await end(false);
  return 'done';
}

async function go(job: TidyJob): Promise<void> {
  if (!tidy || busyNow()) return;
  const { businessId, value } = tidy;
  const picks = listOf(value, job).filter((c) => ticked[job].has(c.profileId));
  if (!picks.length) return;
  if (await warnedToday()) {
    set({
      state: 'over',
      line: 'Facebook warned you today, so the extension stops until tomorrow.',
    });
    return;
  }
  stopped = false;
  let done = 0;
  let room = left(value, job);
  try {
    for (const [i, who] of picks.entries()) {
      if (stopped) break;
      if (room <= 0) {
        set({
          state: 'over',
          line: `That’s today’s limit of ${value.limits[job].most}. Carry on tomorrow.`,
        });
        break;
      }
      set({
        state: 'going',
        job,
        line: `${i + 1} of ${picks.length}: ${WORDS[job].doing} ${who.name}…`,
      });
      const outcome = await one(job, who, businessId);
      if (outcome === null) break;
      outcomes.set(who.profileId, outcome);
      ticked[job].delete(who.profileId);
      if (outcome === 'done') {
        done++;
        room--;
      }
      draw();
      if (!stopped && i < picks.length - 1) {
        set({
          state: 'going',
          job,
          line: `${WORDS[job].done}: ${counted(done, 'person', 'people')}. Waiting a moment before the next…`,
        });
        await pause(paced());
      }
    }
    if (busyNow())
      set({
        state: 'over',
        line: `${stopped ? 'Stopped. ' : 'Done. '}${WORDS[job].done}: ${counted(done, 'person', 'people')}.`,
      });
  } catch (error) {
    set({
      state: 'over',
      line: `Stopped after ${counted(done, 'person', 'people')}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  await refreshTidy();
}

// ---- Drawing ----

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function outcomeView(outcome: Outcome | undefined): Child {
  if (!outcome) return null;
  if (outcome === 'done') return chip('Done', 'saved');
  if (outcome === 'already') return chip('Done already', 'saved');
  return h('span', { class: 'muted' }, ` · ${outcome.skipped}`);
}

function listView(job: TidyJob, value: Tidy, busy: boolean): Child[] {
  const all = listOf(value, job);
  const shown = all.slice(0, SHOWN);
  const picked = ticked[job];
  const room = left(value, job);
  const lines: Child[] = [
    h('h3', {}, `${WORDS[job].title} · ${value.totals[job].toLocaleString()}`),
    h(
      'p',
      { class: 'muted' },
      job === 'cancel_request'
        ? `Sent more than ${counted(value.cancelAfterWeeks, 'week')} ago and not answered. Facebook pauses your requests when too many wait.`
        : `No contact either way in six months, friends for longer, and not in Contacts, a prospect, kept or on Don’t pitch. You have ${value.friends.toLocaleString()} of ${value.cap.toLocaleString()} friends.`,
    ),
  ];
  if (job === 'unfriend' && value.needsFile)
    return [
      ...lines.slice(0, 1),
      h(
        'p',
        { class: 'muted' },
        'Bring in your Facebook file first (Your Facebook file, below): it says when you last talked to each friend.',
      ),
    ];
  if (!all.length) return [...lines, h('p', { class: 'muted' }, 'Nobody right now.')];
  const items = shown.map((who) => {
    const tick = h('input', { type: 'checkbox' });
    tick.checked = picked.has(who.profileId);
    tick.disabled = busy || outcomes.has(who.profileId);
    tick.addEventListener('change', () => {
      if (tick.checked) picked.add(who.profileId);
      else picked.delete(who.profileId);
      draw();
    });
    const when =
      job === 'cancel_request'
        ? `sent ${day(who.since)}`
        : who.lastContact
          ? `last contact ${day(who.lastContact)}`
          : 'no contact on record';
    return h(
      'li',
      {},
      h(
        'label',
        { class: 'auto' },
        tick,
        ' ',
        link(who.name, who.url),
        h('span', { class: 'muted' }, ` · ${when}`),
        who.fit === 'good' ? h('span', { class: 'muted' }, ' · fits a playbook') : null,
      ),
      outcomeView(outcomes.get(who.profileId)),
    );
  });
  const open = shown.filter((who) => !outcomes.has(who.profileId));
  return [
    ...lines,
    h('ul', { class: 'list' }, ...items),
    all.length > shown.length
      ? h('p', { class: 'muted' }, `The first ${SHOWN} shown. Do these, and the next ones show.`)
      : null,
    h(
      'div',
      { class: 'actions' },
      button(
        open.length && open.every((who) => picked.has(who.profileId)) ? 'Untick all' : 'Tick all',
        () => {
          const all = open.every((who) => picked.has(who.profileId));
          for (const who of open) {
            if (all) picked.delete(who.profileId);
            else picked.add(who.profileId);
          }
          draw();
        },
        { disabled: busy || !open.length },
      ),
      button(
        picked.size ? `${WORDS[job].button} (${picked.size})` : WORDS[job].button,
        () => void go(job),
        { primary: true, disabled: busy || !picked.size || room <= 0 || warned !== null },
      ),
    ),
    h(
      'p',
      { class: 'muted' },
      room > 0
        ? `Up to ${counted(room, 'more')} today. It goes slowly, a person at a time, in a tab you can see.`
        : `That’s today’s limit of ${value.limits[job].most}. Carry on tomorrow.`,
    ),
  ];
}

function draw(): void {
  if (!box) return;
  const shown = tidy !== null || problem !== null;
  box.hidden = !shown;
  if (!shown) return box.replaceChildren();
  const busy = busyNow();
  const value = tidy?.value ?? null;
  const web =
    account?.signedIn && tidy ? `${account.webUrl}/app/w/${tidy.businessId}/a/outreach` : null;
  const count = value ? value.totals.cancel_request + value.totals.unfriend : 0;
  const details = h('details', {});
  details.open = busy || (box.querySelector('details') as HTMLDetailsElement | null)?.open === true;
  const parts: Child[] = [
    h(
      'summary',
      {},
      h(
        'h2',
        {},
        count ? `Tidy up your friends · ${count.toLocaleString()}` : 'Tidy up your friends',
      ),
    ),
    problem ? h('p', { class: 'muted' }, `Couldn’t get the lists. ${problem}`) : null,
    value?.warning
      ? h('p', { class: 'warning-note', role: 'alert' }, warningNote(value.warning))
      : null,
    warned && !value?.warning?.today
      ? h(
          'p',
          { class: 'warning-note', role: 'alert' },
          `Facebook warned you today: “${warned[0]}”. The extension stops until tomorrow.`,
        )
      : null,
    h(
      'p',
      { class: 'muted' },
      'Tick the ones to go, and the extension presses the button on each one’s profile for you, slowly, in a tab you can see. It stops at today’s limit, and on any warning from Facebook.',
    ),
    ...(value ? listView('cancel_request', value, busy) : []),
    ...(value ? listView('unfriend', value, busy) : []),
    run.state !== 'idle' ? h('p', { class: 'status', role: 'status' }, run.line) : null,
    run.state === 'stuck'
      ? h(
          'div',
          { class: 'actions' },
          button('Carry on', () => carry(true), { primary: true }),
          button('Skip', () => carry(false)),
        )
      : null,
    busy
      ? button('Stop', () => {
          stopped = true;
          carry(false);
        })
      : null,
    web ? hfosLink('See your friends in HandsFreeOS', `${web}?view=friends`) : null,
  ];
  details.append(...parts.filter((part): part is Node | string => Boolean(part)));
  box.replaceChildren(details);
}

function carry(on: boolean): void {
  const then = carryOn;
  carryOn = null;
  then?.(on);
}

export function startTidy(into: HTMLElement): void {
  box = into;
  onWarning(() => void refreshTidy());
  void refreshTidy();
}
