/**
 * Social Outreach in the worker (docs/addon-architecture.md): what it does when something happens in a business, its own
 * jobs, and what it does as it arrives, turns on or off and leaves. The worker hands it work only while it's on,
 * and everything it does through the kernel (with `ctx.actor`) is refused the moment it's turned off.
 *
 * Every hook must be safe to run again: a hook that throws is retried, and the move isn't finished until it
 * succeeds. Declare in the manifest what's here: `events.consumes` for each subscriber, `jobs` for each job,
 * `resources` for what it makes at a provider (and then `releaseResource`).
 */
import { catalogAddon } from '@hfos/core/server';
import type { AddonWorkerModule } from '../types';

export const outreachAddonWorker: AddonWorkerModule = {
  manifest: catalogAddon('outreach'),
  // subscribers: { 'person.updated': async (ctx) => { … } },
  // jobs: { 'outreach.daily': async (ctx) => { … } },
  // onEnable: arm recurring jobs with scheduleAddonJob, from now: nothing that came due while it was off runs late.
};
