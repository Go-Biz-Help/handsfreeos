/**
 * Decision 99's parts of the person's own profile, put in by **Put these in** (docs/outreach.md, decision 99; the
 * owner: "nothing should be handed for the user to do, the extension should be able to do it all"): their work, their
 * best post and LinkedIn's booking link featured, Facebook's links that don't fit them taken off or changed,
 * LinkedIn's address and website, and Alignable's Elevator Pitch, ideal customer and partner and services. Each
 * network's job (./profile.ts, ./linkedin/profile.ts, ./looking.ts) says which, on which of its pages, and this puts
 * them in, one by one:
 *
 * - **Its page opened, and the part put in there** by the tab (`hfos-write-part`, src/networks/fill.ts). A form on a page
 *   of its own (LinkedIn's Add position, Alignable's new service) is opened when the tab says so, and asked again.
 * - **The code Alignable emails** before a change (decision 82) is asked of the person in HandsFreeOS (`job.code`) and
 *   put in where Alignable asks, and the part asked again: at most three tries, as for About Us.
 * - **A step it can't find is handed over**, saying where to press on the page it's on (**Carry on** once it's in),
 *   with a note of that page and what was missing (decision 74). Only that part: never one that went in by itself.
 * - **Only what shows is said to be in.** The job reads the profile again at the end (`unseenParts`): a part that went in
 *   but doesn't show there is left out of what's in, and the end says to check it.
 */
import type { AskTask } from '@hfos/core/addons/outreach/asks';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import type { ProfileRead } from '@hfos/core/addons/outreach/profile-check';
import { EVERY_PART_STEPS as S, workLine } from '@hfos/core/addons/outreach/profile-parts';
import { sameLink } from '../networks/facebook/links';
import { fillMissing, type PartKind, type PartWrite, type PartWrote } from '../networks/fill';
import type { Job, JobEnd } from './job';

type EditTask = Extract<AskTask, { kind: 'profile_edit' }>;

const STOPPED: JobEnd = { line: 'Stopped.', warned: false, failed: true };

/** One part to put in: what, on which page, and what the person does when it can't. */
export interface PartStep {
  readonly write: PartWrite;
  /** The page it's put in on, opened first. */
  readonly page: string;
  /** What the person is asked to do there when it can't put it in: the job adds "Then press Carry on.". */
  readonly byHand: string;
  /** What it says it's doing. */
  readonly doing: string;
}

/** How a part went: in by itself, there already, or put in by the person, who pressed Carry on. */
export type PartOutcome = 'in' | 'already' | 'handed';

/** The ways a network's job lends: opening a page (null once it's open, how it ended on a warning), and its code. */
export interface PartWays {
  readonly open: (url: string) => Promise<JobEnd | null>;
  /**
   * The code the network emailed, asked of the person and put in where it asks: `again` to ask the part again, `none`
   * when none came or it wasn't taken (the part's handed over then), or how it ended.
   */
  readonly code?: () => Promise<'again' | 'none' | JobEnd>;
}

/** How many times a part is asked again: a page of its own once, and the code's tries. */
const AGAIN_MOST = 4;

/** What putting a part in found, for the note that goes with handing it over (decision 74). */
export function partNote(kind: PartKind, wrote: PartWrote | null) {
  const job = `profile_edit.${kind}`;
  if (!wrote)
    return { job, note: 'The tab didn’t say how putting it in went.', outline: true } as const;
  const { names, missing, ...counts } = wrote.steps;
  const said = fillMissing(wrote.steps);
  return {
    job,
    found: {
      ...counts,
      result: [wrote.result],
      ...(missing.length ? { missing } : {}),
      ...(names.length ? { seen: names } : {}),
    },
    note: said.length ? `Not done: ${said.join('; ')}.` : null,
    outline: true,
  };
}

/** Puts each part in, in turn: how each went, or how it ended (stopped, or a warning). */
export async function putParts(
  job: Job,
  steps: readonly PartStep[],
  ways: PartWays,
): Promise<JobEnd | PartOutcome[]> {
  const outcomes: PartOutcome[] = [];
  for (const step of steps) {
    if (job.stopped()) return STOPPED;
    job.progress(step.doing);
    const opened = await ways.open(step.page);
    if (opened) return opened;
    let wrote: PartWrote | null = null;
    for (let tries = 0; tries <= AGAIN_MOST; tries++) {
      const answer = await job.tab.ask({ type: 'hfos-write-part', part: step.write });
      wrote = answer.ok ? answer : null;
      if (wrote?.result === 'elsewhere' && wrote.next) {
        const there = await ways.open(wrote.next);
        if (there) return there;
        continue;
      }
      if (wrote?.result === 'code' && ways.code) {
        const coded = await ways.code();
        if (typeof coded === 'object') return coded;
        if (coded === 'again') {
          job.progress(step.doing);
          continue;
        }
      }
      break;
    }
    if (wrote?.result === 'done' || wrote?.result === 'already') {
      outcomes.push(wrote.result === 'done' ? 'in' : 'already');
      continue;
    }
    // Something wasn't as expected: the person puts it in, and says when. The note of the page says which step.
    if (!job.handOver)
      return { line: `${step.doing.replace(/…$/, '')} didn’t go.`, warned: false, failed: true };
    const reply = await job.handOver(
      `${step.byHand} Then press Carry on.`,
      partNote(step.write.kind, wrote),
    );
    if (reply !== 'carry_on') return STOPPED;
    outcomes.push('handed');
  }
  return outcomes;
}

/** How much of a post is quoted to find it by: its first words. */
const quoteStart = (words: string) => {
  const cut = words.replace(/\s+/g, ' ').trim();
  return cut.length <= 60 ? cut : `${cut.slice(0, 57).replace(/\s+\S*$/, '')}…`;
};

/** The pages each network's parts are put in on. */
export interface PartPages {
  /** Their profile. */
  readonly profile: string;
  /** Facebook's Work and education, and Contact and basic info. */
  readonly work?: string | null;
  readonly links?: string | null;
  /** LinkedIn's Public profile & URL, Contact info and their posts. */
  readonly address?: string;
  readonly contact?: string;
  readonly posts?: string;
}

/**
 * The parts of an edit decision 99 adds, as steps on each network's pages, in the order they go in: on Facebook the
 * links taken off (before the new ones go in, by the job), then the work and the post; on LinkedIn the address, the
 * websites, the work and what's featured; on Alignable the Elevator Pitch, the ideal customer and partner, and the
 * services.
 */
export function partSteps(platform: Platform, task: EditTask, pages: PartPages): PartStep[] {
  const steps: PartStep[] = [];
  if (platform === 'facebook') {
    for (const change of task.linkChanges)
      steps.push({
        write: { kind: 'link_off', link: change.from },
        page: pages.links ?? pages.profile,
        byHand: S.linkOff(change.from),
        doing: change.to ? 'Changing a link…' : 'Taking a link off…',
      });
  }
  if (platform === 'linkedin') {
    if (task.username)
      steps.push({
        write: { kind: 'username', username: task.username },
        page: pages.address ?? pages.profile,
        byHand: S.username(task.username),
        doing: 'Putting your new address in…',
      });
    for (const link of task.links)
      steps.push({
        write: { kind: 'link_add', link },
        page: pages.contact ?? pages.profile,
        byHand: S.linkAdd(link),
        doing: 'Adding your website…',
      });
  }
  if (task.work && (platform === 'facebook' || platform === 'linkedin'))
    steps.push({
      write: { kind: 'work', ...task.work },
      page: (platform === 'facebook' ? pages.work : null) ?? pages.profile,
      byHand: S.work(platform, workLine(task.work)),
      doing: 'Putting your work in…',
    });
  if (task.featured?.link && platform === 'linkedin')
    steps.push({
      write: { kind: 'feature_link', link: task.featured.link },
      page: pages.profile,
      byHand: S.featureLink(task.featured.link),
      doing: 'Featuring your booking link…',
    });
  if (task.featured?.post && (platform === 'facebook' || platform === 'linkedin'))
    steps.push({
      write: { kind: 'feature_post', post: task.featured.post },
      page: (platform === 'linkedin' ? pages.posts : null) ?? pages.profile,
      byHand: S.featurePost(platform, quoteStart(task.featured.post)),
      doing: 'Featuring your best post…',
    });
  if (platform === 'alignable') {
    if (task.bio)
      steps.push({
        write: { kind: 'pitch', words: task.bio },
        page: pages.profile,
        byHand: S.pitch(task.bio),
        doing: 'Putting your Elevator Pitch in…',
      });
    for (const who of ['customer', 'partner'] as const) {
      const words = task.ideal?.[who];
      if (words)
        steps.push({
          write: { kind: 'ideal', who, words },
          page: pages.profile,
          byHand: S.ideal(who, words),
          doing: `Putting your ideal ${who} in…`,
        });
    }
    for (const service of task.services)
      steps.push({
        write: { kind: 'service', name: service.name, words: service.words },
        page: pages.profile,
        byHand: S.service(service.name),
        doing: 'Adding your service…',
      });
  }
  return steps;
}

/** Words with no spaces, in lower case: to find one written by the AI however the page draws it. */
const squash = (text: string | null | undefined): string =>
  (text ?? '').toLowerCase().replace(/\s+/g, '');

/** Whether any of these lines says the words. */
const said = (lines: readonly string[] | null | undefined, words: string): boolean =>
  (lines ?? []).some((line) => squash(line).includes(squash(words)));

/**
 * The parts that went in but don't show on the profile read after: their work's company not in its intro, a link taken
 * off still there, a service not among them, LinkedIn's new address not in its own, an ideal's words not in it. What
 * the read doesn't take in (a pinned post, the Elevator Pitch, LinkedIn's websites) is taken as in.
 */
export function unseenParts(
  platform: Platform,
  task: EditTask,
  read: ProfileRead,
): Set<'work' | 'featured' | 'ideal' | 'services' | 'linkChanges' | 'username'> {
  const unseen = new Set<'work' | 'featured' | 'ideal' | 'services' | 'linkChanges' | 'username'>();
  // Work goes in on Facebook and LinkedIn only.
  if (platform !== 'alignable' && task.work && !said(read.intro, task.work.company))
    unseen.add('work');
  if (
    platform === 'facebook' &&
    task.linkChanges.some((c) => (read.links ?? []).some((l) => sameLink(l, c.from)))
  )
    unseen.add('linkChanges');
  if (platform === 'alignable') {
    if (task.services.some((s) => !said(read.featured, s.name))) unseen.add('services');
    const ideal = task.ideal;
    if (
      ideal &&
      (['customer', 'partner'] as const).some(
        (who) => ideal[who] && !said(read.intro, ideal[who]!.slice(0, 60)),
      )
    )
      unseen.add('ideal');
  }
  if (
    platform === 'linkedin' &&
    task.username &&
    !squash(read.url).includes(`/in/${squash(task.username)}`)
  )
    unseen.add('username');
  if (platform === 'linkedin' && task.featured?.link && !said(read.featured, task.featured.link))
    unseen.add('featured');
  return unseen;
}

/** What's said of the parts that don't show yet: where to check them. */
export function unseenPartsWords(platform: Platform, unseen: ReadonlySet<string>): string | null {
  if (!unseen.size) return null;
  const names: Record<string, string> = {
    work: platform === 'linkedin' ? 'your new position under Experience' : 'your workplace',
    featured: 'your booking link under Featured',
    ideal: 'your ideal customer and partner',
    services: 'your new services',
    linkChanges: 'the links you asked to take off',
    username: 'your new address',
  };
  const list = [...unseen].map((p) => names[p] ?? p);
  const joined =
    list.length === 1 ? list[0]! : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]!}`;
  return `${platform === 'facebook' ? 'Facebook' : platform === 'linkedin' ? 'LinkedIn' : 'Alignable'} hasn’t shown ${joined} on your profile yet. Check it there in a minute.`;
}

/** A shown edit: the parts that don't show yet taken out, for the words of what's in. */
export function shownParts(task: EditTask, unseen: ReadonlySet<string>): EditTask {
  return {
    ...task,
    work: unseen.has('work') ? null : task.work,
    featured: unseen.has('featured')
      ? task.featured?.post
        ? { post: task.featured.post, link: null }
        : null
      : task.featured,
    ideal: unseen.has('ideal') ? null : task.ideal,
    services: unseen.has('services') ? [] : task.services,
    linkChanges: unseen.has('linkChanges') ? [] : task.linkChanges,
    username: unseen.has('username') ? null : task.username,
  };
}
