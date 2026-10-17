/**
 * Check LinkedIn (`checkup`, docs/outreach.md decisions 74 and 76): one press when something on LinkedIn isn't working.
 * It opens the person's main LinkedIn pages one at a time and reads each as the other jobs do (their profile, their
 * feed, their connections, a people search, a posts search, their messages and one connection's profile), and on the
 * way tries each of the extension's steps up to its last press (src/networks/linkedin/tries.ts): putting the headline
 * in, posting, commenting, connecting, messaging, liking, withdrawing and the data file. Nothing is ever saved,
 * posted, sent, liked, connected or withdrawn. Each page and each step is noted in HandsFreeOS with what it found
 * (../report.ts), the outline kept when a step doesn't work, so everything that doesn't is found in one go; the end's
 * line names the steps that don't, and those it found nothing to try on. Its window stays in front while it works,
 * as Chrome draws nothing in a window hidden behind another, and then the person's own comes back. It stops on any
 * LinkedIn warning.
 */
import { REPORT_WORDS, type TryStepName } from '@hfos/core/addons/outreach/reports';
import type { LinkedInRead } from '../../networks';
import { DATA_PAGE } from '../../networks/linkedin/data';
import type { StepTry, TryStep } from '../../networks/linkedin/tries';
import type { Post, ProfileRef } from '../../networks/linkedin/types';
import { sameMember } from '../../networks/linkedin/urls';
import { pause, paced, warnedOn, type Job, type JobEnd } from '../job';
import { loadNote, ownProfileNote, tryNote } from '../report';
import {
  CONNECTIONS,
  INVITATIONS_SENT,
  LINKEDIN,
  OWN_PROFILE,
  postSearchUrl,
  readLinkedIn,
} from './read';

/** What the searches look for: everyday words, to see how LinkedIn draws its results. */
const SEARCH_WORDS = 'small business';
/** Between pages: a person going from one to the next. */
const BETWEEN_MS = [2_500, 5_000] as const;

const isEnd = (got: LinkedInRead | JobEnd): got is JobEnd => 'warned' in got;

/**
 * A profile, every part drawn: LinkedIn draws Experience and what's below only as it comes into view, so the tab's
 * script scrolls it to its foot and back first (the own profile's read, which does that on any profile), and what it
 * read is noted.
 */
async function wholeProfile(job: Job, own: boolean): Promise<void> {
  const read = await job.tab.ask({ type: 'hfos-own-profile' });
  const got = read.ok && 'read' in read ? read : null;
  const note = loadNote(own && got ? ownProfileNote(got.read) : {}, got?.load);
  await job.report?.({ ...note, outline: true });
}

/** The person's work in the job's window: pages read and steps tried, as it goes. */
class Checkup {
  pages = 0;
  readonly nothingOn: string[] = [];
  readonly tries: StepTry[] = [];

  constructor(private readonly job: Job) {}

  /** Opens a page and reads it, at a person's pace after the first; a LinkedIn warning ends the job. */
  async open(url: string, name: string): Promise<LinkedInRead | JobEnd> {
    if (this.pages > 0) await pause(paced(BETWEEN_MS));
    this.job.progress(`Checking ${name}…`);
    await this.job.tab.open(url);
    const page = await readLinkedIn(this.job.tab);
    const warned = await warnedOn(this.job, page);
    if (warned) return warned;
    this.pages++;
    return page;
  }

  /** Notes the page with its outline, and says when its readers found nothing on it. */
  async note(name: string, count: number): Promise<void> {
    await this.job.report?.({ outline: true });
    if (count === 0) this.nothingOn.push(name);
  }

  /** Tries a step on the page the tab shows, notes how it went, and says. */
  async tryHere(step: TryStep, profile?: ProfileRef): Promise<StepTry> {
    this.job.progress(`Trying ${REPORT_WORDS_STEP[step]}…`);
    const answer = await this.job.tab.ask({
      type: 'hfos-try',
      step,
      ...(profile ? { profile } : {}),
    });
    const tried: StepTry = answer.ok
      ? answer.tried
      : { step, tried: true, works: false, found: {}, missing: [answer.error] };
    this.tries.push(tried);
    await this.job.report?.(tryNote(tried));
    return tried;
  }

  /**
   * The steps as the end's line counts them: one tried two ways (messaging, on the profile and on the page its Message
   * links to) works when either does.
   */
  steps(): StepTry[] {
    const each = new Map<TryStep, StepTry>();
    for (const tried of this.tries) {
      const before = each.get(tried.step);
      if (!before || (tried.works && !before.works) || (tried.tried && !before.tried))
        each.set(tried.step, tried);
    }
    return [...each.values()];
  }

  /** A step with nothing to try it on: noted as such, nothing opened. */
  async nothingFor(step: TryStep, why: string): Promise<void> {
    const tried: StepTry = { step, tried: false, works: false, found: {}, missing: [why] };
    this.tries.push(tried);
    await this.job.report?.({ ...tryNote(tried), outline: false });
  }
}

/** The step's name, as the progress line says it. */
const REPORT_WORDS_STEP: Readonly<Record<TryStep, string>> = {
  headline: 'your headline',
  post: 'a post',
  comment: 'a comment',
  connect: 'connecting',
  message: 'a message',
  like: 'a like',
  withdraw: 'withdrawing',
  file: 'the data file',
};

async function checkup(job: Job): Promise<JobEnd> {
  const c = new Checkup(job);
  const stopped = (): JobEnd | null => (job.stopped() ? { line: 'Stopped.', warned: false } : null);

  // Your profile: read whole, then putting the headline in tried.
  const own = await c.open(OWN_PROFILE, 'your profile');
  if (isEnd(own)) return own;
  await wholeProfile(job, true);
  await c.tryHere('headline');

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

  // A posts search; then a person's post from your feed or the search, on its own page, to try commenting on (LinkedIn's
  // newer feed links few of its posts: with none, one of a connection's own, below).
  if (stopped()) return stopped()!;
  const posts = await c.open(postSearchUrl(SEARCH_WORDS), 'the posts search');
  if (isEnd(posts)) return posts;
  await c.note('the posts search', posts.posts?.length ?? 0);
  const theirPost =
    [...(feed.posts ?? []), ...(posts.posts ?? [])].find((p) => p.url && !p.company)?.url ?? null;
  const commentOn = async (url: string): Promise<JobEnd | null> => {
    if (stopped()) return stopped();
    const post = await c.open(url, 'a post');
    if (isEnd(post)) return post;
    await c.tryHere('comment');
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
      : ((
          activity.posts?.find((p) => p.url && own(p)) ??
          activity.posts?.find((p) => p.url && !p.company)
        )?.url ?? null);
    if (ofTheirs) {
      const ended = await commentOn(ofTheirs);
      if (ended) return ended;
    }
  } else {
    await c.nothingFor('message', 'no connection to try it with');
    await c.nothingFor('like', 'no connection whose posts to try it on');
  }
  if (!c.tries.some((t) => t.step === 'comment'))
    await c.nothingFor(
      'comment',
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

  const steps = c.steps();
  const names = (pick: (t: StepTry) => boolean) =>
    steps.filter(pick).map((t) => t.step as TryStepName);
  const broken = names((t) => t.tried && !t.works);
  const untried = names((t) => !t.tried);
  const line = REPORT_WORDS.checkupTried('LinkedIn', c.pages, broken, untried, steps.length);
  await job.report?.({
    job: 'checkup.summary',
    found: {
      pages: c.pages,
      steps: steps.length,
      working: steps.filter((t) => t.works).length,
      ...(broken.length ? { notWorking: broken } : {}),
      ...(untried.length ? { nothingToTry: untried } : {}),
      ...(c.nothingOn.length ? { nothingRead: c.nothingOn } : {}),
    },
    note: line,
    outline: false,
  });
  return { line, warned: false };
}

/** Check LinkedIn: with its window in front the whole time, then the person's own back. */
export async function checkLinkedIn(job: Job): Promise<JobEnd> {
  return job.tab.inFront ? job.tab.inFront(() => checkup(job)) : checkup(job);
}
