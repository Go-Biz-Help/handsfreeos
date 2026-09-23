import { type Grants } from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';

import { useBusiness } from '@/components/shell/business-context';

/** The person's own access row for the business open now (me_v1): their role, and what they may do (0105). */
export const MY_ACCESS_SQL = `
  SELECT role, permissions FROM workspace_access WHERE workspace_id = ? AND user_id = ? LIMIT 1`;

/** A synced `text[]` arrives as a JSON array; anything else is "not known yet". */
export function permissionsOf(json: string | null | undefined): string[] | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : null;
  } catch {
    return null;
  }
}

/**
 * What this person may do in the business open now (0105). The synced `workspace_access` row is the truth — it is
 * what the sync rules themselves read — then what `account.me` said when the phone last asked, and failing both
 * (an older copy) their role's defaults, which is what `holds` falls back to.
 */
export function useGrants(): Grants {
  const { business, me } = useBusiness();
  const { data } = useQuery<{ role: string | null; permissions: string | null }>(MY_ACCESS_SQL, [
    business.id,
    me.user.id,
  ]);
  const row = data[0];
  const role = (row?.role ?? business.role) as Grants['role'];
  const found = permissionsOf(row?.permissions) ?? business.permissions ?? null;
  // Stable while nothing changes, so screens that depend on it don't redo their work on every copy update.
  const key = found ? JSON.stringify(found) : null;
  const permissions = React.useMemo(
    () => (key === null ? null : (JSON.parse(key) as string[])),
    [key],
  );
  return React.useMemo(() => ({ role, permissions }), [role, permissions]);
}
