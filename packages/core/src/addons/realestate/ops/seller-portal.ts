/**
 * The seller's own listing in their portal, step 12 (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round three:
 * Listing core"). Chris decided (2026-10-01): sellers use the same portal as buyers, showing their listing.
 *
 * - **Their listing** (`realestate.portal.listing`, read as the customer): its address and price as it stands, each
 *   price change asked of them, the MLS number once it's live and the page's address once it's up, the home's facts,
 *   the description they signed, the open houses to come, their questionnaire, and the offers side by side as their
 *   agent last shared them, with what they said about each. Where they sign off and what they still have to do is
 *   their to-do (`realestate.portal.deal`).
 * - **The questionnaire** (`portal.questionnaire.save` / `submit`): their answers about the home, saved as they go,
 *   then sent once; sending finishes its task and their agent hears. Only the agent confirms the facts.
 */
import { and, eq, ne } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { requireCustomer } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { listingPagePath, streetOf, type SellerAnswers } from '../listing';
import { realestateAddon } from '../manifest';
import { NET_NOTE } from '../offer-words';
import {
  PortalDealInput,
  PortalListingOutput,
  PortalQuestionnaireOutput,
  PortalQuestionnaireSaveInput,
  PortalQuestionnaireSubmitInput,
  type CompareRowOut,
} from '../schemas';
import { clientTasks, sellerQuestionnaires } from '../tables';
import { completeTask } from './client-tasks';
import { dealClients, historyLine, inWorkspace, requireOpen, type Deal } from './common';
import { clientDeal, notYours } from './portal';
import { PROOF_EVENTS } from './proof-hooks';
import type { CommandContext } from '../../../kernel/types';

const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null);

// ---------- the look-up (as the customer) ----------

export const portalListing = defineAddonQuery(realestateAddon, {
  name: 'realestate.portal.listing',
  description:
    'The seller’s own listing in their portal: its price and each change asked of them, the MLS and its page once live, its facts and signed description, open houses, their questionnaire, and the offers side by side as shared with them.',
  input: PortalDealInput,
  output: PortalListingOutput,
  permission: null,
  actors: ['customer'],
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireCustomer(ctx);
    const deal = input.dealId;
    const [d] = await rows<{ side: string; archived_at: string | null }>(
      ctx.tx,
      sql`select d.side, r.archived_at from app.custom_records r
          join addon_realestate.deals d on d.record_id = r.id where r.id = ${deal}`,
    );
    if (!d || d.archived_at || d.side !== 'listing') throw notYours();
    const [facts] = await rows<{
      address: string | null;
      list_price_cents: number | null;
      site_slug: string | null;
      page_slug: string | null;
    }>(
      ctx.tx,
      sql`select address, list_price_cents::float8 as list_price_cents, site_slug, page_slug
          from portal.listing_facts() where record_id = ${deal}`,
    );
    const [l] = await rows<{
      facts: Record<string, unknown> | null;
      mls_number: string | null;
      mls_live_on: string | null;
    }>(
      ctx.tx,
      sql`select facts, mls_number, mls_live_on::text from addon_realestate.listings where deal_record_id = ${deal}`,
    );
    const prices = await rows<{
      id: string;
      from_cents: number;
      to_cents: number;
      words: string;
      state: 'waiting' | 'applied' | 'withdrawn';
      applied_at: Date | null;
      proposed_at: Date;
    }>(
      ctx.tx,
      sql`select id, from_cents::float8 as from_cents, to_cents::float8 as to_cents, words, state, applied_at,
            proposed_at
          from addon_realestate.listing_prices where deal_record_id = ${deal} order by proposed_at desc`,
    );
    const [description] = await rows<{ words: string; signed_at: Date | null }>(
      ctx.tx,
      sql`select words, signed_at from addon_realestate.listing_descriptions
          where deal_record_id = ${deal} and state = 'signed' order by version desc limit 1`,
    );
    const openHouses = await rows<{ id: string; starts_at: Date; ends_at: Date }>(
      ctx.tx,
      sql`select id, starts_at, ends_at from addon_realestate.open_houses
          where deal_record_id = ${deal} and state = 'planned' and ends_at > now()
          order by starts_at`,
    );
    const [q] = await rows<{
      answers: SellerAnswers;
      state: 'draft' | 'submitted';
      saved_at: Date | null;
      submitted_at: Date | null;
    }>(
      ctx.tx,
      sql`select answers, state, saved_at, submitted_at from addon_realestate.seller_questionnaires
          where deal_record_id = ${deal}`,
    );
    const [task] = await rows<{ id: string }>(
      ctx.tx,
      sql`select id from addon_realestate.client_tasks
          where deal_record_id = ${deal} and kind = 'questionnaire' and status <> 'canceled'
          order by created_at desc limit 1`,
    );
    const [cmp] = await rows<{
      id: string;
      shown: { address?: string; rows?: CompareRowOut[] };
      shared_at: Date;
    }>(
      ctx.tx,
      sql`select id, shown, shared_at from addon_realestate.offer_comparisons
          where deal_record_id = ${deal} order by shared_at desc limit 1`,
    );
    const choices = cmp
      ? await rows<{
          offer_id: string;
          choice: 'accept' | 'counter' | 'decline' | 'talk';
          words: string | null;
          at: Date;
        }>(
          ctx.tx,
          sql`select offer_id, choice, words, at from addon_realestate.offer_choices
              where comparison_id = ${cmp.id} and person_id = ${me.personId} order by at desc`,
        )
      : [];
    const address = facts?.address ?? null;
    const answers = q?.answers ?? {};
    return {
      dealId: deal,
      address,
      street: address ? streetOf(address) : null,
      priceCents: facts?.list_price_cents ?? null,
      priceChanges: prices.map((p) => ({
        id: p.id,
        fromCents: p.from_cents,
        toCents: p.to_cents,
        words: p.words,
        state: p.state,
        appliedAt: iso(p.applied_at),
        proposedAt: iso(p.proposed_at)!,
      })),
      mls: l?.mls_number && l.mls_live_on ? { number: l.mls_number, liveOn: l.mls_live_on } : null,
      pagePath:
        facts?.site_slug && facts.page_slug
          ? listingPagePath(facts.site_slug, facts.page_slug)
          : null,
      facts: l?.facts ?? {},
      description: description
        ? { words: description.words, signedAt: iso(description.signed_at) }
        : null,
      openHouses: openHouses.map((o) => ({
        id: o.id,
        startsAt: iso(o.starts_at)!,
        endsAt: iso(o.ends_at)!,
      })),
      questionnaire: {
        state: q ? q.state : task ? ('asked' as const) : ('none' as const),
        taskId: task?.id ?? null,
        answers: {
          facts: (answers.facts ?? {}) as Record<string, unknown>,
          updates: answers.updates ?? null,
          loves: answers.loves ?? null,
        },
        savedAt: iso(q?.saved_at ?? null),
        submittedAt: iso(q?.submitted_at ?? null),
      },
      comparison: cmp
        ? {
            id: cmp.id,
            sharedAt: iso(cmp.shared_at)!,
            address: cmp.shown.address ?? address ?? '',
            rows: cmp.shown.rows ?? [],
            note: NET_NOTE,
            myChoices: choices.map((c) => ({
              offerId: c.offer_id,
              choice: c.choice,
              words: c.words,
              at: iso(c.at)!,
            })),
          }
        : null,
    };
  },
});

// ---------- the questionnaire (for the signed-in seller) ----------

/** The seller's listing deal and its open questionnaire task: what saving or sending answers needs. */
async function myQuestionnaire(ctx: CommandContext, dealId: string) {
  const me = requireCustomer(ctx);
  const deal = await clientDeal(ctx, dealId);
  if (deal.side !== 'listing') throw notYours();
  requireOpen(deal);
  const [task] = await ctx.tx
    .select()
    .from(clientTasks)
    .where(
      and(
        eq(clientTasks.dealRecordId, deal.recordId),
        eq(clientTasks.kind, 'questionnaire'),
        ne(clientTasks.status, 'canceled'),
      ),
    )
    .limit(1);
  if (!task || (task.forPersonId && task.forPersonId !== me.personId))
    throw HfosError.rule(
      'realestate_questionnaire_not_asked',
      409,
      'Your agent hasn’t asked you about your home yet. Send them a message if you’d like to tell them about it.',
    );
  const [q] = await ctx.tx
    .select()
    .from(sellerQuestionnaires)
    .where(
      and(
        eq(sellerQuestionnaires.workspaceId, deal.workspaceId),
        eq(sellerQuestionnaires.dealRecordId, deal.recordId),
      ),
    )
    .for('update');
  if (q?.state === 'submitted')
    throw HfosError.rule(
      'realestate_questionnaire_sent',
      409,
      'You sent your answers already. If something has changed, tell your agent in a message.',
    );
  return { me, deal, task, q: q ?? null };
}

const qOut = (deal: Deal, q: typeof sellerQuestionnaires.$inferSelect) => ({
  dealId: deal.recordId,
  state: q.state,
  savedAt: q.savedAt?.toISOString() ?? null,
  submittedAt: q.submittedAt?.toISOString() ?? null,
});

export const portalQuestionnaireSave = defineAddonCommand(realestateAddon, {
  name: 'realestate.portal.questionnaire.save',
  description:
    'The seller saves their answers about their home in their portal, as they go: its facts, what they’ve updated and what they love about it. Nothing is sent until they send it.',
  risk: 1,
  input: PortalQuestionnaireSaveInput,
  output: PortalQuestionnaireOutput,
  permission: null,
  actors: ['customer'],
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const { me, deal, q } = await myQuestionnaire(ctx, input.dealId);
    const was = (q?.answers ?? {}) as SellerAnswers;
    const next: SellerAnswers = {
      facts: { ...(was.facts ?? {}), ...input.facts },
      updates: input.updates !== undefined ? input.updates || undefined : was.updates,
      loves: input.loves !== undefined ? input.loves || undefined : was.loves,
    };
    const answers = JSON.parse(JSON.stringify(next)) as Record<string, unknown>;
    const at = changeMoment(ctx.meta);
    const [row] = await ctx.tx
      .insert(sellerQuestionnaires)
      .values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        answers,
        state: 'draft',
        savedByPersonId: me.personId,
        savedAt: at,
      })
      .onConflictDoUpdate({
        target: [sellerQuestionnaires.workspaceId, sellerQuestionnaires.dealRecordId],
        set: { answers, savedByPersonId: me.personId, savedAt: at },
      })
      .returning();
    return qOut(deal, row!);
  },
});

export const portalQuestionnaireSubmit = defineAddonCommand(realestateAddon, {
  name: 'realestate.portal.questionnaire.submit',
  description:
    'The seller sends their saved answers about their home to their agent. It finishes the task; their agent confirms the facts.',
  risk: 1,
  input: PortalQuestionnaireSubmitInput,
  output: PortalQuestionnaireOutput,
  permission: null,
  actors: ['customer'],
  scope: inWorkspace,
  emits: ['realestate.listing.questionnaire_sent', 'realestate.client_task.done', ...PROOF_EVENTS],
  async handler(ctx, input) {
    const { me, deal, task, q } = await myQuestionnaire(ctx, input.dealId);
    const answers = (q?.answers ?? {}) as SellerAnswers;
    if (!q || (!Object.keys(answers.facts ?? {}).length && !answers.updates && !answers.loves))
      throw HfosError.rule(
        'realestate_questionnaire_empty',
        409,
        'Answer at least one question about your home, then send it.',
      );
    const at = changeMoment(ctx.meta);
    const [row] = await ctx.tx
      .update(sellerQuestionnaires)
      .set({ state: 'submitted', submittedByPersonId: me.personId, submittedAt: at })
      .where(
        and(
          eq(sellerQuestionnaires.workspaceId, deal.workspaceId),
          eq(sellerQuestionnaires.dealRecordId, deal.recordId),
        ),
      )
      .returning();
    const name =
      (await dealClients(ctx, deal.recordId)).find((c) => c.id === me.personId)?.firstName ??
      'The seller';
    await historyLine(ctx, deal, 'questionnaire_sent', { after: { name } });
    await completeTask(ctx, deal, task, me.personId, {});
    await ctx.emit({
      type: 'realestate.listing.questionnaire_sent',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: {
        name,
        ownerUserId: deal.ownerUserId,
        facts: Object.keys(answers.facts ?? {}).length,
      },
    });
    return qOut(deal, row!);
  },
});

export const sellerPortalQueries = [portalListing] as const;
export const sellerPortalCommands = [portalQuestionnaireSave, portalQuestionnaireSubmit] as const;
