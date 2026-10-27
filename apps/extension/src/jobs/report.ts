/**
 * What a job saw (docs/outreach.md, decision 74): a note of the page its tab shows, sent to HandsFreeOS as a problem
 * report (core's schemas/problem-report.ts), which staff read on the support desk's Problem reports page, so a reader
 * that misses something on a network's real pages is found from what this computer sent rather than from the person
 * describing it.
 *
 * A note has the page's kind and its address as the outline masks it (people's and groups' parts as {1}, {2}…),
 * whether Chrome showed the page, what the readers found (counts, yes or no, and the network's own section names
 * from the outline's headings; never words) within the most core keeps (`reportFound`), a line on what was missing,
 * and, when asked, the outline itself: tags, roles and the network's own words, with everything a person wrote as
 * "[2 words]". A note that can't be made or sent is let go: it never stops or slows the job past the read.
 */
import { PROBLEM_FOUND_MOST, PROBLEM_OUTLINE_MOST } from '@hfos/core/problem-report';
import type { ProfileRead } from '@hfos/core/addons/outreach/profile-check';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { TRY_STEP_NAMES } from '@hfos/core/addons/outreach/reports';
import type { PageRead } from '../networks/kit';
import { editorMissing, type EditorSteps } from '../networks/facebook/editors';
import { nameMissing, type NameSteps } from '../networks/accounts-center/name';
import type { CenterNetwork } from '../networks/accounts-center/pages';
import { usernameMissing, type UsernameSteps } from '../networks/accounts-center/username';
import type { StepTry } from '../networks/tries';
import {
  aboutMissing,
  headlineMissing,
  type AboutSteps,
  type HeadlineSteps,
  type ProfileLoad,
} from '../networks/linkedin/own-profile';
import type { Hfos, JobTab } from './job';

/** What a job adds to its note of a page. */
export interface ReportNote {
  /** The step within the job, when there's more than one to tell apart: Check LinkedIn's `checkup.headline`. */
  readonly job?: string;
  readonly found?: Readonly<Record<string, number | boolean | readonly string[]>>;
  /** What it couldn't find, in the extension's own words: never anything a person wrote. */
  readonly note?: string | null;
  /** Keep the page's outline: something was missing, a step was handed over, or the person asked for Check LinkedIn. */
  readonly outline?: boolean;
  /**
   * The outline to keep in place of the page's as it is now: the one a step took while what it opened was still open
   * (Check LinkedIn's tries).
   */
  readonly outlineText?: string;
}

export type Reporter = (note?: ReportNote) => Promise<void>;

/** Whose job and which: the ask it's for (null for a step of the day) and its kind or step. */
export interface ReportFor {
  readonly businessId: string;
  readonly platform: Platform;
  readonly askId: string | null;
  readonly job: string;
}

/** A heading in the outline (`h2`, `h2 id="…"`), with its words on the line when it has them. */
const HEADING = /^(\s*)h[1-6](?:\s[^"]*)?(?:\s"([^"]*)")?\s*$/;
/** Words on an outline line: the network's own when they aren't masked (`"[2 words]"`) or a link's (`{1}`). */
const OWN_WORDS = /\s"([^"[{]{1,60})"\s*$/;
/** The outline's second line: the page's kind and its masked address. */
const PAGE_LINE = /^Page: \S+ (.+)$/m;

const depth = (line: string) => line.length - line.trimStart().length;

/**
 * The network's own section names on the page, from the outline's headings, each once, in page order: a heading's own
 * words, or the first words inside it (`h2` › `span "Experience"`). Never a masked heading, such as a person's name.
 */
export function sectionsIn(outline: string): string[] {
  const names = new Set<string>();
  const lines = outline.split('\n');
  lines.forEach((line, i) => {
    const heading = HEADING.exec(line);
    if (!heading || names.size >= 40) return;
    let words = heading[2] === undefined ? null : (OWN_WORDS.exec(line)?.[1] ?? '');
    for (let j = i + 1; words === null && j < lines.length && depth(lines[j]!) > depth(line); j++)
      if (/\s"[^"]*"\s*$/.test(lines[j]!)) words = OWN_WORDS.exec(lines[j]!)?.[1] ?? '';
    if (words?.trim()) names.add(words.trim());
  });
  return [...names];
}

const upper = (key: string) => `${key[0]!.toUpperCase()}${key.slice(1)}`;
/** A row's or a read's parts, by their names. */
const partsOf = (value: unknown): string[] =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).filter((k) => /^[a-z][a-zA-Z]{0,20}$/.test(k))
    : [];
/** Whether a part had something: words, a yes, a list with something in it, a number. */
const filled = (value: unknown): boolean =>
  Array.isArray(value)
    ? value.length > 0
    : typeof value === 'string'
      ? value.trim() !== ''
      : typeof value === 'number' ||
        value === true ||
        (value !== null && typeof value === 'object');

/** Something a report says was found: a count, a yes or no, or names (the network's own, or the readers'). */
type Fact = number | boolean | readonly string[];

/**
 * What each thing found is, least needed first: how many of a list's rows had one of their parts, those folded into
 * the parts some rows lacked, a list's count, the lists with none, the page's own read (with the readers' warnings and
 * notes), the network's own section names, and what the job itself found, which is what the report is for.
 */
const NEEDED = ['part', 'lacking', 'list', 'empty', 'own', 'sections', 'job'] as const;

interface FoundFact {
  readonly key: string;
  readonly value: Fact;
  readonly is: (typeof NEEDED)[number];
  /** A part's list and its own name (`threads`, `author` for `threadsAuthor`). */
  readonly list?: string;
  readonly part?: string;
}

/** The read's lists a report keeps with the page's own read: what the readers warned of, and their notes. */
const KEPT_LISTS: ReadonlySet<string> = new Set(['warnings', 'notes']);
/** The lists with none, by name, once a report has to fold them. */
const EMPTY_KEY = 'emptyLists';

/** What the readers found on a page, each with what it is, in the read's order. Never what anyone said. */
function pageFacts(read: PageRead): FoundFact[] {
  // One of each, where it was first found, as the last read of it says.
  const facts = new Map<string, FoundFact>();
  const put = (fact: FoundFact) => facts.set(fact.key, fact);
  for (const [key, value] of Object.entries(read))
    if (Array.isArray(value) && /^[a-z][a-zA-Z]{0,39}$/.test(key))
      put({ key, value: value.length, is: KEPT_LISTS.has(key) ? 'own' : 'list' });
  // A network's own readers' (Alignable's businesses, posts, answers, chats): each list's count, how many of its rows
  // had each of their parts, and which parts a page's own read had. Never what any of them said.
  const lists = (read as { readonly found?: Readonly<Record<string, unknown>> }).found;
  for (const [key, value] of Object.entries(lists ?? {})) {
    if (!/^[a-z][a-zA-Z]{0,30}$/.test(key)) continue;
    if (typeof value === 'boolean') put({ key, value, is: 'own' });
    else if (Array.isArray(value)) {
      put({ key, value: value.length, is: 'list' });
      for (const part of partsOf(value[0]))
        put({
          key: `${key}${upper(part)}`,
          value: value.filter((row) => filled((row as Record<string, unknown> | null)?.[part]))
            .length,
          is: 'part',
          list: key,
          part,
        });
    } else if (value && typeof value === 'object') {
      put({ key, value: true, is: 'own' });
      for (const part of partsOf(value))
        put({
          key: `${key}${upper(part)}`,
          value: filled((value as Record<string, unknown>)[part]),
          is: 'own',
        });
    } else if (value === null) put({ key, value: false, is: 'own' });
  }
  const profile = (read as { readonly profile?: Record<string, unknown> | null }).profile;
  if (profile && typeof profile === 'object') {
    put({ key: 'profile', value: true, is: 'own' });
    for (const key of ['name', 'headline', 'about', 'role', 'company', 'location'] as const)
      if (key in profile)
        put({
          key: `profile${upper(key)}`,
          value: profile[key] !== null && profile[key] !== undefined && profile[key] !== '',
          is: 'own',
        });
  }
  return [...facts.values()];
}

/** What the readers found on a page: how many of each list, and which parts of a profile. Never what they said. */
export function pageFound(read: PageRead): Record<string, number | boolean> {
  return Object.fromEntries(
    pageFacts(read).map((fact) => [fact.key, fact.value as number | boolean]),
  );
}

/**
 * What a report says was found: the page's facts, the network's own section names and the job's own facts (which win
 * over the page's of the same name), within the most core keeps (`PROBLEM_FOUND_MOST`), so a page with many lists,
 * such as an Alignable business's page with posts and answers on it, is never refused for it. Past the most, the same
 * page always loses the same facts, least needed first:
 *
 * 1. The lists with none are folded into one, `emptyLists`, by name: nothing is lost.
 * 2. Each list's parts, from the read's last list back, are folded into one, `<list>Lacking`: the names of the parts
 *    some of its rows didn't have (`threadsLacking: ['likes']`), in place of how many had each.
 * 3. What's still too many goes, least needed first and the read's last first (`NEEDED`): parts, then folded parts,
 *    then lists' counts, then the lists with none. The page's own read, its warnings and notes, its section names and
 *    the job's own facts go only past all those, which no page comes near.
 */
export function reportFound(
  read: PageRead,
  sections: readonly string[] = [],
  job: ReportNote['found'] = {},
  most: number = PROBLEM_FOUND_MOST,
): Record<string, number | boolean | string[]> {
  let facts: FoundFact[] = [
    ...pageFacts(read).filter((fact) => !Object.hasOwn(job, fact.key)),
    ...(sections.length && !Object.hasOwn(job, 'sections')
      ? [{ key: 'sections', value: sections, is: 'sections' as const }]
      : []),
    ...Object.entries(job).map(([key, value]) => ({ key, value, is: 'job' as const })),
  ];
  /** Facts made one, in the first one's place (they're in the read's order); or let go, when its name is taken. */
  const fold = (gone: readonly FoundFact[], into: FoundFact) => {
    const at = facts.indexOf(gone[0]!);
    const kept = facts.filter((fact) => !gone.includes(fact));
    if (!kept.some((fact) => fact.key === into.key)) kept.splice(at, 0, into);
    facts = kept;
  };
  const empty = facts.filter((fact) => fact.is === 'list' && fact.value === 0);
  if (facts.length > most && empty.length > 1)
    fold(empty, { key: EMPTY_KEY, value: empty.map((fact) => fact.key), is: 'empty' });
  for (const list of facts.filter((fact) => fact.is === 'list').reverse()) {
    if (facts.length <= most) break;
    const parts = facts.filter((fact) => fact.is === 'part' && fact.list === list.key);
    if (parts.length > 1)
      fold(parts, {
        key: `${list.key}Lacking`,
        value: parts.flatMap((fact) =>
          (fact.value as number) < (list.value as number) ? [fact.part!] : [],
        ),
        is: 'lacking',
      });
  }
  if (facts.length > most) {
    const gone = new Set(
      facts
        .map((fact, at) => ({ at, need: NEEDED.indexOf(fact.is) }))
        .sort((a, b) => a.need - b.need || b.at - a.at)
        .slice(0, facts.length - most)
        .map(({ at }) => at),
    );
    facts = facts.filter((_, at) => !gone.has(at));
  }
  return Object.fromEntries(
    facts.map(({ key, value }) => [key, typeof value === 'object' ? [...value] : value]),
  );
}

/** A note of a person's own profile as it was read for the AI's check: what was there, and what wasn't. */
export function ownProfileNote(read: ProfileRead): ReportNote {
  const roles = read.intro?.length ?? 0;
  const featured = read.featured?.length ?? 0;
  const posts = read.posts?.length ?? 0;
  const parts = PARTS_ON[read.platform ?? 'facebook'];
  const missing = [
    !read.bio && parts.bio,
    !read.about && parts.about,
    roles === 0 && parts.intro,
    featured === 0 && parts.featured,
    posts === 0 && parts.posts,
  ].filter((m): m is string => typeof m === 'string');
  return {
    found: {
      name: Boolean(read.name),
      bio: Boolean(read.bio),
      about: Boolean(read.about),
      roles,
      featured,
      posts,
      photo: Boolean(read.picture),
      banner: Boolean(read.cover),
    },
    note: missing.length ? `Not read: ${missing.join(', ')}.` : null,
    // Featured and posts are often none at all; the outline is kept when what nearly everyone has wasn't read.
    outline: !read.bio || roles === 0,
  };
}

/** What each part of a profile is called on each network, as a note's "Not read" says it: null where none is read. */
const PARTS_ON: Readonly<
  Record<
    Platform,
    Readonly<Record<'bio' | 'about' | 'intro' | 'featured' | 'posts', string | null>>
  >
> = {
  facebook: {
    bio: 'the bio',
    about: null,
    intro: 'the intro',
    featured: 'Featured',
    posts: 'any posts',
  },
  linkedin: {
    bio: 'the headline',
    about: 'About',
    intro: 'Experience',
    featured: 'Featured',
    posts: 'any posts',
  },
  instagram: {
    bio: 'the bio',
    about: null,
    intro: 'a link',
    featured: 'highlights',
    posts: 'any posts',
  },
  // Its Elevator Pitch isn't read yet, and its posts aren't on the profile.
  alignable: {
    bio: null,
    about: 'About Us',
    intro: 'the ideal customer',
    featured: 'the services',
    posts: null,
  },
};

/**
 * How loading a whole profile went, added to its note: the steps down, the parts LinkedIn held a place for and those
 * still empty when it was read, and whether the page itself scrolled. Parts left empty are said, and keep the outline.
 */
export function loadNote(note: ReportNote, load: ProfileLoad | undefined): ReportNote {
  if (!load) return note;
  const left =
    load.left > 0
      ? `LinkedIn left ${load.left === 1 ? 'a part' : `${load.left} parts`} of the page empty.`
      : null;
  return {
    found: {
      ...note.found,
      loadSteps: load.steps,
      placesBefore: load.places,
      placesLeft: load.left,
      pageScrolled: load.page,
    },
    note: [note.note, left].filter(Boolean).join(' ') || null,
    outline: Boolean(note.outline) || load.left > 0,
  };
}

/**
 * How putting LinkedIn's headline in went, step by step, for its note: each step's count or yes or no, the box's names
 * for its fields as the outline shows them, and what wasn't there, in the extension's own words.
 */
export function headlineNote(steps: HeadlineSteps | undefined, tried = false): ReportNote {
  if (!steps)
    return { note: 'The tab didn’t say how putting the headline in went.', outline: true };
  const missing = headlineMissing(steps, tried);
  const { names, ...counts } = steps;
  return {
    found: { ...counts, ...(names.length ? { seen: names } : {}) },
    note: missing.length ? `Not done: ${missing.join('; ')}.` : null,
    outline: missing.length > 0,
  };
}

/** How putting LinkedIn's About in went, step by step, for its note: as the headline's. */
export function aboutNote(steps: AboutSteps | undefined): ReportNote {
  if (!steps) return { note: 'The tab didn’t say how putting the About in went.', outline: true };
  const missing = aboutMissing(steps, false);
  const { names, ...counts } = steps;
  return {
    found: { ...counts, ...(names.length ? { seen: names } : {}) },
    note: missing.length ? `Not done: ${missing.join('; ')}.` : null,
    outline: missing.length > 0,
  };
}

/**
 * How putting Facebook's bio or a link in went, step by step, for the note that goes with handing it over (decision
 * 89): as LinkedIn's headline's. `job` names the step: `profile_edit.bio`, `profile_edit.links`.
 */
export function editorNote(part: 'bio' | 'links', steps: EditorSteps | undefined): ReportNote {
  const job = `profile_edit.${part}`;
  if (!steps)
    return {
      job,
      note: `The tab didn’t say how putting the ${part === 'bio' ? 'bio' : 'link'} in went.`,
      outline: true,
    };
  const missing = editorMissing(part, steps);
  const { names, ...counts } = steps;
  return {
    job,
    found: { ...counts, ...(names.length ? { seen: names } : {}) },
    note: missing.length ? `Not done: ${missing.join('; ')}.` : null,
    outline: true,
  };
}

/**
 * How putting the username in went, on Accounts Center for the person's own Facebook or Instagram profile, step by
 * step, for the note that goes with handing it over (decision 89).
 */
export function usernameNote(
  steps: UsernameSteps | undefined,
  network: CenterNetwork = 'facebook',
): ReportNote {
  const job = 'profile_edit.username';
  if (!steps)
    return { job, note: 'The tab didn’t say how putting the username in went.', outline: true };
  const missing = usernameMissing(steps, false, network);
  const { names, asking, answer, ...counts } = steps;
  return {
    job,
    found: {
      ...counts,
      password: asking === 'password',
      code: asking === 'code',
      confirm: asking === 'confirm',
      answered: answer !== 'none',
      ...(names.length ? { seen: names } : {}),
    },
    note: missing.length ? `Not done: ${missing.join('; ')}.` : null,
    outline: true,
  };
}

/**
 * How putting the name in went, on Accounts Center for the person's own Facebook or Instagram profile, step by step,
 * for the note that goes with handing it over (decision 89): as the username's, with how the name is shown.
 */
export function nameNote(steps: NameSteps | undefined, network: CenterNetwork): ReportNote {
  const job = 'profile_edit.name';
  if (!steps)
    return { job, note: 'The tab didn’t say how putting the name in went.', outline: true };
  const missing = nameMissing(steps, network);
  const { names, asking, answer, order, ...counts } = steps;
  return {
    job,
    found: {
      ...counts,
      password: asking === 'password',
      code: asking === 'code',
      confirm: asking === 'confirm',
      answered: answer !== 'none',
      orderKept: order === 'kept',
      orderUnpicked: order === 'unpicked',
      ...(names.length ? { seen: names } : {}),
    },
    note: missing.length ? `Not done: ${missing.join('; ')}.` : null,
    outline: true,
  };
}

/**
 * How one of Check LinkedIn's tries went (decision 76), for its note: whether it works, what it found, the names of
 * what it looked among, and what was missing, in the extension's own words. The outline is kept when it doesn't work:
 * the one the try took while what it opened was still open, when it took one. The address it may hand the job to try
 * again on is never in it.
 */
export function tryNote(tried: StepTry): ReportNote {
  const name = TRY_STEP_NAMES[tried.step];
  // Its own full stop, when a reason brought one ("…the page that step is on."), never doubled.
  const why = tried.missing.join('; ').replace(/[.\s]+$/, '');
  return {
    job: `checkup.${tried.step}`,
    found: {
      works: tried.works,
      tried: tried.tried,
      ...tried.found,
      ...(tried.seen?.length ? { seen: tried.seen } : {}),
    },
    note: tried.works
      ? null
      : `${name[0]!.toUpperCase()}${name.slice(1)}: ${tried.tried ? '' : 'not tried, '}${why}.`,
    // A try's own outline, taken while what it opened was open, is kept even when it works: an editor Check opened.
    outline: !tried.works || Boolean(tried.outline),
    ...(tried.outline ? { outlineText: tried.outline } : {}),
  };
}

/**
 * A job's way to note the page its tab shows: reads it with its outline there, and saves the note in HandsFreeOS.
 */
export function reporter(tab: JobTab, hfos: Hfos, at: ReportFor): Reporter {
  return async (note = {}) => {
    try {
      const answer = await tab.ask({ type: 'hfos-outline' });
      if (!answer.ok) return;
      const outline = note.outlineText ?? answer.outline ?? '';
      const sections = outline ? sectionsIn(outline) : [];
      await hfos({
        type: 'hfos-report',
        input: {
          workspaceId: at.businessId,
          report: {
            addonId: 'outreach',
            source: 'extension',
            area: at.platform,
            ref: at.askId,
            job: (note.job ?? at.job).slice(0, 40),
            version: chrome.runtime.getManifest().version.slice(0, 20),
            page: String(answer.result.kind).slice(0, 40),
            path: (PAGE_LINE.exec(outline)?.[1] ?? '').slice(0, 500),
            shown: answer.shown ?? null,
            found: reportFound(answer.result, sections, note.found),
            note: note.note?.slice(0, 300) ?? null,
            outline: note.outline && outline ? outline.slice(0, PROBLEM_OUTLINE_MOST) : null,
          },
        },
      });
    } catch (error) {
      console.warn('HandsFreeOS Social couldn’t save its note of the page', error);
    }
  };
}
