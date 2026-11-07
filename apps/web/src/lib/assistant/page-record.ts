'use client';
import { assistantPageRecord, assistantScreenPath, type PageRecord } from '@hfos/core';
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
  const params = useSearchParams();
  const appt = params.get('appt');
  // The lead open in the pipeline board's side sheet.
  const lead = params.get('lead');
  return useMemo(
    () => assistantPageRecord(pathname, workspaceId, appt, lead),
    [pathname, workspaceId, appt, lead],
  );
}

/**
 * The screen itself, inside the business, with its query string: each question carries it too, so the Assistant
 * knows which page or setting is open (a calendar's settings, an invoice, the audit log), not only which record.
 */
export function useScreenPath(workspaceId: string): string | null {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  return useMemo(
    () => assistantScreenPath(pathname, workspaceId, search),
    [pathname, workspaceId, search],
  );
}
