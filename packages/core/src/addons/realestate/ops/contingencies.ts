/**
 * Contingencies (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round four", step 3): what a deal's contract lets a
 * side step back for, each ending on its date, and how each ended.
 *
 * - **Tracked on their own** from the accepted offer and the key dates (./risk.ts); the agent adds one the contract
 *   names that isn't on the list.
 * - **The agent records how it ended** (Chris, 2026-10-02): satisfied, waived or expired, with the signed removal form,
 *   one of the deal's documents. An owner or admin (Approve exceptions) can record one without it, with a reason
 *   that's kept. It's proof for the contingency tracker (X-17), and the client sees it in their portal.
 * - Health: yellow while one ends within two business days, red once one is past its end with nothing recorded.
 */
import { and, asc, eq } from 'drizzle-orm';
import { HfosError } from '../../../errors';
import { executeCommandWithin, scopeCan } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import type { Permission } from '../../../permissions';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import {
  CONTINGENCY_KINDS,
  contingencyClock,
  contingencyEnd,
  contingencyLabel,
  contingencyStateWords,
  inSentence,
} from '../contingencies';
import { realestateAddon } from '../manifest';
import {
  ContingenciesInput,
  ContingenciesOutput,
  ContingencyAddInput,
  ContingencyOutput,
  ContingencyResolveInput,
} from '../schemas';
import { contingencies, documents } from '../tables';
import { keyDatesOf, termsNow } from '../terms';
import {
  actorUserId,
  businessCalendarOf,
  dealLine,
  historyLine,
  inWorkspace,
  loadDeal,
  requireNotArchived,
  timeZoneOf,
  todayIn,
  userNames,
} from './common';
import { openWork, termEntriesOf } from './engine';
import { addProof, PROOF_EVENTS } from './proof-hooks';
import { termEnter } from './terms';

const ENDED_WORDS = { satisfied: 'satisfied', waived: 'waived', expired: 'expired' } as const;

export const contingencyAdd = defineAddonCommand(realestateAddon, {
  name: 'realestate.contingency.add',
  description:
    'Track a contingency on a deal: one of the usual kinds (inspection, financing, appraisal, the sale of the buyer’s home, HOA documents, title review), ending on its key date, or one the contract names, with its own end date.',
  risk: 1,
  input: ContingencyAddInput,
  output: ContingencyOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.contingency.added'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireNotArchived(deal);
    if (input.kind !== 'other') {
      const [had] = await ctx.tx
        .select({ id: contingencies.id, state: contingencies.state })
        .from(contingencies)
        .where(
          and(eq(contingencies.dealRecordId, deal.recordId), eq(contingencies.kind, input.kind)),
        );
      if (had)
        throw HfosError.rule(
          'realestate_contingency_exists',
          409,
          `${deal.name} already has the ${inSentence(CONTINGENCY_KINDS[input.kind].label)} contingency. Change when it ends under Key dates.`,
        );
    }
    const endKey = CONTINGENCY_KINDS[input.kind].endKey;
    const [made] = await ctx.tx
      .insert(contingencies)
      .values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        kind: input.kind,
        label: input.kind === 'other' ? input.label! : null,
        endKey,
        endsOn: input.kind === 'other' ? input.endsOn! : null,
        source: 'typed',
        createdBy: actorUserId(ctx),
        createdAt: changeMoment(ctx.meta),
      })
      .returning();
    await historyLine(ctx, deal, 'contingency_added', {
      after: { kind: input.kind, label: input.label ?? null, source: 'typed' },
    });
    const label = contingencyLabel(made!);
    const eventId = await ctx.emit({
      type: 'realestate.contingency.added',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: { name: deal.name, contingencyId: made!.id, kind: input.kind },
      after: { name: deal.name, contingency: label },
    });
    await dealLine(ctx, deal, `added the ${inSentence(label)} contingency`, { eventId });
    // Its end date, when the key dates don't have it yet.
    if (endKey && input.date)
      await executeCommandWithin(ctx, termEnter, {
        workspaceId: deal.workspaceId,
        dealId: deal.recordId,
        key: endKey,
        date: input.date,
        source: 'typed',
      });
    else await (await openWork(ctx, deal)).settle();
    return { dealId: deal.recordId, contingencyId: made!.id };
  },
});

export const contingencyResolve = defineAddonCommand(realestateAddon, {
  name: 'realestate.contingency.resolve',
  description:
    'Record how a contingency ended: satisfied, waived or expired, with the signed removal form from the deal’s documents. An owner or admin can record it without the form, with a reason. The client sees it in their portal.',
  risk: 2,
  input: ContingencyResolveInput,
  output: ContingencyOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.contingency.resolved', ...PROOF_EVENTS],
  async handler(ctx, input) {
    const [row] = await ctx.tx
      .select()
      .from(contingencies)
      .where(
        and(
          eq(contingencies.id, input.contingencyId),
          eq(contingencies.workspaceId, ctx.scope.workspaceId!),
        ),
      );
    if (!row)
      throw HfosError.notFound(
        'That contingency isn’t on the deal anymore, or you’re not on its deal. Refresh to see its contingencies.',
      );
    const deal = await loadDeal(ctx, row.dealRecordId, { lock: true });
    requireNotArchived(deal);
    const [c] = await ctx.tx
      .select()
      .from(contingencies)
      .where(eq(contingencies.id, row.id))
      .for('update');
    const label = contingencyLabel(c!);
    if (c!.state !== 'open')
      throw HfosError.rule(
        'realestate_contingency_ended',
        409,
        `The ${inSentence(label)} contingency was already recorded as ${ENDED_WORDS[c!.state as keyof typeof ENDED_WORDS]}. Refresh to see it.`,
      );
    let documentTitle: string | null = null;
    if (input.documentId) {
      const [doc] = await ctx.tx
        .select({ id: documents.id, title: documents.title, status: documents.status })
        .from(documents)
        .where(and(eq(documents.id, input.documentId), eq(documents.dealRecordId, deal.recordId)));
      if (!doc)
        throw HfosError.notFound(
          'That form isn’t one of this deal’s documents. Add it under Documents first, then pick it.',
        );
      if (doc.status === 'void')
        throw HfosError.rule(
          'realestate_document_void',
          409,
          `“${doc.title}” was voided, so it can’t show how the contingency ended. Pick the signed form.`,
        );
      documentTitle = doc.title;
    } else {
      if (!input.reason)
        throw HfosError.rule(
          'realestate_contingency_needs_form',
          409,
          `Recording how the ${inSentence(label)} contingency ended needs the signed form. Add it under Documents and pick it, or ask an owner or admin to record it without the form.`,
        );
      if (ctx.actor.type !== 'human' || !scopeCan(ctx.scope, 'realestate.except' as Permission))
        throw HfosError.forbidden(
          'Only an owner or admin (Approve exceptions) can record how a contingency ended without the signed form. Ask one of them, or add the form.',
          'realestate_contingency_exception_permission',
        );
    }
    const at = changeMoment(ctx.meta);
    await ctx.tx
      .update(contingencies)
      .set({
        state: input.how,
        resolvedAt: at,
        resolvedBy: actorUserId(ctx),
        documentId: input.documentId ?? null,
        note: input.note ?? null,
        overrideReason: input.documentId ? null : input.reason!,
        updatedAt: at,
      })
      .where(eq(contingencies.id, c!.id));
    await historyLine(ctx, deal, 'contingency_resolved', {
      before: { kind: c!.kind, label, state: 'open' },
      after: {
        kind: c!.kind,
        label,
        state: input.how,
        documentId: input.documentId ?? null,
        withoutForm: !input.documentId,
      },
      note: input.documentId ? (input.note ?? null) : input.reason!,
    });
    await addProof(
      ctx,
      deal,
      { keys: ['X-17'] },
      input.documentId
        ? { kind: 'document', documentId: input.documentId }
        : {
            kind: 'note',
            body: `The ${inSentence(label)} contingency was ${ENDED_WORDS[input.how]} without the signed form: ${input.reason}`,
          },
    );
    const eventId = await ctx.emit({
      type: 'realestate.contingency.resolved',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: {
        name: deal.name,
        contingencyId: c!.id,
        kind: c!.kind,
        how: input.how,
        withoutForm: !input.documentId,
      },
      before: { name: deal.name, [label]: 'open' },
      after: { name: deal.name, [label]: input.how },
    });
    await dealLine(
      ctx,
      deal,
      `recorded the ${inSentence(label)} contingency as ${ENDED_WORDS[input.how]}`,
      {
        eventId,
        body: input.documentId
          ? `With “${documentTitle}”.${input.note ? ` ${input.note}` : ''}`
          : `Without the signed form: ${input.reason}`,
        ...(input.documentId ? {} : { tone: 'warning' as const }),
      },
    );
    await (await openWork(ctx, deal)).settle();
    return { dealId: deal.recordId, contingencyId: c!.id };
  },
});

export const contingencyList = defineAddonQuery(realestateAddon, {
  name: 'realestate.contingencies',
  description:
    'A deal’s contingencies: when each ends, whether it’s open, ending soon or past its end, and how each ended, with the form.',
  input: ContingenciesInput,
  output: ContingenciesOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_get_contingencies',
    description: 'A deal’s contingencies, when each ends and how each ended.',
  },
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId);
    const list = await ctx.tx
      .select({ c: contingencies, title: documents.title })
      .from(contingencies)
      .leftJoin(documents, eq(documents.id, contingencies.documentId))
      .where(eq(contingencies.dealRecordId, deal.recordId))
      .orderBy(asc(contingencies.createdAt));
    const keyDates = keyDatesOf(termsNow(await termEntriesOf(ctx, deal.recordId)));
    const timeZone = await timeZoneOf(ctx);
    const calendar = await businessCalendarOf(ctx);
    const today = todayIn(timeZone);
    const names = await userNames(
      ctx,
      list.map((r) => r.c.resolvedBy),
    );
    return {
      dealId: deal.recordId,
      contingencies: list.map(({ c, title }) => {
        const end = contingencyEnd(c, keyDates);
        const resolvedOn = c.resolvedAt ? todayIn(timeZone, c.resolvedAt) : null;
        return {
          id: c.id,
          kind: c.kind,
          label: contingencyLabel(c),
          endKey: c.endKey,
          endsOn: end.date,
          endConfirmed: end.confirmed,
          state: c.state,
          stateWords: contingencyStateWords({ state: c.state, resolvedOn }, end.date, today),
          clock: c.state === 'open' ? contingencyClock(end.date, today, calendar) : 'open',
          source: c.source,
          resolvedAt: c.resolvedAt?.toISOString() ?? null,
          resolvedByName: c.resolvedBy ? (names.get(c.resolvedBy) ?? null) : null,
          document: c.documentId && title ? { id: c.documentId, title } : null,
          note: c.note,
          overrideReason: c.overrideReason,
        };
      }),
      can: {
        except:
          ctx.actor.type === 'human' && scopeCan(ctx.scope, 'realestate.except' as Permission),
      },
    };
  },
});

export const contingencyCommands = [contingencyAdd, contingencyResolve];
export const contingencyQueries = [contingencyList];
