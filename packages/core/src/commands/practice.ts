/**
 * Practice businesses (Admin → Try onboarding, 20261027027200). A HandsFreeOS admin goes through an onboarding as a
 * brand-new customer would, in a real business made for it, and nothing in it is kept:
 *
 * - `practice.start`: the practice sign-up's first screen makes the organization and its business, owned by the admin
 *   and marked as practice, the way `organization.create` makes a new customer's. Nobody is credited for it.
 * - `practice.pay`: the stand-in checkout. The plan goes on the business with no spot held and no card kept.
 * - `practice.end`: deleting it, as an owner does, without typing its name; the worker takes it and its organization
 *   out (apps/worker/src/workspace/delete.ts, practice/jobs.ts). At its time the worker does the same on its own.
 *
 * Everything that would reach the outside world from one is pretended by the worker (apps/worker/src/practice/).
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { HfosError } from '../errors';
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
    'Admin → Try onboarding: make a practice business, owned by you, to go through an onboarding as a new customer would. Nothing in it leaves HandsFreeOS, and it is deleted when you end it or after 24 hours.',
  risk: 1,
  input: PracticeStartInput,
  output: PracticeStartOutput,
  permission: 'platform.practice.use',
  scope: () => ({ kind: 'platform' as const }),
  emits: ['organization.created', 'workspace.created'],
  async handler(ctx, input) {
    const suffix = randomUUID().slice(0, 6);
    const orgSlug = `${slugify(input.businessName)}-${suffix}`;
    const wsSlug = orgSlug;
    const [row] = await rows<{ org_id: string; ws_id: string }>(
      ctx.tx,
      sql`select * from private.start_practice(${input.businessName}, ${orgSlug}, ${input.businessName},
            ${wsSlug}, ${input.timezone}, ${input.industry}, ${PRACTICE_HOURS}::integer)`,
    );
    if (!row)
      throw HfosError.internal(
        'The practice business couldn’t be made just now. Try again in a minute.',
      );
    const [made] = await rows<{ ends_at: Date | string }>(
      ctx.tx,
      sql`select practice_ends_at as ends_at from app.organizations where id = ${row.org_id}::uuid`,
    );
    // The same two events a new customer's sign-up records, in the practice organization: what hears them runs with
    // the practice stand-ins, and they go with it.
    await ctx.emit({
      type: 'organization.created',
      entityType: 'organization',
      entityId: row.org_id,
      organizationId: row.org_id,
      workspaceId: null,
      payload: { name: input.businessName, slug: orgSlug, practice: true },
      after: { name: input.businessName, slug: orgSlug },
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
    return {
      organizationId: row.org_id,
      workspaceId: row.ws_id,
      endsAt: new Date(made?.ends_at ?? Date.now()).toISOString(),
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
  permission: 'workspace.delete',
  scope: inWorkspace,
  emits: ['workspace.deletion_requested'],
  async handler(ctx, input) {
    const [ws] = await rows<{ name: string; practice: boolean }>(
      ctx.tx,
      sql`select w.name, private.is_practice_workspace(w.id) as practice
          from app.workspaces w where w.id = ${input.workspaceId}::uuid`,
    );
    if (!ws)
      throw HfosError.notFound(
        'That practice business has already gone. Start another from Admin → Try onboarding.',
      );
    if (!ws.practice) throw notPractice();
    // Recorded before the mark, as workspace.delete does: once marked, nothing more is written to the business. The
    // worker's deletion job picks it up from here.
    await ctx.emit({
      type: 'workspace.deletion_requested',
      entityType: 'workspace',
      entityId: input.workspaceId,
      payload: { name: ws.name, practice: true },
      before: { name: ws.name },
      after: null,
    });
    const [marked] = await rows<{ requested_at: Date | string }>(
      ctx.tx,
      sql`select private.request_workspace_deletion(${input.workspaceId}::uuid) as requested_at`,
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
