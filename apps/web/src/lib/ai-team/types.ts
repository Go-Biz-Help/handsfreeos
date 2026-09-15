/**
 * What the AI teammate pages work with: the API's `ai_teammate.get` and `ai_teammate.activity`, with the
 * catalogs and issues typed as core's, so the builder's rules read them directly.
 */
import type { TeammateCatalogs, TeammateIssue } from '@hfos/core';
import type { AiTeammateActivity, AiTeammateGet } from '@/lib/api/types';

export type TeammateSummary = NonNullable<AiTeammateGet['teammate']>;
export type TeammateStatus = TeammateSummary['status'];
export type TeammateChannelKey = 'sms' | 'email' | 'chat';
/** Training-wheels progress. The counts live on the teammate, and only the database changes them. */
export type TeammateProgress = NonNullable<AiTeammateGet['progress']>;
export type TeammateRevision = AiTeammateGet['revisions'][number];

export interface TeammateGet extends Omit<AiTeammateGet, 'catalogs' | 'issues'> {
  readonly catalogs: TeammateCatalogs;
  readonly issues: readonly TeammateIssue[];
}

/** The API's answer as the pages use it. Its issue fixes carry settings patches as plain JSON. */
export function teammateGetOf(raw: AiTeammateGet): TeammateGet {
  return { ...raw, issues: raw.issues as unknown as TeammateIssue[] };
}

type RunOut = AiTeammateActivity['runs'][number];
export type RunStatus = RunOut['status'];
export type RunOutcome = NonNullable<RunOut['outcome']>;

/** One reply job ("AI run"): what started it, what it used, and how it came out. */
export interface TeammateRun extends RunOut {
  /** The conversation's channel. Not in the API yet; the list shows it when it arrives. */
  readonly channel?: TeammateChannelKey | null;
}

export interface TeammateActivityCounters extends Readonly<AiTeammateActivity['counters']> {
  /** Appointments it booked today. Not in the API yet; counted from today's runs until it is. */
  readonly bookedToday?: number;
}

export interface TeammateActivity {
  readonly counters: TeammateActivityCounters;
  /** Newest first. */
  readonly runs: readonly TeammateRun[];
  readonly nextCursor: string | null;
}
