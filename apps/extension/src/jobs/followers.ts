/**
 * **Your followers** on Facebook (docs/outreach.md decision 113; `followers`, once a week while the extension works on
 * its own there, before the day's checks). The owner's pick: "Once a week it reads your followers, the AI checks each
 * one like a friend, and the fits go on Today for a friend request."
 *
 * HandsFreeOS says whether this week's read is due (`outreach.followers.next`). The person's own followers list is
 * read a screen at a time, up to 300, and saved to HandsFreeOS as theirs (`outreach.followers.save`): those who aren't
 * their friends are checked by the AI like friends, inside the day's checks, and the good fits go on Today for a
 * friend request. Nothing is pressed on Facebook. It stops on any Facebook warning; stopped part-way, what it read is
 * kept and the list is read again next time.
 *
 * The followers list's address is a guess till the owner's next Check Facebook outlines it: a list that showed nobody
 * is noted with its outline so it can be tuned.
 */
import { FOLLOWERS_READ_MOST } from '@hfos/core/addons/outreach/followers';
import { followersSave } from '../hfos/saves';
import { FACEBOOK } from '../networks/facebook/urls';
import { counted } from '../words';
import { valueOf, type Job, type JobEnd } from './job';
import { ended, gather } from './people';

/** The person's own followers: Facebook sends /me on to their own profile, as it does /me/friends. */
export const YOUR_FOLLOWERS = `${FACEBOOK}/me/followers`;
/** Screens of the list it loads: enough for the most one read takes. */
export const FOLLOWERS_SCROLLS = 20;

/** This week's read of the person's followers, if it's due: saved for the AI to check those who aren't friends. */
export async function readFollowers(job: Job): Promise<JobEnd> {
  job.progress('Asking HandsFreeOS whether this week’s followers are read…');
  const next = valueOf(
    await job.hfos({
      type: 'hfos-followers-next',
      input: { workspaceId: job.businessId, platform: 'facebook' },
    }),
  );
  if (!next.due)
    return {
      line: 'Your followers were read this week. They’re read again a week after the last time.',
      warned: false,
    };
  job.progress('Opening your followers…');
  await job.tab.open(YOUR_FOLLOWERS);
  const got = await gather(
    job,
    FOLLOWERS_SCROLLS,
    // This job opened their own list: any followers tab it lands on is theirs.
    (page) => (page.kind === 'followers' ? (page.people ?? []) : []),
    (count) => `Reading your followers… ${counted(count, 'follower')} so far.`,
  );
  if (ended(got)) return got;
  const people = got.people.slice(0, FOLLOWERS_READ_MOST);
  const stopped = job.stopped();
  if (stopped && !people.length)
    return {
      line: 'Stopped before your followers were read. They’re read next time.',
      warned: false,
    };
  if (!people.length) await job.report?.({ note: 'Facebook showed no followers.', outline: true });
  let added = 0;
  let saved = 0;
  for (const input of followersSave(people, job.businessId, !stopped)) {
    const done = valueOf(await job.hfos({ type: 'hfos-followers-save', input }));
    added += done.added;
    saved += done.saved;
  }
  if (!saved)
    return {
      line: 'Facebook showed no followers. They’re read again next week.',
      warned: false,
    };
  const parts = [
    `${stopped ? 'Stopped. ' : ''}Read ${counted(saved, 'follower')}: ${added.toLocaleString()} new who aren’t your friends.`,
    added
      ? 'The AI checks them like friends, and the good fits come onto Today for a friend request.'
      : null,
    stopped ? 'The rest are read next time.' : null,
  ];
  return { line: parts.filter(Boolean).join(' '), warned: false };
}
