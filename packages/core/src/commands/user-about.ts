/**
 * About you (docs/outreach.md, decision 165): a person's own words about themselves, for the AI that writes as them
 * (app.user_about). Only they read or change it. The event and the audit row say that it changed, never what it says.
 */
import { eq } from 'drizzle-orm';
import { userAbout } from '@hfos/db/schema';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { UserAboutSetInput, UserAboutSetOutput } from '../schemas/user-about';

export const userAboutSet = defineCommand({
  name: 'user_about.set',
  description:
    'Set About you: what you say of yourself, in your own words (where you’re from, your heritage, family, faith, hobbies, teams, past jobs), for the AI that writes as you. Only you see it. Empty clears it.',
  risk: 1,
  input: UserAboutSetInput,
  output: UserAboutSetOutput,
  permission: null,
  scope: () => ({ kind: 'account' }),
  emits: ['user.about_updated'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const [current] = await ctx.tx
      .select({ about: userAbout.about })
      .from(userAbout)
      .where(eq(userAbout.userId, me))
      .for('update');
    const filled = input.about.length > 0;
    if ((current?.about ?? '') === input.about) return { filled, changed: false };
    if (!filled) await ctx.tx.delete(userAbout).where(eq(userAbout.userId, me));
    else if (current)
      await ctx.tx.update(userAbout).set({ about: input.about }).where(eq(userAbout.userId, me));
    else await ctx.tx.insert(userAbout).values({ userId: me, about: input.about });
    await ctx.emit({
      type: 'user.about_updated',
      entityType: 'user',
      entityId: me,
      organizationId: null,
      workspaceId: null,
      // That it changed, never the words: they're the person's alone.
      payload: { filled },
    });
    return { filled, changed: true };
  },
});
