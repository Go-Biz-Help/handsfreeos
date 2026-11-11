/**
 * The business email step (messaging/email-setup.ts): onboarding's "Your business email" stop, and Home's "Set up
 * your business email". Each screen saves on its own Next:
 *
 * - The address (`sender`). The free one on the shared subdomain is renamed from the random letters it was made
 *   with and made the default at once; an address that has sent mail keeps its name (replies point at it), so a new
 *   one takes over. On the business's own domain, the domain is added (its records start being made) and keeps a plan:
 *   once its records check out, the team address is made and becomes the default on its own (applyDomainPlan, from
 *   email_domain.record). Until then the cleaned-up free address carries the mail.
 * - The records (`records`): whether the domain's mail comes here too.
 * - An address just for the person (`own`), on the domain, made with the rest once it verifies.
 *
 * Each part runs the command it already has where there is one, in this transaction, with its own checks and events.
 */
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { emailAddresses, emailDomains } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { executeCommandWithin } from '../kernel/execute';
import type { CommandContext } from '../kernel/types';
import {
  emailSetupDomainOf,
  emailSetupOffersReceiving,
  emailSetupProblems,
  type EmailDomainPlan,
  type EmailSetupAnswers,
  type EmailSetupState,
} from '../messaging/email-setup';
import { loadEmailSetupState } from '../messaging/email-setup-load';
import { normalizeEmailDomain } from '../schemas/email';
import {
  EmailDomainSendStepsInput,
  EmailDomainSendStepsOutput,
  EmailSetupSaveInput,
  EmailSetupSaveOutput,
} from '../schemas/email-setup';
import { applyDomainPlan, emailAddressCreate, emailAddressUpdate, emailDomainAdd } from './email';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** How many times a day a business can email its domain's steps. */
export const EMAIL_STEPS_PER_DAY = 10;

const clean = (plan: EmailDomainPlan): EmailDomainPlan =>
  JSON.parse(JSON.stringify(plan)) as EmailDomainPlan;

/** A domain's plan changed: kept on the domain, with its event. Nothing when it's the same. */
async function setPlan(
  ctx: CommandContext,
  d: { readonly id: string; readonly domain: string; readonly plan: EmailDomainPlan },
  next: EmailDomainPlan,
) {
  const after = clean(next);
  if (JSON.stringify(clean(d.plan)) === JSON.stringify(after)) return;
  const [row] = await ctx.tx
    .update(emailDomains)
    .set({ plan: after })
    .where(eq(emailDomains.id, d.id))
    .returning({ id: emailDomains.id });
  if (!row) throw HfosError.forbidden();
  await ctx.emit({
    type: 'email_domain.planned',
    entityType: 'email_domain',
    entityId: d.id,
    payload: { domain: d.domain },
    before: { plan: d.plan },
    after: { domain: d.domain, plan: after },
  });
}

/** Another domain's records were on their way for the team address: now they won't switch anything. */
async function dropOtherPlans(ctx: CommandContext, state: EmailSetupState, keep: string | null) {
  for (const d of state.domains)
    if (d.id !== keep && d.status !== 'verified' && (d.plan.team || d.plan.own))
      await setPlan(ctx, d, {});
}

/**
 * The free address on the shared subdomain, with this name and the name customers see, and the default when asked.
 * Renamed from the random letters it was made with; an address that has sent mail keeps its name, so a new one takes
 * over beside it. Returns the address.
 */
async function useFree(
  ctx: CommandContext,
  state: EmailSetupState,
  localPart: string,
  displayName: string,
  isDefault: boolean,
): Promise<string> {
  const ws = ctx.scope.workspaceId!;
  const address = `${localPart}@${state.sharedDomain}`;
  const [have] = await ctx.tx
    .select({ id: emailAddresses.id })
    .from(emailAddresses)
    .where(and(eq(emailAddresses.workspaceId, ws), eq(emailAddresses.address, address)));
  const update = (emailAddressId: string, rename: boolean) =>
    executeCommandWithin(ctx, emailAddressUpdate, {
      workspaceId: ws,
      emailAddressId,
      displayName,
      ...(rename ? { localPart } : {}),
      ...(isDefault ? { isDefault: true } : {}),
    });
  if (have) {
    await update(have.id, false);
    return address;
  }
  if (state.free)
    try {
      await update(state.free.id, true);
      return address;
    } catch (e) {
      // It has sent mail, so replies point at it: it keeps its name, and a new one takes over.
      if (!(e instanceof HfosError) || e.rule !== 'email_address_in_use') throw e;
    }
  await executeCommandWithin(ctx, emailAddressCreate, {
    workspaceId: ws,
    localPart,
    displayName,
    isDefault,
  });
  return address;
}

interface Saved {
  changes: string[];
  emailDomainId: string | null;
}

async function saveSender(
  ctx: CommandContext,
  state: EmailSetupState,
  answers: EmailSetupAnswers,
  out: Saved,
) {
  const ws = ctx.scope.workspaceId!;
  const name = answers.name.trim();
  const freeLocal = answers.freeLocal.trim().toLowerCase();
  if (answers.with !== 'domain') {
    await dropOtherPlans(ctx, state, null);
    const address = await useFree(ctx, state, freeLocal, name, true);
    out.changes.push(`Emails go out from ${address}`);
    return;
  }
  const domain = normalizeEmailDomain(answers.domain);
  const local = answers.local.trim().toLowerCase();
  const d = emailSetupDomainOf(state, { domain });
  let id = d?.id ?? null;
  if (!id) {
    const made = await executeCommandWithin(ctx, emailDomainAdd, { workspaceId: ws, domain });
    id = made.output.emailDomainId;
    out.changes.push(`Adds ${domain}, and makes its records`);
  }
  out.emailDomainId = id;
  await dropOtherPlans(ctx, state, id);
  await setPlan(
    ctx,
    { id, domain, plan: d?.plan ?? {} },
    {
      ...(d?.plan ?? {}),
      team: { localPart: local, displayName: name },
    },
  );
  if (d?.status === 'verified') {
    out.changes.push(...(await applyDomainPlan(ctx, id)));
    return;
  }
  // Until the records are in, the free address carries the mail, without its random letters. A name someone else
  // has keeps the one it has: the domain's address takes over soon.
  if (!state.sender?.domain)
    try {
      await useFree(ctx, state, freeLocal, name, true);
    } catch (e) {
      if (
        !(e instanceof HfosError) ||
        (e.rule !== 'email_address_taken' && e.rule !== 'email_local_part_reserved')
      )
        throw e;
    }
  out.changes.push(`Emails go out from ${local}@${domain} once its records are in`);
}

/** The domain the answers name, as the business has it, or a refusal that says to pick it first. */
function domainOf(state: EmailSetupState, answers: EmailSetupAnswers) {
  const d = answers.with === 'domain' ? emailSetupDomainOf(state, answers) : null;
  if (!d)
    throw HfosError.rule(
      'email_setup_no_domain',
      409,
      'Pick your domain under “Which address should customers see?” first, then come back to this screen.',
    );
  return d;
}

async function saveRecords(
  ctx: CommandContext,
  state: EmailSetupState,
  answers: EmailSetupAnswers,
  out: Saved,
) {
  const d = domainOf(state, answers);
  out.emailDomainId = d.id;
  if (answers.receive === null || !emailSetupOffersReceiving(d) || d.receiving !== 'off') return;
  const { receive: _, ...rest } = d.plan;
  await setPlan(ctx, d, { ...rest, receive: answers.receive });
  if (d.status === 'verified') out.changes.push(...(await applyDomainPlan(ctx, d.id)));
  else if (answers.receive)
    out.changes.push(`Mail to ${d.domain} comes here once its records are in`);
}

async function saveOwn(
  ctx: CommandContext,
  state: EmailSetupState,
  answers: EmailSetupAnswers,
  out: Saved,
) {
  // Only on the business's own domain, and only once: someone with an address of their own keeps it.
  if (answers.with !== 'domain' || state.mine) return;
  const d = domainOf(state, answers);
  out.emailDomainId = d.id;
  const { own: _, ...rest } = d.plan;
  const me = requireHuman(ctx).userId;
  const local = answers.mineLocal.trim().toLowerCase();
  await setPlan(ctx, d, answers.mine ? { ...rest, own: { localPart: local, userId: me } } : rest);
  if (!answers.mine) return;
  if (d.status === 'verified') out.changes.push(...(await applyDomainPlan(ctx, d.id)));
  else out.changes.push(`Makes ${local}@${d.domain} for you once its records are in`);
}

export const emailSetupSave = defineCommand({
  name: 'email_setup.save',
  description:
    'Set up the address the business’s emails (booking confirmations, reminders, invoices, the AI teammate’s) go out from, one screen at a time. sender: a free address on mail.handsfreeos.com, made the default now, or a team address on the business’s own domain, which is added and becomes the default on its own once its DNS records check out (mail goes from the free address until then). records: whether the domain’s mail comes to the Inbox too. own: an address on the domain just for you, which only you read and booking emails never use.',
  risk: 2,
  input: EmailSetupSaveInput,
  output: EmailSetupSaveOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: [
    'email_domain.planned',
    'email_address.created',
    'email_address.updated',
    'email_domain.receiving_requested',
  ],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const state = await loadEmailSetupState(ctx.tx, ws, me);
    const problems = emailSetupProblems(input.part, input.email, state);
    if (problems.length)
      throw HfosError.validation(
        problems.map((p) => ({ path: p.path, message: p.message })),
        problems[0]!.message,
      );
    const out: Saved = { changes: [], emailDomainId: null };
    if (input.part === 'sender') await saveSender(ctx, state, input.email, out);
    else if (input.part === 'records') await saveRecords(ctx, state, input.email, out);
    else await saveOwn(ctx, state, input.email, out);
    const [now] = await ctx.tx
      .select({ address: emailAddresses.address })
      .from(emailAddresses)
      .where(and(eq(emailAddresses.workspaceId, ws), eq(emailAddresses.isDefault, true)));
    return { workspaceId: ws, ...out, sender: now?.address ?? state.sender?.address ?? '' };
  },
});

export const emailDomainSendSteps = defineCommand({
  name: 'email_domain.send_steps',
  description: `Email the DNS records for one of the business’s domains, with the steps for where it’s managed, to you or to whoever looks after the domain. Up to ${EMAIL_STEPS_PER_DAY} a day.`,
  risk: 2,
  input: EmailDomainSendStepsInput,
  output: EmailDomainSendStepsOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['email_domain.steps_requested'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const [d] = await ctx.tx
      .select({
        id: emailDomains.id,
        domain: emailDomains.domain,
        dkimHost: emailDomains.dkimHost,
      })
      .from(emailDomains)
      .where(and(eq(emailDomains.id, input.emailDomainId), eq(emailDomains.workspaceId, ws)));
    if (!d)
      throw HfosError.notFound(
        'That domain isn’t there anymore. It may have been removed. Refresh and try again.',
      );
    if (!d.dkimHost)
      throw HfosError.rule(
        'email_steps_not_ready',
        409,
        `The records for ${d.domain} are still being made. Try again in a minute.`,
      );
    const [asked] = await rows<{ n: number }>(
      ctx.tx,
      sql`select count(*)::int as n from app.events
          where workspace_id = ${ws} and event_type = 'email_domain.steps_requested'
            and created_at > now() - interval '1 day'`,
    );
    if ((asked?.n ?? 0) >= EMAIL_STEPS_PER_DAY)
      throw HfosError.rule(
        'email_steps_limit',
        429,
        `The steps for your domains went out ${EMAIL_STEPS_PER_DAY} times today, which is the most a day. Copy the records from this screen instead, or try again tomorrow.`,
      );
    await ctx.emit({
      type: 'email_domain.steps_requested',
      entityType: 'email_domain',
      entityId: d.id,
      payload: { domain: d.domain, to: input.to, by: me },
    });
    return { emailDomainId: d.id, to: input.to };
  },
});
