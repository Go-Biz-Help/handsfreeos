'use client';
import { parseConfig, type CalendarConfig } from '@hfos/core';
import { apiBrowser, unwrap } from '@/lib/api/client';

const TTL = 60_000;
const cache = new Map<string, { at: number; config: Promise<CalendarConfig> }>();

/** A calendar's settings (people, lengths, places, reminders), kept for a minute between screens. */
export function calendarConfig(workspaceId: string, calendarId: string): Promise<CalendarConfig> {
  const hit = cache.get(calendarId);
  if (hit && Date.now() - hit.at < TTL) return hit.config;
  const config = apiBrowser()
    .POST('/v1/queries/calendar.get', { body: { workspaceId, calendarId } })
    .then(unwrap)
    .then((out) => parseConfig(out.calendar.config));
  config.catch(() => cache.delete(calendarId));
  cache.set(calendarId, { at: Date.now(), config });
  return config;
}
