/**
 * Keeps each network where it should be, in the background (./on.ts): works out from the person's settings and
 * Chrome's leave which networks the extension works on, keeps that in `hfos.networks` for every tab's script and the
 * panel, and has Chrome run a network's script on its site only while it does. Facebook's script is the manifest's
 * own, so this only ever registers and takes away the other networks' scripts (LinkedIn's, Instagram's, Alignable's):
 * `chrome.scripting.registerContentScripts` while both HandsFreeOS says it's on and Chrome allows it (from install
 * since 0.88.0, unless the person took its sites back in Chrome), unregistered as soon as either stops.
 *
 * The background calls it when it wakes, when the settings or who's signed in change, and when the person allows or
 * takes back a site in Chrome (../background.ts). One at a time, so two calls never register the same script. Who's
 * signed in is the place the sign-in keeps (`hfos.place`, kept at each sign-in and gone at sign-out), so it never asks
 * HandsFreeOS.
 */
import { SETTINGS_KEY } from '../hfos/follow';
import { PLACE_KEY } from '../hfos/messages';
import { onAccountsCenter } from './accounts-center/pages';
import { KIT_LIST } from './index';
import type { Kit } from './kit';
import {
  isWorking,
  NETWORKS_KEY,
  networkStates,
  statesNow,
  type NetworksSaid,
  type NetworkStates,
} from './on';

/** A network's script, as Chrome's registered scripts know it. */
export const scriptId = (kit: Pick<Kit, 'platform'>) => `hfos-${kit.platform}`;

const isSaid = (value: unknown): value is NetworksSaid => {
  const said = value as Partial<NetworksSaid> | null;
  return (
    typeof said === 'object' &&
    said !== null &&
    typeof said.userId === 'string' &&
    typeof said.settings === 'object' &&
    said.settings !== null &&
    typeof said.rules === 'object' &&
    said.rules !== null
  );
};

/**
 * Whether Chrome lets the extension on all of a network's own sites. Its Accounts Center (Instagram's, from 0.93.0)
 * isn't one of them: someone who keeps the extension to some sites in Chrome may not have let it on there, and only
 * Put these in's username and name need it, which say so themselves (../jobs/accounts-center.ts `centerAllowed`). Its
 * script is still registered there, and runs once Chrome lets it.
 */
async function granted(kit: Kit): Promise<boolean> {
  const own = kit.hosts.filter((host) => !onAccountsCenter(host.replace(/\*$/, '')));
  try {
    return await chrome.permissions.contains({ origins: own });
  } catch {
    return false;
  }
}

/** Whether a registered script runs on exactly the network's sites. */
const sameSites = (matches: readonly string[] | undefined, hosts: readonly string[]): boolean =>
  JSON.stringify([...(matches ?? [])].sort()) === JSON.stringify([...hosts].sort());

/**
 * Runs a network's script on its site, or stops it, as it should be. One registered by an older build on fewer sites
 * (Instagram's before its Accounts Center joined them, 0.93.0) is moved onto the sites the kit has now.
 */
async function place(kit: Kit, states: NetworkStates): Promise<void> {
  const id = scriptId(kit);
  const [script] = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  const wanted = isWorking(kit, states);
  const its: chrome.scripting.RegisteredContentScript = {
    id,
    matches: [...kit.hosts],
    js: ['content.js'],
    runAt: 'document_idle',
    allFrames: false,
    persistAcrossSessions: true,
  };
  if (wanted && !script) await chrome.scripting.registerContentScripts([its]);
  else if (wanted && script && !sameSites(script.matches, kit.hosts))
    await chrome.scripting.updateContentScripts([its]);
  else if (!wanted && script) await chrome.scripting.unregisterContentScripts({ ids: [id] });
}

/** Who's signed in, as the sign-in keeps it: null when nobody is. */
const userOf = (place: unknown): string | null => {
  const userId = (place as { userId?: unknown } | null)?.userId;
  return typeof userId === 'string' ? userId : null;
};

async function sync(): Promise<NetworkStates> {
  let kept: Record<string, unknown> = {};
  try {
    kept = await chrome.storage.local.get([SETTINGS_KEY, PLACE_KEY]);
  } catch {
    // Read as nobody signed in, and nothing loaded yet.
  }
  const said = kept[SETTINGS_KEY];
  const asked: Partial<Record<Kit['platform'], boolean>> = {};
  for (const kit of KIT_LIST) if (kit.registered) asked[kit.platform] = await granted(kit);
  const states = networkStates(
    KIT_LIST,
    isSaid(said) ? said : null,
    userOf(kept[PLACE_KEY]),
    asked,
  );
  if (JSON.stringify(await statesNow()) !== JSON.stringify(states))
    await chrome.storage.local.set({ [NETWORKS_KEY]: states });
  for (const kit of KIT_LIST) {
    if (!kit.registered) continue;
    try {
      await place(kit, states);
    } catch (error) {
      console.error(`HandsFreeOS Social couldn’t set up ${kit.network.name}’s script`, error);
    }
  }
  return states;
}

let turn: Promise<unknown> = Promise.resolve();

/** Works out the networks again and puts their scripts where they should be. Never throws. */
export function syncNetworks(): Promise<NetworkStates | null> {
  const next = turn.then(sync, sync).catch((error: unknown) => {
    console.error('HandsFreeOS Social couldn’t work out which networks are on', error);
    return null;
  });
  turn = next;
  return next;
}
