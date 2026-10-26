/**
 * The whole transaction, exported (round six, step 10; spec §18 and §26). Owners and admins (`realestate.export`)
 * ask for it; the worker builds the zip (apps/worker/src/addons/realestate/export.ts) and keeps it as a file on the
 * deal; the deal's Documents list each export with its fingerprint.
 *
 * - **One at a time** per deal: asking again while one is being built answers with that one.
 * - **Needs signal**: it's a request to the server, never queued on a phone.
 */
import { and, desc, eq, gt } from 'drizzle-orm';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { realestateAddon } from '../manifest';
import {
  DealExportInput,
  DealExportOutput,
  ExportFinishedInput,
  ExportFinishedOutput,
  ExportsInput,
  ExportsOutput,
} from '../schemas';
import { exports } from '../tables';
import { actorUserId, historyLine, inWorkspace, loadDeal, requireNotArchived } from './common';

/** An export still building after this long is taken as lost, and a new one can start. */
const STUCK_MS = 60 * 60_000;

export const dealExport = defineAddonCommand(realestateAddon, {
  name: 'realestate.deal.export',
  description:
    'Export the whole transaction: every file on the deal with its fingerprint, and every record, in one zip with a manifest. It’s kept on the deal’s Documents when it’s ready.',
  risk: 1,
  input: DealExportInput,
  output: DealExportOutput,
  permission: 'realestate.export',
  ai: { tool: 'realestate_deal_export', autonomy: 'confirm' },
  scope: inWorkspace,
  emits: ['realestate.deal.export_requested'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireNotArchived(deal);
    const [building] = await ctx.tx
      .select({ id: exports.id })
      .from(exports)
      .where(
        and(
          eq(exports.dealRecordId, deal.recordId),
          eq(exports.state, 'building'),
          gt(exports.requestedAt, new Date(Date.now() - STUCK_MS)),
        ),
      );
    if (building) return { exportId: building.id, state: 'building' as const };
    const [row] = await ctx.tx
      .insert(exports)
      .values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        requestedBy: actorUserId(ctx),
      })
      .returning({ id: exports.id });
    await historyLine(ctx, deal, 'export_requested');
    await ctx.emit({
      type: 'realestate.deal.export_requested',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { exportId: row!.id },
    });
    return { exportId: row!.id, state: 'building' as const };
  },
});

export const exportFinished = defineAddonCommand(realestateAddon, {
  name: 'realestate.export_finished',
  description: 'Worker: a transaction export is ready on the deal, or why it couldn’t be made.',
  risk: 0,
  input: ExportFinishedInput,
  output: ExportFinishedOutput,
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: ['realestate.deal.exported'],
  async handler(ctx, input) {
    const [x] = await ctx.tx
      .select()
      .from(exports)
      .where(and(eq(exports.id, input.exportId), eq(exports.workspaceId, ctx.scope.workspaceId!)))
      .for('update');
    if (!x || x.state !== 'building')
      return { exportId: input.exportId, state: x?.state ?? ('failed' as const) };
    const state = input.failure ? ('failed' as const) : ('ready' as const);
    await ctx.tx
      .update(exports)
      .set({
        state,
        fileId: input.fileId ?? null,
        manifestSha256: input.manifestSha256 ?? null,
        counts: input.counts ?? {},
        failure: input.failure ?? null,
        readyAt: state === 'ready' ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(exports.id, x.id));
    await historyLine(ctx, { recordId: x.dealRecordId }, 'exported', {
      after: { state },
      note: input.failure ?? null,
    });
    await ctx.emit({
      type: 'realestate.deal.exported',
      entityType: 'realestate_deal',
      entityId: x.dealRecordId,
      payload: { exportId: x.id, state },
    });
    return { exportId: x.id, state };
  },
});

export const exportsList = defineAddonQuery(realestateAddon, {
  name: 'realestate.exports',
  description:
    'A deal’s transaction exports: when each was asked for, whether it’s ready, and its file.',
  input: ExportsInput,
  output: ExportsOutput,
  permission: 'realestate.export',
  ai: { tool: 'realestate_exports' },
  scope: inWorkspace,
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId);
    const list = await ctx.tx
      .select()
      .from(exports)
      .where(eq(exports.dealRecordId, deal.recordId))
      .orderBy(desc(exports.requestedAt))
      .limit(20);
    return {
      exports: list.map((x) => ({
        id: x.id,
        state: x.state,
        fileId: x.fileId,
        manifestSha256: x.manifestSha256,
        counts: x.counts,
        failure: x.failure,
        requestedBy: x.requestedBy,
        requestedAt: x.requestedAt.toISOString(),
        readyAt: x.readyAt?.toISOString() ?? null,
      })),
    };
  },
});

export const exportCommands = [dealExport, exportFinished] as const;
export const exportQueries = [exportsList] as const;
