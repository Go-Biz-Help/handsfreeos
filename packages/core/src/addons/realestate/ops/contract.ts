/**
 * Reading contracts and amendments (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round four", step 2).
 *
 * - **Read on its own.** A contract, amendment or addendum added to a deal as a PDF is read by the worker
 *   (`realestate.contract.read_requested`); "Read it again" asks once more. A reading is never a change to the deal.
 * - **A person confirms each value** (Chris, 2026-10-02). What the reading found waits beside its clause, page and
 *   words, each with the value that counts now. Confirming one enters it on the deal's key dates as confirmed, from
 *   the contract or the amendment, with its words, and replaces what was there (kept in the history). Duties resting on
 *   a date start, or move, then.
 * - **What an amendment changes** is worked out before anyone confirms it: each open duty whose due time would move.
 * - Confirming a reading is proof for the contract timeline duties (X-15, S-49), and an amendment's for X-16.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, ne } from 'drizzle-orm';
import type { z } from 'zod';
import { files } from '@hfos/db/schema';
import { addDays } from '../../../calendar/engine/zoned';
import { HfosError } from '../../../errors';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { DOCUMENT_KINDS, type DocumentKind, type DutyDef } from '../catalog/types';
import { READ_KINDS, type ContractKey, type ReadKind } from '../contract-read';
import { addBusinessDays } from '../dates/business-days';
import { resolveDue } from '../dates/due';
import { KEY_DATES, type KeyDateKey, type KeyDates } from '../dates/key-dates';
import { realestateAddon } from '../manifest';
import { dayWords, dueRuleWords, SOURCE_WORDS } from '../rule-words';
import {
  ContractConfirmInput,
  ContractConfirmOutput,
  ContractReadDoneInput,
  ContractReadDoneOutput,
  ContractReadOutput,
  ContractReadQueryInput,
  ContractReadsInput,
  ContractReadsOutput,
  ContractRejectInput,
  ContractRejectOutput,
  DocumentReadInput,
  DocumentReadOutput,
} from '../schemas';
import { OPEN_DUTY_STATUSES } from '../states';
import { contractReads, documents, duties, termEntries, type ContractValue } from '../tables';
import { keyDatesOf, sameValue, termLabel, termsNow, termValueWords, type TermKey } from '../terms';
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
  type Ctx,
  type Deal,
} from './common';
import { dateProblemsOf, openWork, termEntriesOf } from './engine';
import { addProof, PROOF_EVENTS } from './proof-hooks';
import { afterTermsChanged, termCounts } from './terms';

type Read = typeof contractReads.$inferSelect;
type Doc = typeof documents.$inferSelect;

/** The events a command that starts a reading declares. */
export const READ_EVENTS = ['realestate.contract.read_requested'] as const;

const isReadKind = (kind: string): kind is ReadKind =>
  (READ_KINDS as readonly string[]).includes(kind);

/** A PDF, by its type or its name: the only kind read. */
export const isPdf = (f: { readonly name: string; readonly mimeType: string | null }) =>
  f.mimeType === 'application/pdf' || /\.pdf$/i.test(f.name);

const kindWords = (kind: string) => (DOCUMENT_KINDS[kind as DocumentKind] ?? kind).toLowerCase();

/**
 * Starts reading a document, or hands back the reading already under way. The worker reads it
 * (`realestate.contract.read_requested`).
 */
export async function startRead(
  ctx: CommandContext,
  deal: Deal,
  doc: Pick<Doc, 'id' | 'fileId' | 'kind' | 'title'>,
): Promise<Read> {
  if (!isReadKind(doc.kind))
    throw HfosError.rule(
      'realestate_read_kind',
      409,
      `Only contracts, amendments and addenda are read. “${doc.title}” is a ${kindWords(doc.kind)}.`,
    );
  const [busy] = await ctx.tx
    .select()
    .from(contractReads)
    .where(and(eq(contractReads.documentId, doc.id), eq(contractReads.state, 'reading')));
  if (busy) return busy;
  const [read] = await ctx.tx
    .insert(contractReads)
    .values({
      workspaceId: deal.workspaceId,
      dealRecordId: deal.recordId,
      documentId: doc.id,
      kind: doc.kind,
      requestedBy: actorUserId(ctx),
      requestedAt: changeMoment(ctx.meta),
    })
    .returning();
  await ctx.emit({
    type: 'realestate.contract.read_requested',
    entityType: 'custom_record',
    entityId: deal.recordId,
    payload: {
      name: deal.name,
      readId: read!.id,
      documentId: doc.id,
      fileId: doc.fileId,
      kind: doc.kind,
      title: doc.title,
    },
    broadcast: false,
  });
  return read!;
}

async function loadRead(
  ctx: Ctx,
  readId: string,
  lock: boolean,
): Promise<{ read: Read; doc: Doc }> {
  const mine = and(
    eq(contractReads.id, readId),
    eq(contractReads.workspaceId, ctx.scope.workspaceId!),
  );
  // Locked on its own: FOR UPDATE OF can't name a table in another schema.
  if (lock)
    await ctx.tx.select({ id: contractReads.id }).from(contractReads).where(mine).for('update');
  const [row] = await ctx.tx
    .select({ read: contractReads, doc: documents })
    .from(contractReads)
    .innerJoin(documents, eq(documents.id, contractReads.documentId))
    .where(mine);
  if (!row)
    throw HfosError.notFound(
      'That reading isn’t there anymore, or you’re not on its deal. Open the deal’s documents to see what was read.',
    );
  return row;
}

const waitingIn = (r: Pick<Read, 'found'>) => r.found.filter((v) => v.state === 'waiting');

export const documentRead = defineAddonCommand(realestateAddon, {
  name: 'realestate.document.read',
  description:
    'Have the AI read a deal’s contract, amendment or addendum (a PDF, scans too) for its parties, money, dates and contingencies, each with its clause. Nothing changes on the deal until a person confirms each value.',
  risk: 1,
  input: DocumentReadInput,
  output: DocumentReadOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: [...READ_EVENTS],
  async handler(ctx, input) {
    const [doc] = await ctx.tx
      .select()
      .from(documents)
      .where(
        and(eq(documents.id, input.documentId), eq(documents.workspaceId, ctx.scope.workspaceId!)),
      );
    if (!doc)
      throw HfosError.notFound(
        'That document isn’t there anymore, or you’re not on its deal. Refresh to see the deal’s documents.',
      );
    const deal = await loadDeal(ctx, doc.dealRecordId, { lock: true });
    requireNotArchived(deal);
    if (doc.status === 'void')
      throw HfosError.rule(
        'realestate_document_void',
        409,
        `“${doc.title}” was voided, so it isn’t read. Add the document again if it’s needed.`,
      );
    const [file] = await ctx.tx
      .select({ name: files.name, mimeType: files.mimeType })
      .from(files)
      .where(eq(files.id, doc.fileId));
    if (!file || !isPdf(file))
      throw HfosError.rule(
        'realestate_read_not_pdf',
        409,
        `Only PDFs are read, and “${doc.title}” isn’t one. Scan or save it as a PDF, add that to the deal, and it’s read on its own.`,
      );
    const read = await startRead(ctx, deal, doc);
    return { dealId: deal.recordId, documentId: doc.id, readId: read.id, state: read.state };
  },
});

export const contractReadDone = defineAddonCommand(realestateAddon, {
  name: 'realestate.contract.read_done',
  description:
    'Worker: what the AI found in a contract, amendment or addendum, each value checked against its words, for a person to confirm. Or why it couldn’t be read.',
  risk: 0,
  input: ContractReadDoneInput,
  output: ContractReadDoneOutput,
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: ['realestate.contract.read_finished'],
  async handler(ctx, input) {
    const { read, doc } = await loadRead(ctx, input.readId, true);
    if (read.state !== 'reading') return { readId: read.id, state: 'skipped' as const };
    const deal = await loadDeal(ctx, read.dealRecordId);
    const at = changeMoment(ctx.meta);
    const failure =
      input.failure ??
      (input.values.length === 0 && input.unclear.length === 0
        ? `The AI didn’t find any terms in “${doc.title}”. Enter the key dates yourself, or read it again.`
        : null);
    const found: ContractValue[] = failure
      ? []
      : input.values.map((v) => ({
          id: randomUUID(),
          key: v.key,
          date: v.date,
          time: null,
          cents: v.cents,
          text: v.text,
          worked: v.worked,
          clause: v.clause,
          page: v.page,
          quote: v.quote,
          state: 'waiting' as const,
          entryId: null,
          decidedBy: null,
          decidedAt: null,
          reason: null,
        }));
    // An amendment that moves a date moves the dates the contract counts from it, to confirm with the rest.
    if (!failure && read.kind !== 'contract')
      found.push(...(await countedFromMoved(ctx, read.id, read.dealRecordId, found)));
    await ctx.tx
      .update(contractReads)
      .set({
        state: failure ? 'failed' : 'read',
        failure,
        scan: input.scan,
        pages: input.pages,
        model: input.model ?? null,
        found,
        unclear: failure ? [] : input.unclear,
        dropped: input.dropped,
        readAt: at,
        updatedAt: at,
      })
      .where(eq(contractReads.id, read.id));
    // An older reading of the same document stops waiting: this one is what's there now.
    if (!failure) {
      const older = await ctx.tx
        .select()
        .from(contractReads)
        .where(
          and(
            eq(contractReads.documentId, doc.id),
            ne(contractReads.id, read.id),
            eq(contractReads.state, 'read'),
          ),
        )
        .for('update');
      for (const o of older.filter((r) => waitingIn(r).length))
        await ctx.tx
          .update(contractReads)
          .set({
            found: o.found.map((v) =>
              v.state === 'waiting'
                ? {
                    ...v,
                    state: 'rejected' as const,
                    decidedAt: at.toISOString(),
                    reason: 'Read again.',
                  }
                : v,
            ),
            updatedAt: at,
          })
          .where(eq(contractReads.id, o.id));
    }
    await historyLine(ctx, deal, 'contract_read', {
      after: {
        readId: read.id,
        documentId: doc.id,
        title: doc.title,
        found: found.length,
        unclear: failure ? 0 : input.unclear.length,
        scan: input.scan,
        failed: !!failure,
      },
      note: failure,
    });
    const eventId = await ctx.emit({
      type: 'realestate.contract.read_finished',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: {
        name: deal.name,
        readId: read.id,
        documentId: doc.id,
        title: doc.title,
        kind: read.kind,
        state: failure ? 'failed' : 'read',
        waiting: found.length,
        unclear: failure ? 0 : input.unclear.length,
        scan: input.scan,
        ownerUserId: deal.ownerUserId,
      },
    });
    await dealLine(
      ctx,
      deal,
      failure
        ? `couldn’t read the ${kindWords(read.kind)} “${doc.title}”`
        : `read the ${kindWords(read.kind)} “${doc.title}”: ${found.length} ${found.length === 1 ? 'value' : 'values'} to confirm`,
      { eventId, ...(failure ? { body: failure, tone: 'warning' as const } : {}) },
    );
    // Values waiting are a reason on the deal's health.
    await (await openWork(ctx, deal)).refreshHealth();
    return { readId: read.id, state: failure ? ('failed' as const) : ('read' as const) };
  },
});

/**
 * The dates an earlier reading worked out from a date this one moves ("possession: at closing and funding"), worked
 * out again from the new one. Only while that earlier value is still what counts, and only where it changes. They
 * keep the contract's own words and clause, and wait for a person like every other value.
 */
async function countedFromMoved(
  ctx: CommandContext,
  readId: string,
  dealId: string,
  found: readonly ContractValue[],
): Promise<ContractValue[]> {
  const moved = new Map(
    found.filter((v) => v.date && v.key in KEY_DATES).map((v) => [v.key, v.date!] as const),
  );
  if (!moved.size) return [];
  const earlier = await ctx.tx
    .select({ found: contractReads.found })
    .from(contractReads)
    .where(
      and(
        eq(contractReads.dealRecordId, dealId),
        ne(contractReads.id, readId),
        eq(contractReads.state, 'read'),
      ),
    );
  const terms = termsNow(await termEntriesOf(ctx, dealId));
  const calendar = await businessCalendarOf(ctx);
  const out: ContractValue[] = [];
  for (const v of earlier.flatMap((r) => r.found)) {
    const w = v.worked;
    if (v.state !== 'confirmed' || !w || !moved.has(w.from)) continue;
    if (found.some((f) => f.key === v.key) || out.some((o) => o.key === v.key)) continue;
    if (terms.get(v.key as TermKey)?.current?.id !== v.entryId) continue;
    const fromDate = moved.get(w.from)!;
    const date = w.business
      ? addBusinessDays(fromDate, w.days, calendar).date
      : addDays(fromDate, w.days);
    if (date === v.date) continue;
    out.push({
      ...v,
      id: randomUUID(),
      date,
      worked: { ...w, fromDate },
      // The words are the contract's, not this document's: no page here to open.
      clause: v.clause ? `${v.clause} of the contract` : 'The contract',
      page: null,
      state: 'waiting',
      entryId: null,
      decidedBy: null,
      decidedAt: null,
      reason: null,
    });
  }
  return out;
}

/** Where a value is in its document, as a key date entry keeps it. */
const placeOf = (v: ContractValue) =>
  v.clause ? (v.page ? `${v.clause}, page ${v.page}` : v.clause) : v.page ? `Page ${v.page}` : null;

export const contractConfirm = defineAddonCommand(realestateAddon, {
  name: 'realestate.contract.confirm',
  description:
    'Confirm values a reading found in a contract, amendment or addendum: each goes on the deal’s key dates as confirmed, with its clause and words, replacing what was there. Duties resting on a date start or move.',
  risk: 1,
  input: ContractConfirmInput,
  output: ContractConfirmOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.contract.confirmed', ...PROOF_EVENTS],
  async handler(ctx, input) {
    const { read, doc } = await loadRead(ctx, input.readId, true);
    const deal = await loadDeal(ctx, read.dealRecordId, { lock: true });
    requireNotArchived(deal);
    if (read.state !== 'read')
      throw HfosError.rule(
        'realestate_read_not_ready',
        409,
        read.state === 'reading'
          ? `“${doc.title}” is still being read. Its values show here in a minute.`
          : `“${doc.title}” couldn’t be read, so there’s nothing to confirm. Read it again, or enter the key dates yourself.`,
      );
    if (doc.status === 'void')
      throw HfosError.rule(
        'realestate_document_void',
        409,
        `“${doc.title}” was voided, so what it says doesn’t count. Set its values aside, or add the document again.`,
      );
    const unknown = (input.valueIds ?? []).filter((id) => !read.found.some((v) => v.id === id));
    if (unknown.length)
      throw HfosError.validation([
        {
          path: 'valueIds',
          message: 'Some of those values aren’t in this reading. Refresh to see it as it is now.',
        },
      ]);
    const pick = read.found.filter(
      (v) => v.state === 'waiting' && (!input.valueIds || input.valueIds.includes(v.id)),
    );
    const w = await openWork(ctx, deal);
    if (!pick.length)
      return { readId: read.id, dealId: deal.recordId, confirmed: 0, ...termCounts(w) };
    const me = actorUserId(ctx);
    const entered = new Map<string, string>();
    for (const v of pick) {
      const [entry] = await ctx.tx
        .insert(termEntries)
        .values({
          workspaceId: deal.workspaceId,
          dealRecordId: deal.recordId,
          key: v.key,
          valueDate: v.date,
          valueTime: v.time,
          valueCents: v.cents,
          valueText: v.text,
          source: read.kind,
          sourceRef: placeOf(v)?.slice(0, 200) ?? null,
          documentId: doc.id,
          quote: v.quote,
          page: v.page,
          readId: read.id,
          scan: read.scan,
          enteredBy: me,
          enteredAt: w.at,
          confirmedBy: me,
          confirmedAt: w.at,
        })
        .returning({ id: termEntries.id });
      // What was there before is replaced, and kept in the history.
      await ctx.tx
        .update(termEntries)
        .set({ supersededBy: entry!.id, supersededAt: w.at })
        .where(
          and(
            eq(termEntries.dealRecordId, deal.recordId),
            eq(termEntries.key, v.key),
            ne(termEntries.id, entry!.id),
            isNull(termEntries.supersededAt),
            isNull(termEntries.rejectedAt),
          ),
        );
      entered.set(v.id, entry!.id);
    }
    const decidedAt = w.at.toISOString();
    const found = read.found.map((v) =>
      entered.has(v.id)
        ? {
            ...v,
            state: 'confirmed' as const,
            entryId: entered.get(v.id)!,
            decidedBy: me,
            decidedAt,
          }
        : v,
    );
    await ctx.tx
      .update(contractReads)
      .set({ found, updatedAt: w.at })
      .where(eq(contractReads.id, read.id));
    await afterTermsChanged(w);
    if (read.kind === 'amendment') {
      await historyLine(ctx, deal, 'event', { after: { events: ['amendment'] } });
      await w.happen(['amendment']);
      await w.settle();
    }
    const keys = pick.map((v) => v.key);
    await addProof(
      ctx,
      deal,
      { keys: read.kind === 'contract' ? ['X-15', 'S-49'] : ['X-15', 'S-49', 'X-16'] },
      {
        kind: 'record',
        refKind: 'contract_read',
        refId: read.id,
        body: `${pick.length} ${pick.length === 1 ? 'value' : 'values'} confirmed from “${doc.title}”.`,
      },
    );
    const left = found.filter((v) => v.state === 'waiting').length;
    await historyLine(ctx, deal, 'contract_confirmed', {
      after: { readId: read.id, documentId: doc.id, title: doc.title, keys, left },
    });
    const eventId = await ctx.emit({
      type: 'realestate.contract.confirmed',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: { name: deal.name, readId: read.id, documentId: doc.id, keys, left },
      after: {
        name: deal.name,
        ...Object.fromEntries(pick.map((v) => [v.key, valueWords(v)])),
      },
    });
    await dealLine(
      ctx,
      deal,
      `confirmed ${pick.length} ${pick.length === 1 ? 'value' : 'values'} from the ${kindWords(read.kind)} “${doc.title}”`,
      {
        eventId,
        body: pick.map((v) => `${termLabel(v.key as TermKey)}: ${valueWords(v)}`).join('\n'),
      },
    );
    return { readId: read.id, dealId: deal.recordId, confirmed: pick.length, ...termCounts(w) };
  },
});

export const contractReject = defineAddonCommand(realestateAddon, {
  name: 'realestate.contract.reject_value',
  description:
    'Set aside a value a reading found that isn’t right, with why. Nothing on the deal changes; type the right value under Key dates.',
  risk: 1,
  input: ContractRejectInput,
  output: ContractRejectOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.contract.value_rejected'],
  async handler(ctx, input) {
    const { read, doc } = await loadRead(ctx, input.readId, true);
    const deal = await loadDeal(ctx, read.dealRecordId, { lock: true });
    requireNotArchived(deal);
    const v = read.found.find((x) => x.id === input.valueId);
    if (!v)
      throw HfosError.notFound(
        'That value isn’t in this reading anymore. Refresh to see it as it is now.',
      );
    if (v.state !== 'waiting')
      throw HfosError.rule(
        'realestate_value_decided',
        409,
        v.state === 'confirmed'
          ? `The ${termLabel(v.key as TermKey).toLowerCase()} was already confirmed. Enter a correction under Key dates to change it.`
          : `The ${termLabel(v.key as TermKey).toLowerCase()} was already set aside.`,
      );
    const at = changeMoment(ctx.meta);
    const found = read.found.map((x) =>
      x.id === v.id
        ? {
            ...x,
            state: 'rejected' as const,
            decidedBy: actorUserId(ctx),
            decidedAt: at.toISOString(),
            reason: input.reason,
          }
        : x,
    );
    await ctx.tx
      .update(contractReads)
      .set({ found, updatedAt: at })
      .where(eq(contractReads.id, read.id));
    const left = found.filter((x) => x.state === 'waiting').length;
    await historyLine(ctx, deal, 'contract_value_rejected', {
      before: { readId: read.id, key: v.key, value: valueWords(v) },
      after: { left },
      note: input.reason,
    });
    await ctx.emit({
      type: 'realestate.contract.value_rejected',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: { name: deal.name, readId: read.id, documentId: doc.id, key: v.key, left },
      broadcast: false,
    });
    await (await openWork(ctx, deal)).refreshHealth();
    return { readId: read.id, dealId: deal.recordId };
  },
});

// ---------- reading what was read ----------

/** A value as a sentence says it. */
export const valueWords = (v: Pick<ContractValue, 'date' | 'time' | 'cents' | 'text'>) =>
  termValueWords({
    valueDate: v.date,
    valueTime: v.time,
    valueCents: v.cents,
    valueText: v.text,
  });

/** "9 days after the contract accepted (Sep 24, 2026)", or "on the closing (Oct 30, 2026)". */
const workedWords = (w: ContractValue['worked']) => {
  if (!w) return null;
  const from = `the ${KEY_DATES[w.from as KeyDateKey].label.toLowerCase()} (${termValueWords({ valueDate: w.fromDate, valueTime: null, valueCents: null, valueText: null })})`;
  if (w.days === 0) return `On ${from}`;
  return `${w.days} ${w.business ? (w.days === 1 ? 'business day' : 'business days') : w.days === 1 ? 'day' : 'days'} after ${from}`;
};

/** Each open duty whose due time would move if these values counted. */
async function movesOf(
  ctx: Ctx,
  deal: Deal,
  keyDates: KeyDates,
  next: KeyDates,
): Promise<ContractReadOutputT['moves']> {
  const timeZone = await timeZoneOf(ctx);
  const calendar = await businessCalendarOf(ctx);
  const open = await ctx.tx
    .select()
    .from(duties)
    .where(
      and(
        eq(duties.dealRecordId, deal.recordId),
        inArray(duties.status, [...OPEN_DUTY_STATUSES, 'draft']),
      ),
    );
  const moves: ContractReadOutputT['moves'] = [];
  for (const d of open) {
    if (d.dueOverrideAt) continue;
    const def = d.definition as unknown as DutyDef;
    if (!def.due) continue;
    const at = { timeZone, calendar, startedAt: d.startedAt.getTime() };
    const before = resolveDue(def.due, { ...at, keyDates });
    const after = resolveDue(def.due, { ...at, keyDates: next });
    if (before.dueAt === after.dueAt) continue;
    moves.push({
      dutyId: d.id,
      title: d.title,
      from: before.date ? dayWords(before.date, timeZone) : null,
      to: after.date ? dayWords(after.date, timeZone) : null,
      why: dueRuleWords(def.due),
      accountableName: d.accountableUserId,
    });
  }
  const names = await userNames(
    ctx,
    moves.map((m) => m.accountableName),
  );
  return moves.map((m) => ({
    ...m,
    accountableName: m.accountableName ? (names.get(m.accountableName) ?? null) : null,
  }));
}

type ContractReadOutputT = z.infer<typeof ContractReadOutput>;

export const contractReadGet = defineAddonQuery(realestateAddon, {
  name: 'realestate.contract.read',
  description:
    'One reading of a contract, amendment or addendum: each value with its clause, page and words, beside what counts on the deal now, what confirming them would move, and what the AI couldn’t place.',
  input: ContractReadQueryInput,
  output: ContractReadOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_get_contract_read',
    description: 'What the AI read in a contract or amendment, and what is still to confirm.',
  },
  async handler(ctx, input) {
    const { read, doc } = await loadRead(ctx, input.readId, false);
    const deal = await loadDeal(ctx, read.dealRecordId);
    const entries = await termEntriesOf(ctx, deal.recordId);
    const terms = termsNow(entries);
    const keyDates = keyDatesOf(terms);
    const waiting = waitingIn(read);
    const next: Record<string, KeyDates[KeyDateKey]> = { ...keyDates };
    for (const v of waiting)
      if (v.date && v.key in KEY_DATES)
        next[v.key] = { date: v.date, time: v.time, source: read.kind, confirmed: true };
    const moves = waiting.length ? await movesOf(ctx, deal, keyDates, next) : [];
    const timeZone = await timeZoneOf(ctx);
    const calendar = await businessCalendarOf(ctx);
    const problems = waiting.length
      ? (await dateProblemsOf(ctx, deal, next, calendar, todayIn(timeZone))).map((p) => ({
          check: p.check,
          words: p.words,
        }))
      : [];
    const names = await userNames(ctx, [
      read.requestedBy,
      ...read.found.map((v) => v.decidedBy),
      ...entries.map((e) => e.confirmedBy),
    ]);
    const [newer] = await ctx.tx
      .select({ id: contractReads.id })
      .from(contractReads)
      .where(
        and(eq(contractReads.documentId, doc.id), gt(contractReads.requestedAt, read.requestedAt)),
      )
      .orderBy(desc(contractReads.requestedAt))
      .limit(1);
    return {
      readId: read.id,
      dealId: deal.recordId,
      dealName: deal.name,
      documentId: doc.id,
      documentTitle: doc.title,
      fileId: doc.fileId,
      kind: read.kind,
      state: read.state,
      scan: read.scan,
      pages: read.pages,
      failure: read.failure,
      requestedAt: read.requestedAt.toISOString(),
      readAt: read.readAt?.toISOString() ?? null,
      requestedByName: read.requestedBy ? (names.get(read.requestedBy) ?? null) : null,
      values: read.found.map((v) => {
        const t = terms.get(v.key as TermKey);
        // What counts now, unless it's this very value, confirmed.
        const nowEntry =
          t?.current && t.current.id !== v.entryId
            ? t.current
            : (t?.live.find((e) => e.id !== v.entryId) ?? null);
        const nowFull = nowEntry ? entries.find((e) => e.id === nowEntry.id) : null;
        return {
          id: v.id,
          key: v.key as ContractKey,
          label: termLabel(v.key as TermKey),
          value: valueWords(v),
          date: v.date,
          cents: v.cents,
          text: v.text,
          worked: workedWords(v.worked),
          clause: v.clause,
          page: v.page,
          quote: v.quote,
          state: v.state,
          decidedByName: v.decidedBy ? (names.get(v.decidedBy) ?? null) : null,
          decidedAt: v.decidedAt,
          reason: v.reason,
          now: nowEntry ? termValueWords(nowEntry) : null,
          nowFrom: nowFull
            ? `${SOURCE_WORDS[nowFull.source]}${nowFull.confirmedAt ? '' : ', not confirmed'}`
            : null,
          same:
            !!nowEntry &&
            sameValue(nowEntry, {
              valueDate: v.date,
              valueTime: v.time,
              valueCents: v.cents,
              valueText: v.text,
            }),
        };
      }),
      unclear: read.unclear,
      dropped: read.dropped,
      moves,
      problems,
      newerReadId: newer?.id ?? null,
    };
  },
});

export const contractReadsList = defineAddonQuery(realestateAddon, {
  name: 'realestate.contract.reads',
  description:
    'The readings of a deal’s contracts and amendments, newest first: each one’s state and how many values wait to be confirmed.',
  input: ContractReadsInput,
  output: ContractReadsOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId);
    const list = await ctx.tx
      .select({ read: contractReads, title: documents.title })
      .from(contractReads)
      .innerJoin(documents, eq(documents.id, contractReads.documentId))
      .where(eq(contractReads.dealRecordId, deal.recordId))
      .orderBy(desc(contractReads.requestedAt), desc(contractReads.id));
    return {
      reads: list.map(({ read, title }) => ({
        readId: read.id,
        documentId: read.documentId,
        documentTitle: title,
        kind: read.kind,
        state: read.state,
        scan: read.scan,
        waiting: read.found.filter((v) => v.state === 'waiting').length,
        confirmed: read.found.filter((v) => v.state === 'confirmed').length,
        unclear: read.unclear.length,
        requestedAt: read.requestedAt.toISOString(),
      })),
    };
  },
});

export const contractCommands = [documentRead, contractReadDone, contractConfirm, contractReject];
export const contractQueries = [contractReadGet, contractReadsList];
