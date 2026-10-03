/**
 * In the field, round six (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round six: The phone and the finish",
 * steps 8 and 9): what an agent notes at a stop, and the final walkthrough.
 *
 * - **Field notes** (B-07): typed, spoken or photographed, made on the phone with their own id so one taken with no
 *   signal is the same note when it arrives. A recording's words come later from the worker
 *   (`realestate.field_note.transcribed`). On a buyer's deal, a note counts as B-07's proof.
 * - **The walkthrough** (X-24): the list is built once, with signal, from the repairs the seller agreed to, what the
 *   contract says stays and goes, the inspection's serious findings nobody asked to fix, and each room
 *   (`walkthroughItems`, the same on the phone). Checking it works with no signal; finishing adds a duty before
 *   closing for each thing that isn't right, and the agent's word that the walkthrough is done counts for X-24.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lt, max, ne, sql as dsql } from 'drizzle-orm';
import { files } from '@hfos/db/schema';
import { HfosError } from '../../../errors';
import { executeCommandWithin } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import { isUniqueViolation } from '../../../kernel/pg-errors';
import type { CommandContext } from '../../../kernel/types';
import { idUnavailable } from '../../../crm/client-ids';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { realestateAddon } from '../manifest';
import {
  FieldNoteAddInput,
  FieldNoteAddOutput,
  FieldNotesInput,
  FieldNotesOutput,
  FieldNoteTranscribedInput,
  FieldNoteTranscribedOutput,
  WalkthroughAddItemInput,
  WalkthroughCheckInput,
  WalkthroughFinishInput,
  WalkthroughFinishOutput,
  WalkthroughGetInput,
  WalkthroughGetOutput,
  WalkthroughItemOutput,
  WalkthroughOutput,
  WalkthroughPlanInput,
  WalkthroughRef,
} from '../schemas';
import {
  fieldNotes,
  inspectionFindings,
  inspections,
  repairRequests,
  walkthroughItems as itemsTable,
  walkthroughs,
} from '../tables';
import { termsNow } from '../terms';
import { walkthroughItems, walkthroughSummary, type WalkthroughFacts } from '../walkthrough';
import type { RepairItem } from '../closing';
import {
  actorKind,
  actorUserId,
  historyLine,
  inWorkspace,
  loadDeal,
  requireNotArchived,
  requireOpen,
  type Ctx,
  type Deal,
} from './common';
import { dutyAdd } from './duties';
import { termEntriesOf } from './engine';
import { addProof, PROOF_EVENTS } from './proof-hooks';

type Walkthrough = typeof walkthroughs.$inferSelect;
type Item = typeof itemsTable.$inferSelect;

/** The words X-24 asks for. */
const WALKTHROUGH_DONE = 'The walkthrough is done';

/** The deal's own files, when they're all there; refused when one isn't. */
async function requireDealFiles(
  ctx: Ctx,
  deal: Deal,
  ids: readonly string[],
  what: string,
): Promise<void> {
  const wanted = [...new Set(ids)];
  if (!wanted.length) return;
  const found = await ctx.tx
    .select({ id: files.id })
    .from(files)
    .where(
      and(
        inArray(files.id, wanted),
        eq(files.workspaceId, deal.workspaceId),
        eq(files.recordType, 'custom_record'),
        eq(files.recordId, deal.recordId),
        isNull(files.deletedAt),
      ),
    );
  if (found.length !== wanted.length)
    throw HfosError.notFound(
      `That ${what} isn’t on ${deal.name} anymore. Add it to the deal again, then save.`,
    );
}

/** An insert with the phone's id: one already taken beyond this person's sight is refused as unusable. */
async function withPhoneId<T>(constraint: string, insert: () => Promise<T>): Promise<T> {
  try {
    return await insert();
  } catch (e) {
    if (isUniqueViolation(e, constraint)) throw idUnavailable();
    throw e;
  }
}

// ---------- field notes ----------

export const fieldNoteAdd = defineAddonCommand(realestateAddon, {
  name: 'realestate.field_note.add',
  description:
    'Note something in the field on a deal: typed, a recording or photos, about the deal, a home, a tour stop, a showing, an open house or the walkthrough. A recording’s words follow on their own.',
  risk: 1,
  input: FieldNoteAddInput,
  output: FieldNoteAddOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  offline: 'anytime',
  emits: ['realestate.field_note.added', ...PROOF_EVENTS],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    // Sent again after its answer was lost: the note it made.
    const [had] = await ctx.tx
      .select({ id: fieldNotes.id, dealRecordId: fieldNotes.dealRecordId })
      .from(fieldNotes)
      .where(and(eq(fieldNotes.id, input.id), eq(fieldNotes.workspaceId, ws)));
    if (had) {
      if (had.dealRecordId !== input.dealId) throw idUnavailable();
      return { noteId: had.id };
    }
    const deal = await loadDeal(ctx, input.dealId);
    requireNotArchived(deal);
    if (input.audioFileId) await requireDealFiles(ctx, deal, [input.audioFileId], 'recording');
    await requireDealFiles(ctx, deal, input.photoFileIds, 'photo');
    const at = changeMoment(ctx.meta);
    await withPhoneId('field_notes_pkey', () =>
      ctx.tx.insert(fieldNotes).values({
        id: input.id,
        workspaceId: ws,
        dealRecordId: deal.recordId,
        aboutKind: input.aboutKind,
        aboutId: input.aboutId ?? null,
        body: input.body ?? null,
        audioFileId: input.audioFileId ?? null,
        transcriptState: input.audioFileId ? 'waiting' : 'none',
        photoFileIds: input.photoFileIds,
        createdBy: actorUserId(ctx),
        notedAt: at,
      }),
    );
    await historyLine(ctx, deal, 'field_note_added', {
      after: {
        about: input.aboutKind,
        spoken: !!input.audioFileId,
        typed: !!input.body,
        photos: input.photoFileIds.length,
      },
    });
    // B-07 "Attend showings": a note of what was seen.
    if (deal.side === 'buyer')
      await addProof(
        ctx,
        deal,
        { keys: ['B-07'] },
        {
          kind: 'note',
          body:
            input.body ??
            (input.audioFileId ? 'A voice note from the field' : 'Photos from the field'),
        },
      );
    await ctx.emit({
      type: 'realestate.field_note.added',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { noteId: input.id, spoken: !!input.audioFileId },
    });
    return { noteId: input.id };
  },
});

export const fieldNoteTranscribed = defineAddonCommand(realestateAddon, {
  name: 'realestate.field_note.transcribed',
  description: 'Worker: a field recording’s words, or that they couldn’t be made.',
  risk: 0,
  input: FieldNoteTranscribedInput,
  output: FieldNoteTranscribedOutput,
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: ['realestate.field_note.transcribed'],
  async handler(ctx, input) {
    const [note] = await ctx.tx
      .select()
      .from(fieldNotes)
      .where(
        and(eq(fieldNotes.id, input.noteId), eq(fieldNotes.workspaceId, ctx.scope.workspaceId!)),
      )
      .for('update');
    if (!note || note.transcriptState !== 'waiting')
      return { noteId: input.noteId, state: 'skipped' as const };
    const state = input.transcript?.trim() ? ('done' as const) : ('failed' as const);
    await ctx.tx
      .update(fieldNotes)
      .set({
        transcript: state === 'done' ? input.transcript!.trim() : null,
        transcriptState: state,
        updatedAt: new Date(),
      })
      .where(eq(fieldNotes.id, note.id));
    await ctx.emit({
      type: 'realestate.field_note.transcribed',
      entityType: 'realestate_deal',
      entityId: note.dealRecordId,
      payload: { noteId: note.id, state },
    });
    return { noteId: note.id, state };
  },
});

export const fieldNotesList = defineAddonQuery(realestateAddon, {
  name: 'realestate.field_notes',
  description:
    'A deal’s field notes, newest first: what was typed, said or photographed, and about what.',
  input: FieldNotesInput,
  output: FieldNotesOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_field_notes',
    description:
      'Read the notes an agent took in the field on a deal, with their recordings’ words.',
  },
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId);
    const list = await ctx.tx
      .select()
      .from(fieldNotes)
      .where(
        and(
          eq(fieldNotes.dealRecordId, deal.recordId),
          ...(input.aboutKind ? [eq(fieldNotes.aboutKind, input.aboutKind)] : []),
          ...(input.aboutId ? [eq(fieldNotes.aboutId, input.aboutId)] : []),
        ),
      )
      .orderBy(desc(fieldNotes.notedAt), desc(fieldNotes.id))
      .limit(200);
    return {
      notes: list.map((n) => ({
        id: n.id,
        aboutKind: n.aboutKind,
        aboutId: n.aboutId,
        body: n.body,
        audioFileId: n.audioFileId,
        transcript: n.transcript,
        transcriptState: n.transcriptState,
        photoFileIds: n.photoFileIds,
        createdBy: n.createdBy,
        notedAt: n.notedAt.toISOString(),
      })),
    };
  },
});

// ---------- the walkthrough ----------

async function loadWalkthrough(ctx: Ctx, id: string, lock = false): Promise<Walkthrough> {
  const q = ctx.tx
    .select()
    .from(walkthroughs)
    .where(and(eq(walkthroughs.id, id), eq(walkthroughs.workspaceId, ctx.scope.workspaceId!)));
  const [w] = lock ? await q.for('update') : await q;
  if (!w)
    throw HfosError.notFound(
      'That walkthrough isn’t there anymore, or you’re not on its deal. Open the deal’s walkthrough again.',
    );
  return w;
}

function requireNotDone(w: Walkthrough): void {
  if (w.state === 'done')
    throw HfosError.rule(
      'realestate_walkthrough_done',
      409,
      'This walkthrough is finished. Plan a new one from the deal to check again.',
    );
}

/** What the list is built from: agreed repairs, what stays and goes, and serious findings. */
async function walkthroughFacts(ctx: Ctx, deal: Deal): Promise<WalkthroughFacts> {
  // The answer that agreed carries no items of its own: they're the request it answered, the asking side's last
  // before it (ours on a buyer deal, the buyers' on a listing).
  const [answer] = await ctx.tx
    .select({ number: repairRequests.number })
    .from(repairRequests)
    .where(
      and(eq(repairRequests.dealRecordId, deal.recordId), eq(repairRequests.outcome, 'agreed')),
    )
    .orderBy(desc(repairRequests.number))
    .limit(1);
  const agreed = answer
    ? await ctx.tx
        .select({ items: repairRequests.items })
        .from(repairRequests)
        .where(
          and(
            eq(repairRequests.dealRecordId, deal.recordId),
            eq(repairRequests.side, deal.side === 'listing' ? 'them' : 'us'),
            lt(repairRequests.number, answer.number),
          ),
        )
        .orderBy(desc(repairRequests.number))
        .limit(1)
    : [];
  const terms = termsNow(await termEntriesOf(ctx, deal.recordId));
  const text = (k: 'included_items' | 'excluded_items') => terms.get(k)?.current?.valueText ?? null;
  const findings = await ctx.tx
    .select({
      id: inspectionFindings.id,
      title: inspectionFindings.title,
      location: inspectionFindings.location,
      severity: inspectionFindings.severity,
    })
    .from(inspectionFindings)
    .innerJoin(inspections, eq(inspections.id, inspectionFindings.inspectionId))
    .where(
      and(eq(inspectionFindings.dealRecordId, deal.recordId), ne(inspections.status, 'canceled')),
    )
    .orderBy(asc(inspections.createdAt), asc(inspectionFindings.position));
  return {
    agreedRepairs: agreed.flatMap((r) => r.items as unknown as RepairItem[]),
    includedItems: text('included_items'),
    excludedItems: text('excluded_items'),
    findings,
  };
}

export const walkthroughPlan = defineAddonCommand(realestateAddon, {
  name: 'realestate.walkthrough.plan',
  description:
    'Plan a deal’s final walkthrough: its checklist from the repairs agreed, what the contract says stays and goes, the inspection’s serious findings and each room.',
  risk: 1,
  input: WalkthroughPlanInput,
  output: WalkthroughOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_plan_walkthrough',
    description:
      'Plan the final walkthrough on a deal, with its checklist built from the contract, repairs and inspection.',
  },
  emits: ['realestate.walkthrough.changed', ...PROOF_EVENTS],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    const [open] = await ctx.tx
      .select()
      .from(walkthroughs)
      .where(and(eq(walkthroughs.dealRecordId, deal.recordId), ne(walkthroughs.state, 'done')));
    if (open?.id === input.id) {
      const [n] = await ctx.tx
        .select({ n: dsql<number>`count(*)::int` })
        .from(itemsTable)
        .where(eq(itemsTable.walkthroughId, open.id));
      return { walkthroughId: open.id, items: n?.n ?? 0 };
    }
    requireOpen(deal);
    if (open)
      throw HfosError.rule(
        'realestate_walkthrough_open',
        409,
        `${deal.name} already has a walkthrough that isn’t finished. Open it from the deal, or finish it first.`,
      );
    const drafts = walkthroughItems(await walkthroughFacts(ctx, deal));
    await withPhoneId('walkthroughs_pkey', () =>
      ctx.tx.insert(walkthroughs).values({
        id: input.id,
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        appointmentId: input.appointmentId ?? null,
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
        createdBy: actorUserId(ctx),
      }),
    );
    if (drafts.length)
      await ctx.tx.insert(itemsTable).values(
        drafts.map((d, i) => ({
          id: randomUUID(),
          workspaceId: deal.workspaceId,
          dealRecordId: deal.recordId,
          walkthroughId: input.id,
          source: d.source,
          sourceRef: d.sourceRef,
          title: d.title.slice(0, 200),
          detail: d.detail,
          position: i + 1,
        })),
      );
    await historyLine(ctx, deal, 'walkthrough_planned', { after: { items: drafts.length } });
    // S-63 "Schedule final walkthrough": its appointment.
    if (input.appointmentId && deal.side === 'listing')
      await addProof(
        ctx,
        deal,
        { keys: ['S-63'] },
        { kind: 'appointment', appointmentId: input.appointmentId },
      );
    await ctx.emit({
      type: 'realestate.walkthrough.changed',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { walkthroughId: input.id, what: 'planned' },
    });
    return { walkthroughId: input.id, items: drafts.length };
  },
});

export const walkthroughStart = defineAddonCommand(realestateAddon, {
  name: 'realestate.walkthrough.start',
  description: 'Start a planned walkthrough, at the home.',
  risk: 1,
  input: WalkthroughRef,
  output: WalkthroughOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  offline: 'anytime',
  emits: ['realestate.walkthrough.changed'],
  async handler(ctx, input) {
    const w = await loadWalkthrough(ctx, input.walkthroughId, true);
    const deal = await loadDeal(ctx, w.dealRecordId);
    requireNotArchived(deal);
    requireNotDone(w);
    const [n] = await ctx.tx
      .select({ n: dsql<number>`count(*)::int` })
      .from(itemsTable)
      .where(eq(itemsTable.walkthroughId, w.id));
    if (w.state === 'started') return { walkthroughId: w.id, items: n?.n ?? 0 };
    const at = changeMoment(ctx.meta);
    await ctx.tx
      .update(walkthroughs)
      .set({ state: 'started', startedAt: at, updatedAt: new Date() })
      .where(eq(walkthroughs.id, w.id));
    await historyLine(ctx, deal, 'walkthrough_started');
    await ctx.emit({
      type: 'realestate.walkthrough.changed',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { walkthroughId: w.id, what: 'started' },
    });
    return { walkthroughId: w.id, items: n?.n ?? 0 };
  },
});

async function loadItem(ctx: Ctx, id: string): Promise<Item> {
  const [i] = await ctx.tx
    .select()
    .from(itemsTable)
    .where(and(eq(itemsTable.id, id), eq(itemsTable.workspaceId, ctx.scope.workspaceId!)));
  if (!i)
    throw HfosError.notFound(
      'That item isn’t on the walkthrough anymore. Open the deal’s walkthrough again.',
    );
  return i;
}

export const walkthroughCheckItem = defineAddonCommand(realestateAddon, {
  name: 'realestate.walkthrough.check_item',
  description:
    'Mark one thing on a walkthrough OK, not OK or not sure, with a note and photos; or uncheck it.',
  risk: 1,
  input: WalkthroughCheckInput,
  output: WalkthroughItemOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  offline: 'anytime',
  emits: ['realestate.walkthrough.changed'],
  async handler(ctx, input) {
    const item = await loadItem(ctx, input.itemId);
    const w = await loadWalkthrough(ctx, item.walkthroughId, true);
    const deal = await loadDeal(ctx, w.dealRecordId);
    requireNotArchived(deal);
    requireNotDone(w);
    if (input.photoFileIds) await requireDealFiles(ctx, deal, input.photoFileIds, 'photo');
    const checked = input.state !== 'unchecked';
    await ctx.tx
      .update(itemsTable)
      .set({
        state: input.state,
        ...(input.note !== undefined ? { note: input.note || null } : {}),
        ...(input.photoFileIds ? { photoFileIds: input.photoFileIds } : {}),
        checkedBy: checked ? actorUserId(ctx) : null,
        checkedAt: checked ? changeMoment(ctx.meta) : null,
        updatedAt: new Date(),
      })
      .where(eq(itemsTable.id, item.id));
    // Checking starts it, when nobody pressed Start.
    if (w.state === 'planned')
      await ctx.tx
        .update(walkthroughs)
        .set({ state: 'started', startedAt: changeMoment(ctx.meta), updatedAt: new Date() })
        .where(eq(walkthroughs.id, w.id));
    await ctx.emit({
      type: 'realestate.walkthrough.changed',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { walkthroughId: w.id, what: 'checked', itemId: item.id },
    });
    return { itemId: item.id };
  },
});

export const walkthroughAddItem = defineAddonCommand(realestateAddon, {
  name: 'realestate.walkthrough.add_item',
  description: 'Add something to check on a walkthrough that its list doesn’t have.',
  risk: 1,
  input: WalkthroughAddItemInput,
  output: WalkthroughItemOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  offline: 'anytime',
  emits: ['realestate.walkthrough.changed'],
  async handler(ctx, input) {
    const w = await loadWalkthrough(ctx, input.walkthroughId, true);
    const [had] = await ctx.tx
      .select({ id: itemsTable.id, walkthroughId: itemsTable.walkthroughId })
      .from(itemsTable)
      .where(and(eq(itemsTable.id, input.id), eq(itemsTable.workspaceId, w.workspaceId)));
    if (had) {
      if (had.walkthroughId !== w.id) throw idUnavailable();
      return { itemId: had.id };
    }
    const deal = await loadDeal(ctx, w.dealRecordId);
    requireNotArchived(deal);
    requireNotDone(w);
    const [last] = await ctx.tx
      .select({ n: max(itemsTable.position) })
      .from(itemsTable)
      .where(eq(itemsTable.walkthroughId, w.id));
    await withPhoneId('walkthrough_items_pkey', () =>
      ctx.tx.insert(itemsTable).values({
        id: input.id,
        workspaceId: w.workspaceId,
        dealRecordId: w.dealRecordId,
        walkthroughId: w.id,
        source: 'added',
        title: input.title,
        detail: input.detail ?? null,
        position: (last?.n ?? 0) + 1,
      }),
    );
    await ctx.emit({
      type: 'realestate.walkthrough.changed',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { walkthroughId: w.id, what: 'item_added', itemId: input.id },
    });
    return { itemId: input.id };
  },
});

/** Each thing that isn't right, a duty before closing; how many were added. */
async function fixDuties(ctx: CommandContext, deal: Deal, items: readonly Item[]): Promise<number> {
  let added = 0;
  for (const i of items) {
    if (i.state !== 'not_ok' || i.dutyId) continue;
    const r = await executeCommandWithin(ctx, dutyAdd, {
      workspaceId: deal.workspaceId,
      dealId: deal.recordId,
      title: `Fix before closing: ${i.title}`.slice(0, 80),
      details: [`Found at the final walkthrough.`, i.note].filter(Boolean).join(' '),
      tracker: 'CLOSE',
      materiality: 'material',
      proof: 'note',
    });
    await ctx.tx
      .update(itemsTable)
      .set({ dutyId: r.output.dutyId, updatedAt: new Date() })
      .where(eq(itemsTable.id, i.id));
    added++;
  }
  return added;
}

export const walkthroughFinish = defineAddonCommand(realestateAddon, {
  name: 'realestate.walkthrough.finish',
  description:
    'Finish a walkthrough: each thing that isn’t right becomes a duty before closing, and your word that it’s done counts for the walkthrough’s duty.',
  risk: 1,
  input: WalkthroughFinishInput,
  output: WalkthroughFinishOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  offline: 'anytime',
  emits: ['realestate.walkthrough.finished', 'realestate.duty.added', ...PROOF_EVENTS],
  async handler(ctx, input) {
    const w = await loadWalkthrough(ctx, input.walkthroughId, true);
    const items = await ctx.tx
      .select()
      .from(itemsTable)
      .where(eq(itemsTable.walkthroughId, w.id))
      .orderBy(asc(itemsTable.position));
    const summary = walkthroughSummary(items.map((i) => i.state));
    if (w.state === 'done') return { walkthroughId: w.id, summary, dutiesAdded: 0 };
    const deal = await loadDeal(ctx, w.dealRecordId, { lock: true });
    requireNotArchived(deal);
    const at = changeMoment(ctx.meta);
    const dutiesAdded = await fixDuties(ctx, deal, items);
    await ctx.tx
      .update(walkthroughs)
      .set({
        state: 'done',
        startedAt: w.startedAt ?? at,
        finishedAt: at,
        clientsAgreedAt: input.clientsAgreed ? at : null,
        updatedAt: new Date(),
      })
      .where(eq(walkthroughs.id, w.id));
    await historyLine(ctx, deal, 'walkthrough_finished', {
      after: { dutiesAdded, clientsAgreed: input.clientsAgreed },
      note: summary,
    });
    // X-24 "Final walkthrough workspace": the agent's own word, never the Assistant's.
    if (deal.side === 'buyer' && actorKind(ctx) === 'person')
      await addProof(
        ctx,
        deal,
        { keys: ['X-24'] },
        { kind: 'attestation', body: `${WALKTHROUGH_DONE}. ${summary}.` },
      );
    await ctx.emit({
      type: 'realestate.walkthrough.finished',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { walkthroughId: w.id, dutiesAdded },
    });
    return { walkthroughId: w.id, summary, dutiesAdded };
  },
});

export const walkthroughGet = defineAddonQuery(realestateAddon, {
  name: 'realestate.walkthrough',
  description:
    'A deal’s walkthrough: the open one, or the last one finished, with each thing to check and how it was.',
  input: WalkthroughGetInput,
  output: WalkthroughGetOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_walkthrough',
    description: 'Read a deal’s final walkthrough checklist and how each thing was.',
  },
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId);
    const [w] = await ctx.tx
      .select()
      .from(walkthroughs)
      .where(eq(walkthroughs.dealRecordId, deal.recordId))
      .orderBy(
        dsql`(${walkthroughs.state} <> 'done') desc`,
        desc(walkthroughs.createdAt),
        desc(walkthroughs.id),
      )
      .limit(1);
    if (!w) return { walkthrough: null };
    const items = await ctx.tx
      .select()
      .from(itemsTable)
      .where(eq(itemsTable.walkthroughId, w.id))
      .orderBy(asc(itemsTable.position), asc(itemsTable.id));
    return {
      walkthrough: {
        id: w.id,
        state: w.state,
        appointmentId: w.appointmentId,
        scheduledAt: w.scheduledAt?.toISOString() ?? null,
        startedAt: w.startedAt?.toISOString() ?? null,
        finishedAt: w.finishedAt?.toISOString() ?? null,
        clientsAgreedAt: w.clientsAgreedAt?.toISOString() ?? null,
        summary: walkthroughSummary(items.map((i) => i.state)),
        items: items.map((i) => ({
          id: i.id,
          source: i.source,
          sourceRef: i.sourceRef,
          title: i.title,
          detail: i.detail,
          state: i.state,
          note: i.note,
          photoFileIds: i.photoFileIds,
          checkedBy: i.checkedBy,
          checkedAt: i.checkedAt?.toISOString() ?? null,
          dutyId: i.dutyId,
        })),
      },
    };
  },
});

export const fieldCommands = [
  fieldNoteAdd,
  fieldNoteTranscribed,
  walkthroughPlan,
  walkthroughStart,
  walkthroughCheckItem,
  walkthroughAddItem,
  walkthroughFinish,
] as const;
export const fieldQueries = [fieldNotesList, walkthroughGet] as const;
