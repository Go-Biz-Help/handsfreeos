/**
 * Client updates (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "The Assistant and client updates"; Chris,
 * 2026-09-30): at a milestone, or when the agent asks, the worker drafts a status email from the deal's facts; the
 * agent edits it and sends it with core's `message.send`, from their own mailbox first, else the team inbox. Every
 * version of its words is checked for fair-housing risk twice (the fixed list here, the model in the worker), and
 * flags are fixed or confirmed with a reason before it goes. Nothing is ever sent on its own.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { messageSend } from '../../../commands/message';
import { personGone } from '../../../crm/records';
import { HfosError } from '../../../errors';
import { executeCommandWithin } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import { FRESH_MINUTES } from '../../../mobile';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { checkWords, FAIR_HOUSING_WORDS_VERSION, type FairHousingFlag } from '../fair-housing';
import { realestateAddon } from '../manifest';
import {
  StatusEmailAcknowledgeInput,
  StatusEmailCheckedInput,
  StatusEmailDraftedInput,
  StatusEmailDraftInput,
  StatusEmailGetOutput,
  StatusEmailListInput,
  StatusEmailListOutput,
  StatusEmailOutput,
  StatusEmailRequestInput,
  StatusEmailSavedOutput,
  StatusEmailSaveInput,
} from '../schemas';
import { drafts, fairHousingChecks } from '../tables';
import {
  actorUserId,
  dealLine,
  historyLine,
  inWorkspace,
  loadDeal,
  requireNotArchived,
  type Ctx,
  type Deal,
} from './common';

type Draft = typeof drafts.$inferSelect;
type Check = typeof fairHousingChecks.$inferSelect;

/** A digest of exactly the words a check read. */
export const textHashOf = (subject: string | null, body: string | null) =>
  createHash('sha256')
    .update(`${subject ?? ''}\n\n${body ?? ''}`)
    .digest('hex');

async function loadDraft(
  ctx: Ctx,
  draftId: string,
  lock = false,
): Promise<{ draft: Draft; deal: Deal }> {
  const q = ctx.tx
    .select()
    .from(drafts)
    .where(and(eq(drafts.id, draftId), eq(drafts.workspaceId, ctx.scope.workspaceId!)));
  const [draft] = lock ? await q.for('update') : await q;
  if (!draft)
    throw HfosError.notFound(
      'That client update isn’t there anymore, or you’re not on its deal. Refresh the deal’s updates.',
    );
  return { draft, deal: await loadDeal(ctx, draft.dealRecordId) };
}

const out = (d: Draft) => ({ dealId: d.dealRecordId, draftId: d.id, status: d.status });

/** The deal's client with an email address, if it has one. */
async function clientOf(ctx: Ctx, dealId: string) {
  const [c] = await rows<{ id: string; first_name: string; email: string | null }>(
    ctx.tx,
    sql`select p.id, p.first_name, p.email::text as email
        from app.relationships rel
        join app.relationship_types rt on rt.id = rel.type_id and rt.addon_key = 'realestate_client'
        join app.people p on p.id = rel.a_person_id
        where rel.b_custom_record_id = ${dealId}
        order by (p.email is null), rel.created_at limit 1`,
  );
  return c ?? null;
}

/** The checks of a draft's words as they are now, and the flags they raise. */
function current(draft: Draft, checks: readonly Check[]) {
  const hash = textHashOf(draft.subject, draft.body);
  const now = checks.filter((c) => c.textHash === hash);
  const latest = (source: 'words' | 'model') =>
    now.filter((c) => c.source === source).sort((a, b) => +b.checkedAt - +a.checkedAt)[0] ?? null;
  const words = latest('words');
  const model = latest('model');
  const flags: FairHousingFlag[] = [];
  const seen = new Set<string>();
  for (const c of [words, model])
    for (const f of (c?.flags ?? []) as FairHousingFlag[]) {
      if (seen.has(f.phrase.toLowerCase())) continue;
      seen.add(f.phrase.toLowerCase());
      flags.push(f);
    }
  return { hash, words, model, flags };
}

async function checksOf(ctx: Ctx, draftId: string) {
  return ctx.tx
    .select()
    .from(fairHousingChecks)
    .where(eq(fairHousingChecks.draftId, draftId))
    .orderBy(desc(fairHousingChecks.checkedAt));
}

async function recordCheck(
  ctx: CommandContext,
  draft: Draft,
  check: {
    source: 'words' | 'model';
    version: string;
    status: 'passed' | 'flagged' | 'unavailable';
    flags: readonly FairHousingFlag[];
    textHash: string;
  },
) {
  await ctx.tx.insert(fairHousingChecks).values({
    workspaceId: draft.workspaceId,
    dealRecordId: draft.dealRecordId,
    draftId: draft.id,
    source: check.source,
    version: check.version,
    status: check.flags.length ? 'flagged' : check.status === 'flagged' ? 'passed' : check.status,
    flags: [...check.flags],
    textHash: check.textHash,
  });
}

export const statusEmailRequest = defineAddonCommand(realestateAddon, {
  name: 'realestate.status_email.request',
  description:
    'Ask for a status email to a deal’s client: HandsFreeOS drafts it from the deal’s facts (its stage, confirmed dates, what’s done and what’s next), checks it for fair-housing risk, and leaves it for the agent to edit and send.',
  risk: 1,
  input: StatusEmailRequestInput,
  output: StatusEmailOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.status_email.requested'],
  actors: ['human', 'system'],
  ai: {
    tool: 'realestate_draft_client_update',
    description:
      'Draft a status email to a deal’s client from its facts, for the agent to review, edit and send. Nothing is sent.',
    keywords: ['client update', 'status email', 'update the buyer', 'update the seller'],
  },
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireNotArchived(deal);
    const client = await clientOf(ctx, deal.recordId);
    if (!client?.email)
      throw HfosError.rule(
        'realestate_no_client_email',
        409,
        client
          ? `${deal.name}’s client has no email address. Add one on their page, then ask again.`
          : `${deal.name} has no client yet. Add the client on the deal, with their email address, then ask again.`,
      );
    // One draft per milestone: a second arrival of the same moment finds the first.
    if (input.milestone !== 'asked') {
      const [was] = await ctx.tx
        .select()
        .from(drafts)
        .where(and(eq(drafts.dealRecordId, deal.recordId), eq(drafts.milestone, input.milestone)));
      if (was && was.status !== 'discarded' && was.status !== 'failed') return out(was);
    }
    const [draft] = await ctx.tx
      .insert(drafts)
      .values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        milestone: input.milestone,
        personId: client.id,
        requestedBy: actorUserId(ctx),
        requestedAt: changeMoment(ctx.meta),
      })
      .returning();
    await ctx.emit({
      type: 'realestate.status_email.requested',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: { name: deal.name, draftId: draft!.id, milestone: input.milestone },
      after: { name: deal.name, clientUpdate: 'requested' },
      broadcast: false,
    });
    return out(draft!);
  },
});

export const statusEmailDrafted = defineAddonCommand(realestateAddon, {
  name: 'realestate.status_email.drafted',
  description:
    'Real Estate Agent’s own: the drafted client update and its first fair-housing checks, or why it couldn’t be drafted.',
  risk: 0,
  input: StatusEmailDraftedInput,
  output: StatusEmailOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['realestate.status_email.ready'],
  actors: ['system'],
  async handler(ctx, input) {
    const { draft, deal } = await loadDraft(ctx, input.draftId, true);
    if (draft.status !== 'drafting') return out(draft);
    const failed = !input.subject || !input.body;
    const [next] = await ctx.tx
      .update(drafts)
      .set(
        failed
          ? {
              status: 'failed',
              failure:
                input.failure?.slice(0, 500) || 'The draft couldn’t be written. Ask for it again.',
              updatedAt: new Date(),
            }
          : {
              status: 'ready',
              subject: input.subject!,
              body: input.body!,
              model: input.model ?? null,
              facts: input.facts ?? null,
              updatedAt: new Date(),
            },
      )
      .where(eq(drafts.id, draft.id))
      .returning();
    if (!failed) {
      const hash = textHashOf(next!.subject, next!.body);
      for (const c of input.checks) await recordCheck(ctx, next!, { ...c, textHash: hash });
    }
    await ctx.emit({
      type: 'realestate.status_email.ready',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: {
        name: deal.name,
        draftId: draft.id,
        milestone: draft.milestone,
        failed,
        mainAgentUserId: deal.ownerUserId,
        requestedBy: draft.requestedBy,
      },
      after: { name: deal.name, clientUpdate: failed ? 'failed' : 'ready' },
      broadcast: false,
    });
    return out(next!);
  },
});

export const statusEmailSave = defineAddonCommand(realestateAddon, {
  name: 'realestate.status_email.save',
  description:
    'Save the agent’s edits to a client update. Its words are checked again for fair-housing risk (the list at once, the model a moment later), and any earlier confirmation of flags no longer counts.',
  risk: 1,
  input: StatusEmailSaveInput,
  output: StatusEmailSavedOutput,
  permission: 'realestate.use',
  ai: { tool: 'realestate_status_email_save' },
  scope: inWorkspace,
  // Checking and editing one works anywhere; its words are checked for fair housing when it arrives (board 81).
  offline: 'anytime',
  emits: ['realestate.status_email.saved'],
  async handler(ctx, input) {
    const { draft, deal } = await loadDraft(ctx, input.draftId, true);
    requireNotArchived(deal);
    if (draft.status !== 'ready')
      throw HfosError.rule(
        'realestate_draft_not_ready',
        409,
        draft.status === 'drafting'
          ? 'That update is still being written. Try again in a moment.'
          : `That update was ${draft.status}, so it doesn’t change any more. Ask for a new one.`,
      );
    const at = changeMoment(ctx.meta);
    const [next] = await ctx.tx
      .update(drafts)
      .set({
        subject: input.subject,
        body: input.body,
        editedBy: actorUserId(ctx),
        editedAt: at,
        flagsAcknowledgedAt: null,
        flagsAcknowledgedBy: null,
        flagsAcknowledgedReason: null,
        updatedAt: at,
      })
      .where(eq(drafts.id, draft.id))
      .returning();
    const flags = checkWords(`${input.subject}\n${input.body}`);
    const hash = textHashOf(input.subject, input.body);
    await recordCheck(ctx, next!, {
      source: 'words',
      version: FAIR_HOUSING_WORDS_VERSION,
      status: 'passed',
      flags,
      textHash: hash,
    });
    await ctx.emit({
      type: 'realestate.status_email.saved',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: { name: deal.name, draftId: draft.id },
      after: { name: deal.name, clientUpdate: 'edited' },
      broadcast: false,
    });
    return { ...out(next!), flags };
  },
});

export const statusEmailChecked = defineAddonCommand(realestateAddon, {
  name: 'realestate.status_email.checked',
  description:
    'Real Estate Agent’s own: the model’s fair-housing check of a client update’s words.',
  risk: 0,
  input: StatusEmailCheckedInput,
  output: StatusEmailOutput,
  permission: null,
  scope: inWorkspace,
  emits: [],
  actors: ['system'],
  async handler(ctx, input) {
    const { draft } = await loadDraft(ctx, input.draftId, true);
    // Words since changed get their own check; this one would be about text nobody will send.
    if (draft.status === 'ready' && textHashOf(draft.subject, draft.body) === input.textHash)
      await recordCheck(ctx, draft, {
        source: 'model',
        version: input.version,
        status: input.status,
        flags: input.flags,
        textHash: input.textHash,
      });
    return out(draft);
  },
});

export const statusEmailAcknowledge = defineAddonCommand(realestateAddon, {
  name: 'realestate.status_email.acknowledge_flags',
  description:
    'Confirm a client update’s fair-housing flags are fine as written, with the reason. Kept with the update; editing it again asks again.',
  risk: 1,
  input: StatusEmailAcknowledgeInput,
  output: StatusEmailOutput,
  permission: 'realestate.use',
  ai: { tool: 'realestate_status_email_acknowledge_flags', autonomy: 'confirm' },
  scope: inWorkspace,
  emits: ['realestate.status_email.flags_acknowledged'],
  async handler(ctx, input) {
    const { draft, deal } = await loadDraft(ctx, input.draftId, true);
    requireNotArchived(deal);
    if (draft.status !== 'ready')
      throw HfosError.rule(
        'realestate_draft_not_ready',
        409,
        'That update isn’t waiting to be sent, so there’s nothing to confirm.',
      );
    const now = current(draft, await checksOf(ctx, draft.id));
    if (!now.flags.length) return out(draft);
    const at = changeMoment(ctx.meta);
    await ctx.tx
      .update(drafts)
      .set({
        flagsAcknowledgedAt: at,
        flagsAcknowledgedBy: actorUserId(ctx),
        flagsAcknowledgedReason: input.reason,
        updatedAt: at,
      })
      .where(eq(drafts.id, draft.id));
    await historyLine(ctx, deal, 'fair_housing_confirmed', {
      after: { draftId: draft.id, phrases: now.flags.map((f) => f.phrase) },
      note: input.reason,
    });
    await ctx.emit({
      type: 'realestate.status_email.flags_acknowledged',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: {
        name: deal.name,
        draftId: draft.id,
        phrases: now.flags.map((f) => f.phrase),
        reason: input.reason,
      },
      after: { name: deal.name, fairHousingFlags: 'confirmed' },
    });
    return out(draft);
  },
});

export const statusEmailSend = defineAddonCommand(realestateAddon, {
  name: 'realestate.status_email.send',
  description:
    'Send a client update the agent has reviewed, as an email to the deal’s client, from the agent’s own mailbox if they have one, else the team inbox. Refused while its fair-housing flags are neither fixed nor confirmed.',
  risk: 2,
  input: StatusEmailDraftInput,
  output: StatusEmailOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.status_email.sent'],
  // It reaches the client: OK'd with no signal, it goes while fresh, and one that waited more than 30 minutes asks
  // again first (board 81).
  offline: { freshMinutes: FRESH_MINUTES },
  ai: {
    tool: 'realestate_send_client_update',
    description:
      'Send a client update the person has read and approved, to the deal’s client. Always asks the person first.',
  },
  async handler(ctx, input) {
    const { draft, deal } = await loadDraft(ctx, input.draftId, true);
    requireNotArchived(deal);
    if (draft.status !== 'ready')
      throw HfosError.rule(
        'realestate_draft_not_ready',
        409,
        draft.status === 'sent'
          ? 'That update was already sent.'
          : draft.status === 'drafting'
            ? 'That update is still being written. Try again in a moment.'
            : `That update was ${draft.status}. Ask for a new one.`,
      );
    const now = current(draft, await checksOf(ctx, draft.id));
    // Edited and sent with no signal (board 81), the send arrives right behind the save that starts the model's check.
    // Nothing is wrong with it, so it's one to send again shortly (503: `retry`), never kept as refused: the phone
    // tries it again and it goes once the check is done, or meets the flags the check raised.
    if (!now.words || !now.model)
      throw HfosError.rule(
        'realestate_check_running',
        503,
        ctx.meta.commandId
          ? 'The fair-housing check on this update is still running. It goes once the check is done.'
          : 'The fair-housing check on this update is still running. Send it again in a moment, once it’s done.',
      );
    if (now.flags.length && !draft.flagsAcknowledgedAt)
      throw HfosError.rule(
        'realestate_fair_housing_flags',
        409,
        `This update has words that could read as a preference about who should live somewhere: ${now.flags
          .map((f) => `“${f.phrase}”`)
          .join(', ')}. Change them, or confirm they’re fine with a reason.`,
      );
    const client = draft.personId
      ? (
          await rows<{ email: string | null; deleted: boolean }>(
            ctx.tx,
            sql`select email::text as email, bin_item_id is not null or erased_at is not null as deleted
                from app.people where id = ${draft.personId}`,
          )
        )[0]
      : undefined;
    // A client deleted (in the Deleted bin, or only a name on their bills) gets nothing more.
    if (draft.personId && client?.deleted)
      throw await personGone(ctx.tx, ctx.scope.workspaceId!, draft.personId);
    if (!draft.personId || !client?.email)
      throw HfosError.rule(
        'realestate_no_client_email',
        409,
        `The client has no email address now. Add one on their page, then send it.`,
      );
    // From the agent's own mailbox, else their own address, else the team inbox.
    const me = actorUserId(ctx);
    const [mailbox] = me
      ? await rows<{ id: string }>(
          ctx.tx,
          sql`select id from app.mailbox_connections
              where workspace_id = ${ctx.scope.workspaceId!} and user_id = ${me} and status = 'active'
                and not shared
              order by connected_at desc nulls last limit 1`,
        )
      : [];
    const [address] =
      me && !mailbox
        ? await rows<{ id: string }>(
            ctx.tx,
            sql`select id from app.email_addresses
                where workspace_id = ${ctx.scope.workspaceId!} and owner_user_id = ${me} limit 1`,
          )
        : [];
    const sent = await executeCommandWithin(ctx, messageSend, {
      workspaceId: ctx.scope.workspaceId!,
      // To the client, at their email address on file.
      personId: draft.personId,
      channel: 'email',
      subject: draft.subject!,
      body: draft.body!,
      ...(mailbox ? { mailboxConnectionId: mailbox.id } : {}),
      ...(address ? { emailAddressId: address.id } : {}),
      clientId: `re-draft-${draft.id}`,
    });
    const at = changeMoment(ctx.meta);
    await ctx.tx
      .update(drafts)
      .set({
        status: 'sent',
        sentAt: at,
        sentBy: me,
        sentMessageId: sent.output.messageId,
        updatedAt: at,
      })
      .where(eq(drafts.id, draft.id));
    await historyLine(ctx, deal, 'client_update_sent', {
      after: { draftId: draft.id, messageId: sent.output.messageId, milestone: draft.milestone },
    });
    const eventId = await ctx.emit({
      type: 'realestate.status_email.sent',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: { name: deal.name, draftId: draft.id, messageId: sent.output.messageId },
      after: { name: deal.name, clientUpdate: 'sent' },
    });
    await dealLine(ctx, deal, `sent the client an update: “${draft.subject}”`.slice(0, 300), {
      eventId,
    });
    return { ...out(draft), status: 'sent' as const };
  },
});

export const statusEmailDiscard = defineAddonCommand(realestateAddon, {
  name: 'realestate.status_email.discard',
  description: 'Throw away a client update that won’t be sent. It stays in the deal’s history.',
  risk: 1,
  input: StatusEmailDraftInput,
  output: StatusEmailOutput,
  permission: 'realestate.use',
  ai: { tool: 'realestate_status_email_discard', autonomy: 'confirm' },
  scope: inWorkspace,
  emits: ['realestate.status_email.discarded'],
  async handler(ctx, input) {
    const { draft, deal } = await loadDraft(ctx, input.draftId, true);
    if (draft.status === 'sent')
      throw HfosError.rule('realestate_draft_not_ready', 409, 'That update was already sent.');
    if (draft.status === 'discarded') return out(draft);
    await ctx.tx
      .update(drafts)
      .set({ status: 'discarded', updatedAt: new Date() })
      .where(eq(drafts.id, draft.id));
    await ctx.emit({
      type: 'realestate.status_email.discarded',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: { name: deal.name, draftId: draft.id },
      after: { name: deal.name, clientUpdate: 'discarded' },
      broadcast: false,
    });
    return { ...out(draft), status: 'discarded' as const };
  },
});

// ---------- reading ----------

async function draftOut(ctx: Ctx, d: Draft) {
  const [p] = d.personId
    ? await rows<{ id: string; name: string; email: string | null }>(
        ctx.tx,
        sql`select id, coalesce(nullif(btrim(first_name || ' ' || last_name), ''), email::text, 'Client') as name,
              email::text as email
            from app.people where id = ${d.personId}`,
      )
    : [];
  return {
    draftId: d.id,
    dealId: d.dealRecordId,
    milestone: d.milestone,
    status: d.status,
    subject: d.subject,
    body: d.body,
    failure: d.failure,
    to: p ? { personId: p.id, name: p.name, email: p.email } : null,
    requestedAt: d.requestedAt.toISOString(),
    sentAt: d.sentAt?.toISOString() ?? null,
  };
}

export const statusEmailList = defineAddonQuery(realestateAddon, {
  name: 'realestate.status_email.list',
  description:
    'A deal’s client updates, newest first: drafting, ready to review, sent or thrown away.',
  input: StatusEmailListInput,
  output: StatusEmailListOutput,
  permission: 'realestate.use',
  ai: { tool: 'realestate_status_email_list' },
  scope: inWorkspace,
  handler: async (ctx, input) => {
    const deal = await loadDeal(ctx, input.dealId);
    const list = await ctx.tx
      .select()
      .from(drafts)
      .where(eq(drafts.dealRecordId, deal.recordId))
      .orderBy(desc(drafts.requestedAt));
    const outList = [];
    for (const d of list) outList.push(await draftOut(ctx, d));
    return { drafts: outList };
  },
});

export const statusEmailGet = defineAddonQuery(realestateAddon, {
  name: 'realestate.status_email.get',
  description:
    'One client update: its words, who it’s to, the fair-housing flags on its words as they are now (with why and a safer way to say it), and whether it can be sent.',
  input: StatusEmailDraftInput,
  output: StatusEmailGetOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_get_client_update',
    description: 'Read a drafted client update, its fair-housing flags and whether it can be sent.',
  },
  handler: async (ctx, input) => {
    const { draft } = await loadDraft(ctx, input.draftId);
    const checks = await checksOf(ctx, draft.id);
    const now = current(draft, checks);
    const checking = draft.status === 'ready' && (!now.words || !now.model);
    return {
      draft: await draftOut(ctx, draft),
      flags: now.flags,
      checking,
      acknowledged: draft.flagsAcknowledgedAt
        ? {
            at: draft.flagsAcknowledgedAt.toISOString(),
            reason: draft.flagsAcknowledgedReason ?? '',
          }
        : null,
      canSend:
        draft.status === 'ready' &&
        !checking &&
        (now.flags.length === 0 || !!draft.flagsAcknowledgedAt),
      checks: checks.map((c) => ({
        source: c.source,
        version: c.version,
        status: c.status,
        flags: c.flags as FairHousingFlag[],
        checkedAt: c.checkedAt.toISOString(),
        current: c.textHash === now.hash,
      })),
    };
  },
});

export const clientUpdateCommands = [
  statusEmailRequest,
  statusEmailDrafted,
  statusEmailSave,
  statusEmailChecked,
  statusEmailAcknowledge,
  statusEmailSend,
  statusEmailDiscard,
];
export const clientUpdateQueries = [statusEmailList, statusEmailGet];
