/**
 * The playbook's short video, its script written by the AI (`outreach.video.script`, docs/outreach.md decision 69;
 * packages/core/src/addons/outreach/video.ts): every part from the live main offer and the playbook as it stands in
 * the builder, or one part again. Core holds what the model is asked and checks what it answers; nothing is saved
 * here, the builder puts the script on the playbook and its save keeps it. Owners and admins write the playbooks, so
 * it's theirs. It counts against the business's daily AI limit like any other use.
 */
import {
  checkedScript,
  VIDEO_SCRIPT_SCHEMA,
  VIDEO_SCRIPT_SYSTEM,
  videoOfferOf,
  VideoScriptAnswer,
  VideoScriptInput,
  videoScriptPrompt,
  type VideoOffer,
  type VideoScript,
} from '@hfos/core/addons/outreach/video';
import { HfosError, MainOfferParts } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { askStructured } from '../../ai/ask';
import type { AddonWorkerAction } from '../types';
import { aiFailure } from './assist';

export const VIDEO_SCRIPT_ACTION = 'outreach.video.script';

export const videoScript: AddonWorkerAction<VideoScriptInput> = {
  permission: 'outreach.manage',
  input: VideoScriptInput,
  async run(ctx, raw): Promise<VideoScript> {
    const input = VideoScriptInput.parse(raw);
    const ws = ctx.scope.workspaceId!;
    const { business, live } = await asWorker(ctx.db, ctx.scope, async (tx) => {
      const [b] = await rows<{ name: string }>(
        tx,
        sql`select name from app.workspaces where id = ${ws}`,
      );
      const [l] = await rows<{ version: number; parts: unknown }>(
        tx,
        sql`select v.version, v.parts from app.main_offers o
            join app.main_offer_versions v on v.workspace_id = o.workspace_id and v.version = o.live_version
            where o.workspace_id = ${ws}`,
      );
      return { business: b, live: l };
    });
    const parts = live ? MainOfferParts.safeParse(live.parts) : null;
    const offer: VideoOffer | null =
      live && parts?.success ? videoOfferOf(live.version, parts.data) : null;
    let script: VideoScript | null;
    try {
      const { value } = await askStructured(ctx, ctx.scope, {
        system: VIDEO_SCRIPT_SYSTEM,
        messages: [
          {
            role: 'user',
            content: videoScriptPrompt(input, business?.name ?? 'the business', offer),
          },
        ],
        schema: VIDEO_SCRIPT_SCHEMA,
        zod: VideoScriptAnswer,
        maxTokens: 2500,
        usage: { source: 'addon', addonId: ctx.manifest.id },
      });
      script = checkedScript(value, input, new Date(), offer?.version ?? null);
    } catch (e) {
      throw aiFailure(e);
    }
    if (!script)
      throw HfosError.rule(
        'ai_failed',
        502,
        'The AI couldn’t write your script just now. Try again in a minute, or write it yourself.',
      );
    return script;
  },
};
