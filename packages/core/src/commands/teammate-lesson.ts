/**
 * Automations' "Learn from corrections": the card's one press. The line of guidance the worker made of corrections
 * to the AI teammate goes at the end of the business's policies in the knowledge profile, which the AI reads on
 * every reply, and the lesson is marked applied, which clears the card. A lesson that goes against what the AI
 * already knows waits for a person to say which is right: `replace` puts the new words in place of the old ones
 * (in the profile, or in the knowledge item that says otherwise), and dismissing the card keeps the old ones.
 */
import { and, eq } from 'drizzle-orm';
import { knowledgeItems, knowledgeProfiles, teammateLessons } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { LESSON_PLACE_NAMES, swapWords, type LessonConflict } from '../knowledge/lessons';
import { emptyKnowledgeProfile, KnowledgeProfile } from '../knowledge/profile';
import {
  LessonConflictSchema,
  TeammateLessonApplyInput,
  TeammateLessonApplyOutput,
} from '../schemas/teammate-lesson';

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

export const teammateLessonApply = defineCommand({
  name: 'teammate_lesson.apply',
  description:
    'Add the line of guidance made of corrections to the AI teammate to the business’s policies, which the AI reads on every reply. When it goes against what the AI already knows, say replace: true to put the new words in place of the old ones; dismissing it keeps them.',
  risk: 1,
  input: TeammateLessonApplyInput,
  output: TeammateLessonApplyOutput,
  permission: 'knowledge.manage',
  scope: (i) => ({ kind: 'workspace' as const, workspaceId: i.workspaceId }),
  emits: ['teammate_lesson.applied', 'knowledge.profile_updated', 'knowledge_item.updated'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const [lesson] = await ctx.tx
      .select()
      .from(teammateLessons)
      .where(and(eq(teammateLessons.id, input.lessonId), eq(teammateLessons.workspaceId, ws)))
      .for('update');
    if (!lesson)
      throw HfosError.notFound(
        'That suggestion isn’t there anymore. It may have been dealt with already. Refresh to see what’s left.',
      );
    if (lesson.status !== 'open')
      throw HfosError.conflict(
        lesson.status === 'applied'
          ? 'That’s already been added to what the AI knows, so there’s nothing more to do.'
          : 'Someone already turned that suggestion down, so there’s nothing more to do.',
        'lesson_decided',
      );
    const conflict = lessonConflictOf(lesson.conflict);
    // Two things the AI would read that say opposite things: a person picks, it never quietly keeps both.
    if (conflict && input.replace !== true)
      throw HfosError.conflict(
        `This goes against what the AI knows: ${lessonConflictWords(conflict)}. Use the new one to change it, or dismiss this to keep it.`,
        'lesson_conflict',
      );
    const line = input.line ?? lesson.line;
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
    let profile = before;
    const changed = new Set<keyof KnowledgeProfile>();
    let replaced: { where: string; before: string; after: string } | null = null;
    let addLine = true;

    // The old words give way to the new ones where they are. Words nobody's left there (someone changed them
    // since) no longer say otherwise, so the line is simply added.
    if (conflict?.place === 'item' && conflict.itemId) {
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
    } else if (conflict && conflict.place !== 'item') {
      const place = conflict.place;
      // In the policies the new line itself takes the old words' place.
      const put = place === 'policies' ? line : conflict.replacement;
      const next = swapWords(profile[place], conflict.existing, put);
      if (next !== null) {
        profile = { ...profile, [place]: next };
        if (next !== before[place]) changed.add(place);
        if (place === 'policies') addLine = false;
        replaced = { where: LESSON_PLACE_NAMES[place], before: conflict.existing, after: put };
      }
    }
    if (addLine) {
      const policies = withLesson(profile.policies, line);
      if (policies === null)
        throw HfosError.conflict(
          'Your policies are full, so this can’t be added. Shorten them under Policies in Knowledge → Business profile, then add it again.',
          'policies_full',
        );
      if (policies !== profile.policies) {
        profile = { ...profile, policies };
        changed.add('policies');
      }
    }
    if (!KnowledgeProfile.safeParse(profile).success)
      throw HfosError.conflict(
        `${replaced?.where ?? 'What the AI knows'} would be too long with the new words. Change it yourself in Knowledge → Business profile instead.`,
        'lesson_too_long',
      );
    if (changed.size) {
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
        payload: { fields: [...changed], allowPrices: profile.allowPrices },
        after: { changed: [...changed].join(', ') },
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
      payload: { lessonId: lesson.id, teammateId: lesson.teammateId, replaced: replaced !== null },
      ...(replaced ? { before: { [replaced.where]: replaced.before } } : {}),
      after: { line, ...(replaced ? { [replaced.where]: replaced.after } : {}) },
    });
    return { lessonId: lesson.id, line, replaced };
  },
});
