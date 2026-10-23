/**
 * LinkedIn's kit (../kit.ts), in the plan's order (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "LinkedIn, part
 * by part"): its readers (part 1), the person's own steps there (part 2), and the steps of what they ask of it from
 * HandsFreeOS (part 4: ./work.ts, done by src/jobs/linkedin/). It starts off. Its site is let on from install (decision
 * 85), and its script runs only while both Chrome allows it and HandsFreeOS says LinkedIn is on for them (../on.ts). As they go, it looks only for LinkedIn's warnings for now; and
 * it works on its own there only once they let it, on a day they started (src/auto/linkedin.ts).
 *
 * The plan's risk, said plainly: LinkedIn's terms forbid software that automates it, and its pages look for
 * extensions. So the extension shows LinkedIn nothing of its own (nothing in `web_accessible_resources`), notes only
 * what the person presses, and builds nothing to get around LinkedIn's limits or checks.
 */
import { NETWORKS } from '@hfos/core/addons/outreach/networks';
import { isWholeAddress, type Kit } from '../kit';
import { linkedInNoticer } from './actions';
import { outlinePage } from './outline';
import { readPage } from './page';
import { readReplies } from './replies';
import type { ReadResult } from './types';
import { classifyUrl, linkedinUrl, profileKey, workUrl } from './urls';
import { readWarnings } from './warnings';
import { work } from './work';

/** LinkedIn's site, asked for when the person turns LinkedIn on: never at install. */
export const LINKEDIN_HOSTS = ['https://www.linkedin.com/*'] as const;

export const linkedin: Kit = {
  platform: 'linkedin',
  network: NETWORKS.linkedin,
  hosts: LINKEDIN_HOSTS,
  registered: true,
  startsOn: false,
  owns: (href) => isWholeAddress(href) && linkedinUrl(href) !== null,
  workUrl,
  kindOf: (href) => classifyUrl(href).kind,
  profileKey,
  readPage: (doc, href) => readPage(doc, href),
  readWarnings,
  readReplies: (doc, href) => readReplies(doc, href),
  // Only its warnings, for now: a chat opened and a group's posts are read as the person goes on Facebook alone.
  lookFor: () => 'warnings',
  noticer: () => linkedInNoticer(),
  outline: (doc, href, options = {}) =>
    outlinePage(doc, href, { ...options, found: options.found as ReadResult | undefined }),
  work,
};
