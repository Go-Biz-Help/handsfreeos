/**
 * Your chats, for the AI, in the side panel (docs/outreach.md, decision 2's "Collect from Facebook"): without
 * Facebook's file, the extension reads the person's one-to-one chats in Messenger and sends each one's latest few
 * messages to HandsFreeOS, where the AI reads them for the Chats tab, as it does the file's (decision 3).
 *
 * - **Read chats I open**: each chat the person opens with the panel open is read for the AI. On by default.
 * - **Read my chats**: it goes through their chats for them in the Messenger tab, one at a time from the list beside
 *   it, at a steady pace, scrolling the list for more (src/facebook/browse.ts). It stops on any Facebook warning,
 *   after a run's worth, or when they press Stop, and skips chats read in the last day with nothing new.
 *
 * Group chats are left out. Nothing is sent on Facebook.
 */
import { chatCollect } from '../hfos/saves';
import type { Account, ChatsCollected } from '../hfos/messages';
import type { ChatPage, ChatSummary, ReadResult } from '../facebook/types';
import { facebookUrl } from '../facebook/urls';
import type { Answer, BrowseAnswer, BrowseAsk } from '../messages';
import { ask } from './ask';
import { button, counted, h, hfosLink, type Child } from './dom';

const OPEN_KEY = 'hfos.readChats';
const DONE_KEY = 'hfos.chatsRead';
/** Messenger's list of chats. */
const MESSENGER = 'https://www.facebook.com/messages/';
/** The most chats one run reads: press again to go on. */
const RUN_MOST = 150;
/** Between chats, a steady pace like a person's: a few seconds, never the same twice. */
const PACE_MS = [7_000, 14_000] as const;
/** While Facebook draws a chat just opened, and more of the list just scrolled to. */
const OPEN_MS = 3_500;
const SCROLL_MS = 2_500;
/** Scrolls in a row that bring no new chat before it's the end of the list. */
const EMPTY_SCROLLS = 4;
/** A chat read in the last day with the same last message isn't read again. */
const AGAIN_MS = 24 * 3_600_000;
/** The most chats remembered as read. */
const REMEMBERED = 3_000;

interface DoneChat {
  readonly at: number;
  readonly last: string | null;
}

type Run =
  | { readonly state: 'idle' }
  | { readonly state: 'going'; readonly read: number; readonly line: string }
  | { readonly state: 'over'; readonly line: string };

let box: HTMLElement;
let account: Account | null = null;
let readOpen = true;
let run: Run = { state: 'idle' };
let stopped = false;
let lastLine: string | null = null;
let done: Record<string, DoneChat> = {};
/** What was last sent for each chat, so a chat read again with nothing new isn't sent again. */
const sent = new Map<string, string>();

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const paced = () => PACE_MS[0] + Math.random() * (PACE_MS[1] - PACE_MS[0]);

const business = () =>
  account?.signedIn && account.businessId ? { id: account.businessId, web: account.webUrl } : null;

async function remember(threadId: string, last: string | null): Promise<void> {
  done[threadId] = { at: Date.now(), last };
  const ids = Object.keys(done);
  if (ids.length > REMEMBERED)
    for (const id of ids
      .sort((a, b) => done[a]!.at - done[b]!.at)
      .slice(0, ids.length - REMEMBERED))
      delete done[id];
  await chrome.storage.local.set({ [DONE_KEY]: done }).catch(() => undefined);
}

/** Read lately, and the list says nothing newer since. */
function readLately(chat: ChatSummary): boolean {
  const had = done[chat.thread.id];
  return !!had && Date.now() - had.at < AGAIN_MS && had.last === (chat.preview ?? chat.when);
}

/** Sends a chat for the AI. What came of it, in words; null when there was nothing new to send. */
async function send(chat: ChatPage, listed: ChatSummary | null): Promise<string | null> {
  const where = business();
  if (!where) return null;
  const built = chatCollect(chat, new Date(), listed?.when);
  if (!built) return null;
  const key = JSON.stringify(built.messages);
  if (sent.get(built.thread.id) === key) return null;
  const answer = await ask({
    type: 'hfos-collect-chats',
    input: { workspaceId: where.id, platform: 'facebook', chats: [built] },
  });
  if (!answer.ok) throw new Error(answer.problem.message);
  sent.set(built.thread.id, key);
  await remember(built.thread.id, listed ? (listed.preview ?? listed.when) : null);
  return words(built.name, answer.value);
}

function words(name: string, got: ChatsCollected): string {
  if (!got.saved) return `Nothing new with ${name}.`;
  return got.waiting
    ? `Sent the chat with ${name} for the AI to read.`
    : `Kept the chat with ${name}.`;
}

/** After the panel reads a page: a chat open there is read for the AI, when that's on. */
export async function collectOpen(result: ReadResult): Promise<void> {
  if (!readOpen || run.state === 'going' || !result.chat) return;
  const listed = result.chats?.find((c) => c.thread.id === result.chat?.thread?.id) ?? null;
  try {
    const line = await send(result.chat, listed);
    if (line) {
      lastLine = line;
      draw();
    }
  } catch (error) {
    lastLine = `Couldn’t send this chat for the AI: ${error instanceof Error ? error.message : String(error)}`;
    draw();
  }
}

// ---- Going through them ----

async function readTab(tabId: number): Promise<ReadResult> {
  let answer: Answer;
  try {
    answer = (await chrome.tabs.sendMessage(tabId, { type: 'hfos-read' })) as Answer;
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    answer = (await chrome.tabs.sendMessage(tabId, { type: 'hfos-read' })) as Answer;
  }
  if (!answer.ok) throw new Error(answer.error);
  return answer.result;
}

async function browse(tabId: number, message: BrowseAsk): Promise<boolean> {
  try {
    return ((await chrome.tabs.sendMessage(tabId, message)) as BrowseAnswer).ok;
  } catch {
    return false;
  }
}

async function go(tabId: number, url: string): Promise<void> {
  await chrome.tabs.update(tabId, { url });
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    await pause(400);
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') break;
  }
  await pause(OPEN_MS);
}

function set(next: Run): void {
  run = next;
  draw();
}

/** The Facebook tab beside the panel. */
async function messengerTab(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id !== undefined && tab.url && facebookUrl(tab.url) ? tab.id : null;
}

async function goThrough(): Promise<void> {
  if (run.state === 'going') return;
  stopped = false;
  const tabId = await messengerTab();
  if (tabId === null) {
    set({ state: 'over', line: 'Open Facebook in this window first, then press Read my chats.' });
    return;
  }
  let read = 0;
  const line = (text: string) => set({ state: 'going', read, line: text });
  try {
    line('Opening Messenger…');
    const first = await readTab(tabId);
    if (first.kind !== 'chats' && first.kind !== 'chat') await go(tabId, MESSENGER);
    const tried = new Set<string>();
    let emptyScrolls = 0;
    while (!stopped && read < RUN_MOST) {
      const page = await readTab(tabId);
      if (page.warnings.length) {
        set({
          state: 'over',
          line: `Stopped: Facebook says “${page.warnings[0]}”. Leave it for today and try again tomorrow.`,
        });
        return;
      }
      const next = (page.chats ?? []).find((c) => !tried.has(c.thread.id) && !readLately(c));
      if (!next) {
        if (emptyScrolls >= EMPTY_SCROLLS || !(await browse(tabId, { type: 'hfos-scroll-chats' })))
          break;
        emptyScrolls++;
        line(`Loading more chats… ${counted(read, 'chat')} read so far.`);
        await pause(SCROLL_MS);
        continue;
      }
      emptyScrolls = 0;
      tried.add(next.thread.id);
      line(`Reading the chat with ${next.name}… ${counted(read, 'chat')} read so far.`);
      if (!(await browse(tabId, { type: 'hfos-open-chat', threadId: next.thread.id })))
        await go(tabId, next.thread.url);
      else await pause(OPEN_MS);
      let opened = await readTab(tabId);
      if (opened.chat?.thread?.id !== next.thread.id) {
        await pause(OPEN_MS);
        opened = await readTab(tabId);
      }
      if (opened.chat?.thread?.id === next.thread.id) {
        const said = await send(opened.chat, next);
        if (said) read++;
        if (said) lastLine = said;
        else await remember(next.thread.id, next.preview ?? next.when);
      }
      if (!stopped) await pause(paced());
    }
    set({
      state: 'over',
      line: stopped
        ? `Stopped. ${counted(read, 'chat')} sent for the AI to read.`
        : read >= RUN_MOST
          ? `${counted(read, 'chat')} sent for the AI to read. Press Read my chats again to go on.`
          : `Done: ${counted(read, 'chat')} sent for the AI to read. Chats read in the last day were left as they were.`,
    });
  } catch (error) {
    set({
      state: 'over',
      line: `Stopped after ${counted(read, 'chat')}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

// ---- Drawing ----

function draw(): void {
  if (!box) return;
  const where = business();
  box.hidden = !where;
  if (!where) return;
  const going = run.state === 'going';
  const toggle = h('input', { type: 'checkbox' });
  toggle.checked = readOpen;
  toggle.addEventListener('change', () => {
    readOpen = toggle.checked;
    void chrome.storage.local.set({ [OPEN_KEY]: readOpen }).catch(() => undefined);
  });
  const parts: Child[] = [
    h('h2', {}, 'Your chats, for the AI'),
    h(
      'p',
      { class: 'muted' },
      'No need to wait for your Facebook file. Chats read here go to the Chats tab, where the AI sums each up, tags it and spots likely prospects. Group chats are left out, and nothing is sent on Facebook.',
    ),
    h('label', { class: 'auto' }, toggle, ' Read chats I open'),
    h(
      'div',
      { class: 'actions' },
      going
        ? button('Stop', () => {
            stopped = true;
          })
        : button('Read my chats', () => void goThrough(), { primary: true }),
      hfosLink('See them in HandsFreeOS', `${where.web}/app/w/${where.id}/a/outreach?view=chats`),
    ),
    run.state !== 'idle' ? h('p', { class: 'status', role: 'status' }, run.line) : null,
    lastLine && run.state !== 'going' ? h('p', { class: 'muted' }, lastLine) : null,
  ];
  box.replaceChildren(h('div', {}, ...parts));
}

/** Asks who's signed in, and where: it reads for the business picked, and hides with none. */
export async function refreshChats(): Promise<void> {
  const answer = await ask({ type: 'hfos-account' });
  account = answer.ok ? answer.value : null;
  draw();
}

export async function startChats(into: HTMLElement): Promise<void> {
  box = into;
  try {
    const stored = await chrome.storage.local.get([OPEN_KEY, DONE_KEY]);
    readOpen = stored[OPEN_KEY] !== false;
    done = (stored[DONE_KEY] as Record<string, DoneChat> | undefined) ?? {};
  } catch {
    // Read chats I open stays on.
  }
  await refreshChats();
}
