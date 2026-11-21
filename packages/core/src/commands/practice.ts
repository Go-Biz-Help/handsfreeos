/**
 * Practice businesses (Admin → Try onboarding, 20261027027400). A HandsFreeOS admin goes through an onboarding as a
 * brand-new customer would, in a real business made for it, and nothing in it is kept:
 *
 * - `practice.start`: the practice sign-up's first screen makes the organization and its business, owned by the admin
 *   and marked as practice, the way `organization.create` makes a new customer's. Nobody is credited for it. Its other
 *   onboardings (20261027027500) make one ready (its plan on), an agency's client, or one the admin is invited into.
 * - `practice.pay`: the stand-in checkout. The plan goes on the business with no spot held and no card kept.
 * - `practice.end`: deleting it, as an owner does, without typing its name, by whoever practises it; the worker takes
 *   it and its organization out (apps/worker/src/workspace/delete.ts, practice/jobs.ts). At its time the worker does
 *   the same on its own.
 *
 * Everything that would reach the outside world from one is pretended by the worker (apps/worker/src/practice/).
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { PRACTICE_HOURS } from '../practice/words';
import {
  PracticeEndInput,
  PracticeEndOutput,
  PracticePayInput,
  PracticePayOutput,
  PracticeStartInput,
  PracticeStartOutput,
} from '../schemas/practice';
import { slugify } from '../slug';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

const notPractice = () =>
  HfosError.rule(
    'practice_only',
    409,
    'That only works in a practice business. Real businesses pay and end through Settings → Billing & Usage.',
  );

export const practiceStart = defineCommand({
  name: 'practice.start',
  description:
    'Admin → Try onboarding: make a practice business to go through an onboarding as a new customer would: yours, an agency’s client you set up for its owner, or one you’re invited to join. Nothing in it leaves HandsFreeOS, and it is deleted when you end it or after 24 hours.',
  risk: 1,
  input: PracticeStartInput,
  output: PracticeStartOutput,
  permission: 'platform.practice.use',
  scope: () => ({ kind: 'platform' as const }),
  emits: ['organization.created', 'workspace.created', 'invitation.created'],
  async handler(ctx, input) {
    // An agency's client is under the agency, named for it; anything else is under a namesake, as a new customer's is.
    const orgName =
      input.as === 'agency' && input.agencyName ? input.agencyName : input.businessName;
    const suffix = randomUUID().slice(0, 6);
    const orgSlug = `${slugify(orgName)}-${suffix}`;
    const wsSlug = `${slugify(input.businessName)}-${suffix}`;
    const [row] = await rows<{ org_id: string; ws_id: string; invitation_id: string | null }>(
      ctx.tx,
      sql`select * from private.start_practice_as(${orgName}, ${orgSlug}, ${input.businessName}, ${wsSlug},
            ${input.timezone}, ${input.industry}, ${PRACTICE_HOURS}::integer, ${input.as},
            ${input.role}::app.member_role, ${input.ready})`,
    );
    if (!row)
      throw HfosError.internal(
        'The practice business couldn’t be made just now. Try again in a minute.',
      );
    const [made] = await rows<{ ends_at: Date | string; email: string | null }>(
      ctx.tx,
      sql`select o.practice_ends_at as ends_at, (select u.email::text from app.users u where u.id = o.practice_by) as email
          from app.organizations o where o.id = ${row.org_id}::uuid`,
    );
    // The same events a new customer's sign-up records, in the practice organization: what hears them runs with the
    // practice stand-ins, and they go with it.
    await ctx.emit({
      type: 'organization.created',
      entityType: 'organization',
      entityId: row.org_id,
      organizationId: row.org_id,
      workspaceId: null,
      payload: { name: orgName, slug: orgSlug, practice: true },
      after: { name: orgName, slug: orgSlug },
    });
    await ctx.emit({
      type: 'workspace.created',
      entityType: 'workspace',
      entityId: row.ws_id,
      organizationId: row.org_id,
      workspaceId: row.ws_id,
      payload: {
        name: input.businessName,
        slug: wsSlug,
        timezone: input.timezone,
        industry: input.industry,
        practice: true,
      },
      after: {
        name: input.businessName,
        slug: wsSlug,
        timezone: input.timezone,
        industry: input.industry,
      },
    });
    // As membership.invite records one: the worker makes the link and emails it to you, marked [Practice]. Then you're
    // out of it, to join it from the invitation as a new teammate does.
    if (row.invitation_id) {
      await ctx.emit({
        type: 'invitation.created',
        entityType: 'invitation',
        entityId: row.invitation_id,
        organizationId: row.org_id,
        workspaceId: row.ws_id,
        payload: {
          email: made?.email ?? '',
          role: input.role,
          invitedBy: requireHuman(ctx).userId,
        },
        after: { email: made?.email ?? '', role: input.role },
      });
      await ctx.tx.execute(sql`select private.practice_step_out(${row.ws_id}::uuid)`);
    }
    return {
      organizationId: row.org_id,
      workspaceId: row.ws_id,
      endsAt: new Date(made?.ends_at ?? Date.now()).toISOString(),
      invitationId: row.invitation_id,
    };
  },
});

export const practicePay = defineCommand({
  name: 'practice.pay',
  description:
    'In a practice business only: the stand-in for paying for a founding spot. The plan picked goes on the business, with its free trial; no card is charged and no spot is used.',
  risk: 1,
  input: PracticePayInput,
  output: PracticePayOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const [row] = await rows<{ plan: 'founding_free' | 'founding_lifetime' | 'monthly' }>(
      ctx.tx,
      sql`select private.practice_pay(${input.workspaceId}::uuid, ${input.offerId}, ${input.trialDays}::integer) as plan`,
    );
    if (!row) throw notPractice();
    return { workspaceId: input.workspaceId, plan: row.plan };
  },
});

export const practiceEnd = defineCommand({
  name: 'practice.end',
  description:
    'End a practice business: it and everything in it are deleted for good, as Delete business does, without typing its name. Only a practice business can be ended this way.',
  risk: 2,
  input: PracticeEndInput,
  output: PracticeEndOutput,
  // Whoever practises it ends it, whatever role they hold in it (a teammate who joined from an invitation holds none
  // that deletes): private.end_practice checks it's theirs.
  permission: 'platform.practice.use',
  scope: () => ({ kind: 'platform' as const }),
  emits: ['workspace.deletion_requested'],
  async handler(ctx, input) {
    const [ws] = await rows<{ name: string; organization_id: string; joined: boolean }>(
      ctx.tx,
      sql`select m.name, m.organization_id, m.joined from private.practice_mine() m
          where m.workspace_id = ${input.workspaceId}::uuid`,
    );
    if (!ws) {
      const [other] = await rows<{ practice: boolean; seen: boolean }>(
        ctx.tx,
        sql`select private.is_practice_workspace(${input.workspaceId}::uuid) as practice,
              exists (select 1 from app.workspaces w where w.id = ${input.workspaceId}::uuid) as seen`,
      );
      if (other?.practice)
        throw HfosError.forbidden(
          'Someone else is practising that business, so only they can end it. It’s deleted on its own within 24 hours of starting.',
          'practice_not_yours',
        );
      if (other?.seen) throw notPractice();
      throw HfosError.notFound(
        'That practice business has already gone. Start another from Admin → Try onboarding.',
      );
    }
    // One you were invited into and never joined: you're in it just long enough to record this, which only someone in
    // a business records.
    if (!ws.joined)
      await ctx.tx.execute(sql`select private.practice_step_in(${input.workspaceId}::uuid)`);
    // Recorded before the mark, as workspace.delete does: once marked, nothing more is written to the business. The
    // worker's deletion job picks it up from here.
    await ctx.emit({
      type: 'workspace.deletion_requested',
      entityType: 'workspace',
      entityId: input.workspaceId,
      organizationId: ws.organization_id,
      workspaceId: input.workspaceId,
      payload: { name: ws.name, practice: true },
      before: { name: ws.name },
      after: null,
    });
    const [marked] = await rows<{ requested_at: Date | string }>(
      ctx.tx,
      sql`select private.end_practice(${input.workspaceId}::uuid) as requested_at`,
    );
    if (!marked?.requested_at)
      throw HfosError.internal(
        'The practice business couldn’t be ended just now. Nothing was deleted. Try again in a minute.',
      );
    return {
      workspaceId: input.workspaceId,
      requestedAt: new Date(marked.requested_at).toISOString(),
    };
  },
});

export const practiceCommands = [practiceStart, practicePay, practiceEnd];
