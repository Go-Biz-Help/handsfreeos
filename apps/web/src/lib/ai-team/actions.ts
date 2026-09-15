/**
 * Every change the AI teammate pages make, in one place: create it, save its settings over the revision
 * they started from, restore a revision, switch its status, and read it and its activity again. Refusals
 * come back as ApiErrors: `revision_conflict` when someone saved first, `teammate_issues` when red items
 * stop it being turned on.
 */
import type { DisclosureMode, TeammateConfig, TeammatePresetKey } from '@hfos/core';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { AiTeammateSaveBody, AiTeammateSaveOut } from '@/lib/api/types';
import {
  teammateGetOf,
  type ActivityPeriod,
  type TeammateActivity,
  type TeammateGet,
  type TeammateProgress,
  type TeammateStatus,
} from './types';

export interface TeammateActions {
  create(input: {
    preset: TeammatePresetKey;
    name: string;
    disclosure: DisclosureMode;
  }): Promise<{ teammateId: string; revision: number }>;
  /** Saves over `baseRevision`; a stale one rejects with the API's `revision_conflict`. */
  saveConfig(input: {
    teammateId: string;
    baseRevision: number;
    config: TeammateConfig;
  }): Promise<AiTeammateSaveOut>;
  /** Saves an old revision's settings again as a new revision. Training progress never changes. */
  restore(input: {
    teammateId: string;
    revision: number;
    baseRevision: number;
  }): Promise<AiTeammateSaveOut>;
  setStatus(input: {
    teammateId: string;
    status: TeammateStatus;
  }): Promise<{ progress: TeammateProgress }>;
  load(): Promise<TeammateGet>;
  /** One period's runs, from the cursor on. */
  activity(input: { cursor: string | null; since: ActivityPeriod }): Promise<TeammateActivity>;
}

export function teammateActions(workspaceId: string): TeammateActions {
  // Made when first used: the builder creates these while it renders, on the server too.
  const api = () => apiBrowser();
  return {
    create: async (input) =>
      unwrap(
        await api().POST('/v1/commands/ai_teammate.create', { body: { workspaceId, ...input } }),
      ),
    saveConfig: async ({ teammateId, baseRevision, config }) =>
      unwrap(
        await api().POST('/v1/commands/ai_teammate.save_config', {
          body: {
            workspaceId,
            teammateId,
            baseRevision,
            config: config as unknown as AiTeammateSaveBody['config'],
          },
        }),
      ),
    restore: async (input) =>
      unwrap(
        await api().POST('/v1/commands/ai_teammate.restore', { body: { workspaceId, ...input } }),
      ),
    setStatus: async (input) =>
      unwrap(
        await api().POST('/v1/commands/ai_teammate.set_status', {
          body: { workspaceId, ...input },
        }),
      ),
    load: async () =>
      teammateGetOf(
        unwrap(await api().POST('/v1/queries/ai_teammate.get', { body: { workspaceId } })),
      ),
    activity: async ({ cursor, since }) =>
      unwrap(
        await api().POST('/v1/queries/ai_teammate.activity', {
          body: { workspaceId, since, ...(cursor ? { cursor } : {}) },
        }),
      ),
  };
}
