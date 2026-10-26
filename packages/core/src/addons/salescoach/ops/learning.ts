/**
 * Learning from wins (round four, docs/salescoach.md): the worker notes which coached calls and conversations ended in
 * a win (`salescoach.win.note`) and keeps what it learned as lessons (`salescoach.lessons.put`); owners and admins
 * (`salescoach.manage`) read them (`salescoach.lesson.list`) and use or dismiss each (`salescoach.lesson.decide`).
 * Using one changes the playbook: a better answer replaces the objection's, a new objection is added.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { rows, sql as dbSql } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { userIdOf } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { LESSON_KINDS, WIN_KINDS, WIN_WINDOW_MS } from '../learn';
import { salescoachAddon } from '../manifest';
import { PLAYBOOK_LIMITS, PlaybookDetails, renumberPlaybook } from '../playbooks';
import { lessons, playbooks } from '../tables';
import { inWorkspace } from './playbooks';

const uuid = z.uuid();
/** A lesson someone said no to isn't suggested again for this long. */
const DISMISSED_FOR_DAYS = 30;

export const winNote = defineAddonCommand(salescoachAddon, {
  name: 'salescoach.win.note',
  description:
    'Worker: a customer booked a job, accepted an estimate, paid or won a deal. Their coached calls and conversations from the week before are marked won.',
  risk: 0,
  input: z.object({
    workspaceId: uuid,
    personIds: z.array(uuid).min(1).max(20),
    how: z.enum(WIN_KINDS),
    at: z.iso.datetime(),
  }),
  output: z.object({ marked: z.number().int() }),
  permission: 'salescoach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['salescoach.win.noted'],
  async handler(ctx, input) {
    const at = new Date(input.at);
    const since = new Date(at.getTime() - WIN_WINDOW_MS);
    const marked = await rows<{ id: string }>(
      ctx.tx,
      dbSql`update addon_salescoach.calls set won_at = ${at.toISOString()}::timestamptz, won_how = ${input.how}
            where workspace_id = ${ctx.scope.workspaceId!} and state = 'done' and won_at is null
              and person_id = any (${`{${input.personIds.join(',')}}`}::uuid[])
              and coalesce(ended_at, started_at) between ${since.toISOString()}::timestamptz and ${at.toISOString()}::timestamptz
            returning id`,
    );
    if (marked.length)
      await ctx.emit({
        type: 'salescoach.win.noted',
        entityType: 'salescoach_call',
        payload: { how: input.how, coached: marked.map((m) => m.id) },
      });
    return { marked: marked.length };
  },
});

const LessonIn = z.object({
  kind: z.enum(LESSON_KINDS),
  objectionId: z
    .string()
    .regex(/^o[0-9]{1,3}$/)
    .nullable(),
  objection: z.string().trim().min(1).max(PLAYBOOK_LIMITS.objection),
  answer: z.string().trim().min(1).max(PLAYBOOK_LIMITS.answer),
  wins: z.number().int().min(0),
  of: z.number().int().min(0),
  evidence: z.array(uuid).max(200),
});

export const lessonsPut = defineAddonCommand(salescoachAddon, {
  name: 'salescoach.lessons.put',
  description:
    'Worker: what the coach learned from wins for a playbook. Each replaces the open one for the same objection; one dismissed lately isn’t suggested again.',
  risk: 0,
  input: z.object({ workspaceId: uuid, playbookId: uuid, lessons: z.array(LessonIn).max(50) }),
  output: z.object({ kept: z.number().int() }),
  permission: 'salescoach.manage',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['salescoach.lessons.found'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    let kept = 0;
    for (const l of input.lessons) {
      const same =
        l.kind === 'better_answer'
          ? dbSql`objection_id = ${l.objectionId}`
          : dbSql`kind = 'new_objection' and lower(btrim(objection)) = lower(btrim(${l.objection}))`;
      const [recent] = await rows<{ id: string }>(
        ctx.tx,
        dbSql`select id from addon_salescoach.lessons
              where workspace_id = ${ws} and playbook_id = ${input.playbookId} and state = 'dismissed'
                and decided_at > now() - make_interval(days => ${DISMISSED_FOR_DAYS}) and ${same}
              limit 1`,
      );
      if (recent) continue;
      await rows(
        ctx.tx,
        dbSql`delete from addon_salescoach.lessons
              where workspace_id = ${ws} and playbook_id = ${input.playbookId} and state = 'open' and ${same}`,
      );
      await ctx.tx.insert(lessons).values({
        workspaceId: ws,
        playbookId: input.playbookId,
        kind: l.kind,
        objectionId: l.objectionId,
        objection: l.objection,
        answer: l.answer,
        wins: l.wins,
        ofCount: Math.max(l.of, l.wins),
        evidence: l.evidence,
      });
      kept++;
    }
    if (kept)
      await ctx.emit({
        type: 'salescoach.lessons.found',
        entityType: 'salescoach_playbook',
        entityId: input.playbookId,
        payload: { lessons: kept },
      });
    return { kept };
  },
});

const LessonOut = z.object({
  id: uuid,
  playbookId: uuid,
  playbookName: z.string(),
  kind: z.enum(LESSON_KINDS),
  objectionId: z.string().nullable(),
  objection: z.string(),
  /** What the playbook says now, for a better answer. */
  current: z.string().nullable(),
  answer: z.string(),
  wins: z.number().int(),
  of: z.number().int(),
  createdAt: z.string(),
});
export type LessonOut = z.infer<typeof LessonOut>;

export const lessonList = defineAddonQuery(salescoachAddon, {
  name: 'salescoach.lesson.list',
  description:
    'What the coach learned from wins, waiting for an owner or admin: better answers to the playbooks’ objections, and objections to add.',
  input: z.object({ workspaceId: uuid }),
  output: z.object({ lessons: z.array(LessonOut) }),
  permission: 'salescoach.manage',
  ai: { tool: 'salescoach_lesson_list' },
  scope: inWorkspace,
  async handler(ctx) {
    const found = await ctx.tx
      .select({ l: lessons, p: playbooks })
      .from(lessons)
      .innerJoin(playbooks, eq(playbooks.id, lessons.playbookId))
      .where(
        and(
          eq(lessons.workspaceId, ctx.scope.workspaceId!),
          eq(lessons.state, 'open'),
          sql`${playbooks.archivedAt} is null`,
        ),
      )
      .orderBy(desc(lessons.wins), desc(lessons.createdAt));
    return {
      lessons: found.map(({ l, p }) => {
        const details = PlaybookDetails.safeParse(p.details);
        const current =
          l.objectionId && details.success
            ? (details.data.objections.find((o) => o.id === l.objectionId)?.answer ?? null)
            : null;
        return {
          id: l.id,
          playbookId: p.id,
          playbookName: p.name,
          kind: l.kind,
          objectionId: l.objectionId,
          objection: l.objection,
          current,
          answer: l.answer,
          wins: l.wins,
          of: l.ofCount,
          createdAt: l.createdAt.toISOString(),
        };
      }),
    };
  },
});

export const lessonDecide = defineAddonCommand(salescoachAddon, {
  name: 'salescoach.lesson.decide',
  description:
    'Use a lesson the coach learned from wins, which changes the playbook (a better answer replaces the objection’s, a new objection is added), or dismiss it.',
  risk: 1,
  input: z.object({ workspaceId: uuid, lessonId: uuid, use: z.boolean() }),
  output: z.object({ state: z.enum(['used', 'dismissed']) }),
  permission: 'salescoach.manage',
  ai: { tool: 'salescoach_lesson_decide', autonomy: 'confirm' },
  scope: inWorkspace,
  emits: ['salescoach.lesson.decided', 'salescoach.playbook.saved'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [l] = await ctx.tx
      .select()
      .from(lessons)
      .where(and(eq(lessons.id, input.lessonId), eq(lessons.workspaceId, ws)));
    if (!l || l.state !== 'open')
      throw HfosError.notFound(
        'That suggestion isn’t waiting anymore: someone may have used or dismissed it. Refresh the page.',
      );
    const me = userIdOf(ctx.actor);
    const at = changeMoment(ctx.meta);
    if (input.use) {
      const [p] = await ctx.tx.select().from(playbooks).where(eq(playbooks.id, l.playbookId));
      if (!p || p.archivedAt)
        throw HfosError.rule(
          'salescoach_playbook_archived',
          409,
          'That playbook is archived. Bring it back under Playbooks first, then use the suggestion.',
        );
      const d = PlaybookDetails.parse(p.details);
      let next: PlaybookDetails;
      if (l.kind === 'better_answer') {
        if (!d.objections.some((o) => o.id === l.objectionId))
          throw HfosError.rule(
            'salescoach_lesson_stale',
            409,
            `“${l.objection}” isn’t in “${p.name}” anymore, so there’s nothing to change. Dismiss this suggestion.`,
          );
        next = {
          ...d,
          objections: d.objections.map((o) =>
            o.id === l.objectionId ? { ...o, answer: l.answer } : o,
          ),
        };
      } else {
        if (d.objections.length >= PLAYBOOK_LIMITS.objections)
          throw HfosError.rule(
            'salescoach_playbook_full',
            409,
            `“${p.name}” already has ${PLAYBOOK_LIMITS.objections} objections. Remove one under Playbooks, then use this.`,
          );
        next = renumberPlaybook({
          ...d,
          objections: [...d.objections, { id: 'o1', objection: l.objection, answer: l.answer }],
        });
      }
      await ctx.tx
        .update(playbooks)
        .set({ details: next, updatedBy: me, updatedAt: at })
        .where(eq(playbooks.id, p.id));
      await ctx.emit({
        type: 'salescoach.playbook.saved',
        entityType: 'salescoach_playbook',
        entityId: p.id,
        payload: { name: p.name, created: false, fromLesson: l.id },
      });
    }
    const state = input.use ? ('used' as const) : ('dismissed' as const);
    await ctx.tx
      .update(lessons)
      .set({ state, decidedBy: me, decidedAt: at })
      .where(eq(lessons.id, l.id));
    await ctx.emit({
      type: 'salescoach.lesson.decided',
      entityType: 'salescoach_playbook',
      entityId: l.playbookId,
      payload: { lessonId: l.id, kind: l.kind, used: input.use },
    });
    return { state };
  },
});

export const learningCommands = [winNote, lessonsPut, lessonDecide] as const;
export const learningQueries = [lessonList] as const;
