/**
 * Automations' "Outreach campaigns" (stage 5): the list, one campaign with everyone in it, and who a new one would
 * reach before it's made.
 */
import { rows, sql, type Tx } from '@hfos/db/client';
import { campaignAudience } from '../campaigns/audience';
import { formatPhone } from '../crm/phone';
import { HfosError } from '../errors';
import { defineQuery } from '../kernel/define';
import {
  CampaignGetOutput,
  CampaignListInput,
  CampaignListOutput,
  CampaignPreviewInput,
  CampaignPreviewOutput,
  CampaignRef,
  type CampaignStatus,
} from '../schemas/campaign';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});
const iso = (d: Date | string | null): string | null => (d ? new Date(d).toISOString() : null);

interface SummaryRow extends Record<string, unknown> {
  id: string;
  name: string;
  goal: string;
  status: CampaignStatus;
  per_hour: number;
  audience: { tagIds?: string[]; stageIds?: string[] } | null;
  created_at: Date;
  approved_at: Date | null;
  finished_at: Date | null;
  next_send_at: Date | null;
  total: number;
  drafting: number;
  ready: number;
  approved: number;
  sent: number;
  skipped: number;
  removed: number;
  failed: number;
}

async function summaries(tx: Tx, workspaceId: string, campaignId: string | null) {
  const list = await rows<SummaryRow>(
    tx,
    sql`select c.id, c.name, c.goal, c.status, c.per_hour, c.audience, c.created_at, c.approved_at, c.finished_at, c.next_send_at,
          count(r.id)::int as total,
          count(r.id) filter (where r.status = 'drafting')::int as drafting,
          count(r.id) filter (where r.status = 'ready')::int as ready,
          count(r.id) filter (where r.status = 'approved')::int as approved,
          count(r.id) filter (where r.status = 'sent')::int as sent,
          count(r.id) filter (where r.status = 'skipped')::int as skipped,
          count(r.id) filter (where r.status = 'removed')::int as removed,
          count(r.id) filter (where r.status = 'failed')::int as failed
        from app.campaigns c left join app.campaign_recipients r on r.campaign_id = c.id
        where c.workspace_id = ${workspaceId}
          ${campaignId ? sql`and c.id = ${campaignId}` : sql``}
        group by c.id
        order by c.created_at desc
        limit 200`,
  );
  return list.map((c) => ({
    id: c.id,
    name: c.name,
    goal: c.goal,
    status: c.status,
    perHour: c.per_hour,
    audience: { tagIds: c.audience?.tagIds ?? [], stageIds: c.audience?.stageIds ?? [] },
    counts: {
      total: c.total,
      drafting: c.drafting,
      ready: c.ready,
      approved: c.approved,
      sent: c.sent,
      skipped: c.skipped,
      removed: c.removed,
      failed: c.failed,
    },
    createdAt: iso(c.created_at)!,
    approvedAt: iso(c.approved_at),
    finishedAt: iso(c.finished_at),
    nextSendAt: iso(c.next_send_at),
  }));
}

export const campaignList = defineQuery({
  name: 'campaign.list',
  description: 'The business’s outreach campaigns, newest first, with how far each has got.',
  input: CampaignListInput,
  output: CampaignListOutput,
  permission: 'records.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const list = await summaries(ctx.tx, input.workspaceId, null);
    return { items: list.map(({ audience: _a, nextSendAt: _n, ...rest }) => rest) };
  },
});

export const campaignGet = defineQuery({
  name: 'campaign.get',
  description:
    'One outreach campaign: everyone it picked, each person’s text, and what became of it.',
  input: CampaignRef,
  output: CampaignGetOutput,
  permission: 'records.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const [found] = await summaries(ctx.tx, input.workspaceId, input.campaignId);
    if (!found) throw HfosError.notFound('That campaign isn’t here any more.');
    const { nextSendAt, ...campaign } = found;
    const list = await rows<{
      id: string;
      person_id: string;
      first_name: string | null;
      last_name: string | null;
      phone_e164: string | null;
      status: string;
      skip_reason: string | null;
      draft: string | null;
      edited: boolean;
      sent_at: Date | null;
      error: string | null;
    }>(
      ctx.tx,
      sql`select r.id, r.person_id, p.first_name, p.last_name, p.phone_e164, r.status, r.skip_reason, r.draft,
            r.edited, r.sent_at, r.error
          from app.campaign_recipients r join app.people p on p.id = r.person_id
          where r.campaign_id = ${input.campaignId}
          order by case r.status when 'skipped' then 2 when 'removed' then 3 else 1 end,
            p.first_name nulls last, p.last_name nulls last, r.id`,
    );
    return {
      campaign,
      recipients: list.map((r) => ({
        id: r.id,
        personId: r.person_id,
        name: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || 'Customer',
        phone: r.phone_e164 ? formatPhone(r.phone_e164) : null,
        status: r.status as 'drafting',
        skipReason: r.skip_reason,
        draft: r.draft,
        edited: r.edited,
        sentAt: iso(r.sent_at),
        error: r.error,
      })),
      nextSendAt: campaign.status === 'sending' ? nextSendAt : null,
    };
  },
});

export const campaignPreviewAudience = defineQuery({
  name: 'campaign.preview_audience',
  description:
    'Who a new outreach campaign would text, and how many are left out and why, before it’s made.',
  input: CampaignPreviewInput,
  output: CampaignPreviewOutput,
  permission: 'records.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const people = await campaignAudience(ctx.tx, input.workspaceId, input.audience, new Date());
    const skipped: Record<string, number> = {};
    for (const p of people)
      if (p.skipReason) skipped[p.skipReason] = (skipped[p.skipReason] ?? 0) + 1;
    return { recipients: people.filter((p) => !p.skipReason).length, skipped };
  },
});

export const campaignQueries = [campaignList, campaignGet, campaignPreviewAudience] as const;
