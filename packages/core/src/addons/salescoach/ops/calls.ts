/**
 * Coached calls (docs/salescoach.md): the add-on's notes on one of core's calls, and the cards it showed the rep.
 *
 * The worker hears the call (apps/worker/src/addons/salescoach/) and writes everything here as the system acting
 * for the add-on: it starts the coached call, adds each card, ends it with what was said, and finishes it with the
 * write-up, which puts the notes on the customer's timeline and a task for each thing the rep promised. People only
 * read, and the rep puts a card away. Row security keeps a coached call to the rep on it and whoever reviews
 * (`salescoach.review`), and a card to its rep.
 */
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { rows, sql as dbSql, type Tx } from '@hfos/db/client';
import { people, users } from '@hfos/db/schema';
import { taskCreate } from '../../../commands/task';
import { fullName } from '../../../crm/records';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { executeCommandWithin } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import { addonTimelineLine, defineAddonCommand, defineAddonQuery } from '../../server';
import {
  AfterCall,
  CallLine,
  CARD_KINDS,
  KEPT_LINES,
  timelineWords,
  type WriteUpKind,
} from '../coach';
import { WIN_KINDS } from '../learn';
import { salescoachAddon } from '../manifest';
import { PlaybookDetails } from '../playbooks';
import { cards, coachedCalls, playbooks } from '../tables';
import { inWorkspace } from './playbooks';

const uuid = z.uuid();

const COACHED_STATES = ['live', 'writing', 'done', 'failed', 'stopped'] as const;

/** How long a call stays "live" on the rep's screen without ending: a stream that never said stop. */
export const LIVE_FOR_MS = 4 * 60 * 60_000;

const Card = z.object({
  id: uuid,
  kind: z.enum(CARD_KINDS),
  title: z.string(),
  say: z.string(),
  heard: z.string(),
  objectionId: z.string().nullable(),
  createdAt: z.string(),
});
export type CoachCard = z.infer<typeof Card>;

const CallSummary = z.object({
  id: uuid,
  /** Core's call, or null for a written conversation's write-up. */
  callId: uuid.nullable(),
  /** The written conversation it writes up, and its channel; null for a call. */
  conversationId: uuid.nullable(),
  channel: z.enum(['sms', 'email', 'chat', 'portal', 'messenger', 'instagram']).nullable(),
  /** Core's live meeting, for a Zoom meeting the coach heard (round three); null otherwise. */
  liveMeetingId: uuid.nullable(),
  state: z.enum(COACHED_STATES),
  rep: z.object({ id: uuid, name: z.string() }).nullable(),
  person: z.object({ id: uuid, name: z.string() }).nullable(),
  playbookName: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  score: z.number().int().nullable(),
  /** How it was won, within a week of it (round four): a job booked, an estimate accepted, paid, a deal won. */
  wonHow: z.enum(WIN_KINDS).nullable(),
});
export type CoachedCallSummary = z.infer<typeof CallSummary>;

const cardOut = (c: typeof cards.$inferSelect): CoachCard => ({
  id: c.id,
  kind: c.kind,
  title: c.title,
  say: c.say,
  heard: c.heard,
  objectionId: c.objectionId,
  createdAt: c.createdAt.toISOString(),
});

type Row = typeof coachedCalls.$inferSelect;

/** The coached calls with their rep's and customer's names, as row security lets the reader see them. */
async function summaries(tx: Tx, found: readonly Row[]): Promise<CoachedCallSummary[]> {
  const userIds = [...new Set(found.flatMap((r) => (r.userId ? [r.userId] : [])))];
  const personIds = [...new Set(found.flatMap((r) => (r.personId ? [r.personId] : [])))];
  const reps = userIds.length
    ? await tx
        .select({ id: users.id, name: users.fullName })
        .from(users)
        .where(inArray(users.id, userIds))
    : [];
  const persons = personIds.length
    ? await tx
        .select({ id: people.id, first: people.firstName, last: people.lastName })
        .from(people)
        .where(inArray(people.id, personIds))
    : [];
  return found.map((r) => {
    const rep = reps.find((u) => u.id === r.userId);
    const person = persons.find((p) => p.id === r.personId);
    return {
      id: r.id,
      callId: r.callId,
      conversationId: r.conversationId,
      channel: (r.channel as CoachedCallSummary['channel']) ?? null,
      liveMeetingId: r.liveMeetingId,
      state: r.state,
      rep: rep ? { id: rep.id, name: rep.name?.trim() || 'Someone on the team' } : null,
      person: person ? { id: person.id, name: fullName(person.first, person.last) } : null,
      playbookName: r.playbookName,
      startedAt: r.startedAt.toISOString(),
      endedAt: r.endedAt?.toISOString() ?? null,
      score: r.result?.score.total ?? null,
      wonHow: r.wonHow ?? null,
    };
  });
}
async function loadCoached(tx: Tx, workspaceId: string, coachedCallId: string): Promise<Row> {
  const [c] = await tx
    .select()
    .from(coachedCalls)
    .where(and(eq(coachedCalls.id, coachedCallId), eq(coachedCalls.workspaceId, workspaceId)));
  if (!c)
    throw HfosError.notFound(
      'That coached call isn’t there anymore, or it isn’t one you can see. Refresh the page.',
    );
  return c;
}

// ---------- the worker's ----------

export const callBegin = defineAddonCommand(salescoachAddon, {
  name: 'salescoach.call.begin',
  description:
    'Worker: someone who is coached answered a call or started a Zoom meeting, and the coach is listening. Starts the coached call with the usual playbook, or finds the one already started.',
  risk: 0,
  input: z
    .object({
      workspaceId: uuid,
      /** Core's phone call, or… */
      callId: uuid.nullable(),
      /** …core's live Zoom meeting (round three). */
      liveMeetingId: uuid.nullable().default(null),
      userId: uuid,
      personId: uuid.nullable(),
    })
    .refine((i) => (i.callId === null) !== (i.liveMeetingId === null), {
      message: 'A coached call is a phone call or a meeting.',
    }),
  output: z.object({
    coachedCallId: uuid,
    playbook: z.object({ id: uuid, name: z.string(), details: PlaybookDetails }).nullable(),
  }),
  permission: 'salescoach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['salescoach.call.started'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [pb] = await ctx.tx
      .select()
      .from(playbooks)
      .where(and(eq(playbooks.workspaceId, ws), isNull(playbooks.archivedAt)))
      .orderBy(desc(playbooks.isDefault), playbooks.createdAt)
      .limit(1);
    const [made] = await ctx.tx
      .insert(coachedCalls)
      .values({
        workspaceId: ws,
        callId: input.callId,
        liveMeetingId: input.liveMeetingId,
        userId: input.userId,
        personId: input.personId,
        playbookId: pb?.id ?? null,
        playbookName: pb?.name ?? null,
      })
      .onConflictDoNothing()
      .returning();
    const c =
      made ??
      (
        await ctx.tx
          .select()
          .from(coachedCalls)
          .where(
            input.callId
              ? eq(coachedCalls.callId, input.callId)
              : eq(coachedCalls.liveMeetingId, input.liveMeetingId!),
          )
      )[0]!;
    if (made)
      await ctx.emit({
        type: 'salescoach.call.started',
        entityType: 'salescoach_call',
        entityId: c.id,
        payload: {
          callId: c.callId,
          liveMeetingId: c.liveMeetingId,
          userId: c.userId,
          personId: c.personId,
        },
      });
    const used = c.playbookId
      ? (await ctx.tx.select().from(playbooks).where(eq(playbooks.id, c.playbookId)))[0]
      : undefined;
    return {
      coachedCallId: c.id,
      playbook: used
        ? { id: used.id, name: used.name, details: PlaybookDetails.parse(used.details) }
        : null,
    };
  },
});

export const cardAdd = defineAddonCommand(salescoachAddon, {
  name: 'salescoach.card.add',
  description:
    'Worker: where the call is in the script now, and a card for the rep when there is something worth showing them.',
  risk: 0,
  input: z.object({
    workspaceId: uuid,
    coachedCallId: uuid,
    step: z.string().nullable(),
    card: z
      .object({
        kind: z.enum(CARD_KINDS),
        title: z.string().trim().min(1).max(80),
        say: z.string().trim().min(1).max(400),
        heard: z.string().max(200),
        objectionId: z
          .string()
          .regex(/^o[0-9]{1,3}$/)
          .nullable(),
      })
      .nullable(),
  }),
  output: z.object({ cardId: uuid.nullable() }),
  permission: 'salescoach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['salescoach.card.added'],
  async handler(ctx, input) {
    const c = await loadCoached(ctx.tx, ctx.scope.workspaceId!, input.coachedCallId);
    if (c.state !== 'live') return { cardId: null };
    const step = input.step && /^s[0-9]{1,3}$/.test(input.step) ? input.step : null;
    if (step && step !== c.step)
      await ctx.tx.update(coachedCalls).set({ step }).where(eq(coachedCalls.id, c.id));
    if (!input.card) return { cardId: null };
    const [card] = await ctx.tx
      .insert(cards)
      .values({
        workspaceId: c.workspaceId,
        coachedCallId: c.id,
        userId: c.userId,
        ...input.card,
      })
      .returning({ id: cards.id });
    // Live: the rep's screen hears this and reads the cards again.
    await ctx.emit({
      type: 'salescoach.card.added',
      entityType: 'salescoach_call',
      entityId: c.id,
      payload: { cardId: card!.id, kind: input.card.kind, userId: c.userId },
    });
    return { cardId: card!.id };
  },
});

export const callEnd = defineAddonCommand(salescoachAddon, {
  name: 'salescoach.call.end',
  description:
    'Worker: the coached call ended. Keeps what was said, both sides, and waits for the write-up; a call where nothing was heard ends there.',
  risk: 0,
  input: z.object({
    workspaceId: uuid,
    coachedCallId: uuid,
    lines: z.array(CallLine).max(KEPT_LINES),
  }),
  output: z.object({ state: z.enum(['writing', 'failed', 'done', 'stopped']) }),
  permission: 'salescoach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['salescoach.call.ended'],
  async handler(ctx, input) {
    const c = await loadCoached(ctx.tx, ctx.scope.workspaceId!, input.coachedCallId);
    // Already ended (a retry): it stays as it was.
    if (c.state !== 'live') return { state: c.state };
    const heard = input.lines.some((l) => l.text.trim());
    const state = heard ? ('writing' as const) : ('failed' as const);
    // A Zoom meeting Zoom started on its own was claimed without a customer; the app may have named them since.
    const [named] =
      !c.personId && c.liveMeetingId
        ? await rows<{ person_id: string | null }>(
            ctx.tx,
            dbSql`select person_id from app.live_meetings where id = ${c.liveMeetingId}`,
          )
        : [];
    await ctx.tx
      .update(coachedCalls)
      .set({
        state,
        lines: input.lines,
        ...(named?.person_id ? { personId: named.person_id } : {}),
        endedAt: changeMoment(ctx.meta),
        ...(heard ? {} : { failure: 'Nothing was heard on this call, so there’s no write-up.' }),
      })
      .where(eq(coachedCalls.id, c.id));
    await ctx.emit({
      type: 'salescoach.call.ended',
      entityType: 'salescoach_call',
      entityId: c.id,
      payload: { callId: c.callId, userId: c.userId, heard },
    });
    return { state };
  },
});

/**
 * A write-up's place in core: its summary and notes on the customer's timeline, and a task for the rep for each thing
 * they promised, about the customer when it knew them. The task ids.
 */
async function landWriteUp(
  ctx: CommandContext,
  c: Row,
  result: AfterCall,
  eventId: string,
  kind: WriteUpKind,
): Promise<string[]> {
  const taskIds: string[] = [];
  if (c.personId) {
    const [rep] = c.userId
      ? await ctx.tx.select({ name: users.fullName }).from(users).where(eq(users.id, c.userId))
      : [];
    const first = rep?.name?.trim().split(/\s+/)[0] ?? null;
    const body = [
      result.summary,
      ...(result.notes.length ? ['', ...result.notes.map((n) => `• ${n}`)] : []),
    ].join('\n');
    await addonTimelineLine(ctx, salescoachAddon, {
      personId: c.personId,
      words: timelineWords(result, first, kind),
      body,
      eventId,
    });
  }
  for (const p of result.promises) {
    const made = await executeCommandWithin(ctx, taskCreate, {
      workspaceId: c.workspaceId,
      title: p.what.slice(0, 200),
      notes: {
        call: 'Promised on a coached call.',
        conversation: 'Promised in a coached conversation.',
        meeting: 'Promised on a coached Zoom call.',
      }[kind],
      dueAt: p.due ? `${p.due}T12:00:00.000Z` : null,
      allDay: true,
      assigneeUserId: c.userId,
      personId: c.personId,
    });
    taskIds.push(made.output.taskId);
  }
  return taskIds;
}

export const callFinish = defineAddonCommand(salescoachAddon, {
  name: 'salescoach.call.finish',
  description:
    'Worker: the write-up of a coached call (summary, notes, promises, follow-up, objections, score), or why there isn’t one. The notes go on the customer’s timeline and each promise becomes a task for the rep.',
  risk: 1,
  input: z.object({
    workspaceId: uuid,
    coachedCallId: uuid,
    result: AfterCall.nullable(),
    failure: z.string().max(300).nullable(),
  }),
  output: z.object({ state: z.enum(['done', 'failed']), taskIds: z.array(uuid) }),
  permission: 'salescoach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['salescoach.call.finished', 'task.created'],
  async handler(ctx, input) {
    const c = await loadCoached(ctx.tx, ctx.scope.workspaceId!, input.coachedCallId);
    // Finished already (a retry), stopped by the rep, or nothing heard: nothing more to write.
    if (c.state !== 'writing')
      return {
        state: c.state === 'done' ? ('done' as const) : ('failed' as const),
        taskIds: [] as string[],
      };
    const result = input.result;
    if (!result) {
      await ctx.tx
        .update(coachedCalls)
        .set({ state: 'failed', failure: input.failure ?? 'The write-up couldn’t be made.' })
        .where(eq(coachedCalls.id, c.id));
      await ctx.emit({
        type: 'salescoach.call.finished',
        entityType: 'salescoach_call',
        entityId: c.id,
        payload: { callId: c.callId, userId: c.userId, written: false },
      });
      return { state: 'failed' as const, taskIds: [] as string[] };
    }
    await ctx.tx
      .update(coachedCalls)
      .set({ state: 'done', result, failure: null })
      .where(eq(coachedCalls.id, c.id));
    const eventId = await ctx.emit({
      type: 'salescoach.call.finished',
      entityType: 'salescoach_call',
      entityId: c.id,
      payload: {
        callId: c.callId,
        userId: c.userId,
        written: true,
        score: result.score.total,
        promises: result.promises.length,
      },
    });
    const taskIds = await landWriteUp(
      ctx,
      c,
      result,
      eventId,
      c.liveMeetingId ? 'meeting' : 'call',
    );
    return { state: 'done' as const, taskIds };
  },
});

export const conversationFinish = defineAddonCommand(salescoachAddon, {
  name: 'salescoach.conversation.finish',
  description:
    'Worker: the write-up of a written conversation that went quiet (summary, notes, promises, follow-up, objections, score), through its newest message. The notes go on the customer’s timeline and each promise becomes a task for the rep. Once per stretch.',
  risk: 1,
  input: z.object({
    workspaceId: uuid,
    conversationId: uuid,
    throughMessageId: uuid,
    channel: z.enum(['sms', 'email', 'chat', 'portal', 'messenger', 'instagram']),
    userId: uuid,
    lines: z.array(CallLine).max(KEPT_LINES),
    result: AfterCall,
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime(),
  }),
  output: z.object({ coachedCallId: uuid.nullable(), taskIds: z.array(uuid) }),
  permission: 'salescoach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['salescoach.conversation.finished', 'task.created'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [conv] = await rows<{ person_id: string | null }>(
      ctx.tx,
      dbSql`select person_id from app.conversations where id = ${input.conversationId} and workspace_id = ${ws}`,
    );
    if (!conv)
      throw HfosError.notFound('That conversation isn’t there anymore, so it can’t be written up.');
    const [pb] = await ctx.tx
      .select({ id: playbooks.id, name: playbooks.name })
      .from(playbooks)
      .where(and(eq(playbooks.workspaceId, ws), isNull(playbooks.archivedAt)))
      .orderBy(desc(playbooks.isDefault), playbooks.createdAt)
      .limit(1);
    const [made] = await ctx.tx
      .insert(coachedCalls)
      .values({
        workspaceId: ws,
        conversationId: input.conversationId,
        throughMessageId: input.throughMessageId,
        channel: input.channel,
        userId: input.userId,
        personId: conv.person_id,
        playbookId: pb?.id ?? null,
        playbookName: pb?.name ?? null,
        state: 'done',
        lines: input.lines,
        result: input.result,
        startedAt: new Date(input.startedAt),
        endedAt: new Date(input.endedAt),
      })
      .onConflictDoNothing()
      .returning();
    // Written up already (a retry): nothing twice.
    if (!made) return { coachedCallId: null, taskIds: [] as string[] };
    const eventId = await ctx.emit({
      type: 'salescoach.conversation.finished',
      entityType: 'salescoach_call',
      entityId: made.id,
      payload: {
        conversationId: input.conversationId,
        userId: input.userId,
        score: input.result.score.total,
        promises: input.result.promises.length,
      },
    });
    const taskIds = await landWriteUp(ctx, made, input.result, eventId, 'conversation');
    return { coachedCallId: made.id, taskIds };
  },
});

// ---------- the rep's ----------

export const callStop = defineAddonCommand(salescoachAddon, {
  name: 'salescoach.call.stop',
  description:
    'Stop the coach on the call you’re on now: no more cards, and nothing from this call is kept or written up.',
  risk: 1,
  input: z.object({ workspaceId: uuid, coachedCallId: uuid }),
  output: z.object({ state: z.enum(COACHED_STATES) }),
  permission: 'salescoach.use',
  scope: inWorkspace,
  emits: ['salescoach.call.stopped'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const c = await loadCoached(ctx.tx, ctx.scope.workspaceId!, input.coachedCallId);
    if (c.userId !== me)
      throw HfosError.rule(
        'salescoach_not_your_call',
        403,
        'Only the person on the call can stop the coach on it.',
      );
    if (c.state !== 'live') return { state: c.state };
    // Row security lets the rep make this one change to their own live call, and no other.
    await ctx.tx
      .update(coachedCalls)
      .set({
        state: 'stopped',
        endedAt: changeMoment(ctx.meta),
        failure: 'You stopped the coach on this call, so nothing from it was kept.',
      })
      .where(eq(coachedCalls.id, c.id));
    await ctx.emit({
      type: 'salescoach.call.stopped',
      entityType: 'salescoach_call',
      entityId: c.id,
      payload: { callId: c.callId, userId: me },
    });
    return { state: 'stopped' as const };
  },
});

export const cardDismiss = defineAddonCommand(salescoachAddon, {
  name: 'salescoach.card.dismiss',
  description: 'Put away a card the coach showed you on a call.',
  risk: 0,
  input: z.object({ workspaceId: uuid, cardId: uuid }),
  output: z.object({ cardId: uuid }),
  permission: 'salescoach.use',
  scope: inWorkspace,
  emits: ['salescoach.card.dismissed'],
  async handler(ctx, input) {
    const [card] = await ctx.tx
      .update(cards)
      .set({ dismissedAt: changeMoment(ctx.meta) })
      .where(
        and(
          eq(cards.id, input.cardId),
          eq(cards.workspaceId, ctx.scope.workspaceId!),
          isNull(cards.dismissedAt),
        ),
      )
      .returning({ id: cards.id, coachedCallId: cards.coachedCallId });
    if (card)
      await ctx.emit({
        type: 'salescoach.card.dismissed',
        entityType: 'salescoach_call',
        entityId: card.coachedCallId,
        payload: { cardId: card.id },
      });
    return { cardId: input.cardId };
  },
});

const LiveOutput = z.object({
  call: z
    .object({
      id: uuid,
      callId: uuid.nullable(),
      liveMeetingId: uuid.nullable(),
      state: z.enum(COACHED_STATES),
      person: z.object({ id: uuid, name: z.string() }).nullable(),
      playbook: z.object({ name: z.string(), details: PlaybookDetails }).nullable(),
      /** The script step the call is at. */
      step: z.string().nullable(),
      startedAt: z.string(),
      cards: z.array(Card),
    })
    .nullable(),
});
export type CoachLive = z.infer<typeof LiveOutput>;

export const live = defineAddonQuery(salescoachAddon, {
  name: 'salescoach.live',
  description:
    'Your call the coach is listening to now, with its cards (newest first) and where it is in the script; or your last one for a few minutes after it ends.',
  input: z.object({ workspaceId: uuid }),
  output: LiveOutput,
  permission: 'salescoach.use',
  scope: inWorkspace,
  async handler(ctx) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const since = new Date(Date.now() - LIVE_FOR_MS);
    const [c] = await ctx.tx
      .select()
      .from(coachedCalls)
      .where(
        and(
          eq(coachedCalls.workspaceId, ws),
          eq(coachedCalls.userId, me),
          gt(coachedCalls.startedAt, since),
          sql`(${coachedCalls.state} = 'live' or ${coachedCalls.endedAt} > now() - interval '10 minutes')`,
        ),
      )
      .orderBy(desc(coachedCalls.startedAt))
      .limit(1);
    if (!c) return { call: null };
    const [pb] = c.playbookId
      ? await ctx.tx.select().from(playbooks).where(eq(playbooks.id, c.playbookId))
      : [];
    const shown = await ctx.tx
      .select()
      .from(cards)
      .where(and(eq(cards.coachedCallId, c.id), isNull(cards.dismissedAt)))
      .orderBy(desc(cards.createdAt))
      .limit(12);
    const [summary] = await summaries(ctx.tx, [c]);
    return {
      call: {
        id: c.id,
        callId: c.callId,
        liveMeetingId: c.liveMeetingId,
        state: c.state,
        person: summary?.person ?? null,
        playbook: pb ? { name: pb.name, details: PlaybookDetails.parse(pb.details) } : null,
        step: c.step,
        startedAt: c.startedAt.toISOString(),
        cards: shown.map(cardOut),
      },
    };
  },
});

export const callList = defineAddonQuery(salescoachAddon, {
  name: 'salescoach.call.list',
  description:
    'Coached calls, newest first, with the rep, the customer and the score: your own, or everyone’s for people who review calls.',
  input: z.object({
    workspaceId: uuid,
    /** Only this rep's. */
    userId: uuid.optional(),
    /** Only this customer's. */
    personId: uuid.optional(),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  output: z.object({ calls: z.array(CallSummary) }),
  permission: 'salescoach.use',
  scope: inWorkspace,
  ai: {
    tool: 'salescoach_list_calls',
    description:
      'Coached sales calls, newest first, with the rep, the customer and the score out of 100.',
  },
  async handler(ctx, input) {
    const found = await ctx.tx
      .select()
      .from(coachedCalls)
      .where(
        and(
          eq(coachedCalls.workspaceId, ctx.scope.workspaceId!),
          input.userId ? eq(coachedCalls.userId, input.userId) : undefined,
          input.personId ? eq(coachedCalls.personId, input.personId) : undefined,
        ),
      )
      .orderBy(desc(coachedCalls.startedAt))
      .limit(input.limit);
    return { calls: await summaries(ctx.tx, found) };
  },
});

export const callGet = defineAddonQuery(salescoachAddon, {
  name: 'salescoach.call.get',
  description:
    'One coached call: what was said, the cards the coach showed, and the write-up with its notes, promises, follow-up, objections, tips and score.',
  input: z.object({ workspaceId: uuid, coachedCallId: uuid }),
  output: z.object({
    call: CallSummary.extend({
      lines: z.array(CallLine),
      result: AfterCall.nullable(),
      failure: z.string().nullable(),
      cards: z.array(Card),
    }),
  }),
  permission: 'salescoach.use',
  scope: inWorkspace,
  ai: {
    tool: 'salescoach_get_call',
    description:
      'One coached sales call: its summary, notes, promises, follow-up, objections, tips and score.',
  },
  async handler(ctx, input) {
    const c = await loadCoached(ctx.tx, ctx.scope.workspaceId!, input.coachedCallId);
    const [summary] = await summaries(ctx.tx, [c]);
    // The rep's cards are theirs: a reviewer sees the write-up, not what the coach whispered.
    const shown = await ctx.tx
      .select()
      .from(cards)
      .where(eq(cards.coachedCallId, c.id))
      .orderBy(cards.createdAt);
    // A call's conversation is core's call's; a written conversation's write-up names its own.
    const [core] = c.callId
      ? await rows<{ conversation_id: string | null }>(
          ctx.tx,
          dbSql`select conversation_id from app.calls where id = ${c.callId}`,
        )
      : [{ conversation_id: c.conversationId }];
    return {
      call: {
        ...summary!,
        lines: c.lines,
        result: c.result,
        failure: c.failure,
        cards: shown.map(cardOut),
        conversationId: core?.conversation_id ?? null,
      },
    };
  },
});

export const callCommands = [
  callBegin,
  cardAdd,
  callEnd,
  callFinish,
  conversationFinish,
  cardDismiss,
  callStop,
] as const;
export const callQueries = [live, callList, callGet] as const;
