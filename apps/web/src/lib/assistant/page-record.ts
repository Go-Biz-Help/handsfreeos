'use client';
import { assistantPageRecord, type PageRecord } from '@hfos/core';
import { usePathname, useSearchParams } from 'next/navigation';
import { useMemo } from 'react';

/**
 * The record on screen. Each question carries it, so "text him" means the customer whose page is open. Which page
 * holds which record lives in `@hfos/core` (M10 step 17), because the phone's screens sit at the same addresses.
 */
export type PageRecordType = PageRecord['type'];
export type { PageRecord };
export { assistantPageRecord as pageRecord };

export function usePageRecord(workspaceId: string): PageRecord | null {
  const pathname = usePathname();
  const appt = useSearchParams().get('appt');
  return useMemo(
    () => assistantPageRecord(pathname, workspaceId, appt),
    [pathname, workspaceId, appt],
  );
}
