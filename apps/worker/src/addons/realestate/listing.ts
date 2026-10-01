/**
 * A listing in the worker (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round three: Listing core").
 *
 * - **Its facts from the old listing's words**, read as a buyer's home's are (./homes.ts): only the words the agent
 *   pasted, each fact with the words it was found in, anything not found in them dropped. A listing's price is its
 *   own (the deal's list price), so a price in the old words is left out. What's left waits for the agent.
 */
import { listingFillFacts } from '@hfos/core/addons/realestate/ops/listing';
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
  'The AI couldn’t read the old listing’s words just now. Enter the home’s facts yourself, or paste them again.';

/** `realestate.listing.pasted`: the facts the old listing's words state, for the agent to check. */
export async function listingPasted(ctx: AddonEventContext): Promise<void> {
  const dealId = ctx.event.entityId;
  if (!dealId) return;
  const [l] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ pasted_state: string; pasted_text: string | null }>(
      tx,
      sql`select pasted_state, pasted_text from addon_realestate.listings
          where workspace_id = ${ctx.scope.workspaceId} and deal_record_id = ${dealId}`,
    ),
  );
  if (!l || l.pasted_state !== 'filling' || !l.pasted_text) return;
  const record = (input: Record<string, unknown>) =>
    executeCommand(
      ctx.db,
      listingFillFacts,
      { workspaceId: ctx.scope.workspaceId, dealId, ...input },
      ctx.actor,
      ctx.meta,
    );
  try {
    const { value, model } = await askStructured(ctx, ctx.scope, {
      system: LISTING_FACTS_SYSTEM,
      messages: [{ role: 'user', content: listingFactsPrompt(l.pasted_text) }],
      schema: LISTING_FACTS_SCHEMA,
      zod: ListingFactsAnswer,
      maxTokens: 700,
      usage: { source: 'addon', addonId: ctx.manifest.id },
    });
    const checked = checkedListingFacts(value, l.pasted_text);
    // The old price isn't this listing's: its list price is signed off on its own.
    const { price_cents: _price, ...facts } = checked.facts;
    const { price_cents: _quote, ...sources } = checked.sources as Record<string, string>;
    await record({ facts, sources, dropped: checked.dropped, model });
  } catch (e) {
    if (!(e instanceof AiAskError)) throw e;
    if (e.retryable && ctx.attempt < 3) throw e;
    await record({ failure: COULD_NOT_READ });
  }
}
