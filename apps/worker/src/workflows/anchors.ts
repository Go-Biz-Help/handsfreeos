/**
 * Dates a run can be timed from (core's DATE_ANCHORS): reading one fresh from its record, and which events
 * set or move each, so the dispatcher can arm date triggers.
 */
import { DATE_ANCHORS, type DateAnchorKey } from '@hfos/core/server';
import { rows, sql, type Tx } from '@hfos/db/client';

/** The events that set or move each anchor. */
export const ANCHOR_EVENTS: Readonly<Record<string, readonly DateAnchorKey[]>> = {
  'appointment.booked': ['appointment.starts_at', 'appointment.ends_at'],
  'appointment.rescheduled': ['appointment.starts_at', 'appointment.ends_at'],
  'attendee.added': ['appointment.starts_at', 'appointment.ends_at'],
  'lead.created': ['lead.created_at', 'lead.stage_entered_at'],
  'lead.stage_changed': ['lead.stage_entered_at'],
  'lead.next_action_set': ['lead.next_action_at'],
  'person.created': ['person.created_at'],
};

export type AnchorRecord = (typeof DATE_ANCHORS)[DateAnchorKey]['record'];

export const anchorRecord = (anchor: DateAnchorKey): AnchorRecord => DATE_ANCHORS[anchor].record;

/**
 * When the anchor is now, or null when it's gone: the record deleted or archived, the appointment cancelled,
 * the next action cleared.
 */
export async function readAnchor(
  tx: Tx,
  workspaceId: string,
  anchor: DateAnchorKey,
  recordId: string | null,
): Promise<number | null> {
  if (!recordId) return null;
  const column = anchor.split('.')[1]!;
  let at: string | Date | null | undefined;
  if (anchor.startsWith('appointment.')) {
    const [a] = await rows<{ at: string | null }>(
      tx,
      sql`select ${sql.raw(column === 'starts_at' ? 'starts_at' : 'ends_at')} as at from app.appointments
          where id = ${recordId} and workspace_id = ${workspaceId} and status <> 'cancelled'`,
    );
    at = a?.at;
  } else if (anchor.startsWith('lead.')) {
    const col = {
      created_at: 'created_at',
      stage_entered_at: 'stage_entered_at',
      next_action_at: 'next_action_at',
    }[column];
    if (!col) return null;
    const [l] = await rows<{ at: string | null }>(
      tx,
      sql`select ${sql.raw(col)} as at from app.leads
          where id = ${recordId} and workspace_id = ${workspaceId} and archived_at is null`,
    );
    at = l?.at;
  } else {
    const [p] = await rows<{ at: string | null }>(
      tx,
      sql`select created_at as at from app.people
          where id = ${recordId} and workspace_id = ${workspaceId} and archived_at is null`,
    );
    at = p?.at;
  }
  return at ? new Date(at).getTime() : null;
}
