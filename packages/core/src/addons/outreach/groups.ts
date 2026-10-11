/**
 * Groups (docs/outreach.md, the plan's Phase 1 step 4): the ones the person sees on Facebook, scored against the
 * business's playbooks as Work these, Maybe or Skip, with why; and the people found in them, where those who run a
 * group (admins and moderators) are never approached. Browser-safe: the extension shows how a group on the page
 * fits, and builds what it saves with these; the Groups tab lists them the same way.
 *
 * Only what the page shows counts:
 * - **Words to search for groups** (the playbook's Where step): one in the group's name or the line under it.
 * - **The area**: one of its places in the name ("Austin Small Business Owners").
 * - **Signs** in quotes: one in the name ("“Owner”").
 * - **Size**: a thousand members or more is worth the time; a group under a hundred, less.
 * - **Being in it**: a group the person has joined can be worked today.
 * - **Who to skip** in quotes: one in the name makes it a skip.
 */
import { z } from 'zod';
import { quoted, says, placesIn } from './fit';
import { INTRO_LINE_MOST, NAME_MOST } from './limits';
import { GroupRef } from './activity';
import { PLATFORM_KEYS, type PlaybookDetails } from './playbooks';
import { PersonName, ProfileRef } from './saves';
import {
  GroupCheckShown,
  JOIN_STATE_KEYS,
  ProspectsLeft,
  type GroupCheckState,
} from './group-checks';

export const GROUP_VERDICTS = { work: 'Work these', maybe: 'Maybe', skip: 'Skip' } as const;
export type GroupVerdict = keyof typeof GROUP_VERDICTS;
export const GROUP_VERDICT_KEYS = Object.keys(GROUP_VERDICTS) as [GroupVerdict, ...GroupVerdict[]];

/** What's known about a group, to see how it fits. */
export interface GroupFacts {
  readonly name: string | null;
  /** The line under its name: "Public group · 12K members", "Last active 2 hours ago". */
  readonly detail: string | null;
  readonly members: number | null;
  readonly privacy: 'public' | 'private' | null;
  /** Whether the person is in it, when known. */
  readonly joined: boolean | null;
}

/** A playbook in use, as much of it as a group's fit reads. */
export interface GroupFitPlaybook {
  readonly id: string;
  readonly name: string;
  readonly details: Pick<PlaybookDetails, 'signs' | 'skip' | 'area' | 'groupWords'>;
}

export interface GroupFit {
  readonly verdict: GroupVerdict;
  readonly score: number;
  readonly playbookId: string | null;
  readonly playbookName: string | null;
  /** Why: "“small business” in its name", "In Austin", "34,718 members", "You’re in it". */
  readonly reasons: readonly string[];
}

/** From here up, a group to work; above nothing, one to look at. */
const WORK = 3;
const BIG = 1_000;
const SMALL = 100;

const count = (n: number) => n.toLocaleString('en-US');

/** How a group fits one playbook, or none (null) by size and being in it alone. */
export function groupFitFor(playbook: GroupFitPlaybook | null, facts: GroupFacts): GroupFit {
  const which = { playbookId: playbook?.id ?? null, playbookName: playbook?.name ?? null };
  const name = facts.name ? [facts.name] : [];
  const both = [...name, ...(facts.detail ? [facts.detail] : [])];
  const details = playbook?.details ?? { signs: [], skip: [], area: null, groupWords: [] };
  const skipped = details.skip.flatMap(quoted).find((words) => says(name, words));
  if (skipped)
    return { ...which, verdict: 'skip', score: -1, reasons: [`“${skipped}” in its name`] };
  let score = 0;
  const reasons: string[] = [];
  const word = details.groupWords
    .map((w) => w.replace(/[“”"]/g, '').trim())
    .find((w) => w && says(both, w));
  if (word) {
    score += 3;
    reasons.push(`“${word}” in its name`);
  }
  const place = placesIn(details.area).find((p) => says(name, p));
  if (place) {
    score += 2;
    reasons.push(`In ${place}`);
  }
  const sign = details.signs.flatMap(quoted).find((words) => says(name, words));
  if (sign) {
    score += 1;
    reasons.push(`“${sign}” in its name`);
  }
  if (facts.members !== null && facts.members >= BIG) {
    score += 1;
    reasons.push(`${count(facts.members)} members`);
  } else if (facts.members !== null && facts.members < SMALL) {
    score -= 1;
    reasons.push(`Only ${count(facts.members)} ${facts.members === 1 ? 'member' : 'members'}`);
  }
  if (facts.joined) {
    score += 1;
    reasons.push('You’re in it');
  }
  // Without a playbook's words to go by, nothing says it's worth the time: at most a maybe.
  const matched = !!(word || place || sign);
  return {
    ...which,
    verdict: matched && score >= WORK ? 'work' : score > 0 ? 'maybe' : 'skip',
    score,
    reasons,
  };
}

/** What the AI made of a group, as its fit reads it (./group-checks.ts, decision 48). */
export interface GroupChecked {
  readonly state: GroupCheckState | null;
  readonly why: readonly string[];
  readonly playbookId?: string | null;
  readonly playbookName?: string | null;
}

/**
 * A group's fit with the AI's check of it on top (decision 48): the business's people there makes it one to work,
 * some of them at least a maybe, and none a skip, whatever its name says. Not checked yet, it's its name's.
 */
export function checkedGroupFit(fit: GroupFit, check: GroupChecked | null): GroupFit {
  const state = check?.state;
  if (!check || !state || state === 'waiting' || state === 'failed') return fit;
  const which = {
    playbookId: check.playbookId ?? fit.playbookId,
    playbookName: check.playbookName ?? fit.playbookName,
  };
  const said = check.why[0];
  if (state === 'not')
    return {
      ...fit,
      ...which,
      verdict: 'skip',
      score: Math.min(fit.score, -1),
      reasons: [said ?? 'The AI says your people aren’t here'],
    };
  if (state === 'good')
    return {
      ...fit,
      ...which,
      verdict: 'work',
      score: fit.score + 3,
      reasons: [said ?? 'The AI says your people are here', ...fit.reasons],
    };
  return {
    ...fit,
    ...which,
    verdict: fit.verdict === 'work' ? 'work' : 'maybe',
    score: fit.score + 1,
    reasons: [said ?? 'The AI says some of your people are here', ...fit.reasons],
  };
}

/** How a group fits the playbooks in use: the one it fits best, a skip only when every playbook skips it. */
export function bestGroupFit(playbooks: readonly GroupFitPlaybook[], facts: GroupFacts): GroupFit {
  if (!playbooks.length) return groupFitFor(null, facts);
  const fits = playbooks.map((p) => groupFitFor(p, facts));
  return fits.reduce((best, fit) => (fit.score > best.score ? fit : best));
}

// ---- Saving ----

/** The most groups, and people in a group, one save takes. */
export const GROUPS_SAVE_MOST = 100;
export const GROUP_PEOPLE_MOST = 500;
const LINES_MOST = 4;

const GroupFactsInput = z.object({
  group: GroupRef,
  privacy: z.enum(['public', 'private']).nullable().default(null),
  members: z.number().int().min(0).max(100_000_000).nullable().default(null),
  detail: z.string().trim().min(1).max(300).nullable().default(null),
  /** Whether the person is in it, as the page showed: "Joined", or "Join group". */
  joined: z.boolean().nullable().default(null),
});

export const GroupsSaveInput = z.object({
  workspaceId: z.uuid(),
  platform: z.enum(PLATFORM_KEYS).default('facebook'),
  groups: z
    .array(GroupFactsInput)
    .min(1, 'There are no groups on the page to save.')
    .max(GROUPS_SAVE_MOST, `Send up to ${GROUPS_SAVE_MOST} groups at a time.`),
});
export type GroupsSaveInput = z.input<typeof GroupsSaveInput>;

export const GroupsSaveOutput = z.object({ saved: z.number().int() });

export const GroupPersonInput = z.object({
  profile: ProfileRef,
  name: PersonName,
  /** The lines under their name. */
  lines: z.array(z.string().trim().min(1).max(INTRO_LINE_MOST)).max(LINES_MOST).default([]),
  /** The part of the list they were in. */
  part: z.string().trim().min(1).max(100).nullable().default(null),
  /** An admin or a moderator. */
  runsGroup: z.boolean().default(false),
});
export type GroupPersonInput = z.input<typeof GroupPersonInput>;

export const GroupSaveInput = GroupFactsInput.extend({
  workspaceId: z.uuid(),
  platform: z.enum(PLATFORM_KEYS).default('facebook'),
  /** People from its People tab, or one of its See all pages. */
  people: z
    .array(GroupPersonInput)
    .max(GROUP_PEOPLE_MOST, `Send up to ${GROUP_PEOPLE_MOST} people at a time.`)
    .default([]),
  /** The page was its full list of admins and moderators: everyone who runs it is known now. */
  adminsPage: z.boolean().default(false),
});
export type GroupSaveInput = z.input<typeof GroupSaveInput>;

export const GroupSaveOutput = z.object({
  groupId: z.uuid(),
  /** People saved from it, new or seen again. */
  people: z.number().int(),
  /** Of them, the admins and moderators, left alone. */
  runsGroup: z.number().int(),
});
export type GroupSaveOutput = z.output<typeof GroupSaveOutput>;

// ---- The Groups tab ----

export const GROUPS_PAGE = 50;
export const GROUP_VIEWS = { ...GROUP_VERDICTS, all: 'All' } as const;
export type GroupView = keyof typeof GROUP_VIEWS;

export const GroupsInput = z.object({
  workspaceId: z.uuid(),
  platform: z.enum(PLATFORM_KEYS).default('facebook'),
  view: z.enum(Object.keys(GROUP_VIEWS) as [GroupView, ...GroupView[]]).default('work'),
  search: z.string().trim().max(NAME_MOST).optional(),
  page: z.number().int().min(1).default(1),
});
export type GroupsInput = z.input<typeof GroupsInput>;

const n = z.number().int().min(0);

export const GroupsOutput = z.object({
  counts: z.object({ work: n, maybe: n, skip: n, all: n }),
  groups: z.array(
    z.object({
      groupId: z.uuid(),
      name: z.string().nullable(),
      url: z.string(),
      privacy: z.enum(['public', 'private']).nullable(),
      members: n.nullable(),
      detail: z.string().nullable(),
      /** Whether the person is in it, as their Facebook last showed. */
      joined: z.boolean().nullable(),
      verdict: z.enum(GROUP_VERDICT_KEYS),
      reasons: z.array(z.string()),
      playbookName: z.string().nullable(),
      /** People saved from its People tab, and of them, who runs it. */
      people: n,
      runsGroup: n,
      /** Whether its full list of admins and moderators has been read. */
      adminsRead: z.boolean(),
      /** Friend requests the business sent to people found there. */
      requests: n,
      /** Of everyone the business reached from it, ever, how many wrote back and booked a demo (./results.ts). */
      replies: n,
      demos: n,
      seenAt: z.iso.datetime().nullable(),
      /** What the AI made of it (decision 48), once it's been checked. */
      check: GroupCheckShown.nullable(),
      /** People there who fit a playbook and haven't been reached yet. */
      left: n,
      /** The person's ask to join it, when they made one. */
      join: z.object({ state: z.enum(JOIN_STATE_KEYS), at: z.iso.datetime() }).nullable(),
    }),
  ),
  /** People left to reach across the groups, against a day's friend requests. */
  prospects: ProspectsLeft,
  /** Whether the person lets the extension join good groups on its own when people left run low. */
  joinsOnItsOwn: z.boolean(),
  page: n.min(1),
  pages: n.min(1),
  total: n,
});
export type GroupsOutput = z.output<typeof GroupsOutput>;
