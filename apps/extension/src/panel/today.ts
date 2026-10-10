/**
 * Today on Facebook, in the side panel: the person's steps so far today against the daily limits, the people they
 * reached and who wrote back, and the last few steps noted (noting itself is turned on and off in HandsFreeOS, decision 37), and a link
 * to the activity panel in HandsFreeOS (docs/outreach.md, decisions 7 and 8). The background notes the steps and
 * answers for the day (src/hfos/noting.ts); this asks it, and asks again whenever it notes one.
 *
 * Under them, the list for today (packages/core/src/addons/outreach/today.ts): friend requests to people from the
 * person's groups who fit a playbook, a first message to new friends, follow-ups and replies, and comments on good
 * posts in their groups (decision 20), each with a link to open and, for a message or a comment, the AI's drafts to
 * copy. Before drafting, the extension looks the person up on Facebook (./lookup.ts, decision 21). The person sends
 * everything themselves; noting the step takes it off, and a post they don't want can be put aside. A first message's
 * drafts open the way the playbook's next opener says, and copying one notes which it was (decision 23); anyone on the
 * list for a message has the person's demo link to copy, so a booking through it counts by itself (decision 24). What
 * the extension does on its own for them (./auto.ts) says so.
 *
 * A message the extension drafted to send for them (packages/core/src/addons/outreach/sends.ts) shows in place of the
 * drafts: one waiting has its words to change, **Send** and **Skip**, and **Approve all** OKs every one waiting but a
 * reply handed over or one to someone who needs the person, which wait to be OK'd one at a time (decision 42); one
 * OK'd says it goes soon. While training wheels are on, it says what's left before they come off.
 */
import {
  DAILY_STEPS,
  DAILY_WORDS,
  FRIEND_ANSWERS,
  pastLimitWords,
  TOUCH_KINDS,
} from '@hfos/core/addons/outreach/limits';
import { OPENER_KINDS, openerShort, type DraftOpener } from '@hfos/core/addons/outreach/openers';
import { warningNote } from '@hfos/core/addons/outreach/tidy';
import { wheelsWords } from '@hfos/core/addons/outreach/automation';
import { DRAFT_KINDS, TODAY_KINDS, type DraftKind } from '@hfos/core/addons/outreach/today';
import { approveAllWords, oneByOne, oneByOneWords } from '@hfos/core/addons/outreach/waiting-words';
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
/** The list for today in the business it saves to, and why it couldn't be had. */
let list: { readonly businessId: string; readonly value: TodayList } | null = null;
let listProblem: string | null = null;
/** The AI's drafts for someone on the list, by `itemKey`, and the opener they took: being looked up, then written, while a string. */
const drafts = new Map<
  string,
  { readonly texts: readonly string[]; readonly opener: DraftOpener | null } | 'looking' | 'writing'
>();
const draftProblems = new Map<string, string>();
/** Messages waiting for the person's OK as they're changing them, by send; and why one couldn't be OK'd or skipped. */
const edits = new Map<string, string>();
const sendProblems = new Map<string, string>();
let approving = false;
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
  if (answer.ok && answer.value.drafts.length)
    drafts.set(key, { texts: answer.value.drafts, opener: answer.value.opener });
  else {
    drafts.delete(key);
    draftProblems.set(
      key,
      answer.ok ? 'The AI had nothing to suggest. Try again.' : answer.problem.message,
    );
  }
  draw();
}

/** Copying a first message notes which opener it was; that it couldn't is no reason to stop them. */
function noteOpener(item: TodayListItem, opener: DraftOpener | null): void {
  if (!list || !opener || !item.profileId) return;
  void ask({
    type: 'hfos-opener-use',
    input: { workspaceId: list.businessId, profileId: item.profileId, opener },
  });
}

/** A button that copies `text`, and says so. */
function copyButton(label: string, text: string, then?: () => void): HTMLElement {
  const copy = button(label, () => {
    void navigator.clipboard.writeText(text).then(
      () => {
        copy.textContent = 'Copied';
        then?.();
      },
      () => (copy.textContent = 'Couldn’t copy'),
    );
  });
  return copy;
}

/** OKs messages the extension drafted, as the person left them; with none named, every one waiting (Approve all). */
async function approve(item: TodayListItem | null): Promise<void> {
  if (!list || approving) return;
  approving = true;
  draw();
  const sendId = item?.send?.sendId;
  const answer = await ask({
    type: 'hfos-send-ok',
    input: {
      workspaceId: list.businessId,
      ...(sendId ? { sends: [{ sendId, text: edits.get(sendId) ?? item.send!.text }] } : {}),
    },
  });
  approving = false;
  if (answer.ok) {
    sendProblems.delete(sendId ?? 'all');
    for (const id of answer.value.approved) edits.delete(id);
  } else sendProblems.set(sendId ?? 'all', answer.problem.message);
  await refreshList();
}

/** Skips a message the extension drafted: it isn't sent, and they're off the list for today. */
async function skipSend(item: TodayListItem): Promise<void> {
  if (!list || !item.send) return;
  const answer = await ask({
    type: 'hfos-send-skip',
    input: { workspaceId: list.businessId, sendId: item.send.sendId },
  });
  if (answer.ok) sendProblems.delete(item.send.sendId);
  else sendProblems.set(item.send.sendId, answer.problem.message);
  await refreshList();
}

/** The message the extension drafted for someone: to change and send or skip while it waits; else going soon. */
function sendView(item: TodayListItem): Child {
  const send = item.send;
  if (!send) return null;
  if (send.state === 'approved')
    return h(
      'div',
      {},
      h('p', { class: 'muted' }, 'OK’d: the extension sends it soon.'),
      h('blockquote', { class: 'post' }, send.text),
    );
  const words = h('textarea', { rows: '4', 'aria-label': `Message to ${item.name}` });
  words.value = edits.get(send.sendId) ?? send.text;
  words.addEventListener('input', () => edits.set(send.sendId, words.value));
  const trouble = sendProblems.get(send.sendId);
  const alone = oneByOneWords(send);
  return h(
    'div',
    {},
    h('p', { class: 'muted' }, 'I’d send this. Change it if you like; your changes teach the AI.'),
    alone ? h('p', { class: 'muted' }, alone) : null,
    words,
    h(
      'div',
      { class: 'actions' },
      button('Send', () => void approve(item), { primary: true, disabled: approving }),
      button('Skip', () => void skipSend(item), { disabled: approving }),
    ),
    trouble ? h('div', { class: 'error' }, trouble) : null,
  );
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
    'div',
    {},
    got.opener
      ? h(
          'p',
          { class: 'muted' },
          `Opens with ${OPENER_KINDS[got.opener.kind].toLowerCase()}: “${openerShort(got.opener.text, 70)}”`,
        )
      : null,
    h(
      'ul',
      { class: 'drafts' },
      ...got.texts.map((text) =>
        h(
          'li',
          {},
          h('p', {}, text),
          copyButton('Copy', text, () => noteOpener(item, got.opener)),
        ),
      ),
      h(
        'li',
        {},
        button('Draft again', () => void draft(item, kind)),
      ),
    ),
  );
}

function itemView(item: TodayListItem): HTMLElement {
  return h(
    'li',
    {},
    h(
      'div',
      { class: 'name' },
      chip(TODAY_KINDS[item.kind]),
      ' ',
      link(item.name, openUrl(item)),
      list?.value.auto.includes(item.kind) ? chip('Done on its own', 'saved') : null,
    ),
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
    item.send ? sendView(item) : draftsView(item),
    item.demoLink ? h('div', {}, copyButton('Copy demo link', item.demoLink)) : null,
  );
}

/** The list for today: what to do, and the groups whose admins are still to be read. */
function listView(): Child[] {
  if (!today?.activity) return [];
  if (!list)
    return listProblem
      ? [h('p', { class: 'muted' }, `Couldn’t get your list. ${listProblem}`)]
      : [];
  const { items, readAdmins, hasPlaybook, wheels } = list.value;
  const shownItems = showAll ? items : items.slice(0, LIST_SHOWN);
  const web = `${today.webUrl}/app/w/${list.businessId}/a/outreach`;
  // Approve all leaves those that wait one at a time: a reply handed over, or one to someone who needs the person.
  const waiting = items.filter(
    (item) => item.send?.state === 'waiting' && !oneByOne(item.send),
  ).length;
  const allTrouble = sendProblems.get('all');
  return [
    h('h3', {}, 'Your list for today'),
    wheels.on ? h('p', { class: 'muted' }, wheelsWords(wheels)) : null,
    waiting > 1
      ? h(
          'div',
          { class: 'actions' },
          button(approveAllWords(waiting), () => void approve(null), {
            primary: true,
            disabled: approving,
          }),
        )
      : null,
    allTrouble ? h('div', { class: 'error' }, allTrouble) : null,
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
          'Noting is off, so the steps you take on Facebook aren’t counted here. Turn on “Note my steps on Facebook” in HandsFreeOS.',
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
  ];
  box.replaceChildren(...parts.filter((part): part is Node | string => Boolean(part)));
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
