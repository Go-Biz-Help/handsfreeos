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

/** Today's counters and the runs of one period, newest first. */
export type TeammateActivity = AiTeammateActivity;
/** One reply job ("AI run"): what started it, what it used, and how it came out. */
export type TeammateRun = AiTeammateActivity['runs'][number];
export type TeammateToolCall = TeammateRun['toolCalls'][number];
export type RunStatus = TeammateRun['status'];
export type RunOutcome = NonNullable<TeammateRun['outcome']>;

/** Activity's periods: today, or the last 7 or 30 days (the page's `?period=`). */
export type ActivityPeriod = 'today' | '7d' | '30d';

export const activityPeriodOf = (v: unknown): ActivityPeriod =>
  v === '7d' || v === '30d' ? v : 'today';
