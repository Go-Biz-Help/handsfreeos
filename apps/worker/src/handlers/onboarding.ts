import { eq } from 'drizzle-orm';
import {
  isBusinessStep,
  PERSONAL_STEPS,
  stepTitle,
  type OnboardingStepKey,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { organizations, users, workspaces } from '@hfos/db/schema';
import { onboardingLinkEmail, onboardingReminderEmail } from '../emails/templates';
import { tenantOf } from '../services';
import type { EventHandler } from './types';

const isStep = (v: unknown): v is OnboardingStepKey =>
  typeof v === 'string' && (isBusinessStep(v) || (PERSONAL_STEPS as readonly string[]).includes(v));

/**
 * "Email me a link" in the phone app (`onboarding.send_link`): the page for one Getting started step, sent to the
 * person who asked. The command worked out the page; only a path in the app goes out, on the app's own address.
 */
export const onOnboardingLinkRequested: EventHandler = async (ctx) => {
  const userId = ctx.event.entityId;
  const { step, path } = (ctx.event.payload ?? {}) as { step?: unknown; path?: unknown };
  if (!userId || !isStep(step) || typeof path !== 'string' || !/^\/[^/\\]/.test(path)) return;
  const scope = tenantOf(ctx.scope);
  const [person] = await ctx.tx
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  if (!person?.email) return;
  const [w] = await ctx.tx
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, scope.workspaceId));
  if (!w) return;
  const content = onboardingLinkEmail({
    step: stepTitle(step),
    business: w.name,
    link: `${ctx.webUrl}${path}`,
  });
  await ctx.mailer.send({ to: String(person.email), ...content });
};

/**
 * An agency's reminder to a client business (`onboarding.remind`): its own owners, never the agency's people, each
 * get their next step with a button to it.
 */
export const onOnboardingRemindRequested: EventHandler = async (ctx) => {
  const { step, path } = (ctx.event.payload ?? {}) as { step?: unknown; path?: unknown };
  if (!isStep(step) || typeof path !== 'string' || !/^\/[^/\\]/.test(path)) return;
  const scope = tenantOf(ctx.scope);
  const owners = await rows<{ email: string }>(
    ctx.tx,
    sql`select u.email::text as email from app.workspace_memberships m
        join app.users u on u.id = m.user_id
        where m.workspace_id = ${scope.workspaceId} and m.role = 'owner'
          and not exists (select 1 from app.organization_memberships om
                          where om.organization_id = ${scope.organizationId} and om.user_id = m.user_id)`,
  );
  if (!owners.length) return;
  const [w] = await ctx.tx
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, scope.workspaceId));
  const [o] = await ctx.tx
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, scope.organizationId));
  if (!w || !o) return;
  const content = onboardingReminderEmail({
    agency: o.name,
    business: w.name,
    step: stepTitle(step),
    link: `${ctx.webUrl}${path}`,
  });
  for (const owner of owners) await ctx.mailer.send({ to: owner.email, ...content });
};
