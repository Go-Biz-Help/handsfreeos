/**
 * Today on Facebook, in the side panel: the person's steps so far today against the daily limits, the people they
 * reached and who wrote back, and the last few steps noted; with the switch that turns noting on and off, and a link
 * to the activity panel in HandsFreeOS (docs/outreach.md, decisions 7 and 8). The background notes the steps and
 * answers for the day (src/hfos/noting.ts); this asks it, and asks again whenever it notes one.
 *
 * Under them, the list for today (packages/core/src/addons/outreach/today.ts): friend requests to people from the
 * person's groups who fit a playbook, a first message to new friends, follow-ups and replies, and comments on good
 * posts in their groups (decision 20), each with a link to open and, for a message or a comment, the AI's drafts to
 * copy. Before drafting, the extension looks the person up on Facebook (./lookup.ts, decision 21). The person sends
 * everything themselves; noting the step takes it off, and a post they don't want can be put aside.
 */
import {
  DAILY_STEPS,
  DAILY_WORDS,
  FRIEND_ANSWERS,
  pastLimitWords,
  TOUCH_KINDS,
} from '@hfos/core/addons/outreach/limits';
import { warningNote } from '@hfos/core/addons/outreach/tidy';
import { DRAFT_KINDS, TODAY_KINDS, type DraftKind } from '@hfos/core/addons/outreach/today';
import type {
  Activity,
  Noted,
  Problem,
  Today,
  TodayList,
  TodayListItem,
  Touched,
} from '../hfos/messages';
import { ask } from './ask';
import { ago, button, chip, counted, h, hfosLink, link, type Child } from './dom';
import { lookUp } from './lookup';
import { onWarning } from './warnings';

/** How often the panel asks again while it's open: the day ends, and a step may wait to be sent. */
const AGAIN_MS = 2 * 60_000;
/** How long after a step is noted it asks: steps come in runs. */
const SOON_MS = 800;

let box: HTMLElement;
let today: Today | null = null;
let problem: Problem | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let switching = false;
/** The list for today in the business it saves to, and why it couldn't be had. */
let list: { readonly businessId: string; readonly value: TodayList } | null = null;
let listProblem: string | null = null;
/** The AI's drafts for someone on the list, by `itemKey`: being looked up, then written, while a string. */
const drafts = new Map<string, readonly string[] | 'looking' | 'writing'>();
const draftProblems = new Map<string, string>();
/** The list's shown, or all of it. */
let showAll = false;

/** The most on the list shown before "Show all". */
const LIST_SHOWN = 8;

/** Asks the background for the day and the list for it, and draws them. */
export async function refreshToday(): Promise<void> {
  clearTimeout(timer);
  const answer = await ask({ type: 'hfos-today' });
  if (answer.ok) [today, problem] = [answer.value, null];
  else problem = answer.problem;
  draw();
  await refreshList();
}

async function refreshList(): Promise<void> {
  const businessId = today?.activity ? today.businessId : null;
  if (!businessId) {
    [list, listProblem] = [null, null];
    return draw();
  }
  const answer = await ask({ type: 'hfos-today-list', workspaceId: businessId });
  if (answer.ok) [list, listProblem] = [{ businessId, value: answer.value }, null];
  else listProblem = answer.problem.message;
  draw();
}

const itemKey = (item: TodayListItem) =>
  `${item.kind}:${item.postId ?? item.chatId ?? item.profileId ?? item.name}`;

async function draft(item: TodayListItem, kind: DraftKind): Promise<void> {
  if (!list) return;
  const businessId = list.businessId;
  const key = itemKey(item);
  drafts.set(key, 'looking');
  draftProblems.delete(key);
  draw();
  const lookup = await lookUp(item.profileUrl);
  drafts.set(key, 'writing');
  draw();
  const answer = await ask({
    type: 'hfos-draft',
    workspaceId: businessId,
    input: {
      kind,
      profileId: item.profileId,
      chatId: item.chatId,
      postId: item.postId,
      lookup,
    },
  });
  if (answer.ok && answer.value.drafts.length) drafts.set(key, answer.value.drafts);
  else {
    drafts.delete(key);
    draftProblems.set(
      key,
      answer.ok ? 'The AI had nothing to suggest. Try again.' : answer.problem.message,
    );
  }
  draw();
}

/** Puts a post aside: off the list, and never suggested again. */
async function skip(item: TodayListItem): Promise<void> {
  if (!list || !item.postId) return;
  const key = itemKey(item);
  const answer = await ask({
    type: 'hfos-post-skip',
    input: { workspaceId: list.businessId, postId: item.postId },
  });
  if (!answer.ok) {
    draftProblems.set(key, answer.problem.message);
    return draw();
  }
  await refreshList();
}

function soon(): void {
  clearTimeout(timer);
  timer = setTimeout(() => void refreshToday(), SOON_MS);
}

async function turn(on: boolean): Promise<void> {
  switching = true;
  draw();
  const answer = await ask({ type: 'hfos-noting', on });
  switching = false;
  if (answer.ok) [today, problem] = [answer.value, null];
  else problem = answer.problem;
  draw();
}

/** What each step or answer noted is called. */
const NOTED: Record<Noted['kind'], string> = { ...TOUCH_KINDS, ...FRIEND_ANSWERS };

/** What a step was, in a few words: "Message · Dana Reyes · chat started", "Confirmed · Dana Reyes". */
function stepWords(noted: Noted): string {
  const place =
    noted.step === 'first_message'
      ? 'chat started'
      : noted.step === 'follow_up'
        ? 'follow-up'
        : null;
  return [NOTED[noted.kind], noted.name, place].filter(Boolean).join(' · ');
}

/** "6 people reached · 1 wrote back". */
function reachedWords(people: number, replies: number): string {
  const reached = `${people.toLocaleString()} ${people === 1 ? 'person' : 'people'} reached`;
  return replies ? `${reached} · ${replies.toLocaleString()} wrote back` : reached;
}

function recentView(recent: readonly Noted[]): Child {
  if (!recent.length) return null;
  return h(
    'div',
    {},
    h('h3', {}, 'Last noted'),
    h(
      'ul',
      { class: 'recent' },
      ...recent.map((noted) =>
        h(
          'li',
          {},
          h('span', {}, stepWords(noted)),
          h('span', { class: 'muted' }, ` · ${ago(noted.at)}`),
          noted.state === 'waiting' ? chip('Waiting to send') : null,
          noted.state === 'not_saved' ? chip('Not saved', 'warn') : null,
          noted.repeated ? h('span', { class: 'muted' }, ' · noted already') : null,
          noted.why ? h('div', { class: 'error' }, noted.why) : null,
        ),
      ),
    ),
  );
}

function limitsView(activity: Activity): Child[] {
  const done = activity.today;
  const past = pastLimitWords(done, activity.limits);
  return [
    h(
      'ul',
      { class: 'limits' },
      ...DAILY_STEPS.map((step) => {
        const count = done[step];
        const limit = activity.limits[step];
        const fill = h('span', { class: 'fill' });
        fill.style.width = `${Math.min(100, Math.round((count / limit) * 100))}%`;
        return h(
          'li',
          { class: count >= limit ? 'full' : undefined },
          h('span', { class: 'label' }, DAILY_WORDS[step].label),
          h('span', { class: 'bar', 'aria-hidden': 'true' }, fill),
          h('span', { class: 'of' }, `${count} of ${limit}`),
        );
      }),
    ),
    past ? h('p', { class: 'warn-line' }, past) : null,
    h('p', { class: 'muted' }, reachedWords(activity.numbers.people, activity.numbers.replies)),
  ];
}

/** Where to open someone on the list: the post to comment on, their chat for a message in one, else their profile. */
function openUrl(item: TodayListItem): string | null {
  if (item.postUrl) return item.postUrl;
  if (item.threadKey)
    return `https://www.facebook.com/messages/t/${encodeURIComponent(item.threadKey)}`;
  return item.profileUrl;
}

function draftsView(item: TodayListItem): Child {
  const kind = DRAFT_KINDS.find((k) => k === item.kind);
  if (!kind) return null;
  const key = itemKey(item);
  const got = drafts.get(key);
  const trouble = draftProblems.get(key);
  if (got === undefined)
    return h(
      'div',
      {},
      button(
        kind === 'comment' ? 'Draft a comment' : 'Draft a message',
        () => void draft(item, kind),
      ),
      kind === 'comment' ? button('Not for me', () => void skip(item)) : null,
      trouble ? h('div', { class: 'error' }, trouble) : null,
    );
  if (got === 'looking') return h('p', { class: 'muted' }, `Looking ${item.name} up on Facebook…`);
  if (got === 'writing') return h('p', { class: 'muted' }, 'Writing drafts…');
  return h(
    'ul',
    { class: 'drafts' },
    ...got.map((text) => {
      const copy = button('Copy', () => {
        void navigator.clipboard.writeText(text).then(
          () => (copy.textContent = 'Copied'),
          () => (copy.textContent = 'Couldn’t copy'),
        );
      });
      return h('li', {}, h('p', {}, text), copy);
    }),
    h(
      'li',
      {},
      button('Draft again', () => void draft(item, kind)),
    ),
  );
}

function itemView(item: TodayListItem): HTMLElement {
  return h(
    'li',
    {},
    h('div', { class: 'name' }, chip(TODAY_KINDS[item.kind]), ' ', link(item.name, openUrl(item))),
    item.why.length ? h('div', { class: 'muted' }, item.why.join(' · ')) : null,
    item.post
      ? h(
          'blockquote',
          { class: 'post' },
          item.post,
          item.posted ? h('span', { class: 'muted' }, ` · ${item.posted}`) : null,
        )
      : null,
    item.summary ? h('div', {}, item.summary) : null,
    item.nextStep ? h('div', { class: 'muted' }, `Next: ${item.nextStep}`) : null,
    draftsView(item),
  );
}

/** The list for today: what to do, and the groups whose admins are still to be read. */
function listView(): Child[] {
  if (!today?.activity) return [];
  if (!list)
    return listProblem
      ? [h('p', { class: 'muted' }, `Couldn’t get your list. ${listProblem}`)]
      : [];
  const { items, readAdmins, hasPlaybook } = list.value;
  const shownItems = showAll ? items : items.slice(0, LIST_SHOWN);
  const web = `${today.webUrl}/app/w/${list.businessId}/a/outreach`;
  return [
    h('h3', {}, 'Your list for today'),
    items.length
      ? h('ul', { class: 'list' }, ...shownItems.map(itemView))
      : h(
          'p',
          { class: 'muted' },
          'Nothing on your list yet. Save groups and their members, and read your chats, to fill it.',
        ),
    items.length > shownItems.length
      ? button(`Show all ${items.length.toLocaleString()}`, () => {
          showAll = true;
          draw();
        })
      : null,
    !hasPlaybook
      ? h(
          'p',
          { class: 'muted' },
          'Friend requests are suggested once the business has a playbook. ',
          hfosLink('Make one', `${web}?view=playbooks`),
        )
      : null,
    ...readAdmins.map((group) =>
      h(
        'p',
        { class: 'muted' },
        'Save the admins and moderators of ',
        link(group.name ?? 'this group', `${group.url.replace(/\/?$/, '/')}members/admins`),
        ' to get its members suggested.',
      ),
    ),
  ];
}

function draw(): void {
  if (!box) return;
  const activity = today?.activity ?? null;
  // Why there are no numbers: HandsFreeOS's words, or the background's when it couldn't answer at all.
  const trouble = activity ? null : (today?.trouble ?? problem?.message ?? null);
  box.hidden = !activity && !trouble;
  if (box.hidden) return box.replaceChildren();
  const parts: Child[] = [
    h(
      'h2',
      {},
      'Today on Facebook',
      activity && today?.businessId
        ? h(
            'span',
            { class: 'see-all' },
            hfosLink('See all', `${today.webUrl}/app/w/${today.businessId}/a/outreach`),
          )
        : null,
    ),
    trouble ? h('p', { class: 'muted' }, `Couldn’t get today’s numbers. ${trouble}`) : null,
    activity?.warning
      ? h('p', { class: 'warning-note', role: 'alert' }, warningNote(activity.warning))
      : null,
    today && !today.noting
      ? h(
          'p',
          { class: 'muted' },
          'Noting is off, so the steps you take on Facebook aren’t counted here.',
        )
      : null,
    ...(activity ? limitsView(activity) : []),
    today?.waiting
      ? h(
          'p',
          { class: 'muted' },
          `${counted(today.waiting, 'step')} waiting to be sent to HandsFreeOS.`,
        )
      : null,
    ...listView(),
    recentView(today?.recent ?? []),
    today ? switchView(today) : null,
  ];
  box.replaceChildren(...parts.filter((part): part is Node | string => Boolean(part)));
}

/** The switch that turns noting on and off. */
function switchView(now: Today): Child {
  const toggle = h('input', { type: 'checkbox' });
  toggle.checked = now.noting;
  toggle.disabled = switching;
  toggle.addEventListener('change', () => void turn(toggle.checked));
  return h('label', { class: 'auto' }, toggle, ' Note what I do on Facebook');
}

/** Draws the day into `into`, and asks again when a step is noted, and every few minutes while the panel shows. */
export function startToday(into: HTMLElement): void {
  box = into;
  onWarning(() => void refreshToday());
  chrome.runtime.onMessage.addListener((note: Touched | undefined) => {
    if (note?.type === 'hfos-touched') soon();
    return false;
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') void refreshToday();
  }, AGAIN_MS);
  void refreshToday();
}
