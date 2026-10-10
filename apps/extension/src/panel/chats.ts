/**
 * Your chats, for the AI, in the side panel (docs/outreach.md, decision 2's "Collect from Facebook"): without
 * Facebook's file, the extension reads the person's one-to-one chats in Messenger and sends each one's latest few
 * messages to HandsFreeOS, where the AI reads them for the Chats tab, as it does the file's (decision 3).
 *
 * - **Read chats I open**: each chat the person opens with the panel open is read for the AI. On by default; set in HandsFreeOS.
 * - **Read my chats**: it goes through their chats for them in the Messenger tab, one at a time from the list beside
 *   it, at a steady pace, scrolling the list for more (src/jobs/chats.ts). It stops on any Facebook warning, after a
 *   run's worth, or when they press Stop, and skips chats read in the last day with nothing new. While it works on its
 *   own, it does this once a day by itself too (src/auto/daily.ts).
 *
 * Group chats are left out. Nothing is sent on Facebook.
 */
import { READ_CHATS_KEY } from '../hfos/follow';
import type { Account } from '../hfos/messages';
import type { ReadResult } from '../facebook/types';
import { facebookUrl } from '../facebook/urls';
import { chatMemory, readChats, sendChat } from '../jobs/chats';
import type { Job, JobTab } from '../jobs/job';
import type { Answer, Ask, BrowseAnswer, BrowseAsk } from '../messages';
import { ask } from './ask';
import { button, h, hfosLink, type Child } from './dom';
import { noteWarnings, warnedToday } from './warnings';

const OPEN_KEY = READ_CHATS_KEY;
/** The most chats one run reads: press again to go on. */
const RUN_MOST = 150;
/** While Facebook draws a page just opened. */
const OPEN_MS = 3_500;

type Run =
  | { readonly state: 'idle' }
  | { readonly state: 'going'; readonly line: string }
  | { readonly state: 'over'; readonly line: string };

let box: HTMLElement;
let account: Account | null = null;
let readOpen = true;
let run: Run = { state: 'idle' };
let stopped = false;
let lastLine: string | null = null;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const business = () =>
  account?.signedIn && account.businessId ? { id: account.businessId, web: account.webUrl } : null;

/** After the panel reads a page: a chat open there is read for the AI, when that's on. */
export async function collectOpen(result: ReadResult): Promise<void> {
  if (!readOpen || run.state === 'going' || !result.chat) return;
  const where = business();
  if (!where) return;
  const listed = result.chats?.find((c) => c.thread.id === result.chat?.thread?.id) ?? null;
  try {
    const line = await sendChat(ask, where.id, chatMemory, result.chat, listed);
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

/** The Facebook tab beside the panel, which Read my chats works in: the person's own, so they see it go. */
function besideTab(tabId: number): JobTab {
  async function open(url: string): Promise<void> {
    await chrome.tabs.update(tabId, { url });
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      await pause(400);
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') break;
    }
    await pause(OPEN_MS);
  }
  async function tell(message: Ask): Promise<Answer>;
  async function tell(message: BrowseAsk): Promise<BrowseAnswer | Answer>;
  async function tell(message: Ask | BrowseAsk): Promise<BrowseAnswer | Answer> {
    try {
      return (await chrome.tabs.sendMessage(tabId, message)) as BrowseAnswer | Answer;
    } catch {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
        return (await chrome.tabs.sendMessage(tabId, message)) as BrowseAnswer | Answer;
      } catch {
        return { ok: false, error: 'Facebook took the tab somewhere else.' };
      }
    }
  }
  return { open, ask: tell };
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
  const where = business();
  if (run.state === 'going' || !where) return;
  stopped = false;
  const warned = await warnedToday();
  if (warned) {
    set({
      state: 'over',
      line: `Facebook warned you today (“${warned[0]}”), so the extension stops until tomorrow.`,
    });
    return;
  }
  const tabId = await messengerTab();
  if (tabId === null) {
    set({ state: 'over', line: 'Open Facebook in this window first, then press Read my chats.' });
    return;
  }
  const job: Job = {
    tab: besideTab(tabId),
    hfos: ask,
    businessId: where.id,
    stopped: () => stopped,
    progress: (line) => set({ state: 'going', line }),
    warn: noteWarnings,
  };
  try {
    const end = await readChats(job, {
      most: RUN_MOST,
      memory: chatMemory,
      said: (line) => {
        lastLine = line;
      },
      again: 'Press Read my chats again to go on.',
    });
    set({ state: 'over', line: end.line });
  } catch (error) {
    set({
      state: 'over',
      line: `Stopped: ${error instanceof Error ? error.message : String(error)}`,
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
  const parts: Child[] = [
    h('h2', {}, 'Your chats, for the AI'),
    h(
      'p',
      { class: 'muted' },
      'No need to wait for your Facebook file. Chats read here go to the Chats tab, where the AI sums each up, tags it and spots likely prospects. Group chats are left out, and nothing is sent on Facebook.',
    ),
    h(
      'p',
      { class: 'muted' },
      readOpen
        ? 'Chats you open are read too. Change that in HandsFreeOS.'
        : 'Chats you open aren’t read. Change that in HandsFreeOS.',
    ),
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
    const stored = await chrome.storage.local.get(OPEN_KEY);
    readOpen = stored[OPEN_KEY] !== false;
  } catch {
    // Read chats I open stays on.
  }
  // Set in HandsFreeOS: ../hfos/follow.ts writes it here.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[OPEN_KEY]) return;
    readOpen = changes[OPEN_KEY].newValue !== false;
    draw();
  });
  await refreshChats();
}
