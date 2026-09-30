/**
 * What Real Estate Agent's commands and queries share (server-only): a deal the person may see, the add-on's kinds
 * and relationship types in this business, its time zone and business days, a deal's history lines and its words.
 * Row security decides what a request sees; a deal someone isn't on reads as not there.
 */
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { customRecords } from '@hfos/db/schema';
import { localDateOf } from '../../../calendar/engine/zoned';
import type { AddonLineTone } from '../../../crm/timeline-words';
import { HfosError } from '../../../errors';
import { scopeCan } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext, QueryContext } from '../../../kernel/types';
import { addonTimelineLine } from '../../server';
import type { DealFact } from '../catalog/types';
import type { BusinessCalendar } from '../dates/business-days';
import { NO_CLOSED_DAYS } from '../dates/business-days';
import { realestateAddon } from '../manifest';
import { STAGE_LABELS, type DealSide, type DealStage } from '../states';
import { dealHistory, dealRoles, deals } from '../tables';
import type { DealRole } from '../words';

export type Ctx = CommandContext | QueryContext;

export const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** A deal as its commands need it: its row and its record's name and people. */
export interface Deal {
  readonly recordId: string;
  readonly workspaceId: string;
  readonly side: DealSide;
  readonly stage: DealStage;
  readonly stageEnteredAt: Date;
  readonly outcome: 'closed' | 'terminated' | 'lost' | 'ended' | null;
  readonly outcomeAt: Date | null;
  readonly outcomeReason: string | null;
  readonly leadId: string | null;
  readonly facts: readonly DealFact[];
  readonly templateSetId: string | null;
  readonly commissionRateBp: number | null;
  readonly commissionFlatCents: number | null;
  readonly commissionCreditCents: number;
  readonly commissionSplitBp: number | null;
  readonly expectedCommissionCents: number | null;
  readonly finalCommissionCents: number | null;
  readonly health: 'green' | 'yellow' | 'red';
  readonly healthReasons: readonly unknown[];
  readonly name: string;
  readonly ownerUserId: string | null;
  readonly teamUserIds: readonly string[];
  readonly archivedAt: Date | null;
}

export const dealGone = () =>
  HfosError.notFound(
    'That deal isn’t there anymore, or you’re not on it. Refresh, or ask its main agent to add you.',
  );

/** A deal in this business the person sees, locked when it's about to change. */
export async function loadDeal(
  ctx: Ctx,
  dealId: string,
  opts: { readonly lock?: boolean } = {},
): Promise<Deal> {
  const ws = ctx.scope.workspaceId!;
  // Locked on its own: FOR UPDATE OF can't name a table in another schema.
  if (opts.lock)
    await ctx.tx
      .select({ id: deals.recordId })
      .from(deals)
      .where(and(eq(deals.recordId, dealId), eq(deals.workspaceId, ws)))
      .for('update');
  const [row] = await ctx.tx
    .select({
      d: deals,
      name: customRecords.name,
      ownerUserId: customRecords.ownerUserId,
      teamUserIds: customRecords.teamUserIds,
      archivedAt: customRecords.archivedAt,
    })
    .from(deals)
    .innerJoin(customRecords, eq(customRecords.id, deals.recordId))
    .where(and(eq(deals.recordId, dealId), eq(deals.workspaceId, ws)));
  if (!row) throw dealGone();
  const d = row.d;
  return {
    recordId: d.recordId,
    workspaceId: d.workspaceId,
    side: d.side,
    stage: d.stage as DealStage,
    stageEnteredAt: d.stageEnteredAt,
    outcome: d.outcome ?? null,
    outcomeAt: d.outcomeAt,
    outcomeReason: d.outcomeReason,
    leadId: d.leadId,
    facts: d.facts as DealFact[],
    templateSetId: d.templateSetId,
    commissionRateBp: d.commissionRateBp,
    commissionFlatCents: d.commissionFlatCents,
    commissionCreditCents: d.commissionCreditCents,
    commissionSplitBp: d.commissionSplitBp,
    expectedCommissionCents: d.expectedCommissionCents,
    finalCommissionCents: d.finalCommissionCents,
    health: d.health,
    healthReasons: d.healthReasons,
    name: row.name,
    ownerUserId: row.ownerUserId,
    teamUserIds: row.teamUserIds,
    archivedAt: row.archivedAt,
  };
}

/** Archived deals are kept as they were: restore one to change it. */
export function requireNotArchived(deal: Deal): void {
  if (deal.archivedAt)
    throw HfosError.rule(
      'realestate_deal_archived',
      409,
      `${deal.name} is archived. Restore it from its page first, then change it.`,
    );
}

/** Still being worked: not closed, lost or ended, and not archived. */
export function requireOpen(deal: Deal): void {
  requireNotArchived(deal);
  if (deal.outcome)
    throw HfosError.rule(
      'realestate_deal_finished',
      409,
      deal.outcome === 'closed'
        ? `${deal.name} is closed, so it doesn’t move any more.`
        : `${deal.name} has ended. Reopen it from its page first.`,
    );
}

export const stageWords = (stage: DealStage) => STAGE_LABELS[stage] ?? stage;

/** Who did it, as the add-on's history says: a person, HandsFreeOS, or the AI (the Assistant or the teammate). */
export function actorKind(ctx: Ctx): 'person' | 'system' | 'ai' {
  if (ctx.actor.type === 'ai_employee') return 'ai';
  if (ctx.actor.type === 'human')
    return ctx.meta.channel === 'assistant' || ctx.meta.channel === 'contact_ai' ? 'ai' : 'person';
  return 'system';
}

export const actorUserId = (ctx: Ctx): string | null =>
  ctx.actor.type === 'human'
    ? ctx.actor.userId
    : ctx.actor.type === 'system'
      ? (ctx.actor.onBehalfOf ?? null)
      : null;

/** A line in the deal's own history. */
export async function historyLine(
  ctx: CommandContext,
  deal: Pick<Deal, 'recordId'>,
  what: string,
  change: {
    readonly before?: Record<string, unknown> | null;
    readonly after?: Record<string, unknown> | null;
    readonly note?: string | null;
  } = {},
): Promise<void> {
  await ctx.tx.insert(dealHistory).values({
    workspaceId: ctx.scope.workspaceId!,
    dealRecordId: deal.recordId,
    at: changeMoment(ctx.meta),
    actorType: actorKind(ctx),
    actorUserId: actorUserId(ctx),
    what,
    before: change.before ?? null,
    after: change.after ?? null,
    note: change.note ?? null,
  });
}

/** A line on the deal's timeline, in the add-on's words. */
export const dealLine = (
  ctx: CommandContext,
  deal: Pick<Deal, 'recordId'>,
  words: string,
  more: {
    readonly body?: string | null;
    readonly eventId?: string;
    readonly tone?: AddonLineTone;
    /** The client's or the lead's timeline too. */
    readonly personId?: string | null;
    readonly leadId?: string | null;
  } = {},
) =>
  addonTimelineLine(ctx, realestateAddon, {
    customRecordId: deal.recordId,
    personId: more.personId ?? null,
    leadId: more.leadId ?? null,
    words,
    body: more.body ?? null,
    eventId: more.eventId ?? null,
    ...(more.tone ? { tone: more.tone } : {}),
  });

// ---------- the add-on's kinds and relationship types here ----------

/** The add-on's two kinds of record in this business, set up by the worker when it was turned on. */
export async function kindIds(ctx: Ctx): Promise<{ deal: string; property: string }> {
  const list = await rows<{ id: string; key: string }>(
    ctx.tx,
    sql`select id, key from app.custom_record_types
        where workspace_id = ${ctx.scope.workspaceId!} and addon_id = 'realestate'
          and key in ('realestate_deal', 'realestate_property')`,
  );
  const deal = list.find((k) => k.key === 'realestate_deal')?.id;
  const property = list.find((k) => k.key === 'realestate_property')?.id;
  if (!deal || !property) throw stillSettingUp();
  return { deal, property };
}

const stillSettingUp = () =>
  HfosError.rule(
    'realestate_setting_up',
    409,
    'Real Estate Agent is still being set up in this business. Try again in a minute.',
  );

/** The add-on's relationship types here, by their key in its manifest. */
export async function relationshipTypeIds(ctx: Ctx): Promise<ReadonlyMap<string, string>> {
  const list = await rows<{ id: string; addon_key: string }>(
    ctx.tx,
    sql`select id, addon_key from app.relationship_types
        where workspace_id = ${ctx.scope.workspaceId!} and addon_id = 'realestate' and archived_at is null`,
  );
  return new Map(list.map((t) => [t.addon_key, t.id]));
}

export async function relationshipTypeId(ctx: Ctx, key: string): Promise<string> {
  const id = (await relationshipTypeIds(ctx)).get(key);
  if (!id) throw stillSettingUp();
  return id;
}

// ---------- the business's clock ----------

export async function timeZoneOf(ctx: Ctx): Promise<string> {
  const [w] = await rows<{ timezone: string }>(
    ctx.tx,
    sql`select timezone from app.workspaces where id = ${ctx.scope.workspaceId!}`,
  );
  return w?.timezone ?? 'America/Chicago';
}

/**
 * Days the business is closed besides weekends and federal holidays: the add-on's `closedDays` setting
 * (`{ "2026-12-24": "Christmas Eve" }`), which the settings page writes (step 12).
 */
export async function businessCalendarOf(ctx: Ctx): Promise<BusinessCalendar> {
  const [i] = await rows<{ closed: unknown }>(
    ctx.tx,
    sql`select settings -> 'closedDays' as closed from app.addon_installations
        where workspace_id = ${ctx.scope.workspaceId!} and addon_id = 'realestate'`,
  );
  const closed = i?.closed;
  if (!closed || typeof closed !== 'object' || Array.isArray(closed)) return NO_CLOSED_DAYS;
  const days = Object.entries(closed as Record<string, unknown>).filter(
    (e): e is [string, string] => /^\d{4}-\d{2}-\d{2}$/.test(e[0]) && typeof e[1] === 'string',
  );
  return { closedDays: new Map(days) };
}

/** Today's date where the business is. */
export const todayIn = (timeZone: string, at: Date = new Date()): string =>
  localDateOf(at.getTime(), timeZone);

// ---------- the team ----------

/** Who on the deal does what: its main agent is its record's owner; the rest are named in `deal_roles`. */
export async function rolesOf(
  ctx: Ctx,
  deal: Pick<Deal, 'recordId'>,
): Promise<ReadonlyMap<string, DealRole>> {
  const list = await ctx.tx
    .select({ userId: dealRoles.userId, role: dealRoles.role })
    .from(dealRoles)
    .where(eq(dealRoles.dealRecordId, deal.recordId));
  return new Map(list.map((r) => [r.userId, r.role]));
}

/** Whoever the coordinator role falls to: the deal's coordinator, else its main agent. */
export function personFor(
  role: 'agent' | 'coordinator' | 'broker',
  deal: Pick<Deal, 'ownerUserId'>,
  roles: ReadonlyMap<string, DealRole>,
): string | null {
  if (role === 'broker') return null;
  if (role === 'coordinator') {
    const coordinator = [...roles].find(([, r]) => r === 'coordinator')?.[0];
    if (coordinator) return coordinator;
  }
  return deal.ownerUserId;
}

/** Their main person, or someone who changes any record's team (owners and admins). */
export function mayChangeTeam(ctx: Ctx, deal: Pick<Deal, 'ownerUserId'>): boolean {
  if (ctx.actor.type !== 'human') return true;
  return scopeCan(ctx.scope, 'records.assign') || deal.ownerUserId === ctx.actor.userId;
}

/** The names of people who work here, for answers. */
export async function userNames(
  ctx: Ctx,
  ids: readonly (string | null)[],
): Promise<ReadonlyMap<string, string>> {
  const list = [...new Set(ids.filter((i): i is string => !!i))];
  if (!list.length) return new Map();
  const found = await rows<{ id: string; name: string }>(
    ctx.tx,
    sql`select u.id, coalesce(nullif(u.full_name, ''), u.email::text) as name
        from app.users u
        where u.id = any(${`{${list.join(',')}}`}::uuid[])`,
  );
  return new Map(found.map((u) => [u.id, u.name]));
}
