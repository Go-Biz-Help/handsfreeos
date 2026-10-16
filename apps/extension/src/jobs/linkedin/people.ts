/**
 * Saving the person's LinkedIn lists, asked from the Friends tab in HandsFreeOS on LinkedIn (docs/outreach.md,
 * decision 43; HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "LinkedIn, part by part", 4):
 *
 * - **Save my connections** (`friends`): opens My Network's connections in a window of its own, scrolls it slowly to
 *   its end, and saves everyone as LinkedIn's friends list, which the Friends tab and the checks work from.
 * - **Check my invitations** (`requests`): opens Manage invitations, the ones they've got and then the ones they've
 *   sent, and saves each as Facebook's friend requests are, both ways; Withdraw old invitations works from the sent.
 *
 * Nothing is pressed on LinkedIn but its own Show more results at the foot of a list that stopped loading
 * (src/networks/linkedin/browse.ts). It stops on any LinkedIn warning.
 */
import type { FriendList } from '@hfos/core/addons/outreach/friends';
import { linkedInItem, linkedInListSave } from '../../hfos/saves';
import type { Invitation, Person } from '../../networks/linkedin/types';
import { profileKey } from '../../networks/linkedin/urls';
import { counted } from '../../words';
import { pause, paced, valueOf, type Job, type JobEnd } from '../job';
import {
  CONNECTIONS,
  ended,
  gather,
  INVITATIONS_RECEIVED,
  INVITATIONS_SENT,
  SIGNED_IN,
} from './read';

/** Connections are read to the end, up to this many screens: 30,000 at most, LinkedIn's cap. */
export const CONNECTION_SCROLLS = 150;
/** Invitations each way, up to this many screens. */
export const INVITATION_SCROLLS = 30;
/** Between the invitations got and the ones sent. */
const BETWEEN_MS = [8_000, 15_000] as const;

const keyOf = (person: Person) => profileKey(person.profile);

/** Saves a list, in parts: how many were new. */
async function saveList(
  job: Job,
  people: readonly Person[],
  list: FriendList,
): Promise<{ added: number } | JobEnd> {
  const built = linkedInListSave(people, list, job.businessId);
  if (!built.ok) return { line: built.why, warned: false, failed: true };
  let added = 0;
  for (const input of built.input)
    added += valueOf(await job.hfos({ type: 'hfos-save-friends', input })).added;
  return { added };
}

const newOnes = (added: number) => (added ? `, ${added.toLocaleString()} new` : '');

/** Opens the person's connections, reads them to the end, and saves them. */
export async function saveConnections(job: Job): Promise<JobEnd> {
  job.progress('Opening your connections…');
  await job.tab.open(CONNECTIONS);
  const got = await gather(
    job,
    CONNECTION_SCROLLS,
    (page) => (page.kind === 'connections' ? (page.people ?? []) : []),
    keyOf,
    (count) => `Reading your connections… ${counted(count, 'connection')} so far.`,
  );
  if (ended(got)) return got;
  if (!got.items.length)
    return { line: `LinkedIn showed no connections. ${SIGNED_IN}`, warned: false, failed: true };
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

/** One way's invitations: opened, read, and saved. */
async function invitations(
  job: Job,
  url: string,
  direction: Invitation['direction'],
  scrolls = INVITATION_SCROLLS,
): Promise<{ count: number; added: number; whole: boolean } | JobEnd> {
  const list: FriendList = direction === 'received' ? 'requests' : 'sent';
  const which = direction === 'received' ? 'you’ve got' : 'you’ve sent';
  job.progress(`Opening the invitations ${which}…`);
  await job.tab.open(url);
  const got = await gather(
    job,
    scrolls,
    (page) =>
      page.kind === 'invitations'
        ? (page.invitations ?? []).filter((i) => i.direction === direction)
        : [],
    keyOf,
    (count) => `Reading the invitations ${which}… ${counted(count, linkedInItem(list))} so far.`,
  );
  if (ended(got)) return got;
  if (!got.items.length) return { count: 0, added: 0, whole: got.whole };
  const saved = await saveList(job, got.items, list);
  if (ended(saved)) return saved;
  return { count: got.items.length, added: saved.added, whole: got.whole };
}

/**
 * One way's invitations, saved to the end of the list, before LinkedIn's first day and as it refreshes them each
 * morning (src/auto/lists.ts): `whole` says it got to the end.
 */
export async function saveInvitations(
  job: Job,
  direction: Invitation['direction'],
): Promise<JobEnd> {
  const got = await invitations(
    job,
    direction === 'received' ? INVITATIONS_RECEIVED : INVITATIONS_SENT,
    direction,
    CONNECTION_SCROLLS,
  );
  if (ended(got)) return got;
  const whole = got.whole && !job.stopped();
  const which = direction === 'received' ? 'you’ve got' : 'you’ve sent';
  return {
    line: got.count
      ? `Saved ${counted(got.count, 'invitation')} ${which}${newOnes(got.added)}.`
      : `No invitations ${which} waiting.`,
    warned: false,
    whole,
  };
}

/** Opens the invitations the person's got and saves them; then the ones they've sent. */
export async function checkInvitations(job: Job): Promise<JobEnd> {
  const got = await invitations(job, INVITATIONS_RECEIVED, 'received');
  if (ended(got)) return got;
  if (job.stopped())
    return { line: `Stopped. Saved ${counted(got.count, 'invitation')}.`, warned: false };
  await pause(paced(BETWEEN_MS));
  const sent = await invitations(job, INVITATIONS_SENT, 'sent');
  if (ended(sent)) return sent;
  const whole = got.whole && sent.whole && !job.stopped();
  if (!got.count && !sent.count)
    return { line: 'No invitations waiting either way.', warned: false, whole };
  return {
    line: `Saved ${counted(got.count, 'invitation')} you’ve got and ${counted(sent.count, 'invitation')} you’ve sent${newOnes(got.added + sent.added)}.`,
    warned: false,
    whole,
  };
}
