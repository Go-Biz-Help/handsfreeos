/**
 * Your profile, checked by the AI (docs/outreach.md, decision 64; packages/core/src/addons/outreach/profile-check.ts):
 * the person's extension read their own Facebook profile and sends what it read here (`outreach.profile.check`); the
 * AI scores it against the checklist with the business's live main offer beside it, and only its answer is kept, on
 * the person's setup row (`outreach.profile.check_save`). What the page said goes no further than this call. It counts
 * against the business's daily AI limit like any other use.
 */
import { profileCheckSave } from '@hfos/core/addons/outreach/ops/readiness';
import {
  checkedProfileCheck,
  PROFILE_CHECK_SCHEMA,
  PROFILE_CHECK_SYSTEM,
  ProfileCheckAnswer,
  profileCheckPrompt,
  ProfileRead,
  type ProfileCheck,
} from '@hfos/core/addons/outreach/profile-check';
import { executeCommand } from '@hfos/core/server';
import { askStructured } from '../../ai/ask';
import type { AddonWorkerAction } from '../types';
import { aiFailure, liveMainOffer } from './assist';

export const PROFILE_CHECK_ACTION = 'outreach.profile.check';

export const profileCheck: AddonWorkerAction<ProfileRead> = {
  permission: 'outreach.use',
  input: ProfileRead,
  async run(ctx, raw): Promise<ProfileCheck> {
    const read = ProfileRead.parse(raw);
    const live = await liveMainOffer(ctx);
    let check: ProfileCheck;
    try {
      const { value } = await askStructured(ctx, ctx.scope, {
        system: PROFILE_CHECK_SYSTEM,
        messages: [{ role: 'user', content: profileCheckPrompt(read, live?.offer ?? null) }],
        schema: PROFILE_CHECK_SCHEMA,
        zod: ProfileCheckAnswer,
        maxTokens: 1200,
        usage: { source: 'addon', addonId: ctx.manifest.id },
      });
      check = checkedProfileCheck(value, read, new Date().toISOString(), live?.version ?? null);
    } catch (e) {
      throw aiFailure(e);
    }
    await executeCommand(
      ctx.db,
      profileCheckSave,
      { workspaceId: ctx.scope.workspaceId, userId: ctx.userId, check },
      ctx.actor,
      ctx.meta,
    );
    return check;
  },
};
