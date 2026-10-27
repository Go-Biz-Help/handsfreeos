/**
 * **Who reacted and commented** on LinkedIn (docs/outreach.md, decision 92), once a day while the extension works on
 * its own there: the people of the good posts its post search found, the AI's own pick (8a). HandsFreeOS says which
 * posts (up to 5 a day: a post asking for exactly what the business offers first, then the busiest, then the newest;
 * none while 3 days of found people wait for their checks). On each post's own page it reads who commented, never the
 * post's writer or the person, and opens the box its reactions count opens, reads its first rows (about 25, never
 * scrolled) with each one's headline and how far they are, leaves out 1st-degree connections, and closes it with its
 * Dismiss. Everyone read goes to HandsFreeOS as found (`outreach.finds.save`): nobody is liked, invited or reached
 * until the AI has checked their own profile (`found_checks`, ../found-checks.ts). A post with nobody new, or one
 * LinkedIn no longer shows, still counts as read. Nothing else is pressed: never "Load more comments", a Like or a
 * profile. It goes at a person's pace and stops on any LinkedIn warning. A post it couldn't read, one with no reactions
 * count to open, and a box of who reacted that didn't open or read nobody are noted with the page's outline (decision
 * 74), once a day each, and the day goes on.
 */
import type { Platform } from '@hfos/core/addons/outreach/networks';
import type { PostsPeopleNext } from '../../hfos/messages';
import { findsSave, type FoundPerson } from '../../hfos/saves';
import type { PostPerson, ReactorsRead } from '../../networks/linkedin/compose';
import { postOf, profileRefOf } from '../../networks/linkedin/urls';
import { counted } from '../../words';
import { paced, pause, valueOf, warnedOn, type Job, type JobEnd } from '../job';
import type { ReportNote } from '../report';
import { readLinkedIn } from './read';

const PLATFORM: Platform = 'linkedin';
/** Between posts: a person going from one to the next. */
const POST_PACE_MS = [15_000, 30_000] as const;
/** HandsFreeOS's word for a post it no longer keeps for the person: its people aren't read. */
const NOT_KEPT = 'outreach_find_post';

/** Notes what a post's page didn't show, once a day for each kind: what was found, and an outline taken earlier. */
type Note = (
  kind: string,
  words: string,
  found: ReportNote['found'],
  outlineText?: string,
) => Promise<void>;

/** Someone read, as HandsFreeOS keeps them: their headline as the line under their name, a commenter's words. */
const foundOf = (person: PostPerson): FoundPerson => ({
  name: person.name,
  profile: person.profile,
  lines: person.headline ? [person.headline] : [],
  said: person.said,
});

/** How far it got, in words for the person. */
function summary(read: number, added: number, gone: number): string {
  const parts = [
    `Read who reacted to and commented on ${counted(read, 'good post')}: ${counted(added, 'new person', 'new people')} for the AI to check.`,
  ];
  if (gone) parts.push(`LinkedIn didn’t show ${counted(gone, 'post')}.`);
  return parts.join(' ');
}

/** The line when there's no post to read: today's all read, or none waits. */
function noneLine(next: PostsPeopleNext): string {
  if (next.perDay > 0 && next.today >= next.perDay)
    return `That’s today’s ${counted(next.perDay, 'good post')} on LinkedIn. It carries on tomorrow.`;
  return 'No good post on LinkedIn waits for its people to be read, or the people found wait for their checks first.';
}

/**
 * Sends a post's people to HandsFreeOS as found, its commenters then who reacted; with nobody, one save of none, so
 * the post counts as read. How many were new, or null when HandsFreeOS no longer keeps the post.
 */
async function savePeople(
  job: Job,
  postId: string,
  commenters: readonly PostPerson[],
  reactors: readonly PostPerson[],
): Promise<number | null> {
  const saves = [
    ...(commenters.length ? [{ how: 'commented' as const, people: commenters }] : []),
    ...(reactors.length || !commenters.length ? [{ how: 'liked' as const, people: reactors }] : []),
  ];
  let added = 0;
  for (const { how, people } of saves) {
    const built = findsSave(people.map(foundOf), how, PLATFORM, job.businessId, { postId });
    if (!built.ok) throw new Error(built.why);
    for (const input of built.input) {
      const answer = await job.hfos({ type: 'hfos-finds-save', input });
      if (!answer.ok && answer.problem.rule === NOT_KEPT) return null;
      added += valueOf(answer).added;
    }
  }
  return added;
}

/**
 * What reading who reacted didn't find, noted while the post's page is still open: no reactions count on a post that
 * HandsFreeOS saw reactions on, a count that opened no box of who reacted (whatever it opened still shows), or a box
 * that read nobody, with its outline from while it was open.
 */
async function noteReactors(
  reactors: ReactorsRead,
  reactions: number | null,
  note: Note,
): Promise<void> {
  if (!reactors.count) {
    if (reactions !== 0)
      await note('count', 'No reactions count on the post to open who reacted.', { count: false });
  } else if (!reactors.opened)
    await note('reactors', 'The post’s reactions count opened no box of who reacted.', {
      count: true,
      box: false,
    });
  else if (!reactors.rows)
    await note(
      'reactors',
      'Nobody read in the box of who reacted.',
      { count: true, box: true, rows: 0 },
      reactors.outline,
    );
}

/** Reads who reacted to and commented on today's good posts on LinkedIn, and sends them to HandsFreeOS as found. */
export async function readPostPeople(job: Job): Promise<JobEnd> {
  job.progress('Asking HandsFreeOS which good posts’ people to read…');
  const next = valueOf(
    await job.hfos({
      type: 'hfos-posts-people-next',
      input: { workspaceId: job.businessId, platform: PLATFORM },
    }),
  );
  if (!next.posts.length) return { line: noneLine(next), warned: false };
  const noted = new Set<string>();
  const note: Note = async (kind, words, found, outlineText) => {
    if (noted.has(kind)) return;
    noted.add(kind);
    await job.report?.({
      job: `post_people.${kind}`,
      note: words,
      found,
      outline: true,
      ...(outlineText ? { outlineText } : {}),
    });
  };
  let read = 0;
  let added = 0;
  let gone = 0;
  for (const [i, post] of next.posts.entries()) {
    if (job.stopped()) return { line: `Stopped. ${summary(read, added, gone)}`, warned: false };
    job.progress(
      `${i + 1} of ${next.posts.length}: reading who reacted to and commented on ${post.name}’s post…`,
    );
    await job.tab.open(postOf(post.url) ?? post.url);
    const page = await readLinkedIn(job.tab);
    const warned = await warnedOn(job, page);
    if (warned) return { ...warned, line: `${warned.line} ${summary(read, added, gone)}` };
    let commenters: readonly PostPerson[] = [];
    let reactors: readonly PostPerson[] = [];
    const shown = page.kind === 'post' && Boolean(page.posts?.length);
    if (shown) {
      const people = await job.tab.ask({
        type: 'hfos-post-people',
        writer: profileRefOf(post.profileUrl),
      });
      if (!people.ok) throw new Error(people.error);
      // The box it opened and closed again: any warning LinkedIn showed meanwhile stops the day, nothing sent.
      const after = await warnedOn(job, await readLinkedIn(job.tab));
      if (after) return { ...after, line: `${after.line} ${summary(read, added, gone)}` };
      await noteReactors(people.reactors, post.reactions, note);
      commenters = people.commenters;
      reactors = people.reactors.people;
    } else {
      // Its own page, but no post read on it: the reader's to look at. Any other page means LinkedIn took it away.
      if (page.kind === 'post') await note('post', 'Couldn’t read the post.', { post: 0 });
      gone++;
    }
    const saved = await savePeople(job, post.postId, commenters, reactors);
    if (saved !== null) {
      added += saved;
      if (shown) read++;
    }
    if (i < next.posts.length - 1 && !job.stopped()) {
      job.progress(`${summary(read, added, gone)} Waiting a moment before the next…`);
      await pause(paced(POST_PACE_MS));
    }
  }
  return { line: `Done. ${summary(read, added, gone)}`, warned: false };
}
