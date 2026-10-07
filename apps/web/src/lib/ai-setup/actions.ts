'use client';
/**
 * Quick setup's calls from the browser (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §7): where it stands,
 * keeping the answers as each screen is finished, Save, and what the website scan found for "What Ava learned".
 */
import {
  AiSetupFinishOutput,
  aiSetupFindingsOf,
  AiSetupSaveOutput,
  type AiSetupAnswers,
  type AiSetupFinding,
  type AiSetupStep,
} from '@hfos/core';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { AiSetupFinishBody, AiSetupSaveBody } from '@/lib/api/types';
import { aiSetupGotOf, type AiSetupFinished, type AiSetupGot, type AiSetupSaved } from './data';

/** The first screen's answers, saved to the business straight away. */
export interface AiSetupBusiness {
  readonly name?: string;
  readonly industry?: string;
  /** As typed. Null: "We don’t have one". */
  readonly website?: string | null;
}

export function aiSetupActions(workspaceId: string) {
  // Made when first used: the screens create these while they render, on the server too.
  const api = () => apiBrowser();
  return {
    get: async (): Promise<AiSetupGot> =>
      aiSetupGotOf(unwrap(await api().POST('/v1/queries/ai_setup.get', { body: { workspaceId } }))),
    save: async (input: {
      step: AiSetupStep;
      answers: AiSetupAnswers;
      business?: AiSetupBusiness;
      /** The first screen's "Start from": saved answers, or null for our picks. Left out: as it was. */
      templateId?: string | null;
    }): Promise<AiSetupSaved> =>
      AiSetupSaveOutput.parse(
        unwrap(
          await api().POST('/v1/commands/ai_setup.save', {
            body: {
              workspaceId,
              step: input.step,
              answers: input.answers as unknown as AiSetupSaveBody['answers'],
              ...(input.business
                ? { business: input.business as AiSetupSaveBody['business'] }
                : {}),
              ...(input.templateId !== undefined ? { templateId: input.templateId } : {}),
            },
          }),
        ),
      ),
    /** "Save these answers for your other businesses", for the agency's owners and admins. */
    saveForOthers: async (organizationId: string, name: string) =>
      unwrap(
        await api().POST('/v1/commands/ai_setup_template.save', {
          body: { organizationId, workspaceId, name },
        }),
      ),
    finish: async (input: {
      answers: AiSetupAnswers;
      baseRevision: number | null;
      /** Where the simple page is shown, for a chat on it. */
      pageOrigin?: string;
    }): Promise<AiSetupFinished> =>
      AiSetupFinishOutput.parse(
        unwrap(
          await api().POST('/v1/commands/ai_setup.finish', {
            body: {
              workspaceId,
              answers: input.answers as unknown as AiSetupFinishBody['answers'],
              baseRevision: input.baseRevision,
              ...(input.pageOrigin ? { pageOrigin: input.pageOrigin } : {}),
            },
          }),
        ),
      ),
    /** What the newest website scan found that's still waiting. */
    findings: async (): Promise<AiSetupFinding[]> => {
      const { scan } = unwrap(
        await api().POST('/v1/queries/knowledge_scan.get', { body: { workspaceId } }),
      );
      if (!scan) return [];
      const { items } = unwrap(
        await api().POST('/v1/queries/knowledge_suggestion.list', {
          body: { workspaceId, scanId: scan.id, status: 'pending', limit: 100 },
        }),
      );
      return aiSetupFindingsOf(items);
    },
    /** "Add the answer" on the test report: a published answer Ava can use straight away. */
    addAnswer: async (question: string, answer: string): Promise<void> => {
      unwrap(
        await api().POST('/v1/commands/knowledge_item.create', {
          body: { workspaceId, content: { kind: 'faq', question, answer }, status: 'published' },
        }),
      );
    },
    turnOn: async (teammateId: string): Promise<void> => {
      unwrap(
        await api().POST('/v1/commands/ai_teammate.set_status', {
          body: { workspaceId, teammateId, status: 'training' },
        }),
      );
    },
  };
}

export type AiSetupActions = ReturnType<typeof aiSetupActions>;
