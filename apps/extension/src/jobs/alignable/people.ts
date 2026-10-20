/**
 * Saving the person's Alignable lists, asked from the Friends tab in HandsFreeOS on Alignable (partners stage 6c,
 * part 4; the Instagram and Alignable plan's "Asks"):
 *
 * - **Save my connections** (`friends`): opens My Network in a window of its own, switches it from Ally's picks to all
 *   their connections, scrolls it slowly to its end, and saves everyone as Alignable's friends list, which the Friends
 *   tab and the checks work from. Each is a business, by Alignable's id for it, with its owner's name.
 * - **Check my connection requests** (`requests`): opens My Network's Requests and saves each request they've got, as
 *   Facebook's friend requests are.
 *
 * Nothing is pressed on Alignable but its own tab of all connections and Show more at the foot of a list. It stops on
 * any Alignable warning.
 */
import type { FriendList } from '@hfos/core/addons/outreach/friends';
import { alignableItem, alignableListSave, type AlignableListed } from '../../hfos/saves';
import { counted } from '../../words';
import { pause, valueOf, type Job, type JobEnd } from '../job';
import { ended, gather, MY_NETWORK, REQUESTS, SIGNED_IN } from './read';

/** Connections are read to the end, up to this many screens. */
export const CONNECTION_SCROLLS = 150;
/** Requests, up to this many screens. */
export const REQUEST_SCROLLS = 30;
/** For My Network to draw all their connections once its tab is pressed. */
const TAB_MS = 2_500;

const keyOf = (person: AlignableListed) =>
  (person.profile.id ?? person.profile.username ?? person.profile.url).toLowerCase();

/** Saves a list, in parts: how many were new. */
async function saveList(
  job: Job,
  people: readonly AlignableListed[],
  list: FriendList,
): Promise<{ added: number } | JobEnd> {
  const built = alignableListSave(people, list, job.businessId);
  if (!built.ok) return { line: built.why, warned: false, failed: true };
  let added = 0;
  for (const input of built.input)
    added += valueOf(await job.hfos({ type: 'hfos-save-friends', input })).added;
  return { added };
}

const newOnes = (added: number) => (added ? `, ${added.toLocaleString()} new` : '');

/** Opens the person's connections, all of them, reads them to the end, and saves them. */
export async function saveConnections(job: Job): Promise<JobEnd> {
  job.progress('Opening your connections…');
  await job.tab.open(MY_NETWORK);
  // My Network opens on Ally's picks, a few of them: its tab of them all.
  if ((await job.tab.ask({ type: 'hfos-show-all' })).ok) await pause(TAB_MS);
  const got = await gather(
    job,
    CONNECTION_SCROLLS,
    (page) => page.found.businesses.filter((b) => b.message || !b.connect),
    keyOf,
    (count) => `Reading your connections… ${counted(count, 'connection')} so far.`,
  );
  if (ended(got)) return got;
  if (!got.items.length)
    return { line: `Alignable showed no connections. ${SIGNED_IN}`, warned: false, failed: true };
  const saved = await saveList(job, got.items, 'friends');
  if (ended(saved)) return saved;
  const whole = got.whole && !job.stopped();
  const tail = whole ? '' : ' It stopped before the end of the list: ask again for the rest.';
  return {
    line: `Saved ${counted(got.items.length, 'connection')}${newOnes(saved.added)}.${tail}`,
    warned: false,
    whole,
  };
}

/** Opens the requests the person's got, and saves them. */
export async function checkRequests(job: Job): Promise<JobEnd> {
  job.progress('Opening your connection requests…');
  await job.tab.open(REQUESTS);
  const got = await gather(
    job,
    REQUEST_SCROLLS,
    (page) => page.found.requests,
    keyOf,
    (count) => `Reading your connection requests… ${counted(count, 'request')} so far.`,
  );
  if (ended(got)) return got;
  if (!got.items.length)
    return { line: 'No connection requests waiting.', warned: false, whole: got.whole };
  const saved = await saveList(job, got.items, 'requests');
  if (ended(saved)) return saved;
  return {
    line: `Saved ${counted(got.items.length, alignableItem('requests'))} you’ve got${newOnes(saved.added)}.`,
    warned: false,
    whole: got.whole && !job.stopped(),
  };
}
