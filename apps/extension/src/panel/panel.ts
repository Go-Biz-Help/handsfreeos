/**
 * The side panel, bare (docs/outreach.md, decisions 43 and 59): the business it works for and how it's doing in the
 * top bar; signing in, with the first run's steps (./account.ts); Next up, what it's doing or does next with today's
 * steps against the limits, Start my day, Stop for today and what the person asked of it from HandsFreeOS
 * (./status.ts); Needs you (./waiting.ts); Done today; and at the foot the settings in a line, who's signed in and a
 * link to HandsFreeOS, where everything else is. "Copy page
 * outline" and "Save page outline" give the Facebook page's shape with names and words hidden, to send to whoever is
 * tuning the readers when the extension gets a page wrong. Opening it, or coming back to it, makes this the person's
 * computer that works (src/hfos/live.ts).
 */
import { outreachPath } from '@hfos/core/addons/outreach/setup';
import type { PageKind } from '../facebook/types';
import { facebookUrl } from '../facebook/urls';
import type { Account } from '../hfos/messages';
import type { Answer, Ask } from '../messages';
import { refreshAccount, startAccount } from './account';
import { ask as askHfos } from './ask';
import { h } from './dom';
import { refreshStatus, startStatus } from './status';
import { refreshWaiting, startWaiting } from './waiting';

const accountBox = document.querySelector<HTMLElement>('#account')!;
const nowBox = document.querySelector<HTMLElement>('#now')!;
const waitingBox = document.querySelector<HTMLElement>('#waiting')!;
const doneBox = document.querySelector<HTMLElement>('#done')!;
const whereBox = document.querySelector<HTMLElement>('#where')!;
const stateChip = document.querySelector<HTMLElement>('#state')!;
const settingsLine = document.querySelector<HTMLElement>('#settings-line')!;
const whoBox = document.querySelector<HTMLElement>('#who')!;
const openLink = document.querySelector<HTMLAnchorElement>('#open-hfos')!;
const outlineSaid = document.querySelector<HTMLElement>('#outline-said')!;
const copyButton = document.querySelector<HTMLButtonElement>('#copy-outline')!;
const saveButton = document.querySelector<HTMLButtonElement>('#save-outline')!;

function say(text: string): void {
  outlineSaid.textContent = text;
}

/** The business it works for, in the top bar, and the foot's link to its Social Outreach: hidden while signed out. */
function linkTo(account: Account | null): void {
  const businessId = account?.signedIn ? account.businessId : null;
  openLink.hidden = !businessId;
  if (account && businessId)
    openLink.href = `${account.webUrl}${outreachPath(businessId, 'today')}`;
  const name = account?.signedIn
    ? account.businesses.find((b) => b.id === account.businessId)?.name
    : undefined;
  whereBox.hidden = !name;
  whereBox.textContent = name ?? '';
}

/** The tab beside the panel, when it's showing Facebook. Other sites' addresses aren't visible to the extension. */
async function facebookTab(): Promise<{ id: number; url: string } | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined || !tab.url || !facebookUrl(tab.url)) return null;
  return { id: tab.id, url: tab.url };
}

async function ask(tabId: number, message: Ask): Promise<Answer> {
  try {
    return (await chrome.tabs.sendMessage(tabId, message)) as Answer;
  } catch {
    // Tabs opened before the extension was installed or updated don't have its reader yet.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return (await chrome.tabs.sendMessage(tabId, message)) as Answer;
  }
}

/** The page's outline, from the Facebook tab beside the panel. Null, with the reason shown, when it couldn't be made. */
async function outline(): Promise<{ text: string; kind: PageKind } | null> {
  const tab = await facebookTab();
  if (!tab) {
    say('Open the Facebook page it got wrong in this window, then try again.');
    return null;
  }
  try {
    const answer = await ask(tab.id, { type: 'hfos-outline' });
    if (!answer.ok) throw new Error(answer.error);
    return answer.outline ? { text: answer.outline, kind: answer.result.kind } : null;
  } catch (error) {
    say(
      `Couldn’t make the outline (${error instanceof Error ? error.message : String(error)}). Reload the Facebook tab and try again.`,
    );
    return null;
  }
}

copyButton.addEventListener('click', async () => {
  const made = await outline();
  if (!made) return;
  try {
    await navigator.clipboard.writeText(made.text);
    say('Copied the page outline. Look it over, then send it with a note about what went wrong.');
  } catch {
    say('Couldn’t copy. Use Save page outline instead.');
  }
});

saveButton.addEventListener('click', async () => {
  const made = await outline();
  if (!made) return;
  const url = URL.createObjectURL(new Blob([made.text], { type: 'text/plain' }));
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  h('a', { href: url, download: `facebook-${made.kind}-outline-${stamp}.txt` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  say(
    'Saved the page outline to your downloads. Look it over, then send it with a note about what went wrong.',
  );
});

/** The person is here: this computer becomes the one that works, and what's shown is asked for again. */
function here(): void {
  if (document.visibilityState !== 'visible') return;
  void askHfos({ type: 'hfos-here' });
  void refreshAccount();
  void refreshStatus();
}
document.addEventListener('visibilitychange', here);

function start(): void {
  void askHfos({ type: 'hfos-here' });
  void startAccount(
    accountBox,
    (account) => {
      linkTo(account);
      void refreshWaiting();
      void refreshStatus();
    },
    whoBox,
  );
  startStatus(nowBox, { done: doneBox, chip: stateChip, settingsLine });
  startWaiting(waitingBox);
}

start();
