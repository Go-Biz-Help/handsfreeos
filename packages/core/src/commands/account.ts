/**
 * A person's own account (M10): deleting it, and their OK for the Assistant.
 *
 * **Delete my account.** The person types their email to confirm. An organization that holds a single business and
 * whose last owner they are passes first to that business's other owners (account/ownership.ts), so a founder who made
 * a teammate an owner can go. A business or agency that would still be left without an owner is refused in plain
 * words naming each place and how to hand it over; the check is the database's own last-owner rule, tried on each of
 * their owner memberships and undone at once, and a refusal undoes the hand-over too. Otherwise the request is recorded
 * in every business the person can reach (`account.deletion_requested`, one each) and the worker's job finishes it
 * within moments: it takes them off each one's calendar teams and service staff lists through the calendars' own
 * commands, disconnects the mailboxes they connected, anonymizes the profile (private.anonymize_user, which also
 * removes their memberships, cells, devices, receipts and Assistant chats), ends every sign-in session and blocks
 * sign-in. What they worked on stays with each business, credited to "Former teammate". Someone who belongs to no
 * business has no business to record it in: their request queues the worker's job directly
 * (private.request_account_deletion), and is noted on their own account.
 *
 * **The Assistant's consent.** The OK is kept in the person's settings with the wording version and the time;
 * `account.me` says whether it is still needed, and the worker's Assistant route refuses without it.
 */
import { eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { users } from '@hfos/db/schema';
import {
  addOrganizationOwner,
  nothingOwnedAlone,
  onlyOwnerPlaces,
  onlyOwnerRefusal,
  soleBusinessHandOvers,
} from '../account/ownership';
import { ASSISTANT_CONSENT_KEY, assistantConsentOf } from '../assistant/consent';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { changeMoment } from '../kernel/moment';
import {
  AccountDeleteInput,
  AccountDeleteOutput,
  AccountNoteDeletedInput,
  AccountNoteDeletedOutput,
  AssistantConsentInput,
  AssistantConsentOutput,
} from '../schemas/user';

export const accountDelete = defineCommand({
  name: 'account.delete',
  description:
    'Delete your own account. Your sign-in and your name are removed and you are signed out everywhere; the customers, messages and jobs you worked on stay with each business, shown as from a former teammate. A business’s only owner makes someone else an owner first.',
  risk: 4,
  input: AccountDeleteInput,
  output: AccountDeleteOutput,
  permission: null,
  scope: () => ({ kind: 'account' }),
  emits: ['account.deletion_requested', 'organization.owner_added'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const [user] = await ctx.tx.select().from(users).where(eq(users.id, me));
    if (!user)
      throw HfosError.notFound(
        'We can’t find your account. Sign out, then sign back in and try again.',
      );
    if (user.deletedAt) return { userId: me, requestedAt: user.deletedAt.toISOString() };
    if (input.confirmEmail !== user.email.toLowerCase())
      throw HfosError.validation([
        {
          path: 'confirmEmail',
          message: 'Type your email address exactly as it is on your account.',
        },
      ]);
    // An organization of one business passes to the business's other owners first; a refusal below undoes it.
    const handOvers = await soleBusinessHandOvers(ctx.tx, me);
    const added: {
      handOver: (typeof handOvers)[number];
      to: (typeof handOvers)[number]['to'][number];
      previous: string;
    }[] = [];
    for (const h of handOvers)
      for (const to of h.to)
        added.push({
          handOver: h,
          to,
          previous: await addOrganizationOwner(ctx.tx, h.organizationId, to.userId),
        });
    const places = await onlyOwnerPlaces(ctx.tx, me);
    if (!nothingOwnedAlone(places)) throw onlyOwnerRefusal(places);
    for (const a of added) {
      if (a.previous === 'owner') continue;
      await ctx.emit({
        type: 'organization.owner_added',
        entityType: 'user',
        entityId: a.to.userId,
        organizationId: a.handOver.organizationId,
        workspaceId: a.handOver.workspaceId,
        payload: { userId: a.to.userId, from: a.previous, when: 'owner_left', leftBy: me },
        before: { role: a.previous },
        after: { role: 'owner', organization: a.handOver.name, leaving: true },
      });
    }
    // Every business the person can reach, directly or through an agency. The request is recorded in each (the
    // worker reads a business's events, and no business sees the others), and the worker's job takes them off each
    // one's calendars and mailboxes before the profile goes.
    const reach = await rows<{ id: string; organization_id: string }>(
      ctx.tx,
      // Only the ones they really work in: a support person can see every business's name (M13), and
      // deleting an account must touch theirs alone.
      sql`select id, organization_id from app.workspaces
          where private.effective_workspace_role(id) is not null order by id`,
    );
    const requestedAt = new Date();
    if (!reach.length) {
      // No business to record it in: the worker's job is queued for this person directly, and noted on their account.
      await rows(ctx.tx, sql`select private.request_account_deletion() as queued`);
      await ctx.emit({
        type: 'account.deletion_requested',
        entityType: 'user',
        entityId: me,
        organizationId: null,
        workspaceId: null,
        payload: { userId: me },
        after: { requested: true },
      });
      return { userId: me, requestedAt: requestedAt.toISOString() };
    }
    for (const w of reach)
      await ctx.emit({
        type: 'account.deletion_requested',
        entityType: 'user',
        entityId: me,
        organizationId: w.organization_id,
        workspaceId: w.id,
        payload: { userId: me },
        after: { requested: true },
      });
    return { userId: me, requestedAt: requestedAt.toISOString() };
  },
});

export const assistantConsent = defineCommand({
  name: 'assistant.consent',
  description:
    'Say OK to what the Assistant does with your questions: what you ask about is sent to an AI service to answer you. One OK covers the web and the phone.',
  risk: 1,
  input: AssistantConsentInput,
  output: AssistantConsentOutput,
  permission: null,
  scope: () => ({ kind: 'account' }),
  emits: ['assistant.consented'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const [user] = await ctx.tx
      .select({ settings: users.settings })
      .from(users)
      .where(eq(users.id, me));
    if (!user)
      throw HfosError.notFound(
        'We can’t find your account. Sign out, then sign back in and try again.',
      );
    const current = assistantConsentOf(user.settings);
    if (current.consentedVersion !== null && current.consentedVersion >= input.version)
      return {
        version: current.consentedVersion,
        consentedAt: current.consentedAt!,
        changed: false,
      };
    const at = changeMoment(ctx.meta).toISOString();
    const kept = { [ASSISTANT_CONSENT_KEY]: { version: input.version, at } };
    await ctx.tx
      .update(users)
      .set({ settings: sql`${users.settings} || ${JSON.stringify(kept)}::jsonb` })
      .where(eq(users.id, me));
    await ctx.emit({
      type: 'assistant.consented',
      entityType: 'user',
      entityId: me,
      organizationId: null,
      workspaceId: null,
      payload: { version: input.version },
      before: current.consentedVersion ? { version: current.consentedVersion } : null,
      after: { version: input.version },
    });
    return { version: input.version, consentedAt: at, changed: true };
  },
});

export const accountNoteDeleted = defineCommand({
  name: 'account.note_deleted',
  description:
    'Worker: someone deleted their account. Recorded in each business they were part of, so the team can see why they are gone.',
  risk: 0,
  input: AccountNoteDeletedInput,
  output: AccountNoteDeletedOutput,
  permission: 'workspace.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['account.deleted'],
  actors: ['system'],
  async handler(ctx, input) {
    await ctx.emit({
      type: 'account.deleted',
      entityType: 'user',
      entityId: input.userId,
      payload: { userId: input.userId },
    });
    return { userId: input.userId };
  },
});
