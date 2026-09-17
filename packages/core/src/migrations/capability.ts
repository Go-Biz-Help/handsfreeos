/**
 * The words a migration uses about itself.
 *
 * The rule this file exists to hold: never fold these into a warning. "GoHighLevel will not give us this" and
 * "HandsFreeOS has nowhere to put this" look the same on a progress bar and are completely different problems
 * — one is a permission to fix, the other is something for us to build. A person reading the report should be
 * able to tell which of the two they are looking at without asking anybody.
 */

export const MIGRATION_CAPABILITIES = [
  'ready',
  'needs_review',
  'action_required',
  'port_required',
  'not_available',
  'not_supported',
  'not_imported',
  'not_in_release',
] as const;
export type MigrationCapability = (typeof MIGRATION_CAPABILITIES)[number];

export const COUNT_QUALITIES = [
  'complete',
  'estimated',
  'permission_limited',
  'not_enumerable',
  'unknown',
] as const;
export type CountQuality = (typeof COUNT_QUALITIES)[number];

export interface CapabilityWords {
  /** The chip on the inventory row. */
  readonly label: string;
  /** The sentence under it. */
  readonly blurb: string;
  /** Whether a count next to this chip means what a count normally means. */
  readonly countsReal: boolean;
}

export const CAPABILITY_WORDS: Record<MigrationCapability, CapabilityWords> = {
  ready: {
    label: 'Ready',
    blurb: 'Comes across as it is.',
    countsReal: true,
  },
  needs_review: {
    label: 'Needs a look',
    blurb: 'Comes across, with one thing that does not fit exactly. We say which.',
    countsReal: true,
  },
  action_required: {
    label: 'Needs you afterwards',
    blurb: 'The history comes across. Something has to be reconnected before it works live.',
    countsReal: true,
  },
  port_required: {
    label: 'Your carrier moves it',
    blurb: 'We find the number. Moving it is a carrier process you start and we track.',
    countsReal: true,
  },
  not_available: {
    label: 'The old system will not give it',
    blurb: 'Either its API does not offer this, or this sign-in cannot reach it.',
    countsReal: false,
  },
  not_supported: {
    label: 'Nowhere to put it yet',
    blurb:
      'The old system has this and HandsFreeOS does not. We are counting how often it comes up.',
    countsReal: true,
  },
  not_imported: {
    label: 'Left out on purpose',
    blurb: 'We read it to check nothing is missing, and never rebuild it.',
    countsReal: true,
  },
  not_in_release: {
    label: 'Not yet',
    blurb: 'Counted so you know what is there. Not brought across in this release.',
    countsReal: true,
  },
};

export const COUNT_QUALITY_WORDS: Record<CountQuality, string> = {
  complete: 'Counted',
  estimated: 'About',
  permission_limited: 'This sign-in cannot see all of these',
  not_enumerable: 'The old system will not count these',
  unknown: 'Not counted yet',
};

/**
 * How to show a count. A count nobody was allowed to make is never shown as a number, because a person
 * reading "0" would reasonably conclude there are none — which is the one thing we must never imply.
 */
export function countWords(count: number, quality: CountQuality): string {
  switch (quality) {
    case 'complete':
      return count.toLocaleString();
    case 'estimated':
      return `about ${count.toLocaleString()}`;
    case 'permission_limited':
      return count > 0 ? `at least ${count.toLocaleString()}` : 'not visible to this sign-in';
    case 'not_enumerable':
      return 'not counted by the old system';
    case 'unknown':
      return '—';
  }
}

/** Whether a category with this status will put anything at all into the business. */
export function willImport(capability: MigrationCapability): boolean {
  return (
    capability === 'ready' || capability === 'needs_review' || capability === 'action_required'
  );
}

/** The six groups the customer's report puts findings into, in the order they are shown. */
export const FINDING_GROUPS = [
  { id: 'ready', title: 'Ready to bring across' },
  { id: 'differences', title: 'Comes across, with differences' },
  { id: 'action', title: 'Needs you to do something afterwards' },
  { id: 'unreadable', title: 'The old system will not give us this' },
  { id: 'unsupported', title: 'HandsFreeOS cannot hold this yet' },
  { id: 'excluded', title: 'Left out on purpose' },
] as const;
export type FindingGroup = (typeof FINDING_GROUPS)[number]['id'];

export function findingGroupOf(capability: MigrationCapability): FindingGroup {
  switch (capability) {
    case 'ready':
      return 'ready';
    case 'needs_review':
      return 'differences';
    case 'action_required':
    case 'port_required':
      return 'action';
    case 'not_available':
      return 'unreadable';
    case 'not_supported':
      return 'unsupported';
    case 'not_imported':
    case 'not_in_release':
      return 'excluded';
  }
}
