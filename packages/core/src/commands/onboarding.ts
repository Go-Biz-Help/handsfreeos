/**
 * Getting started (HANDSFREEOS_ONBOARDING_IMPLEMENTATION_PLAN.md §5): the answers to the quick questions, skipping a
 * step, "Add them as you go", hiding the guide or finishing the tour, finishing the guide for good, and emailing
 * yourself a link to a step from the phone.
 *
 * The business's part lives in `workspaces.settings.onboarding` and needs workspace.update; a person's own part
 * lives in their `users.settings.onboarding`, keyed by business, and anyone in the business may change their own.
 */
import { eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { users, workspaces } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { scopeCan } from '../kernel/execute';
import type { CommandContext } from '../kernel/types';
import { loadOnboardingStatus } from '../onboarding/load';
import { stepPath } from '../onboarding/paths';
import {
  businessOnboardingOf,
  ONBOARDING_SETTINGS_KEY,
  personalOnboardingOf,
  storedBusinessOnboarding,
  withPersonalOnboarding,
  type BusinessOnboarding,
  type PersonalOnboarding,
} from '../onboarding/settings';
import { isBusinessStep, type PersonalStepKey } from '../onboarding/steps';
import { ONBOARDING_WORDS, stepTitle } from '../onboarding/words';
import {
  OnboardingAsYouGoInput,
  OnboardingAsYouGoOutput,
  OnboardingFinishInput,
  OnboardingFinishOutput,
  OnboardingSaveAnswersInput,
  OnboardingSaveAnswersOutput,
  OnboardingSendLinkInput,
  OnboardingSendLinkOutput,
  OnboardingSetViewInput,
  OnboardingSetViewOutput,
  OnboardingSkipInput,
  OnboardingSkipOutput,
} from '../schemas/onboarding';
import { linkProblem } from '../schemas/workspace';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

const NOT_THERE =
  'That business isn’t there, or you’re no longer in it. Pick a business from your list.';

/** The business's guide, read with its row held until this command saves. */
async function lockBusiness(ctx: CommandContext) {
  const [w] = await ctx.tx
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.scope.workspaceId!))
    .for('update');
  if (!w) throw HfosError.notFound(NOT_THERE);
  const stored = (w.settings ?? {}) as Record<string, unknown>;
  return { stored, current: businessOnboardingOf(stored) };
}

async function saveBusiness(
  ctx: CommandContext,
  stored: Record<string, unknown>,
  next: BusinessOnboarding,
  extra: Record<string, unknown> = {},
) {
  const [row] = await ctx.tx
    .update(workspaces)
    .set({
      settings: { ...stored, ...extra, [ONBOARDING_SETTINGS_KEY]: storedBusinessOnboarding(next) },
    })
    .where(eq(workspaces.id, ctx.scope.workspaceId!))
    .returning({ id: workspaces.id });
  // Row-level security lets only someone with workspace.update change a business's settings.
  if (!row) throw HfosError.forbidden();
}

/** This person's own view of the business's guide, read with their row held until this command saves. */
async function lockPerson(ctx: CommandContext) {
  const userId = requireHuman(ctx).userId;
  const [u] = await ctx.tx
    .select({ settings: users.settings })
    .from(users)
    .where(eq(users.id, userId))
    .for('update');
  if (!u)
    throw HfosError.notFound(
      'We couldn’t find your account. Sign out, sign in again and try once more.',
    );
  return {
    userId,
    settings: u.settings,
    current: personalOnboardingOf(u.settings, ctx.scope.workspaceId!),
  };
}

async function savePerson(
  ctx: CommandContext,
  userId: string,
  settings: Record<string, unknown>,
  next: PersonalOnboarding,
) {
  await ctx.tx
    .update(users)
    .set({
      settings: {
        ...settings,
        [ONBOARDING_SETTINGS_KEY]: withPersonalOnboarding(settings, ctx.scope.workspaceId!, next),
      },
    })
    .where(eq(users.id, userId));
}

/** "lonestarhvac.com" is how people type it; a link needs the https:// in front. */
function withScheme(v: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`;
}

export const onboardingSaveAnswers = defineCommand({
  name: 'onboarding.save_answers',
  description:
    'Save the four quick questions after Create business: what the business wants help with first, where its customers are now, its website, and how many people work there. They put the setup steps in order.',
  risk: 1,
  input: OnboardingSaveAnswersInput,
  output: OnboardingSaveAnswersOutput,
  permission: 'workspace.update',
  scope: inWorkspace,
  emits: ['onboarding.answers_saved'],
  async handler(ctx, input) {
    requireHuman(ctx);
    let website: string | null | undefined;
    if (input.website !== undefined) {
      website = input.website ? withScheme(input.website) : null;
      const problem = website ? linkProblem(website) : null;
      if (problem)
        throw HfosError.validation(
          [{ path: 'website', message: problem }],
          `That website address doesn’t look right. ${problem}`,
        );
    }
    const { stored, current } = await lockBusiness(ctx);
    const answers = {
      goal: input.goal,
      customersIn: input.customersIn,
      teamSize: input.teamSize,
    };
    await saveBusiness(
      ctx,
      stored,
      { ...current, answers },
      website !== undefined ? { website } : {},
    );
    const before = typeof stored['website'] === 'string' ? stored['website'] : null;
    await ctx.emit({
      type: 'onboarding.answers_saved',
      entityType: 'workspace',
      entityId: ctx.scope.workspaceId!,
      payload: { ...answers, website: website !== undefined },
      before: { answers: current.answers, website: before },
      after: { answers, website: website !== undefined ? website : before },
    });
    return {
      workspaceId: ctx.scope.workspaceId!,
      answers,
      website: website !== undefined ? website : before || null,
    };
  },
});

export const onboardingSkip = defineCommand({
  name: 'onboarding.skip',
  description:
    'Skip a Getting started step for now, or bring a skipped one back. A step for the whole business needs workspace.update; a step on your own list (the phone app, signing in faster, notifications, your calendar) is yours to skip.',
  risk: 1,
  input: OnboardingSkipInput,
  output: OnboardingSkipOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  emits: ['onboarding.step_skipped'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const ws = ctx.scope.workspaceId!;
    const sets = scopeCan(ctx.scope, 'workspace.update');
    const out = (changed: boolean) => ({
      workspaceId: ws,
      step: input.step,
      skipped: input.skipped,
      changed,
    });
    const emit = () =>
      ctx.emit({
        type: 'onboarding.step_skipped',
        entityType: 'workspace',
        entityId: ws,
        payload: {
          step: input.step,
          skipped: input.skipped,
          for: isBusinessStep(input.step) ? 'business' : 'person',
        },
      });
    if (isBusinessStep(input.step)) {
      if (!sets)
        throw HfosError.forbidden(ONBOARDING_WORDS.businessStep, 'onboarding_business_step');
      const { stored, current } = await lockBusiness(ctx);
      if (!!current.skipped[input.step] === input.skipped) return out(false);
      const skipped = { ...current.skipped };
      if (input.skipped)
        skipped[input.step] = { at: new Date().toISOString(), by: requireHuman(ctx).userId };
      else delete skipped[input.step];
      await saveBusiness(ctx, stored, { ...current, skipped });
      await emit();
      return out(true);
    }
    // An owner's list has the phone app and signing in faster; notifications and their calendar are a teammate's.
    const step = input.step as PersonalStepKey;
    if (sets && (step === 'notifications' || step === 'my_calendar'))
      throw HfosError.rule('onboarding_not_your_step', 400, ONBOARDING_WORDS.notYourStep);
    const { userId, settings, current } = await lockPerson(ctx);
    if (!!current.skipped[step] === input.skipped) return out(false);
    const skipped = { ...current.skipped };
    if (input.skipped) skipped[step] = new Date().toISOString();
    else delete skipped[step];
    await savePerson(ctx, userId, settings, { ...current, skipped });
    await emit();
    return out(true);
  },
});

export const onboardingAsYouGo = defineCommand({
  name: 'onboarding.as_you_go',
  description:
    'Answer the customers step with "Add them as you go": new leads add themselves, so the step counts as done. False takes the answer back.',
  risk: 1,
  input: OnboardingAsYouGoInput,
  output: OnboardingAsYouGoOutput,
  permission: 'workspace.update',
  scope: inWorkspace,
  emits: ['onboarding.customers_as_you_go'],
  async handler(ctx, input) {
    const userId = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const { stored, current } = await lockBusiness(ctx);
    if (!!current.customersAsYouGo === input.asYouGo)
      return { workspaceId: ws, asYouGo: input.asYouGo, changed: false };
    await saveBusiness(ctx, stored, {
      ...current,
      customersAsYouGo: input.asYouGo ? { at: new Date().toISOString(), by: userId } : null,
    });
    await ctx.emit({
      type: 'onboarding.customers_as_you_go',
      entityType: 'workspace',
      entityId: ws,
      payload: { asYouGo: input.asYouGo },
    });
    return { workspaceId: ws, asYouGo: input.asYouGo, changed: true };
  },
});

export const onboardingSetView = defineCommand({
  name: 'onboarding.set_view',
  description:
    'Hide your Getting started guide from Home, or show it again from Get help; or record that you finished or skipped the tour. Your own view only.',
  risk: 0,
  input: OnboardingSetViewInput,
  output: OnboardingSetViewOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  emits: ['onboarding.view_changed'],
  async handler(ctx, input) {
    const { userId, settings, current } = await lockPerson(ctx);
    const next: PersonalOnboarding = {
      ...current,
      hidden: input.hidden ?? current.hidden,
      tourDoneAt:
        input.tourDone === undefined
          ? current.tourDoneAt
          : input.tourDone
            ? (current.tourDoneAt ?? new Date().toISOString())
            : null,
    };
    const out = {
      workspaceId: ctx.scope.workspaceId!,
      hidden: next.hidden,
      tourDoneAt: next.tourDoneAt,
    };
    if (next.hidden === current.hidden && next.tourDoneAt === current.tourDoneAt) return out;
    await savePerson(ctx, userId, settings, next);
    await ctx.emit({
      type: 'onboarding.view_changed',
      entityType: 'workspace',
      entityId: ctx.scope.workspaceId!,
      payload: {
        ...(next.hidden !== current.hidden ? { hidden: next.hidden } : {}),
        ...(next.tourDoneAt !== current.tourDoneAt ? { tourDone: !!next.tourDoneAt } : {}),
      },
    });
    return out;
  },
});

export const onboardingFinish = defineCommand({
  name: 'onboarding.finish',
  description:
    'Finish your Getting started guide for good, once every step on your list is done, waiting on someone else, or skipped. It doesn’t come back after, even if something is disconnected later. Refused while a step is still to do.',
  risk: 0,
  input: OnboardingFinishInput,
  output: OnboardingFinishOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  emits: ['onboarding.finished'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const status = await loadOnboardingStatus(ctx, ws, input.device);
    if (!status.complete) {
      const open = status.steps
        .filter((s) => s.state === 'todo' || s.state === 'needs_fix')
        .map((s) => stepTitle(s.key, s.note.name));
      throw HfosError.conflict(ONBOARDING_WORDS.notFinished(open), 'onboarding_not_finished');
    }
    const { userId, settings, current } = await lockPerson(ctx);
    if (current.finishedAt) return { workspaceId: ws, finishedAt: current.finishedAt };
    const finishedAt = new Date().toISOString();
    await savePerson(ctx, userId, settings, { ...current, finishedAt });
    await ctx.emit({
      type: 'onboarding.finished',
      entityType: 'workspace',
      entityId: ws,
      payload: { audience: status.audience, done: status.done, skipped: status.skipped },
    });
    return { workspaceId: ws, finishedAt };
  },
});

/** The same link, asked for again within this long, isn't sent twice: the first is still on its way. */
const LINK_REPEAT_MINUTES = 10;
/** As many links as one person is sent in a day. */
export const LINKS_PER_DAY = 20;

export const onboardingSendLink = defineCommand({
  name: 'onboarding.send_link',
  description:
    'Email yourself a link to a Getting started step that’s easier on a computer ("Email me a link" in the phone app). The same step again within 10 minutes isn’t sent twice.',
  risk: 0,
  input: OnboardingSendLinkInput,
  output: OnboardingSendLinkOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  emits: ['onboarding.link_requested'],
  async handler(ctx, input) {
    const { userId } = requireHuman(ctx);
    const ws = ctx.scope.workspaceId!;
    const path = stepPath(ws, input.step);
    if (!path) throw HfosError.rule('onboarding_no_link', 400, ONBOARDING_WORDS.noLink);
    // Only a step on this person's list: the business's steps are for whoever sets the business up, and
    // notifications and their calendar are a teammate's.
    const sets = scopeCan(ctx.scope, 'workspace.update');
    if (isBusinessStep(input.step) && !sets)
      throw HfosError.forbidden(ONBOARDING_WORDS.businessStep, 'onboarding_business_step');
    if (sets && (input.step === 'notifications' || input.step === 'my_calendar'))
      throw HfosError.rule('onboarding_not_your_step', 400, ONBOARDING_WORDS.notYourStep);

    const [me] = await ctx.tx
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId));
    if (!me)
      throw HfosError.notFound(
        'We couldn’t find your account. Sign out, sign in again and try once more.',
      );
    const [asked] = await rows<{ today: number; again: number }>(
      ctx.tx,
      sql`select count(*)::int as today,
            count(*) filter (where created_at > now() - make_interval(mins => ${LINK_REPEAT_MINUTES})
                               and payload->>'step' = ${input.step})::int as again
          from app.events
          where actor_id = ${userId} and event_type = 'onboarding.link_requested'
            and created_at > now() - interval '1 day'`,
    );
    const out = (sent: boolean) => ({ workspaceId: ws, step: input.step, email: me.email, sent });
    if ((asked?.again ?? 0) > 0) return out(false);
    if ((asked?.today ?? 0) >= LINKS_PER_DAY)
      throw HfosError.rule('onboarding_link_limit', 429, ONBOARDING_WORDS.linkLimit(asked!.today));
    await ctx.emit({
      type: 'onboarding.link_requested',
      entityType: 'user',
      entityId: userId,
      payload: { step: input.step, path },
    });
    return out(true);
  },
});
