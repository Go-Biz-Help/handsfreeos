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
  listingPostChecked,
  listingPostsDrafted,
} from '@hfos/core/addons/realestate/ops/marketing';
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
  LISTING_POSTS_SCHEMA,
  LISTING_POSTS_SYSTEM,
  ListingPostsAnswer,
  listingPostsPrompt,
  type ListingDescriptionFacts,
  type ListingPostsFacts,
} from '@hfos/core/addons/realestate/prompts';
import { executeCommand, money } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { AiAskError, askStructured } from '../../ai/ask';
import { addDays, localDateOf, localInstant } from '@hfos/core/server';
import { clearAddonAlert, raiseAddonAlert } from '../alerts';
import { scheduleAddonJob } from '../queue';
import type { AddonEventContext, AddonJobContext, AddonScopeContext } from '../types';
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

// ---------- a visitor asked ----------

/** `realestate.listing.asked`: the listing's agent hears that someone asked about it on its page. */
export async function listingAsked(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as Record<string, unknown>;
  const dealId = ctx.event.entityId;
  const personId = typeof p['personId'] === 'string' ? p['personId'] : null;
  if (!dealId || !personId) return;
  const owner = typeof p['ownerUserId'] === 'string' ? p['ownerUserId'] : null;
  const street = typeof p['street'] === 'string' ? p['street'] : 'your listing';
  const name = typeof p['name'] === 'string' && p['name'] ? p['name'] : 'Someone';
  await raiseAddonAlert(ctx, {
    key: `asked:${dealId}:${personId}`,
    severity: 'attention',
    title: `${name} asked about ${street}`.slice(0, 200),
    detail: 'On the listing’s page. Their question is on their timeline, with a lead for you.',
    href: `/a/realestate/deals/${dealId}/marketing`,
    permission: 'realestate.use',
    customRecordId: dealId,
    personId,
    audienceUserIds: owner ? [owner] : [],
    assigneeUserId: owner,
  });
}

// ---------- the seller's questionnaire ----------

/** `realestate.listing.questionnaire_sent`: the seller sent their answers; their agent checks and confirms the facts. */
export async function questionnaireSent(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as Record<string, unknown>;
  const dealId = ctx.event.entityId;
  if (!dealId) return;
  const owner = typeof p['ownerUserId'] === 'string' ? p['ownerUserId'] : null;
  const name = typeof p['name'] === 'string' && p['name'] ? p['name'] : 'The seller';
  await raiseAddonAlert(ctx, {
    key: `questionnaire:${dealId}`,
    severity: 'attention',
    title: `${name} sent their answers about the home`.slice(0, 200),
    detail: 'Check them against the old listing, then confirm the home’s facts.',
    href: `/a/realestate/deals/${dealId}/facts`,
    permission: 'realestate.use',
    customRecordId: dealId,
    audienceUserIds: owner ? [owner] : [],
    assigneeUserId: owner,
  });
}

/** `realestate.listing.facts_confirmed`: the answers are checked, so the reminder goes. */
export async function factsConfirmed(ctx: AddonEventContext): Promise<void> {
  if (ctx.event.entityId) await clearAddonAlert(ctx, `questionnaire:${ctx.event.entityId}`);
}

// ---------- the price ----------

/**
 * `realestate.listing.price_changed`: a new price is in use (the page shows it at once); the listing's agent is
 * reminded to change it on the MLS too, when it's there. A later change replaces the reminder.
 */
export async function priceChanged(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as Record<string, unknown>;
  const dealId = ctx.event.entityId;
  if (!dealId || p['onMls'] !== true) return;
  const owner = typeof p['ownerUserId'] === 'string' ? p['ownerUserId'] : null;
  const street = typeof p['street'] === 'string' ? p['street'] : 'The listing';
  const to = typeof p['toCents'] === 'number' ? money(p['toCents']) : 'its new price';
  await raiseAddonAlert(ctx, {
    key: `price_mls:${dealId}`,
    severity: 'attention',
    title: `Change the price on the MLS: ${street} is now ${to}`.slice(0, 200),
    detail: 'The seller signed it off, and the listing’s page shows it already.',
    href: `/a/realestate/deals/${dealId}/price`,
    permission: 'realestate.use',
    customRecordId: dealId,
    audienceUserIds: owner ? [owner] : [],
    assigneeUserId: owner,
  });
}

// ---------- offers ----------

const CHOICE_TITLES: Readonly<Record<string, string>> = {
  accept: 'wants to accept',
  counter: 'wants to counter',
  decline: 'wants to decline',
  talk: 'wants to talk about',
};

/**
 * `realestate.offers.seller_chose`: the seller said in their portal what they want about an offer. Their agent hears;
 * nothing is accepted. A newer choice on the same offer replaces the alert.
 */
export async function sellerChose(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as Record<string, unknown>;
  const dealId = ctx.event.entityId;
  const offerId = typeof p['offerId'] === 'string' ? p['offerId'] : null;
  if (!dealId || !offerId) return;
  const owner = typeof p['ownerUserId'] === 'string' ? p['ownerUserId'] : null;
  const name = typeof p['name'] === 'string' && p['name'] ? p['name'] : 'The seller';
  const what = CHOICE_TITLES[String(p['choice'])] ?? 'answered';
  const buyers = typeof p['buyers'] === 'string' && p['buyers'] ? ` from ${p['buyers']}` : '';
  await raiseAddonAlert(ctx, {
    key: `seller_chose:${dealId}:${offerId}`,
    severity: 'attention',
    title: `${name} ${what} offer ${String(p['number'] ?? '')}${buyers}`.slice(0, 200),
    detail:
      'In their portal. It tells you what they want; nothing is accepted until the contract is signed.',
    href: `/a/realestate/deals/${dealId}/offers`,
    permission: 'realestate.use',
    customRecordId: dealId,
    audienceUserIds: owner ? [owner] : [],
    assigneeUserId: owner,
  });
}

// ---------- social posts ----------

/** `realestate.listing.posts_requested`: three posts from the home's public facts, each read by both checks. */
export async function postsRequested(ctx: AddonEventContext): Promise<void> {
  const dealId = ctx.event.entityId;
  const batch = Number(((ctx.event.payload ?? {}) as Record<string, unknown>)['batch'] ?? 0);
  if (!dealId || !batch) return;
  const facts = await asWorker(ctx.db, ctx.scope, async (tx): Promise<ListingPostsFacts | null> => {
    const [waiting] = await rows<{ n: number }>(
      tx,
      sql`select count(*)::int as n from addon_realestate.listing_posts
          where deal_record_id = ${dealId} and batch = ${batch} and state = 'drafting'`,
    );
    if (!waiting?.n) return null;
    const [l] = await rows<{
      facts: Record<string, unknown>;
      address: string | null;
      price: number | null;
      description: string | null;
    }>(
      tx,
      sql`select l.facts,
            (select pr.name from app.relationships rel
               join app.relationship_types rt on rt.id = rel.type_id and rt.addon_key = 'realestate_property_of'
               join app.custom_records pr on pr.id = rel.b_custom_record_id
              where rel.a_custom_record_id = l.deal_record_id order by rel.created_at desc limit 1) as address,
            (select t.value_cents::float8 from addon_realestate.term_entries t
              where t.deal_record_id = l.deal_record_id and t.key = 'list_price'
                and t.superseded_at is null and t.rejected_at is null
              order by t.confirmed_at is null, t.entered_at desc limit 1) as price,
            (select d.words from addon_realestate.listing_descriptions d
              where d.deal_record_id = l.deal_record_id and d.state = 'signed') as description
          from addon_realestate.listings l
          where l.workspace_id = ${ctx.scope.workspaceId} and l.deal_record_id = ${dealId}`,
    );
    if (!l) return null;
    const words: Record<string, string> = {};
    for (const key of LISTING_HOME_FACT_KEYS) {
      const v = l.facts[key];
      if (v !== undefined && v !== null) words[LISTING_FACTS[key].label] = factWords(key, v);
    }
    const address = l.address ?? '';
    return {
      street: streetOf(address) || 'The home',
      city: address.split(',').slice(1).join(',').trim() || null,
      price: l.price ? money(l.price) : null,
      facts: words,
      description: l.description,
      openHouses: [],
    };
  });
  if (!facts) return;
  const done = (input: Record<string, unknown>) =>
    executeCommand(
      ctx.db,
      listingPostsDrafted,
      { workspaceId: ctx.scope.workspaceId, dealId, batch, ...input },
      ctx.actor,
      ctx.meta,
    );
  let written: { posts: string[]; model: string };
  try {
    const { value, model } = await askStructured(ctx, ctx.scope, {
      system: LISTING_POSTS_SYSTEM,
      messages: [{ role: 'user', content: listingPostsPrompt(facts) }],
      schema: LISTING_POSTS_SCHEMA,
      zod: ListingPostsAnswer,
      maxTokens: 700,
      usage: { source: 'addon', addonId: ctx.manifest.id },
    });
    written = { posts: value.posts, model };
  } catch (e) {
    if (!(e instanceof AiAskError)) throw e;
    if (e.retryable && ctx.attempt < 3) throw e;
    await done({ failure: e.message });
    return;
  }
  const posts = [];
  for (const words of written.posts.slice(0, 3)) {
    const flags = checkWords(words);
    posts.push({
      words,
      checks: [
        {
          source: 'words',
          version: FAIR_HOUSING_WORDS_VERSION,
          status: flags.length ? 'flagged' : 'passed',
          flags,
        },
        await modelCheck(ctx, `Social post about ${facts.street}`, words),
      ],
    });
  }
  await done({ posts, model: written.model });
}

/** `realestate.listing.post_saved`: the model reads the agent's own words for a post. */
export async function postSaved(ctx: AddonEventContext): Promise<void> {
  const postId = ((ctx.event.payload ?? {}) as Record<string, unknown>)['postId'];
  if (typeof postId !== 'string') return;
  const [p] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ state: string; words: string | null }>(
      tx,
      sql`select state, words from addon_realestate.listing_posts where id = ${postId}`,
    ),
  );
  if (!p || p.state !== 'ready' || !p.words) return;
  const check = await modelCheck(ctx, 'Social post', p.words);
  await executeCommand(
    ctx.db,
    listingPostChecked,
    {
      workspaceId: ctx.scope.workspaceId,
      postId,
      textHash: textHashOf(null, p.words),
      version: check.version,
      status: check.status,
      flags: check.flags,
    },
    ctx.actor,
    ctx.meta,
  );
}

// ---------- open houses: the next morning's reminder ----------

export const OPEN_HOUSE_FOLLOW_UP = 'realestate.open_house_follow_up';
export const openHouseAlertKey = (openHouseId: string) => `open_house:${openHouseId}`;

/** `realestate.open_house.planned`: a reminder at 9 the next morning, the business's time, after it ends. */
export async function openHousePlanned(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as Record<string, unknown>;
  const openHouseId = typeof p['openHouseId'] === 'string' ? p['openHouseId'] : null;
  const endsAt = typeof p['endsAt'] === 'string' ? Date.parse(p['endsAt']) : NaN;
  if (!openHouseId || Number.isNaN(endsAt) || !ctx.event.entityId) return;
  const dealId = ctx.event.entityId;
  await asWorker(ctx.db, ctx.scope, async (tx) => {
    const [ws] = await rows<{ timezone: string | null }>(
      tx,
      sql`select timezone from app.workspaces where id = ${ctx.scope.workspaceId}`,
    );
    const tz = ws?.timezone || 'UTC';
    const runAt = localInstant(addDays(localDateOf(endsAt, tz), 1), '09:00', tz);
    await scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: OPEN_HOUSE_FOLLOW_UP,
        dedupeKey: `${OPEN_HOUSE_FOLLOW_UP}:${openHouseId}`,
        runAt: new Date(runAt),
        payload: {
          openHouseId,
          dealId,
          hostUserId: typeof p['hostUserId'] === 'string' ? p['hostUserId'] : null,
          street: typeof p['street'] === 'string' ? p['street'] : 'the listing',
        },
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
    );
  });
}

/** Visitors on their own not yet followed up, at a planned open house. */
async function notFollowedUp(ctx: AddonScopeContext, openHouseId: string): Promise<number> {
  const [r] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ n: number }>(
      tx,
      sql`select count(*)::int as n from addon_realestate.open_house_visitors v
          join addon_realestate.open_houses o on o.id = v.open_house_id and o.state = 'planned'
          where v.open_house_id = ${openHouseId} and not v.with_agent and v.followed_up_at is null`,
    ),
  );
  return r?.n ?? 0;
}

/** `realestate.open_house_follow_up`: the host's card, if anyone is still waiting to hear from them. */
export async function openHouseFollowUpJob(ctx: AddonJobContext): Promise<void> {
  const p = ctx.job.payload as Record<string, unknown>;
  const openHouseId = typeof p['openHouseId'] === 'string' ? p['openHouseId'] : null;
  const dealId = typeof p['dealId'] === 'string' ? p['dealId'] : null;
  if (!openHouseId || !dealId) return;
  const n = await notFollowedUp(ctx, openHouseId);
  if (!n) return;
  const host = typeof p['hostUserId'] === 'string' ? p['hostUserId'] : null;
  await raiseAddonAlert(ctx, {
    key: openHouseAlertKey(openHouseId),
    severity: 'attention',
    title:
      `${n} open house ${n === 1 ? 'visitor' : 'visitors'} to follow up at ${String(p['street'] ?? 'the listing')}`.slice(
        0,
        200,
      ),
    detail: 'Call or write to each, then mark them followed up on the open house.',
    href: `/a/realestate/deals/${dealId}/open-houses`,
    permission: 'realestate.use',
    customRecordId: dealId,
    audienceUserIds: host ? [host] : [],
    assigneeUserId: host,
  });
}

/** `realestate.open_house.followed_up`: the card goes once everyone is. */
export async function openHouseFollowedUp(ctx: AddonEventContext): Promise<void> {
  const openHouseId = ((ctx.event.payload ?? {}) as Record<string, unknown>)['openHouseId'];
  if (typeof openHouseId !== 'string') return;
  if ((await notFollowedUp(ctx, openHouseId)) === 0)
    await clearAddonAlert(ctx, openHouseAlertKey(openHouseId), 'done');
}
