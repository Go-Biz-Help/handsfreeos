/**
 * Openers on group posts, in the side panel (docs/outreach.md, decisions 18 to 20): posts in the person's groups worth
 * a comment from them.
 *
 * - **Look for posts as I scroll**: on a group's page, each read of its feed sends the posts that say a playbook's signs
 *   or ask for help to HandsFreeOS (`outreach.posts.save`), where the AI checks each one. The panel marks them: good,
 *   or still being checked. On by default; set in HandsFreeOS.
 * - **Find posts**: the extension goes through the groups the person is in that are marked Work these (or Maybe, when
 *   none are), in a tab they can see, scrolling each one's feed slowly (src/jobs/posts.ts), and sends what it finds
 *   the same way. It stops on any Facebook warning, and does nothing on a day it saw one. While it works on its own,
 *   it does this once a day by itself too (src/auto/daily.ts).
 *
 * The good ones go on Today's list with two comment drafts (./today.ts). Nothing is pressed or written on Facebook.
 */
import type { ReadResult } from '../facebook/types';
import { MARK_POSTS_KEY } from '../hfos/follow';
import type { Account, PostMark, PostsSaveInput } from '../hfos/messages';
import { postsSave } from '../hfos/saves';
import { ask } from './ask';
import type { Job } from '../jobs/job';
import { findPosts, groupsToWork, RUN_GROUPS } from '../jobs/posts';
import { button, chip, clip, counted, h, link, type Child } from './dom';
import { WorkTab } from '../tab';
import { refreshToday } from './today';
import { noteWarnings, onWarning, warnedToday } from './warnings';

const ON_KEY = MARK_POSTS_KEY;
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
  const job: Job = {
    tab,
    hfos: ask,
    businessId: id,
    stopped: () => stopped,
    progress: (line) => set({ state: 'going', line }),
    warn: noteWarnings,
  };
  set({ state: 'going', line: 'Getting your groups…' });
  try {
    const groups = await groupsToWork(job, RUN_GROUPS);
    if (typeof groups === 'string') return set({ state: 'over', line: groups });
    const end = await findPosts(job, groups, (page) => send(page, 'find'));
    set({ state: 'over', line: end.line });
    if (!end.warned) void refreshToday();
  } catch (error) {
    set({
      state: 'over',
      line: `Stopped: ${error instanceof Error ? error.message : String(error)}`,
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
  const parts: Child[] = [
    h('h2', {}, 'Posts worth a comment'),
    h(
      'p',
      { class: 'muted' },
      'Posts in your groups that ask for help or match your playbooks. The AI checks each one, and the good ones go on your list for today with two comment drafts. You post the comment yourself.',
    ),
    h(
      'p',
      { class: 'muted' },
      markOn
        ? 'It looks for them as you scroll a group, too. Change that in HandsFreeOS.'
        : 'It doesn’t look as you scroll. Change that in HandsFreeOS.',
    ),
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
  // Set in HandsFreeOS: ../hfos/follow.ts writes it here.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[ON_KEY]) return;
    markOn = changes[ON_KEY].newValue !== false;
    draw();
  });
  await refreshPosts();
}
