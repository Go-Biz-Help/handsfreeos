import { businessHref } from '@/components/shell/business-context';

/**
 * The phone's Search everything screen, with what was typed when there is something (the Contacts and Inbox boxes'
 * "Search everything for “q”"). It stays in the app's own address, never sent anywhere.
 */
export function searchScreenHref(workspaceId: string, q = ''): string {
  const typed = q.trim().slice(0, 120);
  const base = businessHref(workspaceId, 'search');
  return typed ? `${base}?q=${encodeURIComponent(typed)}` : base;
}
