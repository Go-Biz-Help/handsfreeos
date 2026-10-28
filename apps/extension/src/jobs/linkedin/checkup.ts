/**
 * Check LinkedIn (`checkup`, docs/outreach.md decisions 74 and 76): one press when something on LinkedIn isn't working.
 * It opens the person's main LinkedIn pages one at a time and reads each as the other jobs do (their profile, their
 * feed, their connections, a people search, a posts search, their messages, Catch up and one connection's profile), and on the
 * way tries each of the extension's steps up to its last press (src/networks/linkedin/tries.ts): putting the headline
 * in, posting, commenting, connecting, messaging, liking, withdrawing and the data file; and on someone else's post on
 * its own page (decision 92), liking it there and the box of who reacted, opened from its reactions count and closed
 * again. Nothing is ever saved, posted, sent, liked, connected or withdrawn. Each page and each step is noted in
 * HandsFreeOS with what it found
 * (../report.ts), the outline kept when a step doesn't work, so everything that doesn't is found in one go; the end's
 * line names the steps that don't, and those it found nothing to try on. Its window stays in front while it works,
 * as Chrome draws nothing in a window hidden behind another (put another over it, and it comes back in front for its
 * next page or step), and then the person's own comes back. It stops on any
 * LinkedIn warning.
 */
import type { LinkedInRead } from '../../networks';
import { DATA_PAGE } from '../../networks/linkedin/data';
import type { Post } from '../../networks/linkedin/types';
import { sameMember } from '../../networks/linkedin/urls';
import { Checkup, isEnd, SEARCH_WORDS, wholeProfile } from '../checkup';
import type { Job, JobEnd } from '../job';
import { CATCH_UP_PAGE } from '../occasions';
import {
  CONNECTIONS,
  INVITATIONS_SENT,
  LINKEDIN,
  OWN_PROFILE,
  postSearchUrl,
  readLinkedIn,
} from './read';

async function checkup(job: Job): Promise<JobEnd> {
  const c = new Checkup<LinkedInRead>(job, 'linkedin', readLinkedIn);
  const stopped = (): JobEnd | null => (job.stopped() ? { line: 'Stopped.', warned: false } : null);

  // Your profile: read whole, then putting the headline in tried, and the About (decision 80).
  const own = await c.open(OWN_PROFILE, 'your profile');
  if (isEnd(own)) return own;
  await wholeProfile(job, true);
  await c.tryHere('headline');
  await c.tryHere('about');

  // Your feed: read, and posting tried.
  const feed = await c.open(`${LINKEDIN}/feed/`, 'your feed');
  if (isEnd(feed)) return feed;
  await c.note('your feed', feed.posts?.length ?? 0);
  await c.tryHere('post');

  // Your connections, and the first one kept to message and like.
  if (stopped()) return stopped()!;
  const connections = await c.open(CONNECTIONS, 'your connections');
  if (isEnd(connections)) return connections;
  await c.note('your connections', connections.people?.length ?? 0);
  const connection = connections.people?.[0]?.profile ?? null;

  // A people search, and someone in it you're not connected with, to try connecting.
  if (stopped()) return stopped()!;
  const search = await c.open(
    `${LINKEDIN}/search/results/people/?keywords=${encodeURIComponent(SEARCH_WORDS)}`,
    'the people search',
  );
  if (isEnd(search)) return search;
  await c.note('the people search', search.people?.length ?? 0);
  const stranger =
    search.people?.find(
      (p) => p.connection === 'not_connected' || (p.connection === 'unknown' && p.degree !== '1st'),
    )?.profile ?? null;
  if (stopped()) return stopped()!;
  if (stranger) {
    const theirs = await c.open(stranger.url, 'someone from the search');
    if (isEnd(theirs)) return theirs;
    await c.tryHere('connect');
  } else await c.nothingFor('connect', 'nobody you’re not connected with in the search');

  // A posts search; then a person's post from your feed or the search, on its own page, to try commenting on, liking
  // there and who reacted (LinkedIn's newer feed links few of its posts: with none, one of a connection's own, below).
  if (stopped()) return stopped()!;
  const posts = await c.open(postSearchUrl(SEARCH_WORDS), 'the posts search');
  if (isEnd(posts)) return posts;
  await c.note('the posts search', posts.posts?.length ?? 0);
  const theirPost =
    [...(feed.posts ?? []), ...(posts.posts ?? [])].find((p) => p.url && !p.company) ?? null;
  const commentOn = async (their: Post): Promise<JobEnd | null> => {
    if (stopped()) return stopped();
    const post = await c.open(their.url!, 'a post');
    if (isEnd(post)) return post;
    await c.tryHere('comment');
    // Decision 92: the post a search found is liked on its own page, and its people read from the box of who reacted.
    const writer = post.posts?.[0]?.author?.profile ?? their.author?.profile ?? null;
    if (writer) await c.tryHere('like', writer);
    await c.tryHere('reactors');
    return null;
  };
  if (theirPost) {
    const ended = await commentOn(theirPost);
    if (ended) return ended;
  }

  // Your messages.
  if (stopped()) return stopped()!;
  const messages = await c.open(`${LINKEDIN}/messaging/`, 'your messages');
  if (isEnd(messages)) return messages;
  await c.note('your messages', messages.chats?.length ?? 0);

  // Catch up: your connections' birthdays and new jobs (decision 108).
  if (stopped()) return stopped()!;
  const catchUp = await c.open(CATCH_UP_PAGE, 'Catch up');
  if (isEnd(catchUp)) return catchUp;
  await c.note('Catch up', catchUp.catchUp?.length ?? 0);

  // One connection: their profile read whole and messaging tried; their activity, and liking tried.
  if (stopped()) return stopped()!;
  if (connection) {
    const theirs = await c.open(connection.url, 'one connection’s profile');
    if (isEnd(theirs)) return theirs;
    await wholeProfile(job, false);
    const messaged = await c.tryHere('message', connection);
    // Nothing opened on the profile, and its Message leads to a page of its own: tried there too.
    if (!messaged.works && messaged.next) {
      if (stopped()) return stopped()!;
      const page = await c.open(messaged.next, 'the page Message leads to');
      if (isEnd(page)) return page;
      await c.tryHere('message', connection);
    }
    if (stopped()) return stopped()!;
    const activity = await c.open(`${connection.url}recent-activity/all/`, 'their posts');
    if (isEnd(activity)) return activity;
    await c.tryHere('like', connection);
    // Nothing on your feed or the search to try commenting on: one of their own posts, on its own page, as the runner
    // comments on (else anything on their activity a person posted).
    const own = (p: Post) => (p.author?.profile ? sameMember(p.author.profile, connection) : false);
    const ofTheirs = theirPost
      ? null
      : (activity.posts?.find((p) => p.url && own(p)) ??
        activity.posts?.find((p) => p.url && !p.company) ??
        null);
    if (ofTheirs) {
      const ended = await commentOn(ofTheirs);
      if (ended) return ended;
    }
  } else {
    await c.nothingFor('message', 'no connection to try it with');
    // Liking was tried on the person's post above, when there was one.
    if (!c.has('like')) await c.nothingFor('like', 'no connection whose posts to try it on');
  }
  for (const step of ['comment', 'reactors'] as const)
    if (!c.has(step))
      await c.nothingFor(
        step,
        'no person’s post with its own page, on your feed, the search or a connection’s activity',
      );

  // Invitations you sent, and Get a copy of your data.
  if (stopped()) return stopped()!;
  const sent = await c.open(INVITATIONS_SENT, 'the invitations you’ve sent');
  if (isEnd(sent)) return sent;
  await c.tryHere('withdraw');
  if (stopped()) return stopped()!;
  const data = await c.open(DATA_PAGE, 'Get a copy of your data');
  if (isEnd(data)) return data;
  await c.tryHere('file');

  return c.end();
}

/** Check LinkedIn: with its window in front the whole time, then the person's own back. */
export async function checkLinkedIn(job: Job): Promise<JobEnd> {
  return job.tab.inFront ? job.tab.inFront(() => checkup(job)) : checkup(job);
}
