import { useQuery } from '@powersync/react-native';
import * as React from 'react';

import { activeCheckIn, type ActiveCheckIn, type CheckInRow } from './check-in';

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
