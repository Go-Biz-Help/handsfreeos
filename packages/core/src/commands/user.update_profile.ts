import { eq } from 'drizzle-orm';
import { users } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { canonicalJson } from '../kernel/receipts';
import { UserUpdateProfileInput, UserUpdateProfileOutput } from '../schemas/user';
import { requireHuman } from '../kernel/actor';

export const userUpdateProfile = defineCommand({
  name: 'user.update_profile',
  description:
    'Update your own name, photo or preferences. Each settings key is replaced whole; `expectedSettings` says what the caller last read, and a key that has changed since refuses the save (409 settings_changed).',
  risk: 1,
  input: UserUpdateProfileInput,
  output: UserUpdateProfileOutput,
  permission: null,
  scope: () => ({ kind: 'account' }),
  emits: ['user.profile_updated'],
  async handler(ctx, input) {
    // Locked until this saves: settings are written back whole, so two saves at once (the menu editor and the
    // Assistant) wait their turn, and each checks what it expected against what the other just saved.
    const [current] = await ctx.tx
      .select()
      .from(users)
      .where(eq(users.id, requireHuman(ctx).userId))
      .for('update');
    if (!current) throw HfosError.notFound('Profile not found.');
    for (const [key, expected] of Object.entries(input.expectedSettings ?? {}))
      if (canonicalJson(current.settings[key] ?? null) !== canonicalJson(expected ?? null))
        throw HfosError.conflict(
          'That was changed somewhere else in the meantime, so nothing was saved. Look at it again, then save.',
          'settings_changed',
        );
    const patch: {
      fullName?: string;
      avatarUrl?: string | null;
      settings?: Record<string, unknown>;
    } = {};
    if (input.fullName !== undefined && input.fullName !== current.fullName)
      patch.fullName = input.fullName;
    if (input.avatarUrl !== undefined && input.avatarUrl !== current.avatarUrl)
      patch.avatarUrl = input.avatarUrl;
    if (input.settings !== undefined) patch.settings = { ...current.settings, ...input.settings };
    const updated = Object.keys(patch);
    if (updated.length === 0) return { userId: current.id, updated: [] };
    await ctx.tx.update(users).set(patch).where(eq(users.id, current.id));
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const k of updated) {
      before[k] = (current as unknown as Record<string, unknown>)[k];
      after[k] = (patch as Record<string, unknown>)[k];
    }
    await ctx.emit({
      type: 'user.profile_updated',
      entityType: 'user',
      entityId: current.id,
      organizationId: null,
      workspaceId: null,
      payload: { fields: updated },
      before,
      after,
    });
    return { userId: current.id, updated };
  },
});
