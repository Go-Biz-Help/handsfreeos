/**
 * Automations' "Learn from corrections", and feedback on the AI teammate's replies: saving the line of guidance the
 * worker made of a correction. It goes on the teammate's Instructions list, which the AI reads in full on every
 * reply (HANDSFREEOS_AI_FEEDBACK_IMPLEMENTATION_PLAN.md), and the lesson is marked applied, which clears the card.
 * A lesson that goes against what the AI already knows waits for a person to say which is right: `replace` puts
 * the new words in place of the old ones (in the profile, a knowledge item or another instruction), and dismissing
 * it keeps the old ones.
 */
import { and, eq } from 'drizzle-orm';
import {
  knowledgeItems,
  knowledgeProfiles,
  teammateInstructions,
  teammateLessons,
} from '@hfos/db/schema';
import { requireTeammate } from '../ai-team/load';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { scopeCan } from '../kernel/execute';
import { LESSON_PLACE_NAMES, swapWords, type LessonConflict } from '../knowledge/lessons';
import { emptyKnowledgeProfile, KnowledgeProfile } from '../knowledge/profile';
import {
  LessonConflictSchema,
  TeammateLessonApplyInput,
  TeammateLessonApplyOutput,
  TeammateLessonDismissInput,
  TeammateLessonDismissOutput,
} from '../schemas/teammate-lesson';
import { addInstruction } from './teammate-instruction';

/** The same words, spaces and case aside. */
const sameWords = (a: string, b: string): boolean =>
  a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();

/** A lesson's stored conflict, or null when it has none (or it doesn't read). */
export function lessonConflictOf(value: unknown): LessonConflict | null {
  if (!value) return null;
  const parsed = LessonConflictSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** "Hours says “Open 7 days a week”", for asking which is right. */
export function lessonConflictWords(c: Pick<LessonConflict, 'where' | 'existing'>): string {
  return `${c.where} says “${c.existing}”`;
}

const lessonGone = () =>
  HfosError.notFound(
    'That suggestion isn’t there anymore. It may have been dealt with already. Refresh to see what’s left.',
  );

const lessonDecided = (status: string) =>
  HfosError.conflict(
    status === 'applied'
      ? 'That’s already been added to the AI teammate’s instructions, so there’s nothing more to do.'
      : 'Someone already turned that suggestion down, so there’s nothing more to do.',
    'lesson_decided',
  );

export const teammateLessonApply = defineCommand({
  name: 'teammate_lesson.apply',
  description:
    'Save the line of guidance made of a correction or feedback to the AI teammate’s Instructions list, which it reads on every reply. When it goes against what the AI already knows, say replace: true to put the new words in place of the old ones; dismissing it keeps them.',
  risk: 1,
  input: TeammateLessonApplyInput,
  output: TeammateLessonApplyOutput,
  permission: 'ai_team.manage',
  scope: (i) => ({ kind: 'workspace' as const, workspaceId: i.workspaceId }),
  emits: [
    'teammate_lesson.applied',
    'teammate_instruction.created',
    'teammate_instruction.updated',
    'teammate_instruction.deleted',
    'knowledge.profile_updated',
    'knowledge_item.updated',
  ],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const [lesson] = await ctx.tx
      .select()
      .from(teammateLessons)
      .where(and(eq(teammateLessons.id, input.lessonId), eq(teammateLessons.workspaceId, ws)))
      .for('update');
    if (!lesson) throw lessonGone();
    if (lesson.status !== 'open') throw lessonDecided(lesson.status);
    const conflict = lessonConflictOf(lesson.conflict);
    // Two things the AI would read that say opposite things: a person picks, it never quietly keeps both.
    if (conflict && input.replace !== true)
      throw HfosError.conflict(
        `This goes against what the AI knows: ${lessonConflictWords(conflict)}. Use the new one to change it, or dismiss this to keep it.`,
        'lesson_conflict',
      );
    if (conflict && conflict.place !== 'instruction' && !scopeCan(ctx.scope, 'knowledge.manage'))
      throw HfosError.forbidden(
        `Saving this changes ${conflict.where} in what the AI knows, which only people who manage the knowledge base can do. Ask an owner or admin to save it.`,
        'needs_knowledge_manage',
      );
    const teammate = await requireTeammate(ctx.tx, ws, lesson.teammateId);
    const line = (input.line ?? lesson.line).replace(/\s+/g, ' ').trim();
    let replaced: { where: string; before: string; after: string } | null = null;

    // The old words give way to the new ones where they are. Words nobody's left there (someone changed them
    // since) no longer say otherwise, so the line is simply added.
    if (conflict?.place === 'instruction' && conflict.itemId) {
      const [other] = await ctx.tx
        .select()
        .from(teammateInstructions)
        .where(
          and(
            eq(teammateInstructions.id, conflict.itemId),
            eq(teammateInstructions.workspaceId, ws),
          ),
        )
        .for('update');
      // The new line says it now: the old one keeps whatever else it said, or goes.
      const body = other ? swapWords(other.body, conflict.existing, '') : null;
      if (other && body !== null) {
        if (body.trim()) {
          await ctx.tx
            .update(teammateInstructions)
            .set({ body: body.slice(0, 300), updatedBy: me })
            .where(eq(teammateInstructions.id, other.id));
          await ctx.emit({
            type: 'teammate_instruction.updated',
            entityType: 'teammate_instruction',
            entityId: other.id,
            payload: { instructionId: other.id, teammateId: other.teammateId },
            before: { instruction: other.body },
            after: { instruction: body },
          });
        } else {
          await ctx.tx.delete(teammateInstructions).where(eq(teammateInstructions.id, other.id));
          await ctx.emit({
            type: 'teammate_instruction.deleted',
            entityType: 'teammate_instruction',
            entityId: other.id,
            payload: { instructionId: other.id, teammateId: other.teammateId },
            before: { instruction: other.body },
          });
        }
        replaced = { where: 'An instruction', before: conflict.existing, after: line };
      }
    } else if (conflict?.place === 'item' && conflict.itemId) {
      const [item] = await ctx.tx
        .select()
        .from(knowledgeItems)
        .where(and(eq(knowledgeItems.id, conflict.itemId), eq(knowledgeItems.workspaceId, ws)))
        .for('update');
      const body = item ? swapWords(item.body, conflict.existing, conflict.replacement) : null;
      if (item && body !== null && body !== item.body) {
        await ctx.tx
          .update(knowledgeItems)
          .set({ body, updatedBy: me })
          .where(eq(knowledgeItems.id, item.id));
        await ctx.emit({
          type: 'knowledge_item.updated',
          entityType: 'knowledge_item',
          entityId: item.id,
          payload: { itemId: item.id, fields: ['body'] },
          before: { title: item.title },
          after: { title: item.title },
        });
        replaced = { where: item.title, before: conflict.existing, after: conflict.replacement };
      }
    } else if (conflict && conflict.place !== 'item' && conflict.place !== 'instruction') {
      const place = conflict.place;
      const [current] = await ctx.tx
        .select()
        .from(knowledgeProfiles)
        .where(eq(knowledgeProfiles.workspaceId, ws))
        .for('update');
      const stored = current ? KnowledgeProfile.safeParse(current.profile) : null;
      const before: KnowledgeProfile = {
        ...(stored?.success ? stored.data : emptyKnowledgeProfile()),
        allowPrices: current?.allowPrices ?? false,
      };
      // Lessons read before the Instructions list put the line itself in the policies; it's on the list now.
      const put =
        place === 'policies' && sameWords(conflict.replacement, line) ? '' : conflict.replacement;
      const next = swapWords(before[place], conflict.existing, put);
      if (next !== null && next !== before[place]) {
        const profile = { ...before, [place]: next };
        if (!KnowledgeProfile.safeParse(profile).success)
          throw HfosError.conflict(
            `${LESSON_PLACE_NAMES[place]} would be too long with the new words. Change it yourself in Knowledge → Business profile instead.`,
            'lesson_too_long',
          );
        const values = {
          profile: profile as unknown as Record<string, unknown>,
          allowPrices: profile.allowPrices,
          updatedBy: me,
        };
        await ctx.tx
          .insert(knowledgeProfiles)
          .values({ workspaceId: ws, ...values })
          .onConflictDoUpdate({ target: knowledgeProfiles.workspaceId, set: values });
        await ctx.emit({
          type: 'knowledge.profile_updated',
          entityType: 'knowledge_profile',
          entityId: ws,
          payload: { fields: [place], allowPrices: profile.allowPrices },
          after: { changed: place },
        });
        replaced = { where: LESSON_PLACE_NAMES[place], before: conflict.existing, after: put };
      }
    }
    const { row } = await addInstruction(ctx, {
      teammateId: teammate.id,
      teammateName: teammate.name,
      body: line,
      lessonId: lesson.id,
    });
    await ctx.tx
      .update(teammateLessons)
      .set({ status: 'applied', decidedBy: me, decidedAt: new Date() })
      .where(eq(teammateLessons.id, lesson.id));
    await ctx.emit({
      type: 'teammate_lesson.applied',
      entityType: 'lesson',
      entityId: lesson.id,
      payload: {
        lessonId: lesson.id,
        teammateId: lesson.teammateId,
        instructionId: row.id,
        replaced: replaced !== null,
      },
      ...(replaced ? { before: { [replaced.where]: replaced.before } } : {}),
      after: { line, ...(replaced ? { [replaced.where]: replaced.after } : {}) },
    });
    return { lessonId: lesson.id, line, instructionId: row.id, replaced };
  },
});

export const teammateLessonDismiss = defineCommand({
  name: 'teammate_lesson.dismiss',
  description:
    'Turn down a line of guidance the AI suggested from a correction or feedback. Nothing changes in what the AI knows.',
  risk: 1,
  input: TeammateLessonDismissInput,
  output: TeammateLessonDismissOutput,
  permission: 'ai_team.manage',
  scope: (i) => ({ kind: 'workspace' as const, workspaceId: i.workspaceId }),
  emits: ['teammate_lesson.dismissed'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const [lesson] = await ctx.tx
      .select()
      .from(teammateLessons)
      .where(and(eq(teammateLessons.id, input.lessonId), eq(teammateLessons.workspaceId, ws)))
      .for('update');
    if (!lesson) throw lessonGone();
    if (lesson.status !== 'open') throw lessonDecided(lesson.status);
    await ctx.tx
      .update(teammateLessons)
      .set({ status: 'dismissed', decidedBy: me, decidedAt: new Date() })
      .where(eq(teammateLessons.id, lesson.id));
    await ctx.emit({
      type: 'teammate_lesson.dismissed',
      entityType: 'lesson',
      entityId: lesson.id,
      payload: { lessonId: lesson.id, teammateId: lesson.teammateId },
      after: { line: lesson.line },
    });
    return { lessonId: lesson.id };
  },
});
