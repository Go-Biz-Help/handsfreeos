/**
 * Waiting for you, first in the side panel (docs/outreach.md, decisions 40 and 42): everything waiting for the
 * person, the same list as HandsFreeOS's Waiting for you tab, in four groups:
 *
 * - **Replies handed over to you**, each with why, its words to change, **Send** and **Skip**;
 * - **Messages to OK**, the same, with **Approve all** above them (which leaves those that wait one at a time);
 * - **Steps it needs you for**: what to do, why the extension couldn't, a link to do it on Facebook, **I did it** and
 *   **Let it go**; a message that didn't go has its words to copy;
 * - **Friend requests to decide**: why they're the person's, a link to their profile, and **Leave it**.
 *
 * The background keeps the list (src/hfos/waiting.ts), with the number on the icon; this draws it, and again whenever
 * it changes. Acting on one asks the background, which asks HandsFreeOS and then looks again.
 */
import { wheelsWords } from '@hfos/core/addons/outreach/automation';
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
  waitingWords,
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

function sendView(item: SendItem): HTMLElement {
  const send = item.send;
  const words = h('textarea', { rows: '4', 'aria-label': `Message to ${send.name}` });
  words.value = edits.get(send.sendId) ?? send.text;
  words.addEventListener('input', () => edits.set(send.sendId, words.value));
  const why = oneByOneWords(send);
  return h(
    'li',
    {},
    h(
      'div',
      { class: 'name' },
      link(send.name, messengerChatUrl(send.threadKey) ?? send.profileUrl),
    ),
    why ? h('div', { class: 'muted' }, why) : null,
    words,
    h(
      'div',
      { class: 'actions' },
      button('Send', () => approve(item), { primary: true, disabled: busy }),
      button('Skip', () => skip(item), { disabled: busy }),
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
  const web = kept ? `${config.webUrl}/app/w/${kept.businessId}/a/outreach` : null;
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
            : sendView(item),
      ),
    ),
    items.length < count
      ? h(
          'p',
          { class: 'muted' },
          `${moreWords(kind, count - items.length)} `,
          web ? hfosLink('See them all', `${web}?view=waiting`) : null,
        )
      : null,
    kind === 'request' && web
      ? h(
          'p',
          { class: 'muted' },
          hfosLink('All your requests', `${web}?view=friends&show=requests`),
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
      'Waiting for you ',
      list.count ? h('span', { class: 'count' }, list.count.toLocaleString()) : null,
      config.webUrl
        ? h(
            'span',
            { class: 'see-all' },
            hfosLink('See all', `${config.webUrl}/app/w/${businessId}/a/outreach?view=waiting`),
          )
        : null,
    ),
    list.count
      ? null
      : h(
          'p',
          { class: 'muted' },
          `${waitingWords(0)} When the extension writes a message for your OK, hands you a reply, or can’t do a step, it shows here.`,
        ),
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
