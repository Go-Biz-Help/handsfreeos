/**
 * A listing's lockboxes (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, round seven, step 4). Chris decided
 * (2026-10-05): read SentriLock's and Supra's emails, guard codes.
 *
 * - **A lockbox**: its kind, where it is, its serial and its code. The code arrives sealed by the worker (core's
 *   sealed values: the app posts it to /v1/addons/sealed first), is kept sealed in `code_enc`, which no person's
 *   role can read, and goes only into the access email to the confirmed agent just before a showing. Nothing here
 *   ever answers with it; Show code is the worker's (/v1/addons/sealed/reveal), kept in the deal's history.
 * - **An opening**: SentriLock's or Supra's email read by the worker into the listing it's about, with the showing
 *   it fits. One that fits no showing raises an alert to the listing's agents (the worker's subscriber).
 */
import { and, desc, eq, gte, isNull, lte, or, sql as dsql } from 'drizzle-orm';
import { HfosError } from '../../../errors';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { realestateAddon } from '../manifest';
import {
  LockboxCodeViewedInput,
  LockboxCodeViewedOutput,
  LockboxListInput,
  LockboxListOutput,
  LockboxOpenedInput,
  LockboxOpenedOutput,
  LockboxOutput,
  LockboxRemoveInput,
  LockboxSaveInput,
} from '../schemas';
import { lockboxes, lockboxOpenings, showings, type LockboxKind } from '../tables';
import {
  actorUserId,
  historyLine,
  inWorkspace,
  loadDeal,
  requireNotArchived,
  requireOpen,
} from './common';
import { requireListingSide } from './listing';

const MINUTE = 60_000;
/** An opening this long before a showing starts, or after it ends, still fits it (agents arrive early, leave late). */
export const OPENING_SLACK_MINUTES = 30;

export const LOCKBOX_KIND_LABELS: Readonly<Record<LockboxKind, string>> = {
  sentrilock: 'SentriLock',
  supra: 'Supra',
  combination: 'Combination lockbox',
  keypad: 'Keypad',
  other: 'Lockbox',
};

/**
 * The columns a lockbox answers with: never `code_enc`, which no person's role may read, so a query naming it
 * would fail rather than show it.
 */
const PUBLIC_COLUMNS = {
  id: lockboxes.id,
  kind: lockboxes.kind,
  place: lockboxes.place,
  serial: lockboxes.serial,
  codeSetAt: lockboxes.codeSetAt,
};

type LockboxRow = {
  id: string;
  kind: LockboxKind;
  place: string | null;
  serial: string | null;
  codeSetAt: Date | null;
};

const lockboxOut = (l: LockboxRow) => ({
  id: l.id,
  kind: l.kind,
  kindLabel: LOCKBOX_KIND_LABELS[l.kind],
  place: l.place,
  serial: l.serial,
  hasCode: l.codeSetAt !== null,
  codeSetAt: l.codeSetAt ? l.codeSetAt.toISOString() : null,
});

export const lockboxSave = defineAddonCommand(realestateAddon, {
  name: 'realestate.lockbox.save',
  description:
    'A listing’s lockbox: its kind, where it is, its serial, and its code (sealed on the way, never shown back here).',
  risk: 1,
  input: LockboxSaveInput,
  output: LockboxOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireOpen(deal);
    requireListingSide(deal);
    const [was] = await ctx.tx
      .select({
        ...PUBLIC_COLUMNS,
        dealRecordId: lockboxes.dealRecordId,
        removedAt: lockboxes.removedAt,
      })
      .from(lockboxes)
      .where(and(eq(lockboxes.workspaceId, deal.workspaceId), eq(lockboxes.id, input.id)));
    if (was && (was.dealRecordId !== deal.recordId || was.removedAt))
      throw HfosError.rule(
        'realestate_lockbox_elsewhere',
        409,
        'That lockbox isn’t on this listing anymore. Add it again here.',
      );
    const now = new Date();
    const code =
      input.code === undefined
        ? {}
        : input.code === null
          ? { codeEnc: null, codeSetAt: null, codeSetBy: null }
          : { codeEnc: input.code, codeSetAt: now, codeSetBy: actorUserId(ctx) };
    const values = {
      kind: input.kind,
      ...(input.place !== undefined ? { place: input.place } : {}),
      ...(input.serial !== undefined ? { serial: input.serial } : {}),
      ...code,
      updatedAt: now,
    };
    const [row] = was
      ? await ctx.tx
          .update(lockboxes)
          .set(values)
          .where(and(eq(lockboxes.workspaceId, deal.workspaceId), eq(lockboxes.id, input.id)))
          .returning(PUBLIC_COLUMNS)
      : await ctx.tx
          .insert(lockboxes)
          .values({
            id: input.id,
            workspaceId: deal.workspaceId,
            dealRecordId: deal.recordId,
            createdBy: actorUserId(ctx),
            ...values,
          })
          .returning(PUBLIC_COLUMNS);
    // The history says the code changed, never what it is.
    await historyLine(ctx, deal, was ? 'lockbox_changed' : 'lockbox_added', {
      before: was ? { kind: was.kind, place: was.place, serial: was.serial } : null,
      after: {
        kind: row!.kind,
        place: row!.place,
        serial: row!.serial,
        ...(input.code === undefined ? {} : { code: input.code === null ? 'cleared' : 'set' }),
      },
    });
    return { dealId: deal.recordId, lockbox: lockboxOut(row!) };
  },
});

export const lockboxRemove = defineAddonCommand(realestateAddon, {
  name: 'realestate.lockbox.remove',
  description: 'Takes a lockbox off a listing, and its code with it.',
  risk: 1,
  input: LockboxRemoveInput,
  output: LockboxOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireNotArchived(deal);
    const [row] = await ctx.tx
      .update(lockboxes)
      .set({
        removedAt: new Date(),
        codeEnc: null,
        codeSetAt: null,
        codeSetBy: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(lockboxes.workspaceId, deal.workspaceId),
          eq(lockboxes.dealRecordId, deal.recordId),
          eq(lockboxes.id, input.id),
          isNull(lockboxes.removedAt),
        ),
      )
      .returning(PUBLIC_COLUMNS);
    if (!row)
      throw HfosError.notFound(
        'That lockbox is already off this listing. Refresh to see what’s on it.',
      );
    await historyLine(ctx, deal, 'lockbox_removed', {
      before: { kind: row.kind, place: row.place, serial: row.serial },
    });
    return { dealId: deal.recordId, lockbox: lockboxOut(row) };
  },
});

export const lockboxOpened = defineAddonCommand(realestateAddon, {
  name: 'realestate.lockbox.opened',
  description:
    'Worker: a lockbox on a listing was opened, as SentriLock’s or Supra’s email says, with the showing it fits if one was booked.',
  risk: 0,
  input: LockboxOpenedInput,
  output: LockboxOpenedOutput,
  permission: 'realestate.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['realestate.lockbox.opened'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    if (deal.archivedAt || deal.side !== 'listing')
      return { openingId: null, booked: false, duplicate: false };
    const [again] = await ctx.tx
      .select({ id: lockboxOpenings.id, booked: lockboxOpenings.booked })
      .from(lockboxOpenings)
      .where(
        and(
          eq(lockboxOpenings.workspaceId, deal.workspaceId),
          eq(lockboxOpenings.messageId, input.messageId),
        ),
      );
    if (again) return { openingId: again.id, booked: again.booked, duplicate: true };
    const openedAt = new Date(input.openedAt);
    // The lockbox: by its serial, or the listing's only one of that maker's.
    const boxes = await ctx.tx
      .select({ id: lockboxes.id, kind: lockboxes.kind, serial: lockboxes.serial })
      .from(lockboxes)
      .where(
        and(
          eq(lockboxes.workspaceId, deal.workspaceId),
          eq(lockboxes.dealRecordId, deal.recordId),
          isNull(lockboxes.removedAt),
        ),
      );
    const bySerial = input.serial
      ? boxes.find((b) => b.serial?.trim().toLowerCase() === input.serial!.trim().toLowerCase())
      : undefined;
    const ofMaker = boxes.filter((b) => b.kind === input.vendor);
    const box = bySerial ?? (ofMaker.length === 1 ? ofMaker[0] : undefined);
    // The showing it fits: confirmed (or done), from a little before it starts to a little after it ends.
    const slack = OPENING_SLACK_MINUTES * MINUTE;
    const [fits] = await ctx.tx
      .select({ id: showings.id })
      .from(showings)
      .where(
        and(
          eq(showings.workspaceId, deal.workspaceId),
          eq(showings.dealRecordId, deal.recordId),
          or(eq(showings.state, 'confirmed'), eq(showings.state, 'done')),
          lte(showings.startsAt, new Date(openedAt.getTime() + slack)),
          gte(showings.endsAt, new Date(openedAt.getTime() - slack)),
        ),
      )
      .orderBy(
        dsql`abs(extract(epoch from (${showings.startsAt} - ${openedAt.toISOString()}::timestamptz)))`,
      )
      .limit(1);
    const [row] = await ctx.tx
      .insert(lockboxOpenings)
      .values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        lockboxId: box?.id ?? null,
        vendor: input.vendor,
        openedAt,
        serial: input.serial ?? null,
        openedBy: input.openedBy ?? null,
        company: input.company ?? null,
        phone: input.phone ?? null,
        showingId: fits?.id ?? null,
        booked: !!fits,
        messageId: input.messageId,
      })
      .returning({ id: lockboxOpenings.id });
    await historyLine(ctx, deal, 'lockbox_opened', {
      after: {
        vendor: input.vendor,
        by: input.openedBy ?? null,
        company: input.company ?? null,
        booked: !!fits,
      },
    });
    await ctx.emit({
      type: 'realestate.lockbox.opened',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: {
        dealId: deal.recordId,
        openingId: row!.id,
        booked: !!fits,
        vendor: input.vendor,
        openedAt: openedAt.toISOString(),
        openedBy: input.openedBy ?? null,
        company: input.company ?? null,
        name: deal.name,
      },
      after: { vendor: input.vendor, booked: !!fits },
    });
    return { openingId: row!.id, booked: !!fits, duplicate: false };
  },
});

export const lockboxCodeViewed = defineAddonCommand(realestateAddon, {
  name: 'realestate.lockbox.code_viewed',
  description:
    'Worker: someone on a listing was shown a lockbox’s code, kept in the deal’s history.',
  risk: 0,
  input: LockboxCodeViewedInput,
  output: LockboxCodeViewedOutput,
  permission: 'realestate.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId);
    const [box] = await ctx.tx
      .select(PUBLIC_COLUMNS)
      .from(lockboxes)
      .where(
        and(
          eq(lockboxes.workspaceId, deal.workspaceId),
          eq(lockboxes.dealRecordId, deal.recordId),
          eq(lockboxes.id, input.lockboxId),
        ),
      );
    if (!box) return { kept: false };
    await historyLine(ctx, deal, 'lockbox_code_viewed', {
      after: { kind: box.kind, place: box.place, viewedBy: input.viewedBy },
    });
    return { kept: true };
  },
});

export const lockboxList = defineAddonQuery(realestateAddon, {
  name: 'realestate.lockbox.list',
  description: 'A listing’s lockboxes (never their codes) and the latest times they were opened.',
  input: LockboxListInput,
  output: LockboxListOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId);
    const boxes = await ctx.tx
      .select(PUBLIC_COLUMNS)
      .from(lockboxes)
      .where(
        and(
          eq(lockboxes.workspaceId, deal.workspaceId),
          eq(lockboxes.dealRecordId, deal.recordId),
          isNull(lockboxes.removedAt),
        ),
      )
      .orderBy(lockboxes.createdAt);
    const openings = await ctx.tx
      .select()
      .from(lockboxOpenings)
      .where(
        and(
          eq(lockboxOpenings.workspaceId, deal.workspaceId),
          eq(lockboxOpenings.dealRecordId, deal.recordId),
        ),
      )
      .orderBy(desc(lockboxOpenings.openedAt))
      .limit(50);
    return {
      lockboxes: boxes.map(lockboxOut),
      openings: openings.map((o) => ({
        id: o.id,
        vendor: o.vendor,
        openedAt: o.openedAt.toISOString(),
        openedBy: o.openedBy,
        company: o.company,
        lockboxId: o.lockboxId,
        showingId: o.showingId,
        booked: o.booked,
      })),
    };
  },
});

export const lockboxCommands = [lockboxSave, lockboxRemove, lockboxOpened, lockboxCodeViewed];
export const lockboxQueries = [lockboxList];
