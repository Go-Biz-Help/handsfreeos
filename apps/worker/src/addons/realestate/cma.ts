/**
 * The CMA's summary in the worker (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round two: Buyer core"): drafted
 * from the CMA's own numbers (the home, the comps the agent used with their values, the range, and what was left out)
 * and checked for fair-housing risk twice, as a client update is: the word list and the model. The agent's edits are
 * read by the model again. The model's use is counted as the add-on's; nothing here shares anything.
 */
import {
  CMA_METHOD_WORDS,
  cmaValues,
  type CmaComp,
  type CompStatus,
} from '@hfos/core/addons/realestate/cma';
import { checkWords, FAIR_HOUSING_WORDS_VERSION } from '@hfos/core/addons/realestate/fair-housing';
import { textHashOf } from '@hfos/core/addons/realestate/ops/client-updates';
import { cmaSummaryChecked, cmaSummaryDrafted } from '@hfos/core/addons/realestate/ops/cma';
import {
  CMA_SUMMARY_SCHEMA,
  CMA_SUMMARY_SYSTEM,
  CmaSummaryAnswer,
  cmaSummaryPrompt,
  type CmaSummaryFacts,
} from '@hfos/core/addons/realestate/prompts';
import { executeCommand, fmtDateLong, money } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { AiAskError, askStructured } from '../../ai/ask';
import type { AddonEventContext, AddonScopeContext } from '../types';
import { modelCheck } from './client-updates';

const cmaIdOf = (ctx: AddonEventContext) => {
  const v = ((ctx.event.payload ?? {}) as Record<string, unknown>)['cmaId'];
  return typeof v === 'string' ? v : null;
};
const n = (v: string | number | null) => (v === null ? null : Number(v));

/** What the model is told about a CMA: its numbers, in words, and nothing else about the deal. */
async function factsOf(ctx: AddonScopeContext, cmaId: string): Promise<CmaSummaryFacts | null> {
  return asWorker(ctx.db, ctx.scope, async (tx) => {
    const [c] = await rows<{
      summary_state: string;
      deal: string;
      address: string;
      beds: number | null;
      baths: string | null;
      sqft: number | null;
      list: number | null;
      year: number | null;
      as_of: string;
      low: number | null;
      likely: number | null;
      high: number | null;
      status: string;
      agent: string | null;
    }>(
      tx,
      sql`select c.summary_state, c.deal_record_id as deal, c.subject_address as address, c.subject_beds as beds,
            c.subject_baths::text as baths, c.subject_sqft as sqft, c.subject_list_price_cents::float8 as list,
            c.subject_year_built as year, c.as_of::text, c.low_cents::float8 as low, c.likely_cents::float8 as likely,
            c.high_cents::float8 as high, c.status,
            coalesce(nullif(u.full_name, ''), u.email::text) as agent
          from addon_realestate.cmas c
          join app.custom_records r on r.id = c.deal_record_id
          left join app.users u on u.id = r.owner_user_id
          where c.id = ${cmaId}`,
    );
    if (!c || c.summary_state !== 'drafting') return null;
    const [client] = await rows<{ first_name: string }>(
      tx,
      sql`select p.first_name from app.relationships rel
          join app.relationship_types rt on rt.id = rel.type_id and rt.addon_key = 'realestate_client'
          join app.people p on p.id = rel.a_person_id
          where rel.b_custom_record_id = ${c.deal} order by rel.created_at limit 1`,
    );
    const comps = await rows<{
      id: string;
      address: string;
      price: number;
      status: CompStatus;
      sold_on: string | null;
      beds: number | null;
      baths: string | null;
      sqft: number | null;
      miles: string | null;
      adjustments: { label: string; cents: number }[];
      used: boolean;
    }>(
      tx,
      sql`select id, address, price_cents::float8 as price, status, sold_on::text, beds, baths::text, sqft,
            distance_miles::text as miles, adjustments, used
          from addon_realestate.cma_comps where cma_id = ${cmaId} order by position`,
    );
    const list: CmaComp[] = comps.map((r) => ({
      id: r.id,
      address: r.address,
      priceCents: r.price,
      status: r.status,
      soldOn: r.sold_on,
      beds: r.beds,
      baths: n(r.baths),
      sqft: r.sqft,
      distanceMiles: n(r.miles),
      adjustments: r.adjustments,
      used: r.used,
    }));
    const subject = {
      beds: c.beds,
      baths: n(c.baths),
      sqft: c.sqft,
      listPriceCents: c.list,
      yearBuilt: c.year,
    };
    const result = cmaValues(subject, list, c.as_of);
    const range =
      c.status !== 'draft' && c.low !== null && c.likely !== null && c.high !== null
        ? { lowCents: c.low, likelyCents: c.likely, highCents: c.high }
        : result.range;
    return {
      agentName: c.agent ?? 'Your agent',
      clientFirstName: client?.first_name?.trim() || 'there',
      home: {
        address: c.address,
        beds: subject.beds,
        baths: subject.baths,
        sqft: subject.sqft,
        listPrice: subject.listPriceCents ? money(subject.listPriceCents) : null,
      },
      range: range
        ? {
            low: money(range.lowCents),
            likely: money(range.likelyCents),
            high: money(range.highCents),
          }
        : null,
      method: CMA_METHOD_WORDS,
      used: list
        .map((comp, i) => ({ comp, v: result.comps[i]! }))
        .filter((x) => x.v.counted)
        .map(({ comp, v }) => ({
          address: comp.address,
          price: money(comp.priceCents),
          sold: comp.soldOn ? fmtDateLong(comp.soldOn) : null,
          beds: comp.beds,
          baths: comp.baths,
          sqft: comp.sqft,
          milesAway: comp.distanceMiles,
          valueForThisHome: v.valueCents === null ? null : money(v.valueCents),
          adjustments: comp.adjustments.map(
            (a) => `${a.label}: ${a.cents >= 0 ? '+' : '−'}${money(Math.abs(a.cents))}`,
          ),
        })),
      leftOut: list
        .map((comp, i) => ({ comp, v: result.comps[i]! }))
        .filter((x) => !x.v.counted)
        .map(({ comp, v }) => ({ address: comp.address, why: v.why ?? 'Left out' })),
    };
  });
}

/** `realestate.cma.summary_requested`: the summary, and both of its checks. */
export async function cmaSummaryRequested(ctx: AddonEventContext): Promise<void> {
  const cmaId = cmaIdOf(ctx);
  if (!cmaId) return;
  const facts = await factsOf(ctx, cmaId);
  if (!facts) return;
  const done = (input: Record<string, unknown>) =>
    executeCommand(
      ctx.db,
      cmaSummaryDrafted,
      { workspaceId: ctx.scope.workspaceId, cmaId, ...input },
      ctx.actor,
      ctx.meta,
    );
  let written: { summary: string; model: string };
  try {
    const { value, model } = await askStructured(ctx, ctx.scope, {
      system: CMA_SUMMARY_SYSTEM,
      messages: [{ role: 'user', content: cmaSummaryPrompt(facts) }],
      schema: CMA_SUMMARY_SCHEMA,
      zod: CmaSummaryAnswer,
      maxTokens: 700,
      usage: { source: 'addon', addonId: ctx.manifest.id },
    });
    written = { summary: value.summary, model };
  } catch (e) {
    if (!(e instanceof AiAskError)) throw e;
    // A busy model is worth another try; anything else is said on the CMA.
    if (e.retryable && ctx.attempt < 3) throw e;
    await done({ failure: e.message });
    return;
  }
  const words = checkWords(written.summary);
  await done({
    summary: written.summary,
    model: written.model,
    checks: [
      {
        source: 'words',
        version: FAIR_HOUSING_WORDS_VERSION,
        status: words.length ? 'flagged' : 'passed',
        flags: words,
      },
      await modelCheck(ctx, `CMA for ${facts.home.address}`, written.summary),
    ],
  });
}

/** `realestate.cma.summary_saved`: the model reads the agent's own words. */
export async function cmaSummarySaved(ctx: AddonEventContext): Promise<void> {
  const cmaId = cmaIdOf(ctx);
  if (!cmaId) return;
  const [c] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ summary_state: string; summary: string | null; address: string }>(
      tx,
      sql`select summary_state, summary, subject_address as address from addon_realestate.cmas where id = ${cmaId}`,
    ),
  );
  if (!c || c.summary_state !== 'ready' || !c.summary) return;
  const check = await modelCheck(ctx, `CMA for ${c.address}`, c.summary);
  await executeCommand(
    ctx.db,
    cmaSummaryChecked,
    {
      workspaceId: ctx.scope.workspaceId,
      cmaId,
      // The words it read: if they've changed again since, that save's own check follows.
      textHash: textHashOf(null, c.summary),
      version: check.version,
      status: check.status,
      flags: check.flags,
    },
    ctx.actor,
    ctx.meta,
  );
}
