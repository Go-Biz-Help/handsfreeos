/**
 * Needs you, in the side panel after Next up (docs/outreach.md, decisions 40, 42, 43 and 59): everything waiting for
 * the person, the same list as Needs you on HandsFreeOS's Today, in five groups:
 *
 * - **Replies handed over to you**, each with why, the texts it would send, **Send**, **Edit** and **Skip**;
 * - **Messages to OK**, the same, with **Approve all** above them (which leaves those that wait one at a time);
 * - **Steps it needs you for**: what to do, why the extension couldn't, a link to do it on Facebook, **I did it** and
 *   **Let it go**; a message that didn't go has its words to copy;
 * - **Friend requests to decide**: why they're the person's, a link to their profile, and **Leave it**;
 * - **Your computer needs you**: a step something they asked of it from HandsFreeOS handed them, with **Carry on**
 *   (and **Skip**, for one person ticked) once they've done it, and **Stop** (decision 43).
 *
 * The background keeps the list (src/hfos/waiting.ts), with the number on the icon; this draws it, and again whenever
 * it changes. Acting on one asks the background, which asks HandsFreeOS and then looks again.
 */
import {
  ASK_KINDS,
  ASK_REPLIES,
  ASK_TYPING_WORDS,
  askRepliesFor,
} from '@hfos/core/addons/outreach/asks';
import { wheelsWords } from '@hfos/core/addons/outreach/automation';
import { recentBubbles, RECENT_WORDS } from '@hfos/core/addons/outreach/sends';
import { outreachPath, type OutreachTab } from '@hfos/core/addons/outreach/setup';
import { messageParts } from '@hfos/core/addons/outreach/voice';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import {
  approveAllCount,
  approveAllWords,
  messengerChatUrl,
  moreWords,
  needClearedWords,
  needTitle,
  needWhyWords,
  NEED_CLEARS,
  oneByOneWords,
  WAITING_KIND_KEYS,
  WAITING_KINDS,
  type NeedClear,
  type WaitingKind,
} from '@hfos/core/addons/outreach/waiting-words';
import { config } from '../hfos/config';
import {
  BUSINESS_KEY,
  PLACE_KEY,
  WAITING_FOR_KEY,
  type Waiting,
  type WaitingItem,
} from '../hfos/messages';
import { ask } from './ask';
import { ago, button, chip, h, hfosLink, link, type Child } from './dom';

type SendItem = Extract<WaitingItem, { kind: 'reply' | 'message' }>;
type NeedItem = Extract<WaitingItem, { kind: 'need' }>;
type RequestItem = Extract<WaitingItem, { kind: 'request' }>;
type AskItem = Extract<WaitingItem, { kind: 'ask' }>;

/** What the background kept, as the panel reads it: whose it is, and the list. */
interface Kept {
  readonly userId: string;
  readonly businessId: string;
  readonly list: Waiting;
}

let box: HTMLElement;
/** The background's last list, and where the person saves now: the list shows only while it's theirs there. */
let stored: Kept | null = null;
let place: { readonly userId: string; readonly businessId: string } | null = null;
let picked: string | null = null;
let kept: Kept | null = null;
/** Messages as the person is changing them, by send; why one couldn't be done, and what happened, by item (or "all"). */
const edits = new Map<string, string>();
/** Messages open to change: the rest show as the texts they'd send. */
const editing = new Set<string>();
const problems = new Map<string, string>();
const notes = new Map<string, string>();
let busy = false;

const isKept = (value: unknown): value is Kept =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Kept).userId === 'string' &&
  typeof (value as Kept).businessId === 'string' &&
  typeof (value as Kept).list === 'object';

const isPlace = (value: unknown): value is NonNullable<typeof place> =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Kept).userId === 'string' &&
  typeof (value as Kept).businessId === 'string';

/** The list kept, when it's for the person signed in and the business they save to now. */
function settle(): void {
  kept =
    stored &&
    place &&
    stored.userId === place.userId &&
    stored.businessId === place.businessId &&
    (picked === null || picked === stored.businessId)
      ? stored
      : null;
  draw();
}

async function act(
  key: string,
  work: () => Promise<{ ok: true } | { ok: false; problem: { message: string } }>,
): Promise<void> {
  if (busy) return;
  busy = true;
  problems.delete(key);
  notes.delete(key);
  draw();
  const answer = await work();
  busy = false;
  if (!answer.ok) problems.set(key, answer.problem.message);
  // The background looks again and writes the list, which draws it; a refusal shows now.
  draw();
}

function approve(item: SendItem | null): void {
  if (!kept) return;
  const workspaceId = kept.businessId;
  const send = item?.send;
  void act(send?.sendId ?? 'all', async () => {
    const answer = await ask({
      type: 'hfos-send-ok',
      input: {
        workspaceId,
        ...(send
          ? { sends: [{ sendId: send.sendId, text: edits.get(send.sendId) ?? send.text }] }
          : {}),
      },
    });
    if (answer.ok) for (const id of answer.value.approved) edits.delete(id);
    return answer;
  });
}

function skip(item: SendItem): void {
  if (!kept) return;
  const workspaceId = kept.businessId;
  void act(item.send.sendId, () =>
    ask({ type: 'hfos-send-skip', input: { workspaceId, sendId: item.send.sendId } }),
  );
}

function clear(item: NeedItem, how: NeedClear): void {
  if (!kept) return;
  const workspaceId = kept.businessId;
  const key = item.need.needId;
  void act(key, async () => {
    const answer = await ask({
      type: 'hfos-need-clear',
      input: { workspaceId, needId: key, how },
    });
    // The extension couldn't do it again after the press: it stays, and says why.
    if (answer.ok && answer.value.state === 'open') notes.set(key, needClearedWords(how, 'open'));
    return answer;
  });
}

function leave(item: RequestItem): void {
  if (!kept) return;
  const workspaceId = kept.businessId;
  void act(item.request.profileId, () =>
    ask({
      type: 'hfos-request-aside',
      input: { workspaceId, profileId: item.request.profileId },
    }),
  );
}

/** Carry on, Skip or Stop, for a step something the person asked of their computer handed them. */
function answerAsk(item: AskItem, how: 'carry_on' | 'skip' | 'stop'): void {
  const askId = item.ask.askId;
  void act(askId, () =>
    ask(
      how === 'stop'
        ? { type: 'hfos-ask-stop', askId }
        : { type: 'hfos-ask-reply', askId, reply: how },
    ),
  );
}

/** A button that copies `text`, and says so. */
function copyButton(text: string): HTMLElement {
  const copy = button('Copy', () => {
    void navigator.clipboard.writeText(text).then(
      () => (copy.textContent = 'Copied'),
      () => (copy.textContent = 'Couldn’t copy'),
    );
  });
  return copy;
}

const trouble = (key: string): Child => {
  const said = problems.get(key);
  if (said) return h('div', { class: 'error' }, said);
  const note = notes.get(key);
  return note ? h('div', { class: 'muted' }, note) : null;
};

/** The chat so far, above a message waiting for an OK: where it's going (@hfos/core/addons/outreach/sends). */
function chatView(send: SendItem['send']): HTMLElement | null {
  // None from a HandsFreeOS before the chat so far.
  if (!send.recent?.length) return null;
  return h(
    'div',
    {},
    h('div', { class: 'muted' }, RECENT_WORDS.title),
    h(
      'ol',
      { class: 'chat', 'aria-label': RECENT_WORDS.title },
      ...recentBubbles(send.recent, Date.now()).map((b) =>
        h(
          'li',
          { class: b.fromMe ? 'me' : 'them' },
          h('span', { class: 'bubble' }, b.text),
          b.when ? h('span', { class: 'when' }, b.when) : null,
        ),
      ),
    ),
  );
}

/** The texts a message goes as, as they'd look in Messenger: dashed until sent (decision 55). */
function textsView(text: string): HTMLElement {
  return h(
    'ol',
    { class: 'texts', 'aria-label': 'Your reply' },
    ...messageParts(text, true).map((part) => h('li', {}, part)),
  );
}

function sendView(item: SendItem): HTMLElement {
  const send = item.send;
  const text = edits.get(send.sendId) ?? send.text;
  const parts = messageParts(text, true).length;
  const why = oneByOneWords(send);
  let words: Child = null;
  if (editing.has(send.sendId)) {
    const area = h('textarea', { rows: '5', 'aria-label': `Message to ${send.name}` });
    area.value = text;
    area.addEventListener('input', () => edits.set(send.sendId, area.value));
    words = area;
  }
  return h(
    'li',
    {},
    h(
      'div',
      { class: 'name' },
      link(send.name, messengerChatUrl(send.threadKey) ?? send.profileUrl),
    ),
    why ? h('div', { class: 'muted' }, why) : null,
    chatView(send),
    words ?? textsView(text),
    h(
      'div',
      { class: 'actions' },
      button(parts > 1 ? `Send ${parts} texts` : 'Send', () => approve(item), {
        primary: true,
        wide: true,
        disabled: busy,
      }),
      button(
        editing.has(send.sendId) ? 'Done' : 'Edit',
        () => {
          if (editing.has(send.sendId)) editing.delete(send.sendId);
          else editing.add(send.sendId);
          draw();
        },
        { disabled: busy },
      ),
      button('Skip', () => skip(item), { ghost: true, disabled: busy }),
    ),
    trouble(send.sendId),
  );
}

function needView(item: NeedItem): HTMLElement {
  const need = item.need;
  const open = need.step === 'message' ? (messengerChatUrl(need.threadKey) ?? need.url) : need.url;
  return h(
    'li',
    {},
    h('div', { class: 'name' }, needTitle(need.step, need.name)),
    h('div', { class: 'muted' }, `${needWhyWords(need.why)} · ${ago(need.seenAt)}`),
    need.text ? h('div', { class: 'drafts' }, h('p', {}, need.text), copyButton(need.text)) : null,
    h(
      'div',
      { class: 'actions' },
      open ? link('Open on Facebook', open) : null,
      button(NEED_CLEARS.done, () => clear(item, 'done'), { primary: true, disabled: busy }),
      button(NEED_CLEARS.dismissed, () => clear(item, 'dismissed'), { disabled: busy }),
    ),
    trouble(need.needId),
  );
}

function askItemView(item: AskItem): HTMLElement {
  const a = item.ask;
  const replies = a.state === 'stuck' ? askRepliesFor(a.kind) : [];
  return h(
    'li',
    {},
    h('div', { class: 'name' }, ASK_KINDS[a.kind], a.about ? ` · ${a.about}` : ''),
    h(
      'div',
      { class: 'muted' },
      a.state === 'typing' ? ASK_TYPING_WORDS : (a.line ?? ''),
      a.computerName ? ` · ${a.computerName}` : '',
    ),
    h(
      'div',
      { class: 'actions' },
      ...replies.map((r) =>
        button(ASK_REPLIES[r], () => answerAsk(item, r), {
          primary: r === 'carry_on',
          disabled: busy,
        }),
      ),
      button('Stop', () => answerAsk(item, 'stop'), { disabled: busy }),
    ),
    trouble(a.askId),
  );
}

function requestView(item: RequestItem): HTMLElement {
  const request = item.request;
  return h(
    'li',
    {},
    h(
      'div',
      { class: 'name' },
      link(request.name, request.url),
      ' ',
      chip(`Asked ${ago(request.since)}`),
    ),
    request.why.length ? h('div', { class: 'muted' }, request.why.join(' · ')) : null,
    h(
      'div',
      { class: 'actions' },
      button('Leave it', () => leave(item), { disabled: busy }),
    ),
    trouble(request.profileId),
  );
}

/** One group: its name with how many, and each listed. */
function groupView(kind: WaitingKind, list: Waiting): Child[] {
  const items = list.items.filter((item) => item.kind === kind);
  const count = list.kinds[kind].count;
  if (!count) return [];
  const businessId = kept?.businessId;
  const web = businessId
    ? (view: OutreachTab, more?: Record<string, string>) =>
        `${config.webUrl}${outreachPath(businessId, view, more)}`
    : null;
  // The same number as the web's: more may wait than are listed.
  const okAll = kind === 'message' ? approveAllCount(list.items, list.kinds.message.count) : 0;
  return [
    h('h3', {}, `${WAITING_KINDS[kind]} · ${count.toLocaleString()}`),
    kind === 'message' && list.wheels.on
      ? h('p', { class: 'muted' }, wheelsWords(list.wheels))
      : null,
    okAll > 1
      ? h(
          'div',
          { class: 'actions' },
          button(approveAllWords(okAll), () => approve(null), { primary: true, disabled: busy }),
        )
      : null,
    kind === 'message' ? trouble('all') : null,
    h(
      'ul',
      { class: 'list' },
      ...items.map((item) =>
        item.kind === 'need'
          ? needView(item)
          : item.kind === 'request'
            ? requestView(item)
            : item.kind === 'ask'
              ? askItemView(item)
              : sendView(item),
      ),
    ),
    items.length < count
      ? h(
          'p',
          { class: 'muted' },
          `${moreWords(kind, count - items.length)} `,
          web ? hfosLink('See them all', web('today')) : null,
        )
      : null,
    kind === 'request' && web
      ? h(
          'p',
          { class: 'muted' },
          hfosLink('All your requests', web('friends', { show: 'requests' })),
        )
      : null,
  ];
}

function draw(): void {
  if (!box) return;
  box.hidden = !kept;
  if (!kept) return box.replaceChildren();
  const { list, businessId } = kept;
  const parts: Child[] = [
    h(
      'h2',
      {},
      W.needsYou,
      list.count ? h('span', { class: 'count' }, list.count.toLocaleString()) : null,
      config.webUrl
        ? h(
            'span',
            { class: 'see-all' },
            hfosLink('See all', `${config.webUrl}${outreachPath(businessId, 'today')}`),
          )
        : null,
    ),
    list.count ? null : h('p', { class: 'muted' }, W.needsYouNone),
    ...WAITING_KIND_KEYS.flatMap((kind) => groupView(kind, list)),
  ];
  box.replaceChildren(...parts.filter((part): part is Node | string => Boolean(part)));
}

/** Draws Waiting for you into `into`, and again whenever the background keeps a new list or the place changes. */
export function startWaiting(into: HTMLElement): void {
  box = into;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!(WAITING_FOR_KEY in changes) && !(PLACE_KEY in changes) && !(BUSINESS_KEY in changes))
      return;
    if (WAITING_FOR_KEY in changes) {
      const next: unknown = changes[WAITING_FOR_KEY]!.newValue;
      stored = isKept(next) ? next : null;
    }
    if (PLACE_KEY in changes) {
      const next: unknown = changes[PLACE_KEY]!.newValue;
      place = isPlace(next) ? next : null;
    }
    if (BUSINESS_KEY in changes) {
      const next: unknown = changes[BUSINESS_KEY]!.newValue;
      picked = typeof next === 'string' ? next : null;
    }
    settle();
  });
  void chrome.storage.local
    .get([WAITING_FOR_KEY, PLACE_KEY, BUSINESS_KEY])
    .then((found) => {
      const list: unknown = found[WAITING_FOR_KEY];
      const where: unknown = found[PLACE_KEY];
      const business: unknown = found[BUSINESS_KEY];
      stored = isKept(list) ? list : null;
      place = isPlace(where) ? where : null;
      picked = typeof business === 'string' ? business : null;
      settle();
    })
    .catch(() => undefined);
  void refreshWaiting();
}

/** Asks the background to look again: when the panel opens, and when the person signs in or picks a business. */
export async function refreshWaiting(): Promise<void> {
  const answer = await ask({ type: 'hfos-waiting' });
  if (answer.ok && answer.value === null) {
    stored = null;
    settle();
  }
}
