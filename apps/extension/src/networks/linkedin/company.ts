/**
 * A company's page (/company/<name>/, and its About tab at /company/<name>/about/): its name, the line it writes under
 * it, and what its Overview or About says, for a look-up before a draft (src/jobs/linkedin/lookup.ts). LinkedIn draws
 * it as a top card with the name as its `h1`, then sections, each under a heading of its own. Its Overview lists
 * facts as a label and then its value ("Industry", then "Plumbing"): they're read as one line, "Industry: Plumbing".
 * Its follower count, the tabs of its page, and LinkedIn's own buttons and links (Follow, Visit website, See all
 * details) are left out.
 */
import { clean } from '../facebook/dom';
import { CONTROLS, inTopBar, shownLines, shownText } from './dom';
import { sectionOf } from './profile';
import type { CompanyPage } from './types';
import { companyFromUrl, linkedinUrl } from './urls';
import { isLinkedInText } from './vocabulary';

/** The heading of what the company says about itself. */
const ABOUT = /^(overview|about|about us)$/i;
/** The labels in its Overview, each followed by its value. */
const LABEL =
  /^(website|phone|industry|company size|headquarters|founded|type|specialties|locations?)$/i;
/** LinkedIn's own words on a company's page that aren't the company's. */
const NOT_THEIRS =
  /^(visit website|follow|following|message|more|see all details|see more|show more|…\s*see more|verified|page verified|claimed|view all \d+ employees|view all employees)$/i;
/** "1,240 followers": a part of the line under its name that says nothing about the company. */
const FOLLOWERS = /^[\d.,]+\s*[km]?\+?\s+followers?$/i;
/** The most lines kept, and the longest. */
const LINES_MOST = 12;
const LINE_LONGEST = 300;

const cut = (line: string) => clean(line).slice(0, LINE_LONGEST);
/** What's never the company's words: buttons, and the tabs of its page (Home, About, Posts, People). */
const NOT_SAID = `${CONTROLS}, nav, [role="navigation"], [role="tablist"]`;

/** A line under the name, without its follower count: "Plumbing · Austin, Texas · 11-50 employees". */
function withoutFollowers(line: string): string {
  return line
    .split(/\s*[·•]\s*/)
    .filter((part) => part && !FOLLOWERS.test(part))
    .join(' · ');
}

/** What its Overview says, each label on one line with its value. */
function aboutLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = lines[i + 1];
    if (LABEL.test(line)) {
      if (next !== undefined && !LABEL.test(next)) {
        out.push(`${line}: ${next}`);
        i++;
      }
      continue;
    }
    out.push(line);
  }
  return out;
}

export function readCompany(root: Element, href: string): CompanyPage {
  const url = linkedinUrl(href);
  const company = url ? companyFromUrl(url) : null;
  const heading = [...root.querySelectorAll('h1')].find((h) => !inTopBar(h)) ?? null;
  const name = (heading && shownText(heading, CONTROLS)) || null;
  const about = sectionOf(root, ABOUT);
  const said = (line: string) =>
    line !== name && !NOT_THEIRS.test(line) && !isLinkedInText(line) && !FOLLOWERS.test(line);
  const top = heading
    ? shownLines(root, {
        max: 10,
        after: heading,
        before: about?.heading ?? null,
        exclude: NOT_SAID,
      })
        .map(withoutFollowers)
        .filter((line) => line && said(line))
    : [];
  const overview = about
    ? aboutLines(
        shownLines(root, {
          max: 40,
          after: about.heading,
          before: about.end,
          exclude: NOT_SAID,
        }).filter(said),
      )
    : [];
  // The line under its name is its tagline, unless it only says its industry, place and size.
  const [first, ...rest] = top;
  const tagline = first && !/·/.test(first) ? cut(first) : null;
  const facts = tagline ? rest : top;
  return {
    name,
    company,
    tagline,
    lines: [...new Set([...facts, ...overview].map(cut).filter(Boolean))].slice(0, LINES_MOST),
  };
}
