/**
 * A deal's key dates and terms (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Terms and their history"). Each value
 * typed in is an entry that never changes, with where it came from; saved by a person it's confirmed, unless they
 * leave it for someone else to check. An amendment or correction names the entry it replaces. A value that
 * disagrees with one already there is a conflict: both stay, nothing resting on it counts as confirmed, and a
 * person settles it (Chris, 2026-09-30). Confirming a date brings its duties, moves the due times resting on it and
 * makes drafts ready to work (./engine.ts).
 */
import { and, eq } from 'drizzle-orm';
import { HfosError } from '../../../errors';
import type { CommandContext } from '../../../kernel/types';
import { defineAddonCommand } from '../../server';
import { realestateAddon } from '../manifest';
import {
  TermChangeOutput,
  TermConfirmInput,
  TermEnterInput,
  TermEnterOutput,
  TermRejectInput,
  TermResolveInput,
} from '../schemas';
import { documents, termEntries } from '../tables';
import { isLive, termKind, termLabel, termOnSide, termValueWords, type TermKey } from '../terms';
import { sideWords } from '../words';
import {
  actorUserId,
  dealLine,
  historyLine,
  inWorkspace,
  loadDeal,
  requireNotArchived,
  type Deal,
} from './common';
import { openWork, type Work } from './engine';

type Entry = typeof termEntries.$inferSelect;

async function entryOf(ctx: CommandContext, deal: Deal, entryId: string): Promise<Entry> {
  const [e] = await ctx.tx
    .select()
    .from(termEntries)
    .where(and(eq(termEntries.id, entryId), eq(termEntries.dealRecordId, deal.recordId)))
    .for('update');
  if (!e)
    throw HfosError.notFound(
      'That entry isn’t on this deal anymore. Refresh to see its dates as they are now.',
    );
  return e;
}

const settled = (e: Entry) =>
  HfosError.rule(
    'realestate_term_replaced',
    409,
    `That ${termLabel(e.key as TermKey).toLowerCase()} was already ${e.rejectedAt ? 'set aside' : 'replaced'}. Refresh to see the deal’s dates as they are now.`,
  );

/** The dates that turned confirmed bring their duties; then due times, drafts and commission follow. */
async function afterTermsChanged(w: Work) {
  const confirmed = await w.reloadTerms();
  for (const key of confirmed) await w.create({ on: 'dates', key });
  await w.settle();
}

const counts = (w: Work) => ({
  dutiesCreated: w.counts.created,
  dutiesActivated: w.counts.activated,
  dutiesRedated: w.counts.redated,
});

export const termEnter = defineAddonCommand(realestateAddon, {
  name: 'realestate.term.enter',
  description:
    'Enter a deal’s key date or term (acceptance, inspection period, closing, price, earnest money…) with where it came from. Saved by a person it’s confirmed unless they say not. An amendment or correction names the entry it replaces; a value that disagrees with one already there waits for a person to choose.',
  risk: 1,
  input: TermEnterInput,
  output: TermEnterOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_enter_date',
    description: 'Enter a deal’s key date or term with where it came from. Asks the person first.',
    autonomy: 'confirm',
  },
  emits: ['realestate.term.entered'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireNotArchived(deal);
    const key = input.key as TermKey;
    const label = termLabel(key);
    if (!termOnSide(key, deal.side))
      throw HfosError.rule(
        'realestate_term_not_here',
        400,
        `A ${sideWords(deal.side)} doesn’t have a ${label.toLowerCase()}.`,
      );
    const kind = termKind(key);
    const wrong =
      (kind === 'date' && input.date === undefined) ||
      (kind === 'money' && input.cents === undefined) ||
      (kind === 'text' && !input.text);
    if (wrong)
      throw HfosError.validation([
        {
          path: kind === 'date' ? 'date' : kind === 'money' ? 'cents' : 'text',
          message:
            kind === 'date'
              ? `${label} is a date. Enter it like 2026-10-30.`
              : kind === 'money'
                ? `${label} is an amount. Enter it in dollars and cents.`
                : `${label} is words. Type them in.`,
        },
      ]);
    if (input.documentId) {
      const [doc] = await ctx.tx
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.id, input.documentId), eq(documents.dealRecordId, deal.recordId)));
      if (!doc)
        throw HfosError.notFound(
          'That document isn’t on this deal anymore. Pick one of its documents, or leave it out.',
        );
    }
    let replaced: Entry | null = null;
    if (input.replaces) {
      replaced = await entryOf(ctx, deal, input.replaces);
      if (!isLive(replaced)) throw settled(replaced);
      if (replaced.key !== key)
        throw HfosError.validation([
          {
            path: 'replaces',
            message: `That entry is the ${termLabel(replaced.key as TermKey).toLowerCase()}, not the ${label.toLowerCase()}.`,
          },
        ]);
    }
    const w = await openWork(ctx, deal);
    const me = actorUserId(ctx);
    const confirm = input.confirm && ctx.actor.type === 'human';
    const [entry] = await ctx.tx
      .insert(termEntries)
      .values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        key,
        valueDate: input.date ?? null,
        valueTime: input.time ?? null,
        valueCents: input.cents ?? null,
        valueText: input.text ?? null,
        source: input.source,
        sourceRef: input.sourceRef ?? null,
        documentId: input.documentId ?? null,
        note: input.note ?? null,
        enteredBy: me,
        enteredAt: w.at,
        ...(confirm ? { confirmedBy: me, confirmedAt: w.at } : {}),
      })
      .returning();
    if (!entry) throw HfosError.forbidden();
    if (replaced)
      await ctx.tx
        .update(termEntries)
        .set({ supersededBy: entry.id, supersededAt: w.at })
        .where(eq(termEntries.id, replaced.id));
    await afterTermsChanged(w);
    const conflict = w.terms.get(key)?.conflict ?? false;
    const value = termValueWords(entry);
    await historyLine(ctx, deal, 'term_entered', {
      before: replaced ? { entryId: replaced.id, value: termValueWords(replaced) } : null,
      after: { key, entryId: entry.id, value, source: input.source, confirmed: confirm, conflict },
      note: input.note ?? null,
    });
    // An amendment is a moment of its own: whatever follows one comes with it.
    if (input.source === 'amendment') {
      await historyLine(ctx, deal, 'event', { after: { events: ['amendment'] } });
      await w.happen(['amendment']);
      await w.settle();
    }
    const eventId = await ctx.emit({
      type: 'realestate.term.entered',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: {
        name: deal.name,
        key,
        entryId: entry.id,
        source: input.source,
        confirmed: confirm,
        conflict,
        replaces: replaced?.id ?? null,
      },
      before: replaced ? { name: deal.name, [key]: termValueWords(replaced) } : null,
      after: { name: deal.name, [key]: value },
    });
    await dealLine(
      ctx,
      deal,
      `${replaced ? 'changed' : 'entered'} the ${label.toLowerCase()}: ${value}`,
      conflict
        ? {
            eventId,
            tone: 'warning',
            body: `It doesn’t match what was entered before, so both are kept until someone chooses which counts.`,
          }
        : { eventId },
    );
    return { dealId: deal.recordId, entryId: entry.id, conflict, ...counts(w) };
  },
});

export const termConfirm = defineAddonCommand(realestateAddon, {
  name: 'realestate.term.confirm',
  description:
    'Confirm a key date or term someone entered without confirming it. Duties resting on a date it confirms become ready to work.',
  risk: 1,
  input: TermConfirmInput,
  output: TermChangeOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_confirm_date',
    description: 'Confirm a key date or term someone entered. Asks the person first.',
    autonomy: 'confirm',
  },
  emits: ['realestate.term.confirmed'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireNotArchived(deal);
    const e = await entryOf(ctx, deal, input.entryId);
    if (!isLive(e)) throw settled(e);
    const w = await openWork(ctx, deal);
    if (e.confirmedAt) return { dealId: deal.recordId, entryId: e.id, ...counts(w) };
    await ctx.tx
      .update(termEntries)
      .set({ confirmedBy: actorUserId(ctx), confirmedAt: w.at })
      .where(eq(termEntries.id, e.id));
    await afterTermsChanged(w);
    const label = termLabel(e.key as TermKey);
    await historyLine(ctx, deal, 'term_confirmed', {
      after: { key: e.key, entryId: e.id, value: termValueWords(e) },
    });
    const eventId = await ctx.emit({
      type: 'realestate.term.confirmed',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: { name: deal.name, key: e.key, entryId: e.id },
      after: { name: deal.name, [e.key]: termValueWords(e) },
    });
    await dealLine(ctx, deal, `confirmed the ${label.toLowerCase()}: ${termValueWords(e)}`, {
      eventId,
    });
    return { dealId: deal.recordId, entryId: e.id, ...counts(w) };
  },
});

export const termReject = defineAddonCommand(realestateAddon, {
  name: 'realestate.term.reject',
  description:
    'Set aside a key date or term that was entered but never confirmed, with why. It stays in the history. A confirmed one is replaced by entering a correction instead.',
  risk: 1,
  input: TermRejectInput,
  output: TermChangeOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.term.rejected'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireNotArchived(deal);
    const e = await entryOf(ctx, deal, input.entryId);
    if (!isLive(e)) throw settled(e);
    const label = termLabel(e.key as TermKey);
    if (e.confirmedAt)
      throw HfosError.rule(
        'realestate_term_confirmed',
        409,
        `That ${label.toLowerCase()} was confirmed. Enter a correction instead, and it replaces this one.`,
      );
    const w = await openWork(ctx, deal);
    await ctx.tx
      .update(termEntries)
      .set({ rejectedBy: actorUserId(ctx), rejectedAt: w.at, rejectedReason: input.reason })
      .where(eq(termEntries.id, e.id));
    await afterTermsChanged(w);
    await historyLine(ctx, deal, 'term_rejected', {
      before: { key: e.key, entryId: e.id, value: termValueWords(e) },
      note: input.reason,
    });
    const eventId = await ctx.emit({
      type: 'realestate.term.rejected',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: { name: deal.name, key: e.key, entryId: e.id, reason: input.reason },
      before: { name: deal.name, [e.key]: termValueWords(e) },
    });
    await dealLine(ctx, deal, `set aside the ${label.toLowerCase()} ${termValueWords(e)}`, {
      eventId,
      body: input.reason,
    });
    return { dealId: deal.recordId, entryId: e.id, ...counts(w) };
  },
});

export const termResolve = defineAddonCommand(realestateAddon, {
  name: 'realestate.term.resolve_conflict',
  description:
    'Settle a key date or term whose entries disagree: the one kept counts (confirmed), and the others are set aside, kept in the history with the reason.',
  risk: 2,
  input: TermResolveInput,
  output: TermChangeOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.term.conflict_resolved'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireNotArchived(deal);
    const keep = await entryOf(ctx, deal, input.keepEntryId);
    if (!isLive(keep)) throw settled(keep);
    if (keep.key !== input.key)
      throw HfosError.validation([
        { path: 'keepEntryId', message: 'Pick one of the entries that disagree.' },
      ]);
    const w = await openWork(ctx, deal);
    const now = w.terms.get(input.key as TermKey);
    const label = termLabel(input.key as TermKey);
    if (!now?.conflict)
      throw HfosError.rule(
        'realestate_no_conflict',
        409,
        `The ${label.toLowerCase()} has nothing to settle: its entries agree. Refresh to see it as it is now.`,
      );
    const others = now.live.filter((e) => e.id !== keep.id);
    for (const e of others)
      await ctx.tx
        .update(termEntries)
        .set({ supersededBy: keep.id, supersededAt: w.at })
        .where(eq(termEntries.id, e.id));
    if (!keep.confirmedAt)
      await ctx.tx
        .update(termEntries)
        .set({ confirmedBy: actorUserId(ctx), confirmedAt: w.at })
        .where(eq(termEntries.id, keep.id));
    await afterTermsChanged(w);
    await historyLine(ctx, deal, 'conflict_resolved', {
      before: {
        key: input.key,
        entries: now.live.map((e) => ({ entryId: e.id, value: termValueWords(e) })),
      },
      after: { key: input.key, entryId: keep.id, value: termValueWords(keep) },
      note: input.reason,
    });
    const eventId = await ctx.emit({
      type: 'realestate.term.conflict_resolved',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: {
        name: deal.name,
        key: input.key,
        kept: keep.id,
        setAside: others.map((e) => e.id),
        reason: input.reason,
      },
      after: { name: deal.name, [input.key]: termValueWords(keep) },
    });
    await dealLine(ctx, deal, `settled the ${label.toLowerCase()}: ${termValueWords(keep)}`, {
      eventId,
      body: input.reason,
    });
    return { dealId: deal.recordId, entryId: keep.id, ...counts(w) };
  },
});

export const termCommands = [termEnter, termConfirm, termReject, termResolve];
