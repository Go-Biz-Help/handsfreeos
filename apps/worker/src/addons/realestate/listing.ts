/**
 * A listing in the worker (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round three: Listing core").
 *
 * - **Its facts from the old listing's words**, read as a buyer's home's are (./homes.ts): only the words the agent
 *   pasted, each fact with the words it was found in, anything not found in them dropped. A listing's price is its
 *   own (the deal's list price), so a price in the old words is left out. What's left waits for the agent.
 * - **Its description**, drafted from its confirmed facts, the agent's notes and the seller's sent answers, and
 *   checked for fair housing risk twice, as a CMA's summary is: the word list and the model. The agent's own words are
 *   read by the model again. The model's use is the add-on's.
 */
import { checkWords, FAIR_HOUSING_WORDS_VERSION } from '@hfos/core/addons/realestate/fair-housing';
import { factWords, LISTING_FACTS } from '@hfos/core/addons/realestate/homes';
import {
  LISTING_HOME_FACT_KEYS,
  streetOf,
  type SellerAnswers,
} from '@hfos/core/addons/realestate/listing';
import { textHashOf } from '@hfos/core/addons/realestate/ops/client-updates';
import {
  descriptionChecked,
  descriptionDrafted,
} from '@hfos/core/addons/realestate/ops/description';
import { listingFillFacts } from '@hfos/core/addons/realestate/ops/listing';
import {
  checkedListingFacts,
  LISTING_DESCRIPTION_SCHEMA,
  LISTING_DESCRIPTION_SYSTEM,
  LISTING_FACTS_SCHEMA,
  LISTING_FACTS_SYSTEM,
  ListingDescriptionAnswer,
  listingDescriptionPrompt,
  ListingFactsAnswer,
  listingFactsPrompt,
  type ListingDescriptionFacts,
} from '@hfos/core/addons/realestate/prompts';
import { executeCommand } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { AiAskError, askStructured } from '../../ai/ask';
import type { AddonEventContext } from '../types';
import { modelCheck } from './client-updates';

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

// ---------- the description ----------

const descriptionIdOf = (ctx: AddonEventContext) => {
  const v = ((ctx.event.payload ?? {}) as Record<string, unknown>)['descriptionId'];
  return typeof v === 'string' ? v : null;
};

/** What the model is told about a listing: its confirmed facts in words, the agent's notes and the seller's words. */
async function descriptionFactsOf(
  ctx: AddonEventContext,
  descriptionId: string,
): Promise<ListingDescriptionFacts | null> {
  return asWorker(ctx.db, ctx.scope, async (tx) => {
    const [d] = await rows<{
      state: string;
      deal: string;
      facts: Record<string, unknown>;
      highlights: string | null;
      answers: SellerAnswers | null;
      questionnaire: string | null;
      address: string | null;
    }>(
      tx,
      sql`select d.state, d.deal_record_id as deal, l.facts, l.highlights, q.answers, q.state as questionnaire,
            (select pr.name from app.relationships rel
               join app.relationship_types rt on rt.id = rel.type_id and rt.addon_key = 'realestate_property_of'
               join app.custom_records pr on pr.id = rel.b_custom_record_id
              where rel.a_custom_record_id = d.deal_record_id order by rel.created_at desc limit 1) as address
          from addon_realestate.listing_descriptions d
          join addon_realestate.listings l on l.workspace_id = d.workspace_id and l.deal_record_id = d.deal_record_id
          left join addon_realestate.seller_questionnaires q
            on q.workspace_id = d.workspace_id and q.deal_record_id = d.deal_record_id
          where d.id = ${descriptionId}`,
    );
    if (!d || d.state !== 'drafting') return null;
    const address = d.address ?? '';
    const facts: Record<string, string> = {};
    for (const key of LISTING_HOME_FACT_KEYS) {
      const v = d.facts[key];
      if (v !== undefined && v !== null) facts[LISTING_FACTS[key].label] = factWords(key, v);
    }
    const sent = d.questionnaire === 'submitted' ? d.answers : null;
    return {
      street: streetOf(address) || 'The home',
      city: address.split(',').slice(1).join(',').trim() || null,
      facts,
      agentNotes: d.highlights,
      sellerUpdates: sent?.updates?.trim() || null,
      sellerLoves: sent?.loves?.trim() || null,
    };
  });
}

/** `realestate.listing.description_requested`: the draft, and both of its checks. */
export async function descriptionRequested(ctx: AddonEventContext): Promise<void> {
  const descriptionId = descriptionIdOf(ctx);
  if (!descriptionId) return;
  const facts = await descriptionFactsOf(ctx, descriptionId);
  if (!facts) return;
  const done = (input: Record<string, unknown>) =>
    executeCommand(
      ctx.db,
      descriptionDrafted,
      { workspaceId: ctx.scope.workspaceId, descriptionId, ...input },
      ctx.actor,
      ctx.meta,
    );
  let written: { words: string; model: string };
  try {
    const { value, model } = await askStructured(ctx, ctx.scope, {
      system: LISTING_DESCRIPTION_SYSTEM,
      messages: [{ role: 'user', content: listingDescriptionPrompt(facts) }],
      schema: LISTING_DESCRIPTION_SCHEMA,
      zod: ListingDescriptionAnswer,
      maxTokens: 900,
      usage: { source: 'addon', addonId: ctx.manifest.id },
    });
    written = { words: value.description, model };
  } catch (e) {
    if (!(e instanceof AiAskError)) throw e;
    if (e.retryable && ctx.attempt < 3) throw e;
    await done({ failure: e.message });
    return;
  }
  const flags = checkWords(written.words);
  await done({
    words: written.words,
    model: written.model,
    checks: [
      {
        source: 'words',
        version: FAIR_HOUSING_WORDS_VERSION,
        status: flags.length ? 'flagged' : 'passed',
        flags,
      },
      await modelCheck(ctx, `Listing description for ${facts.street}`, written.words),
    ],
  });
}

/** `realestate.listing.description_saved`: the model reads the agent's own words. */
export async function descriptionSaved(ctx: AddonEventContext): Promise<void> {
  const descriptionId = descriptionIdOf(ctx);
  if (!descriptionId) return;
  const [d] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ state: string; words: string | null }>(
      tx,
      sql`select state, words from addon_realestate.listing_descriptions where id = ${descriptionId}`,
    ),
  );
  if (!d || d.state !== 'ready' || !d.words) return;
  const check = await modelCheck(ctx, 'Listing description', d.words);
  await executeCommand(
    ctx.db,
    descriptionChecked,
    {
      workspaceId: ctx.scope.workspaceId,
      descriptionId,
      textHash: textHashOf(null, d.words),
      version: check.version,
      status: check.status,
      flags: check.flags,
    },
    ctx.actor,
    ctx.meta,
  );
}
