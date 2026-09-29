import { eq } from 'drizzle-orm';
import {
  isBusinessStep,
  PERSONAL_STEPS,
  stepTitle,
  type OnboardingStepKey,
} from '@hfos/core/server';
import { users, workspaces } from '@hfos/db/schema';
import { onboardingLinkEmail } from '../emails/templates';
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
