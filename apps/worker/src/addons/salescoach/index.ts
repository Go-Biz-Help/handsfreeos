/**
 * AI Sales Coach in the worker (docs/salescoach.md, docs/addon-architecture.md): what it does with a call it hears
 * live (./live.ts), the write-up after (./after-call.ts), replies to suggest when a customer writes (./suggest.ts), and a
 * playbook to start from (./draft.ts). The worker
 * hands it work only while it's on, and everything it does through the kernel (with `ctx.actor`) is refused the
 * moment it's turned off.
 */
import { catalogAddon } from '@hfos/core/server';
import type { AddonWorkerModule } from '../types';
import { afterCall } from './after-call';
import { playbookDraft } from './draft';
import { AFTER_CALL_JOB, salescoachLiveCalls } from './live';
import { conversationQuiet, QUIET_JOB } from './quiet';
import { onCustomerWrote, SUGGEST_JOB, suggestReplies } from './suggest';

export const salescoachAddonWorker: AddonWorkerModule = {
  manifest: catalogAddon('salescoach'),
  liveCalls: salescoachLiveCalls,
  // A customer wrote: replies to suggest, once the burst settles (./suggest.ts).
  subscribers: { 'message.received': onCustomerWrote },
  // A customer wrote: replies to suggest, and a write-up once the conversation goes quiet (./quiet.ts).
  jobs: {
    [AFTER_CALL_JOB]: afterCall,
    [SUGGEST_JOB]: suggestReplies,
    [QUIET_JOB]: conversationQuiet,
  },
  actions: { 'salescoach.playbook.draft': playbookDraft },
};
