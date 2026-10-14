/**
 * AI Sales Coach in the worker (docs/salescoach.md, docs/addon-architecture.md): what it does with a call it hears
 * live (./live.ts), the write-up after (./after-call.ts), and a playbook to start from (./draft.ts). The worker
 * hands it work only while it's on, and everything it does through the kernel (with `ctx.actor`) is refused the
 * moment it's turned off.
 */
import { catalogAddon } from '@hfos/core/server';
import type { AddonWorkerModule } from '../types';
import { afterCall } from './after-call';
import { playbookDraft } from './draft';
import { AFTER_CALL_JOB, salescoachLiveCalls } from './live';

export const salescoachAddonWorker: AddonWorkerModule = {
  manifest: catalogAddon('salescoach'),
  liveCalls: salescoachLiveCalls,
  jobs: { [AFTER_CALL_JOB]: afterCall },
  actions: { 'salescoach.playbook.draft': playbookDraft },
};
