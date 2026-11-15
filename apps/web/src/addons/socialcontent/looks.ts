/**
 * The Calendar's look (List, Week or Month) is kept for the next visit in a cookie, so the page opens on it from the
 * server with no flash (the owner, 15 Nov: each person's last look is remembered). A plain module: the route reads it
 * on the server and the page writes it in the browser.
 */
import type { CalendarLook } from '@hfos/core/addons/socialcontent/calendar-looks';

export const LOOK_COOKIE = 'socialcontent-look';

/** Keeps the look picked for the next visit. */
export function rememberLook(look: CalendarLook) {
  document.cookie = `${LOOK_COOKIE}=${look}; path=/; max-age=31536000; samesite=lax`;
}

/** A day asked for in the address, when it's a real one. */
export function dayAsked(v: string | undefined): string | null {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const at = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== v ? null : v;
}
