/**
 * A home's facts from its pasted listing words (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round two: Buyer
 * core"). Only the words the agent (or the client) pasted are read: a link is never opened. Each fact comes back with
 * the words it was found in, and anything whose words aren't in the text, or whose number isn't in its words, is
 * dropped (core's checkedListingFacts). What's left waits for the agent to confirm. The model's use is the add-on's.
 */
import { homeFillFacts } from '@hfos/core/addons/realestate/ops/homes';
import {
  checkedListingFacts,
  LISTING_FACTS_SCHEMA,
  LISTING_FACTS_SYSTEM,
  ListingFactsAnswer,
  listingFactsPrompt,
} from '@hfos/core/addons/realestate/prompts';
import { executeCommand } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { AiAskError, askStructured } from '../../ai/ask';
import type { AddonEventContext } from '../types';

const COULD_NOT_READ =
  'The AI couldn’t read the listing’s words just now. Enter the home’s facts from the listing.';

/** `realestate.home.added` with pasted words: the facts they state, for the agent to check. */
export async function homeAdded(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as Record<string, unknown>;
  const homeId = typeof p['homeId'] === 'string' ? p['homeId'] : null;
  if (!homeId || p['fill'] !== true) return;
  const [home] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ facts_state: string; pasted_text: string | null }>(
      tx,
      sql`select facts_state, pasted_text from addon_realestate.homes where id = ${homeId}`,
    ),
  );
  if (!home || home.facts_state !== 'filling' || !home.pasted_text) return;
  const record = (input: Record<string, unknown>) =>
    executeCommand(
      ctx.db,
      homeFillFacts,
      { workspaceId: ctx.scope.workspaceId, homeId, ...input },
      ctx.actor,
      ctx.meta,
    );
  try {
    const { value, model } = await askStructured(ctx, ctx.scope, {
      system: LISTING_FACTS_SYSTEM,
      messages: [{ role: 'user', content: listingFactsPrompt(home.pasted_text) }],
      schema: LISTING_FACTS_SCHEMA,
      zod: ListingFactsAnswer,
      maxTokens: 700,
      usage: { source: 'addon', addonId: ctx.manifest.id },
    });
    const checked = checkedListingFacts(value, home.pasted_text);
    await record({
      facts: checked.facts,
      sources: checked.sources,
      dropped: checked.dropped,
      model,
    });
  } catch (e) {
    if (!(e instanceof AiAskError)) throw e;
    // A busy model is worth another try; anything else is said on the home.
    if (e.retryable && ctx.attempt < 3) throw e;
    await record({ failure: COULD_NOT_READ });
  }
}
