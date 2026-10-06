import type { paths } from '@hfos/api-client';
import {
  AiSetupFinishOutput,
  aiSetupFindingsOf,
  AiSetupGetOutput,
  AiSetupSaveOutput,
  type AiSetupAnswers,
  type AiSetupFinding,
  type AiSetupStep,
} from '@hfos/core';

import { api, unwrap } from '@/lib/api';
import { config } from '@/lib/config';

/**
 * Quick setup's calls from the phone (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §7–§8), as the web's
 * lib/ai-setup/actions.ts makes them: where it stands, keeping the answers as each screen is finished, Save, what the
 * website scan found, an answer added from the test chat, and turning the teammate on. All of them need signal: none
 * goes into the queue of changes, because each answer depends on what the server says next.
 */

/** What a command takes, from the API's own description of it. */
type In<P extends keyof paths> = paths[P] extends {
  post: { requestBody?: { content: { 'application/json': infer B } } };
}
  ? B
  : never;

export type AiSetupGot = ReturnType<typeof AiSetupGetOutput.parse>;
export type AiSetupSaved = ReturnType<typeof AiSetupSaveOutput.parse>;
export type AiSetupFinished = ReturnType<typeof AiSetupFinishOutput.parse>;

/** The first screen's answers, saved to the business straight away. */
export interface AiSetupBusiness {
  readonly name?: string;
  readonly industry?: string;
  /** As typed. Null: "We don’t have one". */
  readonly website?: string | null;
}

export function aiSetupCalls(workspaceId: string) {
  return {
    /** Read through core's schema, so every default is filled in and core's functions take it as it is. */
    get: async (): Promise<AiSetupGot> =>
      AiSetupGetOutput.parse(
        unwrap(await api.POST('/v1/queries/ai_setup.get', { body: { workspaceId } })),
      ),
    save: async (input: {
      step: AiSetupStep;
      answers: AiSetupAnswers;
      business?: AiSetupBusiness;
    }): Promise<AiSetupSaved> =>
      AiSetupSaveOutput.parse(
        unwrap(
          await api.POST('/v1/commands/ai_setup.save', {
            body: {
              workspaceId,
              step: input.step,
              answers: input.answers as unknown as In<'/v1/commands/ai_setup.save'>['answers'],
              ...(input.business
                ? {
                    business: input.business as In<'/v1/commands/ai_setup.save'>['business'],
                  }
                : {}),
            },
          }),
        ),
      ),
    finish: async (input: {
      answers: AiSetupAnswers;
      baseRevision: number | null;
    }): Promise<AiSetupFinished> =>
      AiSetupFinishOutput.parse(
        unwrap(
          await api.POST('/v1/commands/ai_setup.finish', {
            body: {
              workspaceId,
              answers: input.answers as unknown as In<'/v1/commands/ai_setup.finish'>['answers'],
              baseRevision: input.baseRevision,
            },
          }),
        ),
      ),
    /** What the newest website scan found that's still waiting. */
    findings: async (): Promise<AiSetupFinding[]> => {
      const { scan } = unwrap(
        await api.POST('/v1/queries/knowledge_scan.get', { body: { workspaceId } }),
      );
      if (!scan) return [];
      const { items } = unwrap(
        await api.POST('/v1/queries/knowledge_suggestion.list', {
          body: { workspaceId, scanId: scan.id, status: 'pending', limit: 100 },
        }),
      );
      return aiSetupFindingsOf(items);
    },
    /** "Add the answer" on the test chat: a published answer the teammate can use straight away. */
    addAnswer: async (question: string, answer: string): Promise<void> => {
      unwrap(
        await api.POST('/v1/commands/knowledge_item.create', {
          body: { workspaceId, content: { kind: 'faq', question, answer }, status: 'published' },
        }),
      );
    },
    turnOn: async (teammateId: string): Promise<void> => {
      unwrap(
        await api.POST('/v1/commands/ai_teammate.set_status', {
          body: { workspaceId, teammateId, status: 'training' },
        }),
      );
    },
    /**
     * Where the website chat's code loads from: the business's own domain once it's serving, else HandsFreeOS's
     * address, as the web's chat page says. A failed look-up gives HandsFreeOS's: code that works beats none.
     */
    chatOrigin: async (): Promise<string> => {
      try {
        const { domain } = unwrap(
          await api.POST('/v1/queries/branded_domain.get', { body: { workspaceId } }),
        );
        return domain && domain.status === 'verified' && domain.certificateReady
          ? `https://${domain.domain}`
          : config.webUrl;
      } catch {
        return config.webUrl;
      }
    },
  };
}

export type AiSetupCalls = ReturnType<typeof aiSetupCalls>;
