/**
 * Real Estate's pages in the client's portal, step 12 (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round two:
 * Buyer core"). Chris decided: the client sees where their deal stands and its key dates, does their own tasks,
 * saves or passes on homes, leaves feedback after a tour, and messages the agent (core's portal messages).
 *
 * - **Look-ups** run as the customer (`portal_actor`): row security alone decides what they read, only their own
 *   deals, and only the columns each table opens to the portal. So each look-up here names its columns.
 * - **Changes** run as HandsFreeOS for the signed-in client (the kernel re-checks their device), so each one checks
 *   the deal is theirs first. Each is recorded as the client's, on the portal channel.
 * - Co-buyers each have their own sign-in: each one's save or pass, feedback and sign-off is their own.
 */
import { localDateOf } from '../../../calendar/engine/zoned';
import {
  contingencyLabel,
  contingencyMeaning,
  contingencyStateWords,
  type ContingencyKind,
  type ContingencyState,
} from '../contingencies';
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { requireCustomer } from '../../../kernel/actor';
import type { CommandContext } from '../../../kernel/types';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { FINANCING_STEPS, type FinancingStep } from '../closing';
import { CLIENT_STAGE_WORDS, CLIENT_STEP_WORDS, clientStep } from '../client-words';
import { KEY_DATES, type KeyDateKey } from '../dates/key-dates';
import { FEED_STATUSES, type MlsSnapshot } from '../feed';
import { addressKey } from '../homes';
import { realestateAddon } from '../manifest';
import { offerSummary, type LoanType, type OfferStatus } from '../offer-words';
import {
  PortalDealInput,
  PortalDealOutput,
  PortalDealsInput,
  PortalDealsOutput,
  PortalHomeAddInput,
  PortalHomeAddOutput,
  PortalHomeReactInput,
  PortalHomeReactOutput,
  PortalTaskAttachInput,
  PortalTaskCompleteInput,
  PortalTaskOutput,
  PortalTourFeedbackInput,
  PortalTourFeedbackOutput,
} from '../schemas';
import type { DealStage } from '../states';
import { homeReactions, homes, tourFeedback, tourStops, tours } from '../tables';
import { historyLine, inWorkspace, loadDeal, requireOpen, type Ctx, type Deal } from './common';
import { completeTask, loadTask, SIGN_OFF_EVENTS } from './client-tasks';
import { settleMatchesFor } from './homes';
import { addProof, PROOF_EVENTS } from './proof-hooks';
import { feedbackWords } from './tours';

export const notYours = () =>
  HfosError.notFound('That isn’t in your portal. Go back to your deals and pick it there.');

/** A deal the signed-in client is on, for their changes; not there otherwise. */
export async function clientDeal(ctx: CommandContext, dealId: string): Promise<Deal> {
  const me = requireCustomer(ctx);
  const [r] = await rows<{ ok: boolean }>(
    ctx.tx,
    sql`select ${dealId}::uuid in (
          select private.portal_records_for(${ctx.scope.workspaceId}::uuid, ${me.personId}::uuid)) as ok`,
  );
  if (!r?.ok) throw notYours();
  return loadDeal(ctx, dealId);
}

// ---------- look-ups (as the customer) ----------

type DealRow = {
  id: string;
  name: string;
  archived_at: string | null;
  side: 'buyer' | 'listing';
  stage: DealStage;
  outcome: string | null;
};

async function myDeals(ctx: Ctx, dealId?: string): Promise<DealRow[]> {
  return rows<DealRow>(
    ctx.tx,
    sql`select r.id, r.name, r.archived_at, d.side, d.stage, d.outcome
        from app.custom_records r join addon_realestate.deals d on d.record_id = r.id
        where (${dealId ?? null}::uuid is null or r.id = ${dealId ?? null}::uuid)
        order by r.created_at desc`,
  );
}

/** The key dates that count: the newest live entry of each, when every live one agrees. */
async function keyDatesOf(ctx: Ctx, dealIds: readonly string[]) {
  if (!dealIds.length) return [];
  const list = await rows<{
    deal: string;
    key: string;
    date: string;
    time: string | null;
    entered: string;
  }>(
    ctx.tx,
    sql`select deal_record_id as deal, key, value_date::text as date, value_time::text as time,
          entered_at::text as entered
        from addon_realestate.term_entries
        where deal_record_id = any(${`{${dealIds.join(',')}}`}::uuid[])
          and superseded_at is null and rejected_at is null`,
  );
  const out: { deal: string; key: string; label: string; date: string; time: string | null }[] = [];
  const seen = new Set<string>();
  for (const e of [...list].sort((a, b) => b.entered.localeCompare(a.entered))) {
    const id = `${e.deal}:${e.key}`;
    if (seen.has(id) || !(e.key in KEY_DATES)) continue;
    seen.add(id);
    // Two live entries that disagree wait for the agent: the client doesn't see either yet.
    if (list.some((x) => x.deal === e.deal && x.key === e.key && x.date !== e.date)) continue;
    out.push({
      deal: e.deal,
      key: e.key,
      label: KEY_DATES[e.key as KeyDateKey].label,
      date: e.date,
      time: e.time ? e.time.slice(0, 5) : null,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

const agentNames = async (ctx: Ctx) =>
  new Map(
    (
      await rows<{ record_id: string; full_name: string | null }>(
        ctx.tx,
        sql`select record_id, full_name from portal.record_owners()`,
      )
    ).map((r) => [r.record_id, r.full_name]),
  );

export const portalDeals = defineAddonQuery(realestateAddon, {
  name: 'realestate.portal.deals',
  description:
    'The client’s deals in their portal: where each stands in their words, the next date, and their to-do.',
  input: PortalDealsInput,
  output: PortalDealsOutput,
  permission: null,
  actors: ['customer'],
  scope: inWorkspace,
  async handler(ctx) {
    requireCustomer(ctx);
    const deals = (await myDeals(ctx)).filter((d) => !d.archived_at);
    const ids = deals.map((d) => d.id);
    const dates = await keyDatesOf(ctx, ids);
    const today = new Date().toISOString().slice(0, 10);
    const open = ids.length
      ? await rows<{ deal: string; n: number }>(
          ctx.tx,
          sql`select deal_record_id as deal, count(*)::int as n from addon_realestate.client_tasks
              where status = 'open' and deal_record_id = any(${`{${ids.join(',')}}`}::uuid[])
              group by deal_record_id`,
        )
      : [];
    const agents = await agentNames(ctx);
    return {
      deals: deals.map((d) => {
        const next = dates.find((x) => x.deal === d.id && x.date >= today) ?? null;
        return {
          dealId: d.id,
          name: d.name,
          side: d.side,
          stage: CLIENT_STAGE_WORDS[d.stage] ?? d.stage,
          step: clientStep(d.side, d.stage),
          steps: [...CLIENT_STEP_WORDS[d.side]],
          agentName: agents.get(d.id) ?? null,
          nextDate: next
            ? { key: next.key, label: next.label, date: next.date, time: next.time }
            : null,
          openTasks: open.find((o) => o.deal === d.id)?.n ?? 0,
          closed: d.outcome !== null,
        };
      }),
    };
  },
});

export const portalDeal = defineAddonQuery(realestateAddon, {
  name: 'realestate.portal.deal',
  description:
    'One of the client’s deals in their portal: where it stands, its key dates, their to-do, the homes and tours, and the CMAs and offer summaries shared with them.',
  input: PortalDealInput,
  output: PortalDealOutput,
  permission: null,
  actors: ['customer'],
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireCustomer(ctx);
    const [d] = await myDeals(ctx, input.dealId);
    if (!d || d.archived_at) throw notYours();
    const deal = d.id;
    const [w] = await rows<{ timezone: string | null }>(
      ctx.tx,
      sql`select timezone from app.workspaces where id = ${ctx.scope.workspaceId}`,
    );
    const tz = w?.timezone ?? 'America/Chicago';
    const agents = await agentNames(ctx);
    const agentName = agents.get(deal) ?? null;
    const dates = await keyDatesOf(ctx, [deal]);
    // Round four: their contingencies and how each ended; never the agent's note.
    const contingencyRows = await rows<{
      id: string;
      kind: ContingencyKind;
      label: string | null;
      end_key: string | null;
      ends_on: string | null;
      state: ContingencyState;
      resolved_at: string | null;
    }>(
      ctx.tx,
      sql`select id, kind, label, end_key, ends_on::text, state, resolved_at::text
          from addon_realestate.contingencies where deal_record_id = ${deal} order by created_at`,
    );
    const people = await rows<{ person_id: string; first_name: string }>(
      ctx.tx,
      sql`select person_id, first_name from portal.record_people() where record_id = ${deal}`,
    );
    const firstName = (id: string) =>
      people.find((p) => p.person_id === id)?.first_name || 'A client';
    const tasks = await rows<{
      id: string;
      kind: 'upload' | 'sign_off' | 'do';
      title: string;
      detail: string | null;
      sign_off_words: string | null;
      for_person_id: string | null;
      due_on: string | null;
      status: 'open' | 'done' | 'canceled';
      done_at: string | null;
    }>(
      ctx.tx,
      sql`select id, kind, title, detail, sign_off_words, for_person_id, due_on::text, status, done_at::text
          from addon_realestate.client_tasks where deal_record_id = ${deal} order by created_at`,
    );
    const parts = await rows<{ task_id: string; person_id: string }>(
      ctx.tx,
      sql`select task_id, person_id from addon_realestate.client_task_completions where deal_record_id = ${deal}`,
    );
    const homeList = await rows<{
      id: string;
      address: string;
      link: string | null;
      facts: Record<string, unknown>;
      status: string;
      added_by_person_id: string | null;
      mls: MlsSnapshot | null;
    }>(
      ctx.tx,
      sql`select id, address, link, facts, status, added_by_person_id, mls from addon_realestate.homes
          where deal_record_id = ${deal} and status <> 'removed' order by created_at`,
    );
    const reactions = await rows<{
      home_id: string;
      person_id: string;
      reaction: 'saved' | 'passed';
    }>(
      ctx.tx,
      sql`select home_id, person_id, reaction from addon_realestate.home_reactions where deal_record_id = ${deal}`,
    );
    const tourList = await rows<{ id: string; status: string; starts_at: Date; ends_at: Date }>(
      ctx.tx,
      sql`select id, status, starts_at, ends_at from addon_realestate.tours
          where deal_record_id = ${deal} and status <> 'canceled' order by starts_at desc`,
    );
    const stops = await rows<{
      id: string;
      tour_id: string;
      home_id: string;
      position: number;
      status: string;
    }>(
      ctx.tx,
      sql`select id, tour_id, home_id, position, status from addon_realestate.tour_stops
          where deal_record_id = ${deal} order by position`,
    );
    const feedback = await rows<{
      stop_id: string;
      interest: string;
      rating: number | null;
      words: string | null;
    }>(
      ctx.tx,
      sql`select stop_id, interest, rating, words from addon_realestate.tour_feedback
          where deal_record_id = ${deal} and person_id = ${me.personId}`,
    );
    const cmas = await rows<{
      id: string;
      subject_address: string;
      low_cents: number;
      likely_cents: number;
      high_cents: number;
      summary: string | null;
      shared_at: Date;
    }>(
      ctx.tx,
      sql`select id, subject_address, low_cents::float8 as low_cents, likely_cents::float8 as likely_cents,
            high_cents::float8 as high_cents, summary, shared_at
          from addon_realestate.cmas where deal_record_id = ${deal} order by number desc`,
    );
    const offers = await rows<{
      id: string;
      home_id: string;
      status: OfferStatus;
      number: number;
      side: 'us' | 'them';
      respond_by: Date | null;
      price_cents: number;
      emd_cents: number | null;
      emd_days: number | null;
      seller_credit_cents: number;
      inspection_days: number | null;
      loan_type: LoanType | null;
      financing_days: number | null;
      appraisal_contingency: boolean | null;
      closing_date: string | null;
      other_terms: string | null;
    }>(
      ctx.tx,
      sql`select o.id, o.home_id, o.status, v.number, v.side, v.respond_by, v.price_cents::float8 as price_cents,
            v.emd_cents::float8 as emd_cents, v.emd_days, v.seller_credit_cents::float8 as seller_credit_cents,
            v.inspection_days, v.loan_type, v.financing_days, v.appraisal_contingency, v.closing_date::text,
            v.other_terms
          from addon_realestate.offers o
          join addon_realestate.offer_versions v on v.id = o.shared_version_id
          where o.deal_record_id = ${deal} order by o.number desc`,
    );
    const steps = await rows<{
      step: FinancingStep;
      status: string;
      expected_on: string | null;
      done_on: string | null;
    }>(
      ctx.tx,
      sql`select step, status, expected_on::text, done_on::text from addon_realestate.financing_steps
          where deal_record_id = ${deal}`,
    );
    const address = (homeId: string) => homeList.find((h) => h.id === homeId)?.address ?? 'A home';
    const now = Date.now();
    return {
      deal: {
        dealId: deal,
        name: d.name,
        side: d.side,
        stage: CLIENT_STAGE_WORDS[d.stage] ?? d.stage,
        step: clientStep(d.side, d.stage),
        steps: [...CLIENT_STEP_WORDS[d.side]],
        agentName,
        closed: d.outcome !== null,
      },
      keyDates: dates.map(({ key, label, date, time }) => ({ key, label, date, time })),
      contingencies: contingencyRows.map((c) => {
        const end =
          c.kind === 'other' ? c.ends_on : (dates.find((k) => k.key === c.end_key)?.date ?? null);
        return {
          id: c.id,
          label: contingencyLabel({ kind: c.kind, label: c.label }),
          meaning: contingencyMeaning(c.kind, d.side),
          state: c.state,
          endsOn: end,
          words: contingencyStateWords(
            {
              state: c.state,
              resolvedOn: c.resolved_at ? localDateOf(Date.parse(c.resolved_at), tz) : null,
            },
            end,
            localDateOf(Date.now(), tz),
          ),
        };
      }),
      tasks: tasks.map((t) => ({
        id: t.id,
        kind: t.kind,
        title: t.title,
        detail: t.detail,
        signOffWords: t.sign_off_words,
        forPersonId: t.for_person_id,
        dueOn: t.due_on,
        status: t.status,
        doneAt: t.done_at ? new Date(t.done_at).toISOString() : null,
        waiting:
          t.status === 'open' && t.kind === 'sign_off'
            ? (() => {
                const done = parts.filter((p) => p.task_id === t.id).map((p) => p.person_id);
                const left = (
                  t.for_person_id ? [t.for_person_id] : people.map((p) => p.person_id)
                ).filter((id) => !done.includes(id));
                return left.length ? `Waiting on ${left.map(firstName).join(' and ')}` : null;
              })()
            : null,
        mine: parts.some((p) => p.task_id === t.id && p.person_id === me.personId),
      })),
      homes: homeList.map((h) => ({
        id: h.id,
        address: h.address,
        link: h.link,
        facts: h.facts,
        status: h.status,
        // Round five: what the MLS says of it, with the notice its MLS asks for, wherever it's shown.
        mls: h.mls
          ? {
              statusWords: FEED_STATUSES[h.mls.status] ?? null,
              listPriceCents: h.mls.listPriceCents,
              photos: (h.mls.photos ?? []).slice(0, 8),
              description: h.mls.description,
              courtesy: h.mls.display?.courtesy ?? null,
              notice: h.mls.display?.notice ?? null,
              logoUrl: h.mls.display?.logoUrl ?? null,
            }
          : null,
        addedByMe: h.added_by_person_id === me.personId,
        mine:
          reactions.find((r) => r.home_id === h.id && r.person_id === me.personId)?.reaction ??
          null,
        others: reactions
          .filter((r) => r.home_id === h.id && r.person_id !== me.personId)
          .map((r) => ({ name: firstName(r.person_id), reaction: r.reaction })),
      })),
      tours: tourList.map((t) => ({
        id: t.id,
        status: t.status,
        startsAt: new Date(t.starts_at).toISOString(),
        endsAt: new Date(t.ends_at).toISOString(),
        stops: stops
          .filter((s) => s.tour_id === t.id)
          .map((s) => {
            const f = feedback.find((x) => x.stop_id === s.id);
            return {
              id: s.id,
              homeId: s.home_id,
              address: address(s.home_id),
              position: s.position,
              status: s.status,
              myFeedback: f ? { interest: f.interest, rating: f.rating, words: f.words } : null,
            };
          }),
      })),
      cmas: cmas.map((c) => ({
        id: c.id,
        address: c.subject_address,
        lowCents: c.low_cents,
        likelyCents: c.likely_cents,
        highCents: c.high_cents,
        summary: c.summary,
        sharedAt: new Date(c.shared_at).toISOString(),
      })),
      offers: offers.map((o) => ({
        id: o.id,
        address: address(o.home_id),
        status: o.status,
        summary: offerSummary(
          {
            number: o.number,
            side: o.side,
            respondBy: o.respond_by ? new Date(o.respond_by).toISOString() : null,
            priceCents: o.price_cents,
            emdCents: o.emd_cents,
            emdDays: o.emd_days,
            sellerCreditCents: o.seller_credit_cents,
            inspectionDays: o.inspection_days,
            loanType: o.loan_type,
            financingDays: o.financing_days,
            appraisalContingency: o.appraisal_contingency,
            closingDate: o.closing_date,
            otherTerms: o.other_terms,
          },
          {
            address: address(o.home_id),
            status: o.status,
            agentFirstName: (agentName ?? 'Your agent').split(/\s+/)[0]!,
            timeZone: tz,
            now,
          },
        ),
      })),
      financing:
        d.side === 'buyer'
          ? (Object.keys(FINANCING_STEPS) as FinancingStep[]).map((step) => {
              const s = steps.find((x) => x.step === step);
              return {
                step,
                label: FINANCING_STEPS[step].label,
                status: s?.status ?? 'not_started',
                date: s?.done_on ?? s?.expected_on ?? null,
              };
            })
          : [],
    };
  },
});

// ---------- changes (for the signed-in client) ----------

export const portalHomeAdd = defineAddonCommand(realestateAddon, {
  name: 'realestate.portal.home.add',
  description:
    'The client adds a home they found to their deal, with its link, for the agent to look at.',
  risk: 1,
  input: PortalHomeAddInput,
  output: PortalHomeAddOutput,
  permission: null,
  actors: ['customer'],
  scope: inWorkspace,
  emits: ['realestate.home.added'],
  async handler(ctx, input) {
    const me = requireCustomer(ctx);
    const deal = await clientDeal(ctx, input.dealId);
    requireOpen(deal);
    if (deal.side !== 'buyer') throw notYours();
    const key = addressKey(input.address);
    const [was] = await ctx.tx
      .select({ id: homes.id, status: homes.status })
      .from(homes)
      .where(and(eq(homes.dealRecordId, deal.recordId), eq(homes.addressKey, key)));
    if (was && was.status !== 'removed')
      throw HfosError.rule(
        'realestate_home_already',
        409,
        `${input.address} is already on your list. Save it there, or message your agent about it.`,
      );
    const [row] = await ctx.tx
      .insert(homes)
      .values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        address: input.address,
        addressKey: key,
        source: 'client',
        link: input.link ?? null,
        addedByPersonId: me.personId,
      })
      .returning({ id: homes.id });
    await settleMatchesFor(ctx, deal, key, row!.id);
    await ctx.tx.insert(homeReactions).values({
      workspaceId: deal.workspaceId,
      dealRecordId: deal.recordId,
      homeId: row!.id,
      personId: me.personId,
      reaction: 'saved',
      note: input.note ?? null,
    });
    await historyLine(ctx, deal, 'home_added', {
      after: { address: input.address, source: 'client' },
    });
    await ctx.emit({
      type: 'realestate.home.added',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { homeId: row!.id, source: 'client', filling: false, ownerUserId: deal.ownerUserId },
    });
    return { homeId: row!.id };
  },
});

export const portalHomeReact = defineAddonCommand(realestateAddon, {
  name: 'realestate.portal.home.react',
  description:
    'The client saves or passes on one of their deal’s homes, with a note. Each co-buyer’s is their own.',
  risk: 1,
  input: PortalHomeReactInput,
  output: PortalHomeReactOutput,
  permission: null,
  actors: ['customer'],
  scope: inWorkspace,
  emits: ['realestate.home.reacted'],
  async handler(ctx, input) {
    const me = requireCustomer(ctx);
    const [h] = await ctx.tx
      .select({
        id: homes.id,
        dealRecordId: homes.dealRecordId,
        address: homes.address,
        status: homes.status,
      })
      .from(homes)
      .where(and(eq(homes.id, input.homeId), eq(homes.workspaceId, ctx.scope.workspaceId!)));
    if (!h || h.status === 'removed') throw notYours();
    const deal = await clientDeal(ctx, h.dealRecordId);
    requireOpen(deal);
    const values = { reaction: input.reaction, note: input.note ?? null, reactedAt: new Date() };
    await ctx.tx
      .insert(homeReactions)
      .values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        homeId: h.id,
        personId: me.personId,
        ...values,
      })
      .onConflictDoUpdate({ target: [homeReactions.homeId, homeReactions.personId], set: values });
    await historyLine(ctx, deal, 'home_reacted', {
      after: { address: h.address, reaction: input.reaction },
    });
    await ctx.emit({
      type: 'realestate.home.reacted',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { homeId: h.id, personId: me.personId, reaction: input.reaction },
    });
    return { homeId: h.id, reaction: input.reaction };
  },
});

export const portalTourFeedback = defineAddonCommand(realestateAddon, {
  name: 'realestate.portal.tour.feedback',
  description:
    'The client says what they thought of a home they saw on a tour. Each co-buyer’s is their own.',
  risk: 1,
  input: PortalTourFeedbackInput,
  output: PortalTourFeedbackOutput,
  permission: null,
  actors: ['customer'],
  scope: inWorkspace,
  emits: ['realestate.tour.feedback_added', ...PROOF_EVENTS],
  async handler(ctx, input) {
    const me = requireCustomer(ctx);
    const [s] = await ctx.tx
      .select({ stop: tourStops, tourStatus: tours.status, address: homes.address })
      .from(tourStops)
      .innerJoin(tours, eq(tours.id, tourStops.tourId))
      .innerJoin(homes, eq(homes.id, tourStops.homeId))
      .where(
        and(eq(tourStops.id, input.stopId), eq(tourStops.workspaceId, ctx.scope.workspaceId!)),
      );
    if (!s || s.tourStatus === 'canceled') throw notYours();
    const deal = await clientDeal(ctx, s.stop.dealRecordId);
    requireOpen(deal);
    if (s.stop.status !== 'visited')
      throw HfosError.rule(
        'realestate_tour_not_seen',
        409,
        `${s.address} isn’t marked as seen yet. Once your agent marks it, you can say what you thought.`,
      );
    const values = {
      interest: input.interest,
      rating: input.rating ?? null,
      words: input.words ?? null,
      recordedBy: null,
      updatedAt: new Date(),
    };
    const [row] = await ctx.tx
      .insert(tourFeedback)
      .values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        tourId: s.stop.tourId,
        stopId: s.stop.id,
        homeId: s.stop.homeId,
        personId: me.personId,
        ...values,
      })
      .onConflictDoUpdate({ target: [tourFeedback.stopId, tourFeedback.personId], set: values })
      .returning({ id: tourFeedback.id });
    const [who] = await rows<{ first_name: string }>(
      ctx.tx,
      sql`select first_name from app.people where id = ${me.personId}`,
    );
    await historyLine(ctx, deal, 'tour_feedback', {
      after: {
        address: s.address,
        name: who?.first_name ?? 'The client',
        interest: input.interest,
      },
    });
    // B-08 "Collect showing feedback": the client's own.
    await addProof(
      ctx,
      deal,
      { keys: ['B-08'] },
      { kind: 'note', body: feedbackWords(who?.first_name ?? 'The client', s.address, input) },
    );
    await ctx.emit({
      type: 'realestate.tour.feedback_added',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: {
        tourId: s.stop.tourId,
        stopId: s.stop.id,
        homeId: s.stop.homeId,
        personId: me.personId,
        interest: input.interest,
        by: 'client',
      },
    });
    return { feedbackId: row!.id };
  },
});

async function myTask(ctx: CommandContext, taskId: string) {
  const me = requireCustomer(ctx);
  const task = await loadTask(ctx, taskId, true);
  const deal = await clientDeal(ctx, task.dealRecordId);
  if (task.status === 'canceled' || (task.forPersonId && task.forPersonId !== me.personId))
    throw notYours();
  requireOpen(deal);
  return { me, task, deal };
}

export const portalTaskComplete = defineAddonCommand(realestateAddon, {
  name: 'realestate.portal.task.complete',
  description:
    'The client finishes a task in their portal: signs off on its exact words, or says they’ve done it. An upload is finished by attaching the file.',
  risk: 1,
  input: PortalTaskCompleteInput,
  output: PortalTaskOutput,
  permission: null,
  actors: ['customer'],
  scope: inWorkspace,
  emits: ['realestate.client_task.done', ...PROOF_EVENTS, ...SIGN_OFF_EVENTS],
  async handler(ctx, input) {
    const { me, task, deal } = await myTask(ctx, input.taskId);
    if (task.kind === 'questionnaire')
      throw HfosError.rule(
        'realestate_task_needs_answers',
        409,
        `“${task.title}” is finished by sending your answers. Open it, answer what you can, and send it.`,
      );
    if (task.kind === 'upload')
      throw HfosError.rule(
        'realestate_task_needs_file',
        409,
        `“${task.title}” is finished by uploading the file. Pick it with Upload on the task.`,
      );
    if (task.kind === 'sign_off' && input.signedWords !== task.signOffWords)
      throw HfosError.rule(
        'realestate_sign_off_changed',
        409,
        'The words you signed off on have changed since you opened them. Read them again, then sign off.',
      );
    const status = await completeTask(ctx, deal, task, me.personId, {
      signedWords: task.kind === 'sign_off' ? task.signOffWords : null,
    });
    return { taskId: task.id, status };
  },
});

export const portalTaskAttach = defineAddonCommand(realestateAddon, {
  name: 'realestate.portal.task.attach',
  description:
    'The client attaches a file they uploaded in their portal to an upload task, which finishes it.',
  risk: 1,
  input: PortalTaskAttachInput,
  output: PortalTaskOutput,
  permission: null,
  actors: ['customer'],
  scope: inWorkspace,
  emits: ['realestate.client_task.done', ...PROOF_EVENTS],
  async handler(ctx, input) {
    const { me, task, deal } = await myTask(ctx, input.taskId);
    if (task.kind !== 'upload')
      throw HfosError.rule('realestate_task_no_file', 409, `“${task.title}” doesn’t take a file.`);
    const [f] = await rows<{ id: string }>(
      ctx.tx,
      sql`select id from app.files where id = ${input.fileId} and workspace_id = ${deal.workspaceId}
            and record_type = 'custom_record' and record_id = ${deal.recordId}
            and uploaded_by_person_id = ${me.personId} and status = 'ready' and deleted_at is null`,
    );
    if (!f)
      throw HfosError.notFound(
        'That file isn’t uploaded to this deal yet. Upload it again, then attach it.',
      );
    const status = await completeTask(ctx, deal, task, me.personId, { fileId: f.id });
    return { taskId: task.id, status };
  },
});

export const portalQueries = [portalDeals, portalDeal] as const;
export const portalCommands = [
  portalHomeAdd,
  portalHomeReact,
  portalTourFeedback,
  portalTaskComplete,
  portalTaskAttach,
] as const;
