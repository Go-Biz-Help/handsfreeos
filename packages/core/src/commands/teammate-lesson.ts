/**
 * Automations' "Repeated corrections": the card's one press. The line of guidance the worker made of repeated
 * corrections to the AI teammate goes at the end of the business's policies in the knowledge profile, which the AI
 * reads on every reply, and the lesson is marked applied, which clears the card.
 */
import { and, eq } from 'drizzle-orm';
import { knowledgeProfiles, teammateLessons } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { emptyKnowledgeProfile, KnowledgeProfile } from '../knowledge/profile';
import { TeammateLessonApplyInput, TeammateLessonApplyOutput } from '../schemas/teammate-lesson';

/** The policies field's own limit. */
const POLICIES_MAX = 3000;

/** The policies with one more line, or null when it would no longer fit. */
export function withLesson(policies: string, line: string): string | null {
  const clean = line.replace(/\s+/g, ' ').trim();
  const lines = policies.split('\n').map((l) => l.trim());
  if (lines.some((l) => l.replace(/^[-•]\s*/, '') === clean)) return policies;
  const next = policies.trim() ? `${policies.trimEnd()}\n${clean}` : clean;
  return next.length > POLICIES_MAX ? null : next;
}

export const teammateLessonApply = defineCommand({
  name: 'teammate_lesson.apply',
  description:
    'Add the line of guidance made of repeated corrections to the AI teammate to the business’s policies, which the AI reads on every reply.',
  risk: 1,
  input: TeammateLessonApplyInput,
  output: TeammateLessonApplyOutput,
  permission: 'knowledge.manage',
  scope: (i) => ({ kind: 'workspace' as const, workspaceId: i.workspaceId }),
  emits: ['teammate_lesson.applied', 'knowledge.profile_updated'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const [lesson] = await ctx.tx
      .select()
      .from(teammateLessons)
      .where(and(eq(teammateLessons.id, input.lessonId), eq(teammateLessons.workspaceId, ws)))
      .for('update');
    if (!lesson) throw HfosError.notFound('That suggestion is gone.');
    if (lesson.status !== 'open')
      throw HfosError.conflict(
        lesson.status === 'applied' ? 'It’s already been added.' : 'It was turned down.',
        'lesson_decided',
      );
    const line = input.line ?? lesson.line;
    const [current] = await ctx.tx
      .select()
      .from(knowledgeProfiles)
      .where(eq(knowledgeProfiles.workspaceId, ws))
      .for('update');
    const stored = current ? KnowledgeProfile.safeParse(current.profile) : null;
    const profile: KnowledgeProfile = {
      ...(stored?.success ? stored.data : emptyKnowledgeProfile()),
      allowPrices: current?.allowPrices ?? false,
    };
    const policies = withLesson(profile.policies, line);
    if (policies === null)
      throw HfosError.conflict(
        'Your policies are full. Make room in what the AI knows, then add it.',
        'policies_full',
      );
    if (policies !== profile.policies) {
      const values = {
        profile: { ...profile, policies } as unknown as Record<string, unknown>,
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
        payload: { fields: ['policies'], allowPrices: profile.allowPrices },
        after: { changed: 'policies' },
      });
    }
    await ctx.tx
      .update(teammateLessons)
      .set({ status: 'applied', decidedBy: me, decidedAt: new Date() })
      .where(eq(teammateLessons.id, lesson.id));
    await ctx.emit({
      type: 'teammate_lesson.applied',
      entityType: 'lesson',
      entityId: lesson.id,
      payload: { lessonId: lesson.id, teammateId: lesson.teammateId },
      after: { line },
    });
    return { lessonId: lesson.id, line };
  },
});
