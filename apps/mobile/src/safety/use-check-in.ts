import { useQuery } from '@powersync/react-native';
import * as React from 'react';

import { deviceStore } from '@/lib/device-store';

import { activeCheckIn, OPEN_STATES, type ActiveCheckIn, type CheckInRow } from './check-in';
import { following, reconcileFollowing } from './follow';

/** The person's own check-ins in a business, from the phone's copy (records_v1), newest first. */
export const MY_CHECK_INS_SQL = `
  SELECT id, workspace_id, user_id, place, started_at, planned_end_at, state, appointment_id, extended_count
  FROM safety_checkins WHERE workspace_id = ? AND user_id = ?
  ORDER BY started_at DESC LIMIT 20`;

/** The person's safety contacts in a business, in their order. */
export const MY_SAFETY_CONTACTS_SQL = `
  SELECT id, contact_user_id, name, phone_e164, email, asked_at, agreed_at, stopped_at, position
  FROM safety_contacts WHERE workspace_id = ? AND user_id = ? ORDER BY position, created_at`;

/** The open check-in, re-read as the copy changes and each minute (it turns overdue on its own). */
export function useActiveCheckIn(workspaceId: string, userId: string): ActiveCheckIn | null {
  const { data } = useQuery<CheckInRow>(MY_CHECK_INS_SQL, [workspaceId, userId]);
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return React.useMemo(() => activeCheckIn(data, now), [data, now]);
}

const followedId = () => following()?.checkInId ?? null;

/** The check-in this phone is sharing where it is for, if any (`follow.ts`). */
export function useFollowedCheckIn(): string | null {
  return React.useSyncExternalStore(deviceStore.subscribe, followedId, followedId);
}

/**
 * Stops sharing where the phone is when the phone's copy says the check-in ended somewhere else: checked out on
 * another phone, or answered by the business. Only once the copy has been read, so an empty first answer stops nothing.
 */
export function useFollowEnds(workspaceId: string, userId: string): void {
  const { data, isLoading } = useQuery<CheckInRow>(MY_CHECK_INS_SQL, [workspaceId, userId]);
  const open = isLoading
    ? null
    : data
        .filter((r) => OPEN_STATES.includes(r.state))
        .map((r) => r.id)
        .join(',');
  React.useEffect(() => {
    if (open !== null) void reconcileFollowing(workspaceId, open ? open.split(',') : []);
  }, [workspaceId, open]);
}
