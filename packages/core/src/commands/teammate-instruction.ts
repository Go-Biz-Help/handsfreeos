/**
 * The AI teammate's Instructions list (HANDSFREEOS_AI_FEEDBACK_IMPLEMENTATION_PLAN.md): rules it reads whole on
 * every reply, call and test, after its fixed rules. People who manage the AI teammate add, change and delete
 * them; saving a lesson (teammate_lesson.apply) adds one through `addInstruction`.
 */
import { and, asc, eq } from 'drizzle-orm';
import { teammateInstructions } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import { loadTeammate } from '../ai-team/load';
import { userNames } from '../calendar/load';
import {
  INSTRUCTIONS_MAX,
  TeammateInstructionCreateInput,
  TeammateInstructionDeleteInput,
  TeammateInstructionDeleteOutput,
  TeammateInstructionOutput,
  TeammateInstructionUpdateInput,
  type TeammateInstructionOut,
} from '../schemas/teammate-feedback';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** Spaces squashed and case aside, for telling a repeat. */
export const sameInstruction = (a: string, b: string): boolean =>
  a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();

const full = (name: string) =>
  HfosError.conflict(
    `${name} has ${INSTRUCTIONS_MAX} instructions, the most it keeps. Delete one it no longer needs under AI teammate → Instructions, then add this one.`,
    'instructions_full',
  );

const noTeammate = () =>
  HfosError.rule(
    'no_teammate',
    409,
    'This business has no AI teammate yet, so there’s nothing to give instructions to. Set one up under AI teammate first.',
  );

const gone = () =>
  HfosError.notFound(
    'That instruction isn’t there anymore. Someone may have deleted it. Refresh to see the list.',
  );

type Row = typeof teammateInstructions.$inferSelect;

/** One instruction as the screens show it. */
export function instructionOut(r: Row, byName: string | null): TeammateInstructionOut {
  return {
    id: r.id,
    body: r.body,
    source: r.source === 'lesson' ? 'lesson' : 'person',
    by: r.createdBy && byName ? { id: r.createdBy, name: byName } : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

async function nameOf(ctx: CommandContext, userId: string): Promise<string | null> {
  return (await userNames(ctx.tx, [userId])).get(userId) ?? null;
}

/**
 * Adds a line to the teammate's list, as the person, and says so. The same words already there are kept as they
 * are rather than added twice. Refuses a full list.
 */
export async function addInstruction(
  ctx: CommandContext,
  opts: {
    readonly teammateId: string;
    readonly teammateName: string;
    readonly body: string;
    readonly lessonId?: string | null;
  },
): Promise<{ row: Row; added: boolean }> {
  const me = requireHuman(ctx).userId;
  const ws = ctx.scope.workspaceId!;
  const list = await ctx.tx
    .select()
    .from(teammateInstructions)
    .where(
      and(
        eq(teammateInstructions.workspaceId, ws),
        eq(teammateInstructions.teammateId, opts.teammateId),
      ),
    )
    .orderBy(asc(teammateInstructions.createdAt));
  const body = opts.body.replace(/\s+/g, ' ').trim();
  const there = list.find((i) => sameInstruction(i.body, body));
  if (there) return { row: there, added: false };
  if (list.length >= INSTRUCTIONS_MAX) throw full(opts.teammateName);
  const [row] = await ctx.tx
    .insert(teammateInstructions)
    .values({
      workspaceId: ws,
      teammateId: opts.teammateId,
      body,
      source: opts.lessonId ? 'lesson' : 'person',
      lessonId: opts.lessonId ?? null,
      createdBy: me,
      updatedBy: me,
    })
    .returning();
  await ctx.emit({
    type: 'teammate_instruction.created',
    entityType: 'teammate_instruction',
    entityId: row!.id,
    payload: {
      instructionId: row!.id,
      teammateId: opts.teammateId,
      source: row!.source,
      lessonId: opts.lessonId ?? null,
    },
    after: { teammate: opts.teammateName, instruction: body },
  });
  return { row: row!, added: true };
}

export const teammateInstructionCreate = defineCommand({
  name: 'teammate_instruction.create',
  description:
    'Add an instruction to the AI teammate’s list, which it reads in full on every reply, call and test (after its fixed rules, which always win). At most 50.',
  risk: 2,
  input: TeammateInstructionCreateInput,
  output: TeammateInstructionOutput,
  permission: 'ai_team.manage',
  scope: inWorkspace,
  emits: ['teammate_instruction.created'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const teammate = await loadTeammate(ctx.tx, ctx.scope.workspaceId!);
    if (!teammate) throw noTeammate();
    const { row, added } = await addInstruction(ctx, {
      teammateId: teammate.id,
      teammateName: teammate.name,
      body: input.body,
    });
    if (!added)
      throw HfosError.conflict(
        `${teammate.name} already has that instruction, so there’s nothing to add.`,
        'instruction_exists',
      );
    return { instruction: instructionOut(row, await nameOf(ctx, me)) };
  },
});

async function requireInstruction(ctx: CommandContext, id: string): Promise<Row> {
  const [row] = await ctx.tx
    .select()
    .from(teammateInstructions)
    .where(
      and(
        eq(teammateInstructions.id, id),
        eq(teammateInstructions.workspaceId, ctx.scope.workspaceId!),
      ),
    )
    .for('update');
  if (!row) throw gone();
  return row;
}

export const teammateInstructionUpdate = defineCommand({
  name: 'teammate_instruction.update',
  description: 'Change the words of one of the AI teammate’s instructions.',
  risk: 2,
  input: TeammateInstructionUpdateInput,
  output: TeammateInstructionOutput,
  permission: 'ai_team.manage',
  scope: inWorkspace,
  emits: ['teammate_instruction.updated'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const before = await requireInstruction(ctx, input.instructionId);
    const body = input.body.replace(/\s+/g, ' ').trim();
    if (body === before.body)
      return {
        instruction: instructionOut(
          before,
          before.createdBy ? await nameOf(ctx, before.createdBy) : null,
        ),
      };
    const others = await ctx.tx
      .select({ id: teammateInstructions.id, body: teammateInstructions.body })
      .from(teammateInstructions)
      .where(eq(teammateInstructions.teammateId, before.teammateId));
    if (others.some((o) => o.id !== before.id && sameInstruction(o.body, body)))
      throw HfosError.conflict(
        'Another instruction already says that. Delete this one instead, or change its words.',
        'instruction_exists',
      );
    const [row] = await ctx.tx
      .update(teammateInstructions)
      .set({ body, updatedBy: me })
      .where(eq(teammateInstructions.id, before.id))
      .returning();
    await ctx.emit({
      type: 'teammate_instruction.updated',
      entityType: 'teammate_instruction',
      entityId: before.id,
      payload: { instructionId: before.id, teammateId: before.teammateId },
      before: { instruction: before.body },
      after: { instruction: body },
    });
    return {
      instruction: instructionOut(row!, row!.createdBy ? await nameOf(ctx, row!.createdBy) : null),
    };
  },
});

export const teammateInstructionDelete = defineCommand({
  name: 'teammate_instruction.delete',
  description:
    'Take one of the AI teammate’s instructions off its list. It stops following it from its next reply.',
  risk: 2,
  input: TeammateInstructionDeleteInput,
  output: TeammateInstructionDeleteOutput,
  permission: 'ai_team.manage',
  scope: inWorkspace,
  emits: ['teammate_instruction.deleted'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const before = await requireInstruction(ctx, input.instructionId);
    await ctx.tx.delete(teammateInstructions).where(eq(teammateInstructions.id, before.id));
    await ctx.emit({
      type: 'teammate_instruction.deleted',
      entityType: 'teammate_instruction',
      entityId: before.id,
      payload: { instructionId: before.id, teammateId: before.teammateId },
      before: { instruction: before.body },
    });
    return { instructionId: before.id };
  },
});
