/**
 * Openers on group posts, in the side panel (docs/outreach.md, decisions 18 to 20): posts in the person's groups worth
 * a comment from them.
 *
 * - **Look for posts as I scroll**: on a group's page, each read of its feed sends the posts that say a playbook's signs
 *   or ask for help to HandsFreeOS (`outreach.posts.save`), where the AI checks each one. The panel marks them: good,
 *   or still being checked. On by default.
 * - **Find posts**: the extension goes through the groups the person is in that are marked Work these (or Maybe, when
 *   none are), in a tab they can see, scrolling each one's feed slowly, a screen at a time (src/facebook/browse.ts),
 *   and sends what it finds the same way. It stops on any Facebook warning, and does nothing on a day it saw one.
 *
 * The good ones go on Today's list with two comment drafts (./today.ts). Nothing is pressed or written on Facebook.
 */
import type { ReadResult } from '../facebook/types';
import type { Account, PostMark, PostsSaveInput } from '../hfos/messages';
import { postsSave } from '../hfos/saves';
import { ask } from './ask';
import { button, chip, clip, counted, h, link, type Child } from './dom';
import { WorkTab } from './tab';
import { refreshToday } from './today';
import { noteWarnings, onWarning, warnedToday } from './warnings';

const ON_KEY = 'hfos.markPosts';
/** The most groups one Find posts goes through, and screens it scrolls in each. */
const RUN_GROUPS = 5;
const FEED_SCROLLS = 8;
/** Between screens, and between groups: a steady pace like a person reading. */
const PACE_MS = [6_000, 12_000] as const;
const GROUP_PACE_MS = [15_000, 30_000] as const;
/** A post still being checked is asked about again after this, as the person keeps scrolling. */
const RECHECK_MS = 30_000;
/** The most marked posts shown. */
const SHOWN = 12;

interface Marked extends PostMark {
  readonly name: string;
  readonly text: string;
  readonly at: number;
}

type Run =
  | { readonly state: 'idle' }
  | { readonly state: 'going'; readonly line: string }
  | { readonly state: 'over'; readonly line: string };

let box: HTMLElement;
let account: Account | null = null;
let markOn = true;
let run: Run = { state: 'idle' };
let stopped = false;
/** The group whose feed the panel shows now, and what it marked there. */
let groupUrl: string | null = null;
const marks = new Map<string, Marked>();
let problem: string | null = null;
const tab = new WorkTab();

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const paced = ([low, high]: readonly [number, number]) => low + Math.random() * (high - low);
const businessId = () => (account?.signedIn ? account.businessId : null);

function set(next: Run): void {
  run = next;
  draw();
}

/**
 * Sends the posts on a group's page that aren't marked yet, and those still being checked a while after, and marks
 * them with what HandsFreeOS said. How many went to the AI to check.
 */
async function send(result: ReadResult, found: PostsSaveInput['found']): Promise<number> {
  const id = businessId();
  if (!id) return 0;
  const built = postsSave(result, id, found);
  if (!built.ok) return 0;
  const now = Date.now();
  const due = built.input.posts.filter((post) => {
    const had = marks.get(post.url);
    return !had || (had.check === 'waiting' && now - had.at > RECHECK_MS);
  });
  if (!due.length) return 0;
  const answer = await ask({ type: 'hfos-save-posts', input: { ...built.input, posts: due } });
  if (!answer.ok) {
    problem = answer.problem.message;
    draw();
    return 0;
  }
  problem = null;
  answer.value.posts.forEach((mark, i) => {
    const post = due[i];
    if (post) marks.set(mark.url, { ...mark, name: post.name, text: post.text, at: now });
  });
  draw();
  return answer.value.checking;
}

/** After the panel reads a page: a group's posts are sent to be checked and marked, when that's on. */
export async function markPosts(result: ReadResult): Promise<void> {
  if (run.state === 'going') return;
  const here = result.kind === 'group' ? (result.group?.group?.url ?? null) : null;
  if (here !== groupUrl) {
    groupUrl = here;
    marks.clear();
    draw();
  }
  if (!here || !markOn || (await warnedToday())) return;
  await send(result, 'scroll');
}

// ---- Find posts ----

/** The groups to go through: the ones the person is in, Work these first, else Maybe. */
async function groupsToWork(id: string): Promise<{ name: string | null; url: string }[] | string> {
  for (const view of ['work', 'maybe'] as const) {
    const answer = await ask({ type: 'hfos-groups', input: { workspaceId: id, view } });
    if (!answer.ok) return answer.problem.message;
    const joined = answer.value.groups.filter((g) => g.joined === true);
    if (joined.length) return joined.slice(0, RUN_GROUPS);
  }
  return 'You’re not in any of the groups marked Work these or Maybe yet. Join one, open it with this panel beside it, then try again.';
}

async function find(): Promise<void> {
  const id = businessId();
  if (run.state === 'going' || !id) return;
  stopped = false;
  const warned = await warnedToday();
  if (warned) {
    set({
      state: 'over',
      line: `Facebook warned you today (“${warned[0]}”), so the extension stops until tomorrow.`,
    });
    return;
  }
  set({ state: 'going', line: 'Getting your groups…' });
  const groups = await groupsToWork(id);
  if (typeof groups === 'string') return set({ state: 'over', line: groups });
  let checking = 0;
  let looked = 0;
  try {
    for (const [g, group] of groups.entries()) {
      if (stopped) break;
      const name = group.name ?? 'your group';
      set({
        state: 'going',
        line: `Opening ${name}… ${counted(checking, 'post')} sent to check so far.`,
      });
      await tab.open(group.url);
      for (let screen = 0; screen < FEED_SCROLLS && !stopped; screen++) {
        const answer = await tab.ask({ type: 'hfos-read' });
        if (!answer.ok) throw new Error(answer.error);
        const page = answer.result;
        if (page.warnings.length) {
          await noteWarnings(page.warnings, page.url);
          set({
            state: 'over',
            line: `Stopped: Facebook says “${page.warnings[0]}”. The extension stops for today, and your daily limits are halved for a week.`,
          });
          return;
        }
        checking += await send(page, 'find');
        set({
          state: 'going',
          line: `Reading ${name}… ${counted(checking, 'post')} sent to check so far.`,
        });
        const moved = await tab.ask({ type: 'hfos-scroll-feed' });
        if (!moved.ok) break;
        await pause(paced(PACE_MS));
      }
      looked++;
      if (!stopped && g < groups.length - 1) await pause(paced(GROUP_PACE_MS));
    }
    set({
      state: 'over',
      line: `${stopped ? 'Stopped. ' : ''}Looked through ${counted(looked, 'group')}: ${counted(checking, 'post')} sent for the AI to check. The good ones go on your list for today.`,
    });
    void refreshToday();
  } catch (error) {
    set({
      state: 'over',
      line: `Stopped after ${counted(looked, 'group')}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

// ---- Drawing ----

function markView(mark: Marked): HTMLElement {
  return h(
    'li',
    {},
    h(
      'div',
      { class: 'name' },
      mark.check === 'good' ? chip('Good to comment', 'saved') : chip('AI checking'),
      ' ',
      link(mark.name, mark.url),
    ),
    mark.why.length ? h('div', { class: 'muted' }, mark.why.join(' · ')) : null,
    h('blockquote', { class: 'post' }, clip(mark.text.replace(/\s+/g, ' '), 200)),
  );
}

function draw(): void {
  if (!box) return;
  const id = businessId();
  box.hidden = !id;
  if (!id) return;
  const going = run.state === 'going';
  const all = [...marks.values()];
  const shown = all.filter((m) => !m.done && (m.check === 'good' || m.check === 'waiting'));
  shown.sort((a, b) => Number(b.check === 'good') - Number(a.check === 'good'));
  const toggle = h('input', { type: 'checkbox' });
  toggle.checked = markOn;
  toggle.addEventListener('change', () => {
    markOn = toggle.checked;
    void chrome.storage.local.set({ [ON_KEY]: markOn }).catch(() => undefined);
  });
  const parts: Child[] = [
    h('h2', {}, 'Posts worth a comment'),
    h(
      'p',
      { class: 'muted' },
      'Posts in your groups that ask for help or match your playbooks. The AI checks each one, and the good ones go on your list for today with two comment drafts. You post the comment yourself.',
    ),
    h('label', { class: 'auto' }, toggle, ' Look for posts as I scroll'),
    h(
      'div',
      { class: 'actions' },
      going
        ? button('Stop', () => {
            stopped = true;
          })
        : button('Find posts', () => void find(), { primary: true }),
    ),
    run.state !== 'idle' ? h('p', { class: 'status', role: 'status' }, run.line) : null,
    problem ? h('p', { class: 'error' }, problem) : null,
    groupUrl && all.length
      ? h(
          'p',
          { class: 'muted' },
          `${counted(all.length, 'post')} looked at here, ${shown.length.toLocaleString()} worth a look.`,
        )
      : null,
    shown.length ? h('ul', { class: 'list' }, ...shown.slice(0, SHOWN).map(markView)) : null,
  ];
  box.replaceChildren(h('div', {}, ...parts));
}

/** Asks who's signed in, and where: it sends to the business picked, and hides with none. */
export async function refreshPosts(): Promise<void> {
  const answer = await ask({ type: 'hfos-account' });
  account = answer.ok ? answer.value : null;
  draw();
}

export async function startPosts(into: HTMLElement): Promise<void> {
  box = into;
  onWarning(() => {
    stopped = true;
    draw();
  });
  try {
    markOn = (await chrome.storage.local.get(ON_KEY))[ON_KEY] !== false;
  } catch {
    // Look for posts as I scroll stays on.
  }
  await refreshPosts();
}
