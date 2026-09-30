/**
 * Health and the sweep (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Health and alerts"). The sweep is the add-on's
 * own system command, run by its worker every fifteen minutes while it's on: each open deal's due times, drafts and
 * health are worked out again as time passes, and it answers where each open duty stands on the alert ladder, for
 * the worker to raise through core's add-on alerts. `deal.risks` answers "what could stop this closing?" with every
 * open material duty, who answers for it, when it's due and what's missing.
 */
import { asc, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { localDateOf } from '../../../calendar/engine/zoned';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import type { ProofRule, ResolvedDuty } from '../catalog/types';
import { healthOf, type HealthReason } from '../health';
import { rungOf } from '../ladder';
import { realestateAddon } from '../manifest';
import { gapWords, proofGaps } from '../proof';
import { DealRisksInput, DealRisksOutput, SweepInput, SweepOutput } from '../schemas';
import { isOpenDuty, isOverdue, type DutyStatus } from '../states';
import { duties } from '../tables';
import { conflictsOf, keyDatesOf, termsNow } from '../terms';
import {
  businessCalendarOf,
  inWorkspace,
  loadDeal,
  rolesOf,
  timeZoneOf,
  userNames,
  type Ctx,
  type Deal,
} from './common';
import { dealProofFactsOf, evidenceFactsOf } from './duties';
import { dateProblemsOf, openWork, termEntriesOf } from './engine';

/** A deal's health as things stand this moment, without writing anything. */
export async function healthNow(ctx: Ctx, deal: Deal, now = Date.now()) {
  const timeZone = await timeZoneOf(ctx);
  const calendar = await businessCalendarOf(ctx);
  const terms = termsNow(await termEntriesOf(ctx, deal.recordId));
  const keyDates = keyDatesOf(terms);
  const today = localDateOf(now, timeZone);
  const list = await ctx.tx
    .select()
    .from(duties)
    .where(eq(duties.dealRecordId, deal.recordId))
    .orderBy(asc(duties.dueAt));
  const health = healthOf({
    duties: list.map((d) => ({
      id: d.id,
      key: d.dutyKey,
      title: d.title,
      status: d.status as DutyStatus,
      materiality: d.materiality as 'standard' | 'material' | 'critical',
      dueAt: d.dueAt?.toISOString() ?? null,
      dueDate: d.dueDate,
      dueState: d.dueState as 'due' | 'none' | 'waiting',
      needsDates: d.needsDates,
      accountableRole: d.accountableRole as 'agent' | 'coordinator' | 'broker',
      accountableUserId: d.accountableUserId,
      blocker: d.blocker,
    })),
    keyDates,
    conflicts: conflictsOf(terms),
    dateProblems: await dateProblemsOf(ctx, deal, keyDates, calendar, today),
    now,
    today,
    calendar,
  });
  return { health, duties: list };
}

export const dealRisks = defineAddonQuery(realestateAddon, {
  name: 'realestate.deal.risks',
  description:
    'What could stop a deal closing: its health with every reason, and each open material or critical duty with who answers for it, when it’s due, the proof it still needs and the next step.',
  input: DealRisksInput,
  output: DealRisksOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  handler: async (ctx, input) => {
    const deal = await loadDeal(ctx, input.dealId);
    const { health, duties: list } = await healthNow(ctx, deal);
    const open = list.filter(
      (d) => isOpenDuty(d.status as DutyStatus) && d.materiality !== 'standard',
    );
    const names = await userNames(ctx, [
      ...list.map((d) => d.accountableUserId),
      ...health.reasons.map((r) => r.accountableUserId ?? null),
    ]);
    const who = (id: string | null | undefined) =>
      id ? { userId: id, name: names.get(id) ?? 'Former member' } : null;
    const proofFacts = await dealProofFactsOf(ctx, deal);
    const now = Date.now();
    const openWork = [];
    for (const d of open) {
      const rule = (d.definition as unknown as ResolvedDuty).proof as ProofRule | null;
      const gaps = proofGaps(rule, await evidenceFactsOf(ctx, d.id), proofFacts);
      const missing = gaps.length ? gapWords(rule, gaps) : '';
      openWork.push({
        dutyId: d.id,
        title: d.title,
        status: d.status as DutyStatus,
        materiality: d.materiality,
        overdue: isOverdue(
          { status: d.status as DutyStatus, dueAt: d.dueAt?.toISOString() ?? null },
          now,
        ),
        dueAt: d.dueAt?.toISOString() ?? null,
        accountable: who(d.accountableUserId),
        missing,
        next:
          d.status === 'blocked'
            ? `Clear what’s in the way: ${d.blocker ?? 'see the duty'}.`
            : d.status === 'waiting_external'
              ? `Chase ${d.waitingOn ?? 'whoever it’s waiting on'}.`
              : missing
                ? `Add ${missing}, then mark it done.`
                : 'Mark it done.',
      });
    }
    return {
      dealId: deal.recordId,
      name: deal.name,
      health: health.level,
      reasons: health.reasons.map((r: HealthReason) => ({
        code: r.code,
        level: r.level,
        words: r.words,
        next: r.next,
        ...(r.dutyId ? { dutyId: r.dutyId } : {}),
        ...(r.keys ? { keys: [...r.keys] } : {}),
        ...(r.dueAt !== undefined ? { dueAt: r.dueAt } : {}),
        accountable: who(r.accountableUserId),
      })),
      openWork,
    };
  },
});

export const sweep = defineAddonCommand(realestateAddon, {
  name: 'realestate.sweep',
  description:
    'Real Estate Agent’s own check, every fifteen minutes: each open deal’s due times, drafts and health again as time passes, and where each open duty stands on the alert ladder.',
  risk: 0,
  input: SweepInput,
  output: SweepOutput,
  permission: null,
  scope: inWorkspace,
  emits: [],
  actors: ['system'],
  async handler(ctx) {
    // Deals still being worked, and closed ones with duties left; never archived ones.
    const ids = await rows<{ id: string }>(
      ctx.tx,
      sql`select d.record_id as id
          from addon_realestate.deals d
          join app.custom_records r on r.id = d.record_id
          where d.workspace_id = ${ctx.scope.workspaceId!} and r.archived_at is null
            and (d.outcome is null or exists (
              select 1 from addon_realestate.duties t
              where t.deal_record_id = d.record_id
                and t.status in ('not_started', 'in_progress', 'waiting_external', 'blocked')))
          order by d.record_id`,
    );
    const alerts = [];
    for (const { id } of ids) {
      const deal = await loadDeal(ctx, id, { lock: true });
      const w = await openWork(ctx, deal);
      await w.settle();
      const now = w.at.getTime();
      const today = localDateOf(now, w.timeZone);
      const roles = await rolesOf(ctx, deal);
      const coordinators = [...roles].filter(([, r]) => r === 'coordinator').map(([u]) => u);
      for (const d of w.duties) {
        const dueAt = d.dueAt?.toISOString() ?? null;
        const rung = rungOf(
          {
            id: d.id,
            key: d.dutyKey,
            title: d.title,
            status: d.status,
            materiality: d.materiality,
            dueAt,
            dueDate: d.dueDate,
          },
          now,
          today,
          w.calendar,
          d.definition.reminders ?? [7, 3, 1],
        );
        if (!rung || !dueAt) continue;
        alerts.push({
          dealId: deal.recordId,
          dealName: deal.name,
          dutyId: d.id,
          key: d.dutyKey,
          title: d.title,
          status: d.status,
          materiality: d.materiality,
          dueAt,
          dueDate: d.dueDate,
          rung,
          accountableUserId: d.accountableUserId,
          mainAgentUserId: deal.ownerUserId,
          coordinatorUserIds: coordinators,
        });
      }
    }
    return { deals: ids.length, alertPersonUserIds: await alertPeopleOf(ctx), alerts };
  },
});

/**
 * The people told of critical alerts besides a deal's own team: those the business picked (Settings → Real Estate),
 * while they still see every deal, else its owners.
 */
export async function alertPeopleOf(ctx: Ctx): Promise<string[]> {
  const [i] = await rows<{ picked: string[] | null }>(
    ctx.tx,
    sql`select array(select jsonb_array_elements_text(settings -> 'alertPersonUserIds')) as picked
        from app.addon_installations
        where workspace_id = ${ctx.scope.workspaceId!} and addon_id = 'realestate'`,
  );
  const picked = (i?.picked ?? []).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  const people = await rows<{ user_id: string }>(
    ctx.tx,
    picked.length
      ? sql`select wa.user_id from app.workspace_access wa
            where wa.workspace_id = ${ctx.scope.workspaceId!} and 'realestate.all_deals' = any (wa.permissions)
              and wa.user_id = any (${`{${picked.join(',')}}`}::uuid[])
            order by wa.user_id`
      : sql`select wa.user_id from app.workspace_access wa
            where wa.workspace_id = ${ctx.scope.workspaceId!} and wa.role = 'owner'
            order by wa.user_id`,
  );
  return people.map((p) => p.user_id);
}

export const healthCommands = [sweep];
export const healthQueries = [dealRisks];
