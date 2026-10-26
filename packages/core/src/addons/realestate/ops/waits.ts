/**
 * What a duty waits on (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round four", step 4).
 *
 * - **Built in, plus the agent's own** (Chris, 2026-10-02). The catalog's order (catalog/order.ts) is written on a
 *   deal once both duties are on it; the agent says a duty waits on another on the same deal, never in a circle.
 *   Built-in orders stay: one that doesn't apply ends when its first duty is waived or done.
 * - **A waiting duty shows what it waits on and who has it; a slip shows what moves**: the duties waiting on it, and
 *   those resting on the same date.
 * - **Waiting on someone outside** has a day to chase them; "Chased" moves it on two business days.
 */
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import { HfosError } from '../../../errors';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import { defineAddonCommand } from '../../server';
import type { ResolvedDuty } from '../catalog/types';
import { makesCircle, waitsOnOf } from '../catalog/order';
import { dueRuleDates } from '../dates/due';
import { realestateAddon } from '../manifest';
import { DutyChasedInput, DutyLinkInput, DutyLinkOutput, DutyOutput } from '../schemas';
import { DUTY_STATUS_LABELS, isDoneDuty, type DutyStatus } from '../states';
import { duties, dutyLinks } from '../tables';
import {
  actorUserId,
  inWorkspace,
  requireNotArchived,
  timeZoneOf,
  userNames,
  type Ctx,
  type Deal,
} from './common';
import { chaseDefault, chaseOn } from './chase';
import { dutyEvent, loadDuty, logLine, type DutyRow } from './duties';
import { openWork } from './engine';

async function onSameDeal(ctx: CommandContext, deal: Deal, id: string): Promise<DutyRow> {
  const [d] = await ctx.tx
    .select()
    .from(duties)
    .where(and(eq(duties.id, id), eq(duties.dealRecordId, deal.recordId)));
  if (!d)
    throw HfosError.notFound(
      'That duty isn’t on this deal. A duty waits only on another on the same deal.',
    );
  return d;
}

export const dutyLink = defineAddonCommand(realestateAddon, {
  name: 'realestate.duty.link',
  description:
    'Say a duty can’t be done before another on the same deal. Its drawer shows what it waits on and who has it, and the deal turns yellow when it’s due soon with that one still open.',
  risk: 1,
  input: DutyLinkInput,
  output: DutyLinkOutput,
  permission: 'realestate.use',
  ai: { tool: 'realestate_duty_link', autonomy: 'confirm' },
  scope: inWorkspace,
  emits: ['realestate.duty.linked'],
  async handler(ctx, input) {
    const { duty, deal } = await loadDuty(ctx, input.dutyId, { lock: true });
    requireNotArchived(deal);
    const first = await onSameDeal(ctx, deal, input.waitsOnId);
    for (const d of [duty, first])
      if (d.status === 'cancelled')
        throw HfosError.rule(
          'realestate_duty_link_cancelled',
          409,
          `“${d.title}” was cancelled, so nothing waits on it or for it.`,
        );
    const links = await ctx.tx
      .select({ from: dutyLinks.dutyId, to: dutyLinks.dependsOnId })
      .from(dutyLinks)
      .where(eq(dutyLinks.dealRecordId, deal.recordId));
    if (links.some((l) => l.from === duty.id && l.to === first.id))
      return { dealId: deal.recordId, dutyId: duty.id, waitsOnId: first.id };
    if (makesCircle(links, duty.id, first.id))
      throw HfosError.rule(
        'realestate_duty_link_circle',
        409,
        `“${first.title}” already waits on “${duty.title}”, so “${duty.title}” can’t wait on it too. Pick a different duty.`,
      );
    await ctx.tx.insert(dutyLinks).values({
      workspaceId: deal.workspaceId,
      dealRecordId: deal.recordId,
      dutyId: duty.id,
      dependsOnId: first.id,
      kind: 'finish_to_start',
      addedBy: actorUserId(ctx),
      createdAt: changeMoment(ctx.meta),
    });
    await logLine(ctx, duty, 'waits_on_added', { after: { dutyId: first.id, title: first.title } });
    await dutyEvent(ctx, 'realestate.duty.linked', duty, deal, {
      after: { waitsOn: first.title },
      payload: { waitsOnId: first.id },
    });
    await (await openWork(ctx, deal)).settle();
    return { dealId: deal.recordId, dutyId: duty.id, waitsOnId: first.id };
  },
});

export const dutyUnlink = defineAddonCommand(realestateAddon, {
  name: 'realestate.duty.unlink',
  description:
    'Take back that a duty waits on another, when a person said so. The built-in order of duties stays.',
  risk: 1,
  input: DutyLinkInput,
  output: DutyLinkOutput,
  permission: 'realestate.use',
  ai: { tool: 'realestate_duty_unlink', autonomy: 'confirm' },
  scope: inWorkspace,
  emits: ['realestate.duty.unlinked'],
  async handler(ctx, input) {
    const { duty, deal } = await loadDuty(ctx, input.dutyId, { lock: true });
    requireNotArchived(deal);
    const [link] = await ctx.tx
      .select()
      .from(dutyLinks)
      .where(and(eq(dutyLinks.dutyId, duty.id), eq(dutyLinks.dependsOnId, input.waitsOnId)));
    if (!link) return { dealId: deal.recordId, dutyId: duty.id, waitsOnId: input.waitsOnId };
    const first = await onSameDeal(ctx, deal, input.waitsOnId);
    if (!link.addedBy && waitsOnOf(duty.dutyKey).includes(first.dutyKey))
      throw HfosError.rule(
        'realestate_duty_link_built_in',
        409,
        `“${duty.title}” waits on “${first.title}” in every deal, so that stays. If “${first.title}” doesn’t apply here, waive it, and nothing waits on it anymore.`,
      );
    await ctx.tx.delete(dutyLinks).where(eq(dutyLinks.id, link.id));
    await logLine(ctx, duty, 'waits_on_removed', {
      before: { dutyId: first.id, title: first.title },
    });
    await dutyEvent(ctx, 'realestate.duty.unlinked', duty, deal, {
      before: { waitsOn: first.title },
      payload: { waitsOnId: first.id },
    });
    await (await openWork(ctx, deal)).settle();
    return { dealId: deal.recordId, dutyId: duty.id, waitsOnId: first.id };
  },
});

export const dutyChased = defineAddonCommand(realestateAddon, {
  name: 'realestate.duty.chased',
  description:
    'Say you chased whoever a duty is waiting on outside. The next day to chase moves on two business days, or to the day given.',
  risk: 0,
  input: DutyChasedInput,
  output: DutyOutput,
  permission: 'realestate.use',
  ai: { tool: 'realestate_duty_chased' },
  scope: inWorkspace,
  emits: ['realestate.duty.chased'],
  async handler(ctx, input) {
    const { duty, deal } = await loadDuty(ctx, input.dutyId, { lock: true });
    requireNotArchived(deal);
    if (duty.status !== 'waiting_external')
      throw HfosError.rule(
        'realestate_duty_not_waiting',
        409,
        `“${duty.title}” isn’t waiting on anyone outside; it’s ${DUTY_STATUS_LABELS[duty.status as DutyStatus].toLowerCase()}. Mark it Waiting on… first.`,
      );
    const at = changeMoment(ctx.meta);
    const next = input.nextOn
      ? chaseOn(input.nextOn, await timeZoneOf(ctx))
      : await chaseDefault(ctx, at);
    if (next.getTime() <= at.getTime())
      throw HfosError.validation([
        { path: 'nextOn', message: 'Pick a day after today to chase them next.' },
      ]);
    await ctx.tx.update(duties).set({ chaseAt: next, updatedAt: at }).where(eq(duties.id, duty.id));
    await logLine(ctx, duty, 'chased', {
      after: { waitingOn: duty.waitingOn, next: next.toISOString() },
      note: input.note ?? null,
    });
    await dutyEvent(ctx, 'realestate.duty.chased', duty, deal, {
      after: { chaseAt: next.toISOString() },
      payload: { chaseAt: next.toISOString() },
    });
    await (await openWork(ctx, deal)).settle();
    return { dealId: deal.recordId, dutyId: duty.id, status: duty.status as DutyStatus };
  },
});

export const waitCommands = [dutyLink, dutyUnlink, dutyChased];

// ---------- what a duty's drawer shows ----------

export interface WaitLine {
  readonly dutyId: string;
  readonly title: string;
  readonly status: DutyStatus;
  readonly accountableName: string | null;
  readonly dueAt: string | null;
  readonly overdue: boolean;
  readonly waitingOn: string | null;
  /** In every deal, or a person said so: their name. */
  readonly builtIn: boolean;
  readonly addedByName: string | null;
}

/** What a duty waits on, what waits on it, and what moves if it slips. */
export async function waitsOf(
  ctx: Ctx,
  duty: DutyRow,
): Promise<{
  readonly waitsOn: WaitLine[];
  readonly waitingOnThis: WaitLine[];
  readonly ifItSlips: { readonly waiting: string[]; readonly sameDate: string[] };
}> {
  const links = await ctx.tx
    .select()
    .from(dutyLinks)
    .where(or(eq(dutyLinks.dutyId, duty.id), eq(dutyLinks.dependsOnId, duty.id)))
    .orderBy(asc(dutyLinks.createdAt), asc(dutyLinks.id));
  const ids = [...new Set(links.flatMap((l) => [l.dutyId, l.dependsOnId]))].filter(
    (id) => id !== duty.id,
  );
  const others = ids.length
    ? await ctx.tx.select().from(duties).where(inArray(duties.id, ids))
    : [];
  const names = await userNames(ctx, [
    ...others.map((o) => o.accountableUserId),
    ...links.map((l) => l.addedBy),
  ]);
  const now = Date.now();
  const line = (o: DutyRow, addedBy: string | null): WaitLine => ({
    dutyId: o.id,
    title: o.title,
    status: o.status as DutyStatus,
    accountableName: o.accountableUserId ? (names.get(o.accountableUserId) ?? null) : null,
    dueAt: o.dueAt?.toISOString() ?? null,
    overdue:
      !isDoneDuty(o.status as DutyStatus) &&
      o.status !== 'draft' &&
      !!o.dueAt &&
      o.dueAt.getTime() <= now,
    waitingOn: o.status === 'waiting_external' ? o.waitingOn : null,
    builtIn: !addedBy,
    addedByName: addedBy ? (names.get(addedBy) ?? null) : null,
  });
  const byId = new Map(others.map((o) => [o.id, o]));
  const waitsOn = links
    .filter((l) => l.dutyId === duty.id && byId.has(l.dependsOnId))
    .map((l) => line(byId.get(l.dependsOnId)!, l.addedBy));
  const waitingOnThis = links
    .filter((l) => l.dependsOnId === duty.id && byId.has(l.dutyId))
    .map((l) => line(byId.get(l.dutyId)!, l.addedBy))
    .filter((w) => w.status !== 'cancelled');
  // Others resting on the same date move with it if that date moves.
  const keys = dueRuleDates((duty.definition as unknown as ResolvedDuty).due);
  const sameDate = keys.length
    ? (
        await ctx.tx
          .select({
            id: duties.id,
            title: duties.title,
            status: duties.status,
            definition: duties.definition,
          })
          .from(duties)
          .where(eq(duties.dealRecordId, duty.dealRecordId))
          .orderBy(asc(duties.dueAt), asc(duties.createdAt), asc(duties.id))
      )
        .filter(
          (o) =>
            o.id !== duty.id &&
            !isDoneDuty(o.status as DutyStatus) &&
            !waitingOnThis.some((w) => w.dutyId === o.id) &&
            dueRuleDates((o.definition as unknown as ResolvedDuty).due).some((k) =>
              keys.includes(k),
            ),
        )
        .map((o) => o.title)
    : [];
  return {
    waitsOn,
    waitingOnThis,
    ifItSlips: {
      waiting: waitingOnThis.filter((w) => !isDoneDuty(w.status)).map((w) => w.title),
      sameDate,
    },
  };
}
