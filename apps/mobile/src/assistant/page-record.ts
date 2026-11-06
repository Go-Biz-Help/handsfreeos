import {
  assistantPageRecord,
  AssistantPageRecord,
  assistantScreenPath,
  type PageRecord,
} from '@hfos/core';
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

/**
 * The screen the mark is pressed on, inside the business, as the web sends it: its address and its query string.
 * The screen's own route params (the business, the person) are in the address already, so they're left out of the
 * query.
 */
export function usePhoneScreenPath(workspaceId: string): string | null {
  const pathname = usePathname();
  const params = useLocalSearchParams();
  return React.useMemo(() => {
    const inPath = new Set(pathname.split('/'));
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params))
      for (const one of [value].flat())
        if (typeof one === 'string' && !inPath.has(one)) query.append(key, one);
    return assistantScreenPath(pathname, workspaceId, query.toString());
  }, [params, pathname, workspaceId]);
}

/** Where the mark goes: Ask HandsFreeOS, carrying the record the screen was showing and the screen itself. */
export function askHref(
  workspaceId: string,
  record: PageRecord | null,
  screen: string | null = null,
): string {
  const query = [
    ...(record ? [`type=${record.type}`, `id=${record.id}`] : []),
    ...(screen ? [`from=${encodeURIComponent(screen)}`] : []),
  ];
  const base = businessHref(workspaceId, 'ask');
  return query.length ? `${base}?${query.join('&')}` : base;
}

/** The screen back from the address, or null when the mark didn't carry one. */
export const screenPathOf = (from: string | undefined): string | null =>
  typeof from === 'string' && from.startsWith('/') ? from : null;

/** The record back from the address, or null when the mark was pressed somewhere without one. */
export function pageRecordOf(params: { type?: string; id?: string }): PageRecord | null {
  const parsed = AssistantPageRecord.safeParse({ type: params.type, id: params.id });
  return parsed.success ? parsed.data : null;
}
