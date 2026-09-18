import { useQuery } from '@powersync/react-native';
import * as React from 'react';

import { useBusiness } from '@/components/shell/business-context';
import type { OutboxRow } from '@/changes/outbox';
import type { PhotoRow } from '@/changes/photos';
import { refusalWords } from '@/changes/describe';
import { SENT_SHOWN_MS } from '@/changes/rules';

import { CRM_OUTBOX_SQL, PHOTOS_SQL } from './queries';

/**
 * This phone's own changes to customers, companies, leads, tasks, notes, tags and files, over the rows in the copy.
 *
 * A change here writes what the person should see straight into the copy in the same transaction (`optimistic`), so
 * the note is in the timeline and the moved lead is in its new stage the instant they press. What the outbox adds is
 * **where each change stands**: still waiting for signal, uploading on its own, or refused with the API's words. The
 * screens wear that as a quiet mark beside the row, which is how a change made with no signal stays visible where it
 * was made.
 */

const PENDING: ReadonlySet<string> = new Set(['waiting', 'sending', 'held', 'ask', 'retry']);

export interface RecordChange {
  readonly row: OutboxRow;
  readonly input: Readonly<Record<string, unknown>>;
  /** The record it is about: a person, company, lead, task, tag, note or file id. */
  readonly about: readonly string[];
  readonly waiting: boolean;
  readonly refused: boolean;
  /** The API's words for a refusal. */
  readonly why: string | null;
}

export function inputOf(row: Pick<OutboxRow, 'input'>): Readonly<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(row.input);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const ids = (input: Readonly<Record<string, unknown>>, keys: readonly string[]): string[] =>
  keys.map((k) => input[k]).filter((v): v is string => typeof v === 'string' && v.length > 0);

/** Which record ids a change is about, so a screen can ask "is anything of mine still waiting?". */
export function aboutOf(row: OutboxRow, input: Readonly<Record<string, unknown>>): string[] {
  return ids(input, [
    'id',
    'personId',
    'companyId',
    'leadId',
    'taskId',
    'recordId',
    'activityId',
    'fileId',
    'tagId',
  ]).concat(row.name.startsWith('file.') ? ids(input, ['recordId']) : []);
}

export function recordChangeOf(row: OutboxRow): RecordChange {
  const input = inputOf(row);
  const refused = row.state === 'refused';
  return {
    row,
    input,
    about: aboutOf(row, input),
    waiting: PENDING.has(row.state),
    refused,
    why: refused ? refusalWords(row.answer, null) : null,
  };
}

/** Every CRM change on this phone for the business on screen, not through or sent just now. */
export function useRecordChanges(): readonly RecordChange[] {
  const { business } = useBusiness();
  const since = React.useMemo(() => new Date(Date.now() - SENT_SHOWN_MS).toISOString(), []);
  const { data } = useQuery<OutboxRow>(CRM_OUTBOX_SQL, [business.id, since]);
  return React.useMemo(() => data.map(recordChangeOf), [data]);
}

/** What this phone still has to say about one record: whether anything waits, and the first refusal to show. */
export interface RecordState {
  readonly waiting: number;
  readonly refused: RecordChange | null;
}

export function stateOf(changes: readonly RecordChange[], recordId: string): RecordState {
  const mine = changes.filter((c) => c.about.includes(recordId));
  return {
    waiting: mine.filter((c) => c.waiting).length,
    refused: mine.find((c) => c.refused) ?? null,
  };
}

/** The photos this phone is uploading, by the record they belong to. */
export function usePhotoUploads(): readonly PhotoRow[] {
  const { data } = useQuery<PhotoRow>(PHOTOS_SQL);
  return data;
}
