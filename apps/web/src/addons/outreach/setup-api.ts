/**
 * The setup's own calls and helpers (./setup-view.tsx): its saves, reading it afresh, and what core's helpers read of
 * it. Kept apart so the setup's screens share them without importing one another.
 */
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { Setup } from './types';

/** Chrome (or another Chromium browser) on a computer: where a build loaded by hand works. A hint, never a block. */
export function isDesktopChrome(userAgent: string): boolean {
  return /Chrome\//.test(userAgent) && !/Mobile|Android|CriOS/.test(userAgent);
}

/**
 * The setup as the API answers it. openapi-fetch's reading drops a key typed only `null` (a main step's `net` in
 * `next`), though the answer has it: the two calls here hand it on as its own type.
 */
export async function saveSetup(
  workspaceId: string,
  body: { finished?: true; started?: true; hideBanner?: true },
): Promise<Setup> {
  return unwrap(
    await apiBrowser().POST('/v1/commands/outreach.setup.save', { body: { workspaceId, ...body } }),
  ) as Setup;
}

export async function getSetup(workspaceId: string): Promise<Setup> {
  return unwrap(
    await apiBrowser().POST('/v1/queries/outreach.setup', { body: { workspaceId } }),
  ) as Setup;
}

/** The setup laid out, as core's helpers read it. */
export const laidOut = (s: Setup) => ({
  states: s.states,
  networks: s.networks,
  business: s.business,
});
