/**
 * Automations' "Outreach campaigns" (stage 5): making one, changing its drafts, approving them all, and pausing,
 * resuming, re-pacing or cancelling it while it sends. Owners and admins (`workflows.manage`), like the other things
 * that write to many customers at once.
 *
 * Making it picks its people and writes down who's left out and why; the worker then drafts each text
 * (`campaign.created`) and, once approved, sends them a few an hour (`campaign.approved`, `campaign.resumed`).
 */
import { and, eq, inArray, sql as dsql } from 'drizzle-orm';
import { rows, sql, type Tx } from '@hfos/db/client';
import { campaignRecipients, campaigns } from '@hfos/db/schema';
import { campaignAudience } from '../campaigns/audience';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import {
  CampaignCreateInput,
  CampaignCreateOutput,
  CampaignRecipientOutput,
  CampaignRecipientRef,
  CampaignRef,
  CampaignSetPaceInput,
  CampaignStateOutput,
  CampaignUpdateDraftInput,
  type CampaignStatus,
} from '../schemas/campaign';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

type CampaignRow = typeof campaigns.$inferSelect;

const STATUS_WORDS: Readonly<Record<string, string>> = {
  drafting: 'still being written',
  review: 'waiting for approval',
  sending: 'sending',
  paused: 'paused',
  done: 'finished',
  cancelled: 'cancelled',
};
const wrongState = (status: string, what: string) =>
  HfosError.conflict(
    `It’s ${STATUS_WORDS[status] ?? status}, so it can’t be ${what}.`,
    'campaign_state',
  );

/** The campaign, locked for this change. */
async function lockCampaign(tx: Tx, ws: string, id: string): Promise<CampaignRow> {
  const [c] = await tx
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.workspaceId, ws), eq(campaigns.id, id)))
    .for('update');
  if (!c) throw HfosError.notFound('That campaign isn’t here any more.');
  return c;
}

export const campaignCreate = defineCommand({
  name: 'campaign.create',
  description:
    'Start an outreach campaign: one text to every customer with one of the tags or an open deal in one of the stages, written per person by the AI from your goal. Nothing is sent until someone approves the drafts.',
  risk: 2,
  input: CampaignCreateInput,
  output: CampaignCreateOutput,
  permission: 'workflows.manage',
  scope: inWorkspace,
  emits: ['campaign.created'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    if (input.offerId) {
      const [offer] = await rows(
        ctx.tx,
        sql`select 1 from app.offers where id = ${input.offerId} and workspace_id = ${ws} and archived_at is null`,
      );
      if (!offer) throw HfosError.notFound('That offer isn’t running any more.');
    }
    const people = await campaignAudience(ctx.tx, ws, input.audience, new Date());
    const recipients = people.filter((p) => p.skipReason === null).length;
    if (recipients === 0)
      throw HfosError.conflict(
        people.length
          ? 'Everyone it picks is left out: no texting consent, texted lately, mid-conversation or booked.'
          : 'Nobody has those tags or stages.',
        'campaign_empty',
      );
    const [c] = await ctx.tx
      .insert(campaigns)
      .values({
        workspaceId: ws,
        name: input.name,
        goal: input.goal,
        audience: { tagIds: input.audience.tagIds, stageIds: input.audience.stageIds },
        perHour: input.perHour,
        offerId: input.offerId,
        createdBy: me,
      })
      .returning({ id: campaigns.id });
    if (!c) throw HfosError.forbidden();
    await rows(
      ctx.tx,
      sql`insert into app.campaign_recipients (workspace_id, campaign_id, person_id, status, skip_reason)
          select ${ws}, ${c.id}, x.person_id,
            case when x.reason is null then 'drafting' else 'skipped' end, x.reason
          from unnest(array[${sql.join(
            people.map((p) => sql`${p.personId}`),
            sql`, `,
          )}]::uuid[], array[${sql.join(
            people.map((p) => sql`${p.skipReason}`),
            sql`, `,
          )}]::text[]) as x(person_id, reason)`,
    );
    const skipped = people.length - recipients;
    await ctx.emit({
      type: 'campaign.created',
      entityType: 'campaign',
      entityId: c.id,
      payload: { campaignId: c.id, recipients, skipped },
      after: { name: input.name, recipients, skipped },
    });
    return { campaignId: c.id, recipients, skipped };
  },
});

/** A recipient whose draft a person may still change: its campaign is being drafted or waiting for approval. */
async function openRecipient(tx: Tx, ws: string, recipientId: string) {
  const [r] = await tx
    .select({
      id: campaignRecipients.id,
      status: campaignRecipients.status,
      campaignId: campaignRecipients.campaignId,
      campaignStatus: campaigns.status,
    })
    .from(campaignRecipients)
    .innerJoin(campaigns, eq(campaigns.id, campaignRecipients.campaignId))
    .where(and(eq(campaignRecipients.workspaceId, ws), eq(campaignRecipients.id, recipientId)))
    .for('update');
  if (!r) throw HfosError.notFound('That person isn’t in this campaign any more.');
  if (r.campaignStatus !== 'review' && r.campaignStatus !== 'drafting')
    throw wrongState(r.campaignStatus, 'changed');
  return r;
}

export const campaignUpdateDraft = defineCommand({
  name: 'campaign.update_draft',
  description: 'Change the text one person in an outreach campaign will get, before it’s approved.',
  risk: 1,
  input: CampaignUpdateDraftInput,
  output: CampaignRecipientOutput,
  permission: 'workflows.manage',
  scope: inWorkspace,
  emits: ['campaign.draft_edited'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const ws = ctx.scope.workspaceId!;
    const r = await openRecipient(ctx.tx, ws, input.recipientId);
    if (r.status !== 'ready' && r.status !== 'drafting')
      throw HfosError.conflict(
        'That person isn’t getting a text in this campaign.',
        'recipient_state',
      );
    await ctx.tx
      .update(campaignRecipients)
      .set({ draft: input.draft, edited: true, status: 'ready' })
      .where(eq(campaignRecipients.id, r.id));
    await ctx.emit({
      type: 'campaign.draft_edited',
      entityType: 'campaign',
      entityId: r.campaignId,
      payload: { campaignId: r.campaignId, recipientId: r.id, _broadcast: false },
    });
    return { recipientId: r.id, status: 'ready' as const };
  },
});

export const campaignRemoveRecipient = defineCommand({
  name: 'campaign.remove_recipient',
  description: 'Take one person out of an outreach campaign before it’s approved.',
  risk: 1,
  input: CampaignRecipientRef,
  output: CampaignRecipientOutput,
  permission: 'workflows.manage',
  scope: inWorkspace,
  emits: ['campaign.recipient_removed'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const ws = ctx.scope.workspaceId!;
    const r = await openRecipient(ctx.tx, ws, input.recipientId);
    await ctx.tx
      .update(campaignRecipients)
      .set({ status: 'removed' })
      .where(eq(campaignRecipients.id, r.id));
    await ctx.emit({
      type: 'campaign.recipient_removed',
      entityType: 'campaign',
      entityId: r.campaignId,
      payload: { campaignId: r.campaignId, recipientId: r.id, _broadcast: false },
    });
    return { recipientId: r.id, status: 'removed' as const };
  },
});

export const campaignApprove = defineCommand({
  name: 'campaign.approve',
  description:
    'Approve every draft in an outreach campaign and start sending, a few an hour in open hours.',
  risk: 3,
  input: CampaignRef,
  output: CampaignStateOutput,
  permission: 'workflows.manage',
  scope: inWorkspace,
  emits: ['campaign.approved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const c = await lockCampaign(ctx.tx, ws, input.campaignId);
    if (c.status === 'sending') return { campaignId: c.id, status: 'sending' as const };
    if (c.status !== 'review') throw wrongState(c.status, 'approved');
    const approved = await ctx.tx
      .update(campaignRecipients)
      .set({ status: 'approved' })
      .where(and(eq(campaignRecipients.campaignId, c.id), eq(campaignRecipients.status, 'ready')))
      .returning({ id: campaignRecipients.id });
    if (!approved.length)
      throw HfosError.conflict('There’s nobody left to send to.', 'campaign_empty');
    const now = new Date();
    await ctx.tx
      .update(campaigns)
      .set({ status: 'sending', approvedBy: me, approvedAt: now, startedAt: now })
      .where(eq(campaigns.id, c.id));
    await ctx.emit({
      type: 'campaign.approved',
      entityType: 'campaign',
      entityId: c.id,
      payload: { campaignId: c.id, approved: approved.length },
      after: { name: c.name, approved: approved.length, perHour: c.perHour },
    });
    return { campaignId: c.id, status: 'sending' as const };
  },
});

/** Pause, resume or cancel: a status change and its event. */
function stateCommand(o: {
  readonly name: `campaign.${string}`;
  readonly description: string;
  readonly event: string;
  readonly from: readonly CampaignStatus[];
  readonly to: CampaignStatus;
  readonly what: string;
}) {
  return defineCommand({
    name: o.name,
    description: o.description,
    risk: 1,
    input: CampaignRef,
    output: CampaignStateOutput,
    permission: 'workflows.manage',
    scope: inWorkspace,
    emits: [o.event],
    async handler(ctx, input) {
      requireHuman(ctx);
      const ws = ctx.scope.workspaceId!;
      const c = await lockCampaign(ctx.tx, ws, input.campaignId);
      if (c.status === o.to) return { campaignId: c.id, status: o.to };
      if (!o.from.includes(c.status as CampaignStatus)) throw wrongState(c.status, o.what);
      await ctx.tx
        .update(campaigns)
        .set({ status: o.to, ...(o.to === 'cancelled' ? { finishedAt: new Date() } : {}) })
        .where(eq(campaigns.id, c.id));
      if (o.to === 'cancelled')
        await ctx.tx
          .update(campaignRecipients)
          .set({ status: 'skipped', skipReason: 'not_sent' })
          .where(
            and(
              eq(campaignRecipients.campaignId, c.id),
              inArray(campaignRecipients.status, ['drafting', 'ready', 'approved']),
            ),
          );
      await ctx.emit({
        type: o.event,
        entityType: 'campaign',
        entityId: c.id,
        payload: { campaignId: c.id },
        after: { name: c.name },
      });
      return { campaignId: c.id, status: o.to };
    },
  });
}

export const campaignPause = stateCommand({
  name: 'campaign.pause',
  description: 'Stop an outreach campaign sending for now; what’s left waits until it’s resumed.',
  event: 'campaign.paused',
  from: ['sending'],
  to: 'paused',
  what: 'paused',
});

export const campaignResume = stateCommand({
  name: 'campaign.resume',
  description: 'Start a paused outreach campaign sending again, at its pace.',
  event: 'campaign.resumed',
  from: ['paused'],
  to: 'sending',
  what: 'resumed',
});

export const campaignCancel = stateCommand({
  name: 'campaign.cancel',
  description:
    'Stop an outreach campaign for good. Texts already sent stay sent; nobody else gets one.',
  event: 'campaign.cancelled',
  from: ['drafting', 'review', 'sending', 'paused'],
  to: 'cancelled',
  what: 'cancelled',
});

export const campaignSetPace = defineCommand({
  name: 'campaign.set_pace',
  description: 'Change how many texts an hour an outreach campaign sends.',
  risk: 1,
  input: CampaignSetPaceInput,
  output: CampaignStateOutput,
  permission: 'workflows.manage',
  scope: inWorkspace,
  emits: ['campaign.pace_changed'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const ws = ctx.scope.workspaceId!;
    const c = await lockCampaign(ctx.tx, ws, input.campaignId);
    if (c.status === 'done' || c.status === 'cancelled') throw wrongState(c.status, 're-paced');
    await ctx.tx
      .update(campaigns)
      .set({ perHour: input.perHour, updatedAt: dsql`now()` })
      .where(eq(campaigns.id, c.id));
    await ctx.emit({
      type: 'campaign.pace_changed',
      entityType: 'campaign',
      entityId: c.id,
      payload: { campaignId: c.id, perHour: input.perHour },
      before: { perHour: c.perHour },
      after: { name: c.name, perHour: input.perHour },
    });
    return { campaignId: c.id, status: c.status as CampaignStatus };
  },
});

export const campaignCommands = [
  campaignCreate,
  campaignUpdateDraft,
  campaignRemoveRecipient,
  campaignApprove,
  campaignPause,
  campaignResume,
  campaignCancel,
  campaignSetPace,
] as const;
