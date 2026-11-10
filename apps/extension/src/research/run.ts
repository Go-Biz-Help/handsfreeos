/**
 * AI Social Media Content Creator's reading computer (docs/socialcontent.md, "The reading computer"; decisions 1 and
 * 12): the extension on the computer an owner or admin picked in its Settings does the add-on's work queue, one thing
 * at a time, oldest first, in a window of its own beside the person's (./tab.ts).
 *
 * Its alarm wakes it each minute. It asks HandsFreeOS, for each business where the add-on is on and the person may use
 * it, for the next thing to read on the networks this build reads (`RESEARCH_NETWORKS`) that still have room today
 * and no warning (./read.ts). Only the reading computer's person gets any: the rest are told so
 * (`socialcontent_not_reader`), and asked again a few minutes later, so picking a computer in Settings starts it soon.
 * It does what it got (find creators, a profile, posts: each network's reads, ./instagram-read.ts for Instagram's answers, ./page-read.ts
 * for Facebook's and LinkedIn's pages), then says how it
 * ended. A read that couldn't go on stops that network for a while (signed out, a reader that can't read the page) or
 * for the day (a warning, the day's room used).
 *
 * Before any reading, each minute, it puts up the business's OK'd posts whose time has come (part 9, ./posting.ts).
 *
 * It never does Social Outreach's work, and Social Outreach never does its: they share only the extension, the
 * network's pace and its day's warnings (decision 1).
 */
import type { ContentNetwork } from '@hfos/core/addons/socialcontent/networks';
import { canSignIn } from '../hfos/config';
import { token } from '../hfos/session';
import { KITS } from '../networks';
import {
  researchBusinesses,
  ResearchRefused,
  workFinish,
  workNext,
  type ResearchWork,
} from './hfos';
import { INSTAGRAM_READS_BY_KIND } from './instagram-read';
import { PAGE_READS_BY_KIND } from './page-read';
import { postTurn } from './posting';
import { roomOn, searchRoomOn, type ReadCtx, type ReadEnd } from './read';
import { ResearchTab } from './tab';

export const RESEARCH_ALARM = 'hfos-research';
/** The networks this build reads, and each one's reads. */
export const RESEARCH_NETWORKS = [
  'instagram',
  'facebook',
  'linkedin',
] as const satisfies readonly ContentNetwork[];
type ResearchNetwork = (typeof RESEARCH_NETWORKS)[number];
const READS: Readonly<
  Record<
    ResearchNetwork,
    Readonly<Record<ResearchWork['kind'], (ctx: ReadCtx) => Promise<ReadEnd>>>
  >
> = {
  instagram: INSTAGRAM_READS_BY_KIND,
  facebook: PAGE_READS_BY_KIND,
  linkedin: PAGE_READS_BY_KIND,
};

/** How long the businesses this person reads for are kept before HandsFreeOS is asked again. */
const BUSINESSES_FOR_MS = 5 * 60_000;
/** After HandsFreeOS says this computer doesn't read for a business, it asks again after this. */
const NOT_READER_FOR_MS = 3 * 60_000;
/** A network whose reads stopped (signed out, a page it can't read) rests this long. */
const REST_MS = 30 * 60_000;

let running = false;
let businesses: { at: number; list: { id: string; name: string }[] } | null = null;
const notReaderUntil = new Map<string, number>();
const restingUntil = new Map<ContentNetwork, number>();
const tabs = new Map<ResearchNetwork, ResearchTab>();

/** The reading tabs open now, so the background never takes them for the person's own. */
export const researchTabIds = (): number[] =>
  [...tabs.values()].map((t) => t.tabId).filter((id): id is number => id !== null);

/** Sets the alarm, when Chrome started or the extension was updated. */
export async function wakeResearch(): Promise<void> {
  try {
    if (!(await chrome.alarms.get(RESEARCH_ALARM)))
      await chrome.alarms.create(RESEARCH_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
  } catch {
    // The next wake sets it.
  }
}

/** The networks it may read on now: room left today, no warning, and not resting. */
async function readsNow(): Promise<ResearchNetwork[]> {
  const now = Date.now();
  const open: ResearchNetwork[] = [];
  for (const network of RESEARCH_NETWORKS)
    if ((restingUntil.get(network) ?? 0) <= now && (await roomOn(network))) open.push(network);
  return open;
}

async function businessesNow(): Promise<{ id: string; name: string }[]> {
  if (businesses && Date.now() - businesses.at < BUSINESSES_FOR_MS) return businesses.list;
  const list = await researchBusinesses();
  businesses = { at: Date.now(), list };
  return list;
}

/** One wake: the next thing to read, done. Never two at once. */
export async function researchTick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    if (!canSignIn() || !(await token().catch(() => null))) return;
    const did = await next();
    // Nothing waits: the reading window closes till there's something.
    if (!did) for (const tab of tabs.values()) await tab.close();
  } catch (error) {
    console.warn('HandsFreeOS Social couldn’t read for AI Social Media Content Creator', error);
  } finally {
    running = false;
  }
}

/** The window for a network's work, opened once and kept. */
function tabFor(network: ResearchNetwork): ResearchTab {
  let tab = tabs.get(network);
  if (!tab) {
    tab = new ResearchTab(KITS[network]);
    tabs.set(network, tab);
  }
  return tab;
}

/**
 * Takes and does the next thing waiting in any business: whether there was one. A post due to go up (part 9,
 * ./posting.ts) comes before any reading, whatever room reading has left today.
 */
async function next(): Promise<boolean> {
  const version = chrome.runtime.getManifest().version;
  for (const business of await businessesNow()) {
    if ((notReaderUntil.get(business.id) ?? 0) > Date.now()) continue;
    if (await postTurn(business.id, tabFor, version)) return true;
  }
  const reads = await readsNow();
  if (!reads.length) return false;
  // Searches for new creators only where their share of the day is left: the rest is for ticked creators (./read.ts).
  const searchOn: ResearchNetwork[] = [];
  for (const network of reads) if (await searchRoomOn(network)) searchOn.push(network);
  for (const business of await businessesNow()) {
    if ((notReaderUntil.get(business.id) ?? 0) > Date.now()) continue;
    let work: ResearchWork | null;
    try {
      work = (await workNext(business.id, reads, searchOn)).work;
    } catch (error) {
      if (error instanceof ResearchRefused && error.rule === 'socialcontent_not_reader')
        notReaderUntil.set(business.id, Date.now() + NOT_READER_FOR_MS);
      // Off since, or no longer theirs: the list is asked for again.
      else if (error instanceof ResearchRefused && error.status !== null) businesses = null;
      continue;
    }
    if (!work || !(RESEARCH_NETWORKS as readonly string[]).includes(work.network)) continue;
    await doWork(business.id, work);
    return true;
  }
  return false;
}

/** Does one thing, and says how it ended. */
async function doWork(businessId: string, work: ResearchWork): Promise<void> {
  const network = work.network as ResearchNetwork;
  const tab = tabFor(network);
  let end: ReadEnd;
  try {
    end = await READS[network][work.kind]({ businessId, work, tab });
  } catch (error) {
    if (error instanceof ResearchRefused) {
      // Stopped from HandsFreeOS: nothing more to say. Out of reach: it's taken again on a later wake.
      if (error.rule === 'socialcontent_work_gone' || error.status === null) return;
      end = { failure: error.message };
    } else {
      console.warn('HandsFreeOS Social couldn’t read', work.kind, error);
      end = { failure: 'Something went wrong while reading. It tries again next time.' };
    }
  }
  if (end.halt === 'while') restingUntil.set(network, Date.now() + REST_MS);
  try {
    await workFinish(businessId, work.id, end.failure);
  } catch {
    // Stopped meanwhile, or out of reach: HandsFreeOS puts it back to waiting after a while.
  }
}
