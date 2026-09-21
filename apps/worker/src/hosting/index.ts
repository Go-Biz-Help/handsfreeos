import type { WorkerEnv } from '../env';
import { createFakeHost } from './fake';
import type { SiteHost } from './host';
import { createVercelHost } from './vercel';

export * from './host';
export { createFakeHost } from './fake';

/**
 * The host, or nothing (M17).
 *
 * **Null is a real answer**, not a missing one: a deployment with no token has not turned branded domains on,
 * and the honest thing is for the feature to be absent rather than present and permanently failing. Every
 * handler checks for it and stops, which is also what keeps a self-hosted copy of this repo from needing a
 * Vercel account to boot.
 */
export function createSiteHost(env: WorkerEnv): SiteHost | null {
  if (env.siteHost === 'off') return null;
  if (env.siteHost === 'fake') return createFakeHost();
  return createVercelHost({
    token: env.vercelToken!,
    projectId: env.vercelProjectId!,
    teamId: env.vercelTeamId,
  });
}
