/**
 * The side panel, bare (docs/outreach.md, decisions 43 and 59): the business it works for and how it's doing in the
 * top bar; signing in, with the first run's steps (./account.ts); Next up, what it's doing or does next with today's
 * steps against the limits, Start my day, Stop for today and what the person asked of it from HandsFreeOS
 * (./status.ts); the networks, when one needs Chrome's leave or warned them (./networks.ts); Needs you (./waiting.ts);
 * Done today; and at the foot the settings in a line, who's signed in and a link to HandsFreeOS, where everything else
 * is. "Copy page outline" and "Save page outline" give the shape of the page beside the panel, on a network the
 * extension works on, with names and words hidden, to send to whoever is tuning the readers when the extension gets a
 * page wrong. Opening it, or coming back to it, makes this the person's computer that works (src/hfos/live.ts).
 */
import { outreachPath } from '@hfos/core/addons/outreach/setup';
import type { Account } from '../hfos/messages';
import type { Answer, Ask } from '../messages';
import { KIT_LIST, kitOf, type Kit, type PageRead } from '../networks';
import { isWorking, statesNow, type NetworkStates } from '../networks/on';
import { refreshAccount, startAccount } from './account';
import { ask as askHfos } from './ask';
import { h } from './dom';
import { startNetworks } from './networks';
import { refreshStatus, startStatus } from './status';
import { refreshWaiting, startWaiting } from './waiting';

const accountBox = document.querySelector<HTMLElement>('#account')!;
const nowBox = document.querySelector<HTMLElement>('#now')!;
const networksBox = document.querySelector<HTMLElement>('#networks')!;
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

/**
 * The tab beside the panel, when it's showing a network the extension works on now. Other sites' addresses, and a
 * network's Chrome hasn't let it on, aren't visible to the extension.
 */
async function networkTab(states: NetworkStates | null): Promise<{ id: number; kit: Kit } | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const kit = tab?.url ? kitOf(tab.url) : null;
  if (tab?.id === undefined || !kit || !isWorking(kit, states)) return null;
  return { id: tab.id, kit };
}

async function ask(tabId: number, message: Ask): Promise<Answer<PageRead>> {
  try {
    return (await chrome.tabs.sendMessage(tabId, message)) as Answer<PageRead>;
  } catch {
    // Tabs opened before the extension was installed or updated don't have its reader yet.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return (await chrome.tabs.sendMessage(tabId, message)) as Answer<PageRead>;
  }
}

/** The page's outline, from the network's tab beside the panel. Null, with the reason shown, when it couldn't be made. */
async function outline(): Promise<{ text: string; kind: string; kit: Kit } | null> {
  const states = await statesNow();
  const tab = await networkTab(states);
  if (!tab) {
    const names = KIT_LIST.filter((kit) => isWorking(kit, states)).map((kit) => kit.network.name);
    say(
      `Open the ${names.join(' or ') || 'Facebook'} page it got wrong in this window, then try again.`,
    );
    return null;
  }
  try {
    const answer = await ask(tab.id, { type: 'hfos-outline' });
    if (!answer.ok) throw new Error(answer.error);
    return answer.outline ? { text: answer.outline, kind: answer.result.kind, kit: tab.kit } : null;
  } catch (error) {
    say(
      `Couldn’t make the outline (${error instanceof Error ? error.message : String(error)}). Reload the ${tab.kit.network.name} tab and try again.`,
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
  h('a', { href: url, download: `${made.kit.platform}-${made.kind}-outline-${stamp}.txt` }).click();
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
  startNetworks(networksBox);
  startWaiting(waitingBox);
}

start();
