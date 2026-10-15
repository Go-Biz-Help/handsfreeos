/**
 * AI help on a playbook's parts, from the builder (`outreach.playbook.assist`, docs/outreach.md): better words for a
 * part, or more to add, from the rest of the playbook as it stands. Core holds what the model is asked and checks
 * what it answers (playbook-assist.ts); nothing is saved here, the person picks what to use. It counts against the
 * business's daily AI limit like any other use.
 */
import {
  checkedNicheFit,
  NICHE_FIT_SCHEMA,
  NICHE_FIT_SYSTEM,
  NicheFitAnswer,
  NicheFitInput,
  nicheFitPrompt,
  type NicheFitOutput,
} from '@hfos/core/addons/outreach/niche-fit';
import {
  checkedAssist,
  PLAYBOOK_ASSIST_SCHEMA,
  PLAYBOOK_ASSIST_SYSTEM,
  PlaybookAssistAnswer,
  PlaybookAssistInput,
  playbookAssistPrompt,
  playbookOffer,
  type PlaybookAssistOutput,
  type PlaybookOffer,
} from '@hfos/core/addons/outreach/playbook-assist';
import { HfosError, MainOfferParts } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import {
  AI_BUDGET_MESSAGE,
  AI_BUSY_MESSAGE,
  AI_UNAVAILABLE_MESSAGE,
  AiAskError,
  askStructured,
} from '../../ai/ask';
import type { AddonWorkerAction } from '../types';

export const PLAYBOOK_ASSIST_ACTION = 'outreach.playbook.assist';
export const NICHE_FIT_ACTION = 'outreach.playbook.niche_fit';

/**
 * The business's live main offer (core's, docs/main-offer.md), as the add-on's AI reads it, and its version; null
 * without one.
 */
export async function liveMainOffer(
  ctx: Parameters<AddonWorkerAction['run']>[0],
): Promise<{ readonly offer: PlaybookOffer; readonly version: number } | null> {
  const [live] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ parts: unknown; line: string; version: number }>(
      tx,
      sql`select v.parts, v.line, v.version from app.main_offers o
          join app.main_offer_versions v on v.workspace_id = o.workspace_id and v.version = o.live_version
          where o.workspace_id = ${ctx.scope.workspaceId}`,
    ),
  );
  const parts = live ? MainOfferParts.safeParse(live.parts) : null;
  return live && parts?.success
    ? { offer: playbookOffer(parts.data, live.line), version: live.version }
    : null;
}

const liveOffer = async (ctx: Parameters<AddonWorkerAction['run']>[0]) =>
  (await liveMainOffer(ctx))?.offer ?? null;

/** The AI's failures, in the words the builder shows. */
export function aiFailure(e: unknown): unknown {
  if (!(e instanceof AiAskError)) return e;
  if (e.code === 'budget_reached' || e.code === 'wallet_empty')
    return HfosError.rule('budget_reached', 429, e.message || AI_BUDGET_MESSAGE);
  if (e.code === 'ai_unavailable')
    return HfosError.rule('ai_not_configured', 503, AI_UNAVAILABLE_MESSAGE);
  if (e.retryable) return HfosError.rule('ai_busy', 503, AI_BUSY_MESSAGE);
  return HfosError.rule(
    'ai_failed',
    502,
    'The AI couldn’t help with that just now. Try again, or write it yourself.',
  );
}

export const playbookAssist: AddonWorkerAction<PlaybookAssistInput> = {
  permission: 'outreach.manage',
  input: PlaybookAssistInput,
  async run(ctx, raw): Promise<PlaybookAssistOutput> {
    const input = PlaybookAssistInput.parse(raw);
    const [[ws], offer] = await Promise.all([
      asWorker(ctx.db, ctx.scope, (tx) =>
        rows<{ name: string }>(
          tx,
          sql`select name from app.workspaces where id = ${ctx.scope.workspaceId}`,
        ),
      ),
      liveOffer(ctx),
    ]);
    try {
      const { value } = await askStructured(ctx, ctx.scope, {
        system: PLAYBOOK_ASSIST_SYSTEM,
        messages: [
          {
            role: 'user',
            content: playbookAssistPrompt(input, ws?.name ?? 'the business', offer),
          },
        ],
        schema: PLAYBOOK_ASSIST_SCHEMA,
        zod: PlaybookAssistAnswer,
        maxTokens: 1500,
        usage: { source: 'addon', addonId: ctx.manifest.id },
      });
      return checkedAssist(value, input);
    } catch (e) {
      throw aiFailure(e);
    }
  },
};

/**
 * Whether a playbook's niche fits the main offer (`outreach.playbook.niche_fit`): inside it, really a second offer,
 * or outside it. With no live main offer there's nothing to check against, and the AI isn't asked.
 */
export const nicheFit: AddonWorkerAction<NicheFitInput> = {
  permission: 'outreach.manage',
  input: NicheFitInput,
  async run(ctx, raw): Promise<NicheFitOutput> {
    const input = NicheFitInput.parse(raw);
    const offer = await liveOffer(ctx);
    if (!offer) return { fit: 'no_offer' };
    try {
      const { value } = await askStructured(ctx, ctx.scope, {
        system: NICHE_FIT_SYSTEM,
        messages: [{ role: 'user', content: nicheFitPrompt(input, offer) }],
        schema: NICHE_FIT_SCHEMA,
        zod: NicheFitAnswer,
        maxTokens: 400,
        usage: { source: 'addon', addonId: ctx.manifest.id },
      });
      return checkedNicheFit(value);
    } catch (e) {
      throw aiFailure(e);
    }
  },
};
