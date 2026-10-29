/**
 * The towns near the person's own on Alignable (../towns.ts, docs/outreach.md decision 115), server side: worked out
 * from where the US Census Bureau puts each town (../us-towns.ts), as the crow flies. Each person's own turn through
 * them. Server-only.
 */
import { sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { requireHuman } from '../../../kernel/actor';
import { defineAddonQuery } from '../../server';
import { outreachAddon } from '../manifest';
import { dayNumber } from '../posts';
import { FindsTownsInput, FindsTownsOutput, NEAR_MILES, NEAR_TOWNS_MOST, townKey } from '../towns';
import { US_TOWNS } from '../us-towns';
import { inWorkspace } from './common';

interface Town {
  readonly town: string;
  readonly key: string;
  readonly lat: number;
  readonly lon: number;
}

let known: { readonly all: readonly Town[]; readonly byKey: ReadonlyMap<string, Town> } | null =
  null;

/** Every town, read once: each as Alignable writes it with its state ("round-rock-tx"), and where it is in degrees. */
function towns() {
  if (known) return known;
  const all: Town[] = [];
  for (const [state, list] of Object.entries(US_TOWNS))
    for (const entry of list.split('|')) {
      const [name, lat, lon] = entry.split(' ');
      if (!name || !lat || !lon) continue;
      const town = `${name}-${state}`;
      all.push({ town, key: townKey(town), lat: Number(lat) / 100, lon: Number(lon) / 100 });
    }
  known = { all, byKey: new Map(all.map((t) => [t.key, t])) };
  return known;
}

const EARTH_MILES = 3958.8;
const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** How far apart two places are, in miles, as the crow flies. */
export function milesApart(
  a: { readonly lat: number; readonly lon: number },
  b: { readonly lat: number; readonly lon: number },
): number {
  const dLat = radians(b.lat - a.lat);
  const dLon = radians(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The towns within `NEAR_MILES` of one, the closest first, up to `NEAR_TOWNS_MOST`: none for a town not known. */
export function townsNear(town: string): string[] {
  const { all, byKey } = towns();
  const here = byKey.get(townKey(town));
  if (!here) return [];
  // A quick box first: a degree of latitude is about 69 miles, one of longitude less away from the equator.
  const dLat = NEAR_MILES / 69;
  const dLon = NEAR_MILES / (69 * Math.max(0.2, Math.cos(radians(here.lat))));
  return all
    .filter(
      (t) =>
        t.key !== here.key &&
        Math.abs(t.lat - here.lat) <= dLat &&
        Math.abs(t.lon - here.lon) <= dLon,
    )
    .map((t) => ({ town: t.town, miles: milesApart(here, t) }))
    .filter((t) => t.miles <= NEAR_MILES)
    .sort((a, b) => a.miles - b.miles || a.town.localeCompare(b.town))
    .slice(0, NEAR_TOWNS_MOST)
    .map((t) => t.town);
}

export const findsTowns = defineAddonQuery(outreachAddon, {
  name: 'outreach.finds.towns',
  description:
    'The towns within 25 miles of the person’s own town on Alignable, the closest first, which the person’s computer keeps the businesses its search shows in, and today’s one of them to search in too, each in turn from the closest. None for a town HandsFreeOS doesn’t know the place of (outside the US).',
  input: FindsTownsInput,
  output: FindsTownsOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const near = townsNear(input.town);
    if (!near.length) return { near, today: null };
    // In turn from the closest, from the person's first day on Alignable (else the day's number).
    const [started] = await rows<{ first_at: Date | string }>(
      ctx.tx,
      sql`select first_at from addon_outreach.network_starts
          where workspace_id = ${ctx.scope.workspaceId!} and user_id = ${me} and platform = 'alignable'`,
    );
    const now = Date.now();
    const turn = dayNumber(now) - (started ? dayNumber(new Date(started.first_at).getTime()) : 0);
    return { near, today: near[Math.max(0, turn) % near.length]! };
  },
});

export const townQueries = [findsTowns] as const;
