/**
 * The onboarding setup (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §5): keeping the answers while
 * someone is part way through, the parts that can't wait, and saving everything at the end.
 *
 * The answers live in `workspaces.settings.onboardingSetup`, so a person can stop on the computer and carry on from
 * the phone. Leaving a screen saves what later screens or other people need straight away: the business itself (and
 * the AI starts reading its website), invitations, Getting started's answers, the booking page, and the review link.
 * "Stay in the loop" saves the rest (`onboarding_setup.finish`): the AI quick setup's own Save, the price list and
 * the person's own hours.
 *
 * Each part runs the command it already has, in this transaction, with its own permission and events.
 */
import { eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { workspaces } from '@hfos/db/schema';
import { aiSetupFlowFactsOf } from '../ai-setup/flow';
import { setupKindOf } from '../ai-setup/kinds';
import { ensureBookingSite } from '../calendar/site';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { executeCommandWithin } from '../kernel/execute';
import type { CommandContext } from '../kernel/types';
import { businessOnboardingOf } from '../onboarding/settings';
import {
  laterOnboardingSetupScreen,
  ONBOARDING_SETUP_SETTINGS_KEY,
  onboardingSetupOf,
  onboardingSetupScreens,
  storedOnboardingSetup,
  type OnboardingSetupAnswers,
  type OnboardingSetupRecord,
} from '../onboarding-setup/answers';
import { loadOnboardingSetupState } from '../onboarding-setup/load';
import {
  myHoursChange,
  myHoursFrom,
  planOnboardingBooking,
  planPriceList,
  priceListChanges,
} from '../onboarding-setup/plan';
import { onboardingSetupScreenProblems } from '../onboarding-setup/summary';
import {
  OnboardingSetupFinishInput,
  OnboardingSetupFinishOutput,
  OnboardingSetupSaveInput,
  OnboardingSetupSaveOutput,
} from '../schemas/onboarding-setup';
import { linkProblem } from '../schemas/workspace';
import { aiSetupFinish, saveBusiness } from './ai-setup';
import { calendarCreate, calendarSetStatus } from './calendar';
import { bookingSiteUpdate, serviceCreate } from './calendar-catalog';
import { scheduleSet } from './calendar-hours';
import { membershipInvite } from './membership.invite';
import { productCreate, productUpdate } from './money-catalog';
import { onboardingAsYouGo, onboardingSaveAnswers } from './onboarding';
import { workspaceUpdate } from './workspace.update';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** The business's onboarding setup and its kind of business, read with its row held until this command saves. */
async function lockSetup(ctx: CommandContext) {
  const [w] = await ctx.tx
    .select({ settings: workspaces.settings, industry: workspaces.industry })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.scope.workspaceId!))
    .for('update');
  if (!w)
    throw HfosError.notFound(
      'That business isn’t there, or you’re no longer in it. Pick a business from your list.',
    );
  return {
    record: onboardingSetupOf((w.settings ?? {}) as Record<string, unknown>),
    settings: (w.settings ?? {}) as Record<string, unknown>,
    kind: setupKindOf(w.industry),
  };
}

async function saveRecord(ctx: CommandContext, next: OnboardingSetupRecord) {
  // Read again: the commands this one ran may have changed other settings since it was locked.
  const [w] = await ctx.tx
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.scope.workspaceId!));
  const [row] = await ctx.tx
    .update(workspaces)
    .set({
      settings: {
        ...((w?.settings ?? {}) as Record<string, unknown>),
        [ONBOARDING_SETUP_SETTINGS_KEY]: storedOnboardingSetup(next),
      },
    })
    .where(eq(workspaces.id, ctx.scope.workspaceId!))
    .returning({ id: workspaces.id });
  // Row-level security lets only someone with workspace.update change a business's settings.
  if (!row)
    throw HfosError.forbidden(
      'The setup saves to the business’s settings, and your role can’t change them. Ask an owner of this business to run it.',
    );
}

/** Getting started's answers, which put Home's list in order, when they changed. */
async function saveQuickAnswers(
  ctx: CommandContext,
  settings: Record<string, unknown>,
  answers: OnboardingSetupAnswers,
) {
  const now = businessOnboardingOf(settings).answers;
  const next = { goal: answers.goal, customersIn: answers.customersIn, teamSize: answers.teamSize };
  if (
    now &&
    now.goal === next.goal &&
    now.customersIn === next.customersIn &&
    now.teamSize === next.teamSize
  )
    return;
  await executeCommandWithin(ctx, onboardingSaveAnswers, {
    workspaceId: ctx.scope.workspaceId!,
    ...next,
  });
}

interface Done {
  invited: string[];
  changes: string[];
  notes: string[];
  calendarId: string | null;
}

/** "Invite them now": each invited as a team member. Someone already in, or already invited, is a note. */
async function invite(ctx: CommandContext, emails: readonly string[], out: Done) {
  for (const email of [...new Set(emails)]) {
    try {
      await executeCommandWithin(ctx, membershipInvite, {
        workspaceId: ctx.scope.workspaceId!,
        email,
        role: 'member',
      });
      out.invited.push(email);
    } catch (e) {
      if (
        !(e instanceof HfosError) ||
        (e.rule !== 'already_member' && e.rule !== 'invitation_pending')
      )
        throw e;
      out.notes.push(e.message);
    }
  }
  if (out.invited.length)
    out.changes.push(
      `Invites ${out.invited.length === 1 ? out.invited[0] : `${out.invited.length} people`} to the team`,
    );
}

/** "Your booking page is ready": the services and hours answered so far become a booking page, turned on. */
async function makeBookingPage(ctx: CommandContext, answers: OnboardingSetupAnswers, out: Done) {
  const ws = ctx.scope.workspaceId!;
  const me = requireHuman(ctx).userId;
  const state = await loadOnboardingSetupState(ctx.tx, ws, me);
  const plan = planOnboardingBooking(state, answers);
  // Hours first: they're what the calendar offers.
  if (plan.myHours)
    await executeCommandWithin(ctx, scheduleSet, {
      workspaceId: ws,
      ownerKind: 'user',
      weekly: plan.myHours,
    });
  if (plan.calendar) {
    const serviceIds = state.services.map((s) => s.id);
    for (const s of plan.services) {
      const made = await executeCommandWithin(ctx, serviceCreate, {
        workspaceId: ws,
        name: s.name,
        description: s.description || null,
        ...(s.minutes ? { durations: [s.minutes] } : {}),
        ...(s.priceCents != null ? { priceCents: s.priceCents } : {}),
      });
      serviceIds.push(made.output.serviceId);
    }
    const made = await executeCommandWithin(ctx, calendarCreate, {
      workspaceId: ws,
      name: plan.calendar,
      preset: 'service',
      services: serviceIds.slice(0, 50),
    });
    out.calendarId = made.output.calendarId;
    try {
      await executeCommandWithin(ctx, calendarSetStatus, {
        workspaceId: ws,
        calendarId: made.output.calendarId,
        status: 'active',
      });
    } catch (e) {
      if (!(e instanceof HfosError) || e.rule !== 'calendar_issues') throw e;
      out.notes.push(e.message);
    }
  }
  if (plan.site) {
    // A business without one gets one named after it, which starts off; then it's turned on, as it was set up.
    const made = await ensureBookingSite(ctx.tx, ws, me);
    const [site] = await rows<{ name: string; intro: string | null }>(
      ctx.tx,
      sql`select name, intro from app.booking_sites where id = ${made.id}`,
    );
    await executeCommandWithin(ctx, bookingSiteUpdate, {
      workspaceId: ws,
      slug: made.slug,
      name: site?.name ?? state.businessName,
      intro: site?.intro ?? null,
      enabled: true,
    });
  }
  out.changes.push(...plan.changes);
}

/** "Your Google review link", which the thank-you text sends: saved as typed, or taken away when it's cleared. */
async function saveReviewLink(
  ctx: CommandContext,
  settings: Record<string, unknown>,
  typed: string,
  out: Done,
) {
  const raw = settings['links'];
  const links =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const link = typed.trim()
    ? /^https?:\/\//i.test(typed.trim())
      ? typed.trim()
      : `https://${typed.trim()}`
    : null;
  if ((links['review'] ?? null) === link) return;
  const problem = linkProblem(link);
  if (problem)
    throw HfosError.validation(
      [{ path: 'answers.reviewLink', message: problem }],
      `That review link doesn’t look right. ${problem}`,
    );
  await executeCommandWithin(ctx, workspaceUpdate, {
    workspaceId: ctx.scope.workspaceId!,
    settings: { links: { ...links, review: link } },
  });
  out.changes.push(
    link ? 'Thank-you texts send your Google review link' : 'Takes away your review link',
  );
}

export const onboardingSetupSave = defineCommand({
  name: 'onboarding_setup.save',
  description:
    'Keep the onboarding setup’s answers while someone is part way through, so they can carry on later or from the phone, and save what can’t wait: the first screen saves the business’s name, kind, address, time zone and website (and the AI teammate starts reading the website); “How many people work with you?” sends invitations; the goal and where customers are put Home’s list in order; the booking stop makes the booking page and turns it on; and the review link is saved for thank-you texts.',
  risk: 2,
  input: OnboardingSetupSaveInput,
  output: OnboardingSetupSaveOutput,
  permission: 'workspace.update',
  scope: inWorkspace,
  // Saving the website on the first screen asks the worker to read it, as the AI quick setup's first screen does.
  emits: ['onboarding_setup.started', 'ai_setup.read_requested'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    if (input.business && input.screen !== 'business')
      throw HfosError.validation([
        { path: 'business', message: 'The business’s details are saved from the first screen.' },
      ]);
    if (input.invite.length && input.screen !== 'goal')
      throw HfosError.validation([
        { path: 'invite', message: 'People are invited from “How many people work with you?”.' },
      ]);
    const before = await lockSetup(ctx);
    let scanStarted = false;
    if (input.business) {
      const { address, timezone, ...business } = input.business;
      ({ scanStarted } = await saveBusiness(ctx, business, {
        ...(timezone ? { timezone } : {}),
        ...(address ? { settings: { address } } : {}),
      }));
    }
    const { record, kind, settings } = await lockSetup(ctx);
    const kindChanged = kind !== before.kind;
    const reached = laterOnboardingSetupScreen(record.reached, input.screen);
    const answers = input.answers;
    const out: Done = { invited: [], changes: [], notes: [], calendarId: null };
    switch (input.screen) {
      case 'goal':
        await invite(ctx, input.invite, out);
        await saveQuickAnswers(ctx, settings, answers);
        break;
      case 'customers':
        await saveQuickAnswers(ctx, settings, answers);
        await executeCommandWithin(ctx, onboardingAsYouGo, {
          workspaceId: ws,
          asYouGo: answers.customersIn === 'none',
        });
        break;
      case 'booking':
        if (answers.booksTime) await makeBookingPage(ctx, answers, out);
        break;
      case 'paid':
        await saveReviewLink(ctx, settings, answers.reviewLink, out);
        break;
      default:
        break;
    }
    // A new run: the first save of all.
    const newRun = !record.started;
    await saveRecord(ctx, {
      ...record,
      draft: answers,
      reached,
      // These answers were given for the kind before, so what's picked by kind is picked again on the next read.
      kind: kindChanged ? (record.kind ?? before.kind) : kind,
      started: record.started ?? { at: new Date().toISOString(), by: me },
    });
    if (newRun)
      await ctx.emit({
        type: 'onboarding_setup.started',
        entityType: 'workspace',
        entityId: ws,
        payload: { screen: input.screen },
      });
    return { workspaceId: ws, reached, kind, kindChanged, scanStarted, ...out };
  },
});

export const onboardingSetupFinish = defineCommand({
  name: 'onboarding_setup.finish',
  description:
    'Save everything the onboarding setup kept, on “Stay in the loop”: the AI quick setup’s own Save (open hours, the business profile, quick facts, a website chat and the AI teammate, which stays off), services with a price on the price list, and your own hours from the open hours. Refuses answers that started from older AI teammate settings (revision_conflict).',
  risk: 2,
  input: OnboardingSetupFinishInput,
  output: OnboardingSetupFinishOutput,
  permission: 'workspace.update',
  scope: inWorkspace,
  emits: ['onboarding_setup.finished'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const { record, kind, settings } = await lockSetup(ctx);
    const state = await loadOnboardingSetupState(ctx.tx, ws, me);
    const answers = input.answers;
    const problems = onboardingSetupScreens(answers, aiSetupFlowFactsOf(state)).flatMap((s) =>
      onboardingSetupScreenProblems(s, answers, state),
    );
    if (problems.length)
      throw HfosError.validation(
        problems.map((p) => ({
          path: p.path ? `answers.${p.path}` : 'answers',
          message: p.message,
        })),
        problems[0]!.message,
      );
    const myHours = myHoursFrom(state, answers);

    // The AI part: the AI quick setup's own Save.
    const ai = await executeCommandWithin(ctx, aiSetupFinish, {
      workspaceId: ws,
      answers: answers.ai,
      baseRevision: input.baseRevision,
    });
    const lines = [...ai.output.changes];

    // The price list, by name: read again, since the AI part may have added services to price.
    const priceList = planPriceList(await loadOnboardingSetupState(ctx.tx, ws, me), answers);
    for (const p of priceList.create)
      await executeCommandWithin(ctx, productCreate, {
        workspaceId: ws,
        name: p.name,
        kind: 'service',
        unitPriceCents: p.priceCents,
        serviceId: p.serviceId,
      });
    for (const p of priceList.update)
      await executeCommandWithin(ctx, productUpdate, {
        workspaceId: ws,
        productId: p.id,
        unitPriceCents: p.priceCents,
      });
    lines.push(...priceListChanges(priceList));

    // The person's own hours, unless the booking stop set them already.
    if (myHours) {
      await executeCommandWithin(ctx, scheduleSet, {
        workspaceId: ws,
        ownerKind: 'user',
        weekly: myHours,
      });
      lines.push(myHoursChange(myHours));
    }
    await saveQuickAnswers(ctx, settings, answers);

    const finished = { at: new Date().toISOString(), by: me };
    await saveRecord(ctx, {
      ...record,
      draft: answers,
      reached: laterOnboardingSetupScreen(record.reached, 'loop'),
      kind,
      started: record.started ?? finished,
      finished,
    });
    await ctx.emit({
      type: 'onboarding_setup.finished',
      entityType: 'workspace',
      entityId: ws,
      payload: { teammateId: ai.output.teammateId, changes: lines.slice(0, 50) },
      after: { changes: lines.slice(0, 20) },
    });
    return { ...ai.output, changes: lines };
  },
});
