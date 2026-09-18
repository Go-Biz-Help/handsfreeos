import { assistantPageRecord, AssistantPageRecord, type PageRecord } from '@hfos/core';
import { useLocalSearchParams, usePathname } from 'expo-router';
import * as React from 'react';

import { businessHref } from '@/components/shell/business-context';

/**
 * The record the screen is showing when the mark is pressed, so "text her that we're on our way" means the customer
 * whose screen is open, exactly as it does on the web. The phone's screens sit at the web's own addresses, so both
 * read it with core's `assistantPageRecord`; the mark carries it to Ask HandsFreeOS on the address.
 */
export type { PageRecord };

export function usePhonePageRecord(workspaceId: string): PageRecord | null {
  const pathname = usePathname();
  const { appt } = useLocalSearchParams<{ appt?: string }>();
  return React.useMemo(
    () => assistantPageRecord(pathname, workspaceId, appt ?? null),
    [appt, pathname, workspaceId],
  );
}

/** Where the mark goes: Ask HandsFreeOS, carrying the record the screen was showing. */
export function askHref(workspaceId: string, record: PageRecord | null): string {
  const base = businessHref(workspaceId, 'ask');
  return record ? `${base}?type=${record.type}&id=${record.id}` : base;
}

/** The record back from the address, or null when the mark was pressed somewhere without one. */
export function pageRecordOf(params: { type?: string; id?: string }): PageRecord | null {
  const parsed = AssistantPageRecord.safeParse({ type: params.type, id: params.id });
  return parsed.success ? parsed.data : null;
}
