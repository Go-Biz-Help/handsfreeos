import * as React from 'react';

import type { Staff } from '@/admin/staff';

export interface DeskContextValue {
  readonly userId: string;
  readonly staff: Staff;
}

const DeskContext = React.createContext<DeskContextValue | null>(null);

export const DeskProvider = DeskContext.Provider;

/** The support person on the desk, and what they may do. Only inside /app/admin. */
export function useDesk(): DeskContextValue {
  const value = React.useContext(DeskContext);
  if (!value) throw new Error('useDesk needs a DeskProvider (the /app/admin layout).');
  return value;
}

/** Whether the support person may do something, from the permissions `platform.me` gave. */
export function useDeskCan(permission: string): boolean {
  return useDesk().staff.permissions.includes(permission);
}

/** Where the desk's screens live, mirroring the web's /admin/…. */
export function deskHref(path = ''): `/app/admin${string}` {
  return `/app/admin${path ? `/${path}` : ''}`;
}
