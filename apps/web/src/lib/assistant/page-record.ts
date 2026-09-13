'use client';
import { usePathname, useSearchParams } from 'next/navigation';
import { useMemo } from 'react';

export type PageRecordType = 'person' | 'company' | 'lead' | 'conversation' | 'appointment';

/** The record on screen. Each question carries it, so "text him" means the customer whose page is open. */
export interface PageRecord {
  readonly type: PageRecordType;
  readonly id: string;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ROUTES: readonly (readonly [PageRecordType, string])[] = [
  ['person', 'customers/people'],
  ['company', 'customers/companies'],
  ['lead', 'leads'],
  ['conversation', 'inbox'],
];

/**
 * /app/w/[ws]/customers/people/[id] is a person, customers/companies/[id] a company, leads/[id] a lead,
 * inbox/[id] a conversation, and /calendar?appt=[id] an appointment (the calendar keeps the open one in the
 * address bar). Every other page has no record.
 */
export function pageRecord(
  pathname: string,
  workspaceId: string,
  appt: string | null = null,
): PageRecord | null {
  const base = `/app/w/${workspaceId}/`;
  if (!pathname.startsWith(base)) return null;
  const rest = pathname.slice(base.length);
  if (/^calendar\/?$/.test(rest))
    return appt && new RegExp(`^${UUID}$`, 'i').test(appt)
      ? { type: 'appointment', id: appt.toLowerCase() }
      : null;
  for (const [type, prefix] of ROUTES) {
    const m = new RegExp(`^${prefix}/(${UUID})(?:/|$)`, 'i').exec(rest);
    if (m) return { type, id: m[1]!.toLowerCase() };
  }
  return null;
}

export function usePageRecord(workspaceId: string): PageRecord | null {
  const pathname = usePathname();
  const appt = useSearchParams().get('appt');
  return useMemo(() => pageRecord(pathname, workspaceId, appt), [pathname, workspaceId, appt]);
}
