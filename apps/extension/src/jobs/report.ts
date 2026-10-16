/**
 * What a job saw (docs/outreach.md, decision 74; core's reports.ts): a note of the page its tab shows, saved in
 * HandsFreeOS for the person, so a reader that misses something on a network's real pages is found from what this
 * computer sent rather than from the person describing it.
 *
 * A note has the page's kind and its address as the outline masks it (people's and groups' parts as {1}, {2}…),
 * whether Chrome showed the page, what the readers found (counts, yes or no, and the network's own section names
 * from the outline's headings; never words), a line on what was missing, and, when asked, the outline itself: tags,
 * roles and the network's own words, with everything a person wrote as "[2 words]". A note that can't be made or
 * sent is let go: it never stops or slows the job past the read.
 */
import { REPORT_OUTLINE_MOST } from '@hfos/core/addons/outreach/reports';
import type { ProfileRead } from '@hfos/core/addons/outreach/profile-check';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import type { PageRead } from '../networks/kit';
import type { Hfos, JobTab } from './job';

/** What a job adds to its note of a page. */
export interface ReportNote {
  readonly found?: Readonly<Record<string, number | boolean>>;
  /** What it couldn't find, in the extension's own words: never anything a person wrote. */
  readonly note?: string | null;
  /** Keep the page's outline: something was missing, a step was handed over, or the person asked for Check LinkedIn. */
  readonly outline?: boolean;
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

/** What the readers found on a page: how many of each list, and which parts of a profile. Never what they said. */
export function pageFound(read: PageRead): Record<string, number | boolean> {
  const found: Record<string, number | boolean> = {};
  for (const [key, value] of Object.entries(read))
    if (Array.isArray(value) && /^[a-z][a-zA-Z]{0,39}$/.test(key)) found[key] = value.length;
  const profile = (read as { readonly profile?: Record<string, unknown> | null }).profile;
  if (profile && typeof profile === 'object') {
    found.profile = true;
    for (const key of ['name', 'headline', 'about', 'role', 'company', 'location'] as const)
      if (key in profile)
        found[`profile${key[0]!.toUpperCase()}${key.slice(1)}`] =
          profile[key] !== null && profile[key] !== undefined && profile[key] !== '';
  }
  return found;
}

/** A note of a person's own profile as it was read for the AI's check: what was there, and what wasn't. */
export function ownProfileNote(read: ProfileRead): ReportNote {
  const roles = read.intro?.length ?? 0;
  const featured = read.featured?.length ?? 0;
  const posts = read.posts?.length ?? 0;
  const missing = [
    !read.bio && (read.platform === 'linkedin' ? 'the headline' : 'the bio'),
    read.platform === 'linkedin' && !read.about && 'About',
    roles === 0 && (read.platform === 'linkedin' ? 'Experience' : 'the intro'),
    featured === 0 && 'Featured',
    posts === 0 && 'any posts',
  ].filter((m): m is string => typeof m === 'string');
  return {
    found: {
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

/**
 * A job's way to note the page its tab shows: reads it with its outline there, and saves the note in HandsFreeOS.
 */
export function reporter(tab: JobTab, hfos: Hfos, at: ReportFor): Reporter {
  return async (note = {}) => {
    try {
      const answer = await tab.ask({ type: 'hfos-outline' });
      if (!answer.ok) return;
      const outline = answer.outline ?? '';
      const sections = outline ? sectionsIn(outline) : [];
      await hfos({
        type: 'hfos-report',
        input: {
          workspaceId: at.businessId,
          report: {
            platform: at.platform,
            askId: at.askId,
            job: at.job.slice(0, 40),
            version: chrome.runtime.getManifest().version.slice(0, 20),
            page: String(answer.result.kind).slice(0, 40),
            path: (PAGE_LINE.exec(outline)?.[1] ?? '').slice(0, 500),
            shown: answer.shown ?? null,
            found: {
              ...pageFound(answer.result),
              ...(sections.length ? { sections } : {}),
              ...note.found,
            },
            note: note.note?.slice(0, 300) ?? null,
            outline: note.outline && outline ? outline.slice(0, REPORT_OUTLINE_MOST) : null,
          },
        },
      });
    } catch (error) {
      console.warn('HandsFreeOS Social couldn’t save its note of the page', error);
    }
  };
}
