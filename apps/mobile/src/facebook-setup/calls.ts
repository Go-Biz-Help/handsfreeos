import {
  facebookSetupContextFrom,
  type FacebookSetupAnswers,
  type FacebookSetupContext,
} from '@hfos/core';

import { api, unwrap } from '@/lib/api';
import { config } from '@/lib/config';
import { NotInThisBuild } from '@/lib/not-in-this-build';

export { NotInThisBuild };

/** The answers as they were left, and when. */
export interface FacebookGuidedDraft {
  readonly answers: Record<string, unknown> | null;
  readonly savedAt: string | null;
}

/**
 * The guided Facebook & Instagram setup's calls from the phone (the owner, 24 Nov 2026, F4 a), as the web's page makes
 * them: what's connected and each channel's rules for someone new (the context core works the answers out from), the
 * answers as they were left, Connect with Facebook's save (facebook_setup.save), Facebook's sign-in through the worker,
 * and the live test's messages. All of them need signal.
 */
export function facebookSetupCalls(workspaceId: string) {
  const body = { body: { workspaceId } };
  return {
    load: async (): Promise<FacebookSetupContext> => {
      const [list, intake] = await Promise.all([
        api.POST('/v1/queries/meta_account.list', body).then(unwrap),
        api.POST('/v1/queries/intake.list', body).then(unwrap),
      ]);
      return facebookSetupContextFrom({
        accounts: list.accounts,
        connections: list.connections,
        sources: intake.sources,
        pipelines: intake.pipelines,
      });
    },
    /**
     * The answers as they were left (guided_setup.get_draft). Only a head start: a read that fails starts from the
     * first question.
     */
    draft: async (): Promise<FacebookGuidedDraft> => {
      try {
        const got = unwrap(
          await api.POST('/v1/queries/guided_setup.get_draft', {
            body: { workspaceId, setup: 'facebook' },
          }),
        );
        return { answers: got.answers ?? null, savedAt: got.savedAt ?? null };
      } catch {
        return { answers: null, savedAt: null };
      }
    },
    save: async (answers: FacebookSetupAnswers) =>
      unwrap(
        await api.POST('/v1/commands/facebook_setup.save', { body: { workspaceId, answers } }),
      ),
    /** Where Facebook's own sign-in starts, through the worker, which keeps what it gives back. */
    signIn: async (): Promise<string> => {
      if (!config.workerUrl) throw new NotInThisBuild();
      const { state } = unwrap(
        await api.POST('/v1/commands/meta_connection.connect', { body: { workspaceId } }),
      );
      return `${config.workerUrl}/oauth/facebook/start?state=${encodeURIComponent(state)}`;
    },
    testMessages: async (since: string) =>
      unwrap(
        await api.POST('/v1/queries/meta_account.test_messages', {
          body: { workspaceId, since },
        }),
      ).accounts,
  };
}

export type FacebookSetupCalls = ReturnType<typeof facebookSetupCalls>;
