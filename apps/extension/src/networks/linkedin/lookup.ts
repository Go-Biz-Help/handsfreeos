/**
 * What a look at someone on LinkedIn reads, as lines for the AI (docs/outreach.md, decisions 21 and 46, LinkedIn's
 * way): what their profile says about them (their headline, their role, where they are, their About) and, for a
 * look-up before a draft, what the company their role links to says about itself. The same lines as Facebook's
 * (../facebook/lookup.ts), cut the same way, so the AI reads both alike.
 */
import { line } from '../facebook/lookup';
import type { CompanyPage, ProfilePage } from './types';

/** The most lines of their About read. */
const ABOUT_LINES = 3;

/** Words on their headline or role that say the company is theirs: "Owner", "Founder & CEO". */
const OWNS =
  /\b(owner|co-?owner|founder|co-?founder|ceo|proprietor|self[- ]employed|principal|managing director)\b/i;

/** What their profile says about them, as lines for the AI. */
export function profileLines(profile: ProfilePage): string[] {
  const lines: string[] = [];
  if (profile.headline) lines.push(profile.headline);
  const role = profile.role;
  if (role)
    lines.push(
      [role.company ? `${role.title} at ${role.company}` : role.title, role.dates]
        .filter(Boolean)
        .join(' · '),
    );
  if (profile.location) lines.push(`Based in ${profile.location}`);
  const about = (profile.about ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, ABOUT_LINES);
  lines.push(...about);
  return [...new Set(lines.map((l) => line(l)).filter(Boolean))];
}

/**
 * Whether the company their profile links to is their own business: only when their role there, or their headline
 * naming it, says so. "Office Manager at Harper Dental" is where they work.
 */
export function ownsCompany(profile: ProfilePage): boolean {
  const name = profile.company?.name;
  if (!name) return false;
  if (profile.role && OWNS.test(profile.role.title) && profile.role.company === name) return true;
  return !!profile.headline?.includes(name) && OWNS.test(profile.headline);
}

/** The line that heads what the company's page says, for the AI: their business, or where they work. */
export function companyHeading(profile: ProfilePage, name: string): string {
  return ownsCompany(profile)
    ? `Their business page: ${line(name)}`
    : `Where they work, a job and not their own business: ${line(name)}`;
}

/** What the company's page says about itself, as lines for the AI, each with its name. */
export function companyLines(company: CompanyPage, label: string): string[] {
  return [company.tagline, ...company.lines]
    .filter((l): l is string => !!l)
    .map((l) => line(`${label}: ${l}`));
}
