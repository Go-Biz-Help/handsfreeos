/**
 * Buyer memory in the worker (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round two: Buyer core").
 *
 * - A client's message (`message.received`) or a call with them transcribed (`call.transcribed`) starts a read of each
 *   of their open buyer deals ten minutes on, one per deal (`realestate.memory_suggest`), so a burst of messages is
 *   read once. Asked for from the deal (`realestate.memory.requested`), it reads at once.
 * - It reads only what's new since it last looked: the client's own messages (website chat only once the visitor
 *   proved who they are, as contact AI does; a private thread only when it's this deal's), their calls' transcripts,
 *   and the team's notes on the deal or the client. Never another deal's private thread or note.
 * - The model's items are checked (core's checkedMemory): each quote word for word in one of those words, nothing the
 *   fixed list or the model calls protected, nothing already kept. What's left is suggested for the agent, with a note
 *   on their Home while any wait; what's dropped is only counted.
 */
import { memorySuggest } from '@hfos/core/addons/realestate/ops/memory';
import {
  checkedMemory,
  MEMORY_SCHEMA,
  MEMORY_SYSTEM,
  MemoryAnswer,
  memoryPrompt,
  type MemorySource,
} from '@hfos/core/addons/realestate/prompts';
import { executeCommand } from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import type { JobResult } from '../../jobs';
import { AiAskError, askStructured } from '../../ai/ask';
import { clearAddonAlert, raiseAddonAlert } from '../alerts';
import { scheduleAddonJob } from '../queue';
import type { AddonEventContext, AddonJobContext, AddonScopeContext } from '../types';

export const MEMORY_JOB = 'realestate.memory_suggest';
/** A burst of messages is read once, this long after the first. */
export const MEMORY_DEBOUNCE_MS = 10 * 60_000;
const FIRST_LOOK_DAYS = 90;
const MAX_CHARS = 30_000;
/** How many of each kind one read looks at, at most. */
const PER_KIND = { message: 60, call: 20, note: 20 } as const;

export const memoryJobKey = (dealId: string) => `${MEMORY_JOB}:${dealId}`;
export const memoryAlertKey = (dealId: string) => `memory:${dealId}`;

const payloadOf = (ctx: AddonEventContext) => (ctx.event.payload ?? {}) as Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** A person's open buyer deals, where they're the client. */
async function clientDeals(tx: Tx, workspaceId: string, personId: string): Promise<string[]> {
  const list = await rows<{ deal: string }>(
    tx,
    sql`select d.record_id as deal
        from app.relationships rel
        join app.relationship_types t on t.id = rel.type_id and t.addon_key = 'realestate_client'
        join addon_realestate.deals d on d.record_id = rel.b_custom_record_id
        where rel.workspace_id = ${workspaceId} and rel.a_person_id = ${personId}
          and d.side = 'buyer' and d.outcome is null`,
  );
  return list.map((d) => d.deal);
}

/** `message.received` / `call.transcribed`: a client said something; their buyer deals are read ten minutes on. */
export async function clientSpoke(ctx: AddonEventContext): Promise<void> {
  const p = payloadOf(ctx);
  const ws = ctx.scope.workspaceId;
  await asWorker(ctx.db, ctx.scope, async (tx) => {
    let personId = str(p['personId']);
    if (ctx.event.eventType === 'call.transcribed' && ctx.event.entityId) {
      const [c] = await rows<{ person_id: string | null; has: boolean }>(
        tx,
        sql`select person_id, transcript is not null and transcript <> '' as has from app.calls
            where id = ${ctx.event.entityId}`,
      );
      personId = c?.has ? c.person_id : null;
    }
    if (!personId) return;
    for (const dealId of await clientDeals(tx, ws, personId))
      await queueRead(ctx, tx, dealId, MEMORY_DEBOUNCE_MS);
  });
}

/** What one read covers, and whether more is left for the next. */
interface Batch {
  readonly sources: MemorySource[];
  readonly kept: string[];
  readonly more: boolean;
}

/** Puts the deal's next read on the queue, `delayMs` from now; one per deal. */
async function queueRead(
  ctx: AddonScopeContext,
  tx: Tx,
  dealId: string,
  delayMs: number,
): Promise<void> {
  await scheduleAddonJob(
    tx,
    { id: ctx.manifest.id, generation: ctx.generation },
    {
      kind: MEMORY_JOB,
      dedupeKey: memoryJobKey(dealId),
      runAt: new Date(Date.now() + delayMs),
      payload: { dealId },
      workspaceId: ctx.scope.workspaceId,
      organizationId: ctx.scope.organizationId,
    },
    // A batch due now moves a waiting read up; a message's ten minutes never push one back.
    { pullEarlier: true },
  );
}

/**
 * What the model may read for a deal: the client's own words and the team's notes, new since it last looked, oldest
 * first. "New" is when HandsFreeOS got it (a call's, when its transcript came), so words that arrive late are still
 * read once. A long backlog is read a batch at a time (`more`). What's already kept, or a person turned down, isn't
 * suggested again.
 */
async function sourcesFor(ctx: AddonScopeContext, dealId: string): Promise<Batch | null> {
  const ws = ctx.scope.workspaceId;
  return asWorker(ctx.db, ctx.scope, async (tx) => {
    const [deal] = await rows<{
      side: string;
      outcome: string | null;
      since: Date | string | null;
    }>(
      tx,
      sql`select side, outcome, memory_read_through as since from addon_realestate.deals
          where record_id = ${dealId}`,
    );
    if (!deal || deal.side !== 'buyer' || deal.outcome) return null;
    const since = deal.since
      ? new Date(deal.since).toISOString()
      : new Date(Date.now() - FIRST_LOOK_DAYS * 86_400_000).toISOString();
    const clients = (
      await rows<{ id: string }>(
        tx,
        sql`select rel.a_person_id as id from app.relationships rel
            join app.relationship_types t on t.id = rel.type_id and t.addon_key = 'realestate_client'
            where rel.workspace_id = ${ws} and rel.b_custom_record_id = ${dealId} and rel.a_person_id is not null`,
      )
    ).map((c) => c.id);
    if (!clients.length) return null;
    const people = `{${clients.join(',')}}`;
    // Times to the millisecond, as the read-through is kept, so the next read starts exactly after this one.
    type Row = { id: string; at: Date | string; text: string };
    const messages = await rows<Row>(
      tx,
      sql`select m.id, date_trunc('milliseconds', m.created_at) as at, m.body_text as text
          from app.messages m join app.conversations c on c.id = m.conversation_id
          where c.workspace_id = ${ws} and c.person_id = any(${people}::uuid[])
            and m.direction = 'inbound' and coalesce(m.body_text, '') <> ''
            and date_trunc('milliseconds', m.created_at) > ${since}::timestamptz
            -- Another deal's private thread is that deal's alone.
            and (not c.sealed or c.custom_record_id = ${dealId})
            and (c.channel <> 'chat' or exists (select 1 from app.chat_visitors v
                   where v.conversation_id = c.id and v.verified_person_id = c.person_id))
          order by m.created_at limit ${PER_KIND.message}`,
    );
    const calls = await rows<Row>(
      tx,
      sql`select id, date_trunc('milliseconds', updated_at) as at, transcript as text from app.calls
          where workspace_id = ${ws} and person_id = any(${people}::uuid[])
            and coalesce(transcript, '') <> '' and date_trunc('milliseconds', updated_at) > ${since}::timestamptz
          order by updated_at limit ${PER_KIND.call}`,
    );
    const notes = await rows<Row>(
      tx,
      sql`select id, date_trunc('milliseconds', created_at) as at, body as text from app.activities
          where workspace_id = ${ws} and kind = 'note' and actor_type = 'human' and coalesce(body, '') <> ''
            and date_trunc('milliseconds', created_at) > ${since}::timestamptz
            and (custom_record_id = ${dealId} or (person_id = any(${people}::uuid[]) and not sealed))
          order by created_at limit ${PER_KIND.note}`,
    );
    const lists = [
      { kind: 'message' as const, list: messages, limit: PER_KIND.message },
      { kind: 'call' as const, list: calls, limit: PER_KIND.call },
      { kind: 'note' as const, list: notes, limit: PER_KIND.note },
    ];
    // A kind that filled its limit may have more after its last: read only up to the earliest such point this time.
    let horizon: string | null = null;
    for (const l of lists)
      if (l.list.length === l.limit) {
        const last = new Date(l.list[l.list.length - 1]!.at).toISOString();
        if (horizon === null || last < horizon) horizon = last;
      }
    const all: MemorySource[] = lists
      .flatMap((l) =>
        l.list.map((r) => ({
          kind: l.kind,
          id: r.id,
          at: new Date(r.at).toISOString(),
          text: r.text,
        })),
      )
      .filter((x) => horizon === null || x.at <= horizon)
      .sort((a, b) => a.at.localeCompare(b.at));
    // Oldest first, as much as fits; the rest is the next batch. One longer than the limit is read cut short.
    const sources: MemorySource[] = [];
    let chars = 0;
    for (const x of all) {
      if (sources.length && chars + x.text.length > MAX_CHARS) break;
      sources.push(x.text.length > MAX_CHARS ? { ...x, text: x.text.slice(0, MAX_CHARS) } : x);
      chars += Math.min(x.text.length, MAX_CHARS);
    }
    // Never stop partway through one moment: what came in alongside the last one waits with it for the next read.
    const cut = sources.length < all.length ? all[sources.length]!.at : null;
    while (cut && sources.length > 1 && sources[sources.length - 1]!.at === cut) sources.pop();
    const kept = (
      await rows<{ words: string }>(
        tx,
        sql`select words from addon_realestate.memory_items
            where deal_record_id = ${dealId} and status in ('suggested', 'confirmed', 'rejected')`,
      )
    ).map((k) => k.words);
    return { sources, kept, more: horizon !== null || sources.length < all.length };
  });
}

/** Reads a deal's new words and suggests what to remember; a long backlog's next batch is queued at once. */
export async function suggestMemory(
  ctx: AddonScopeContext & { readonly attempt: number },
  dealId: string,
): Promise<void> {
  const found = await sourcesFor(ctx, dealId);
  if (!found || !found.sources.length) return;
  let answer: MemoryAnswer;
  try {
    ({ value: answer } = await askStructured(ctx, ctx.scope, {
      system: MEMORY_SYSTEM,
      messages: [{ role: 'user', content: memoryPrompt(found.sources, found.kept) }],
      schema: MEMORY_SCHEMA,
      zod: MemoryAnswer,
      maxTokens: 1200,
      usage: { source: 'addon', addonId: ctx.manifest.id },
    }));
  } catch (e) {
    if (!(e instanceof AiAskError)) throw e;
    // A busy model is worth another try; otherwise the words stay unread for the next pass.
    if (e.retryable && ctx.attempt < 3) throw e;
    return;
  }
  const checked = checkedMemory(answer, found.sources, found.kept);
  await executeCommand(
    ctx.db,
    memorySuggest,
    {
      workspaceId: ctx.scope.workspaceId,
      dealId,
      items: checked.items.map((i) => ({
        kind: i.kind,
        words: i.words,
        quote: i.quote,
        sourceKind: i.source.kind,
        sourceId: i.source.id,
      })),
      readThrough: found.sources[found.sources.length - 1]!.at,
      unquoted: checked.unquoted,
      protectedDropped: checked.protectedDropped,
    },
    ctx.actor,
    ctx.meta,
  );
  if (found.more) await asWorker(ctx.db, ctx.scope, (tx) => queueRead(ctx, tx, dealId, 0));
}

/** `realestate.memory_suggest`: the read, ten minutes after the client spoke. */
export async function memoryJob(ctx: AddonJobContext): Promise<JobResult> {
  const dealId = str(ctx.job.payload['dealId']);
  if (dealId) await suggestMemory(ctx, dealId);
}

/** `realestate.memory.requested`: read now. */
export async function memoryRequested(ctx: AddonEventContext): Promise<void> {
  if (ctx.event.entityId) await suggestMemory(ctx, ctx.event.entityId);
}

/** `realestate.memory.suggested` / `.decided`: a note on the main agent's Home while suggestions wait, gone when none do. */
export async function memoryWaitingChanged(ctx: AddonEventContext): Promise<void> {
  const dealId = ctx.event.entityId;
  if (!dealId) return;
  const p = payloadOf(ctx);
  const waiting = typeof p['waiting'] === 'number' ? p['waiting'] : 0;
  if (waiting === 0) {
    await clearAddonAlert(ctx, memoryAlertKey(dealId), 'done');
    return;
  }
  if (ctx.event.eventType !== 'realestate.memory.suggested' || p['added'] === 0) return;
  const name = str(p['name']) ?? 'a deal';
  await raiseAddonAlert(ctx, {
    key: memoryAlertKey(dealId),
    severity: 'info',
    title: `${waiting === 1 ? 'Something' : `${waiting} things`} the buyer said, to confirm`,
    detail: `${name}. Keep what’s right; nothing is remembered until you do.`,
    href: `/a/realestate/deals/${dealId}/buyer`,
    permission: 'realestate.use',
    customRecordId: dealId,
    assigneeUserId: str(p['ownerUserId']),
  });
}
