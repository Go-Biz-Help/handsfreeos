/**
 * Facebook Messenger and Instagram (20261025000200): the Pages and accounts a business has connected, and where its
 * customers came from.
 */
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { conversations, metaAccounts, metaConnections, metaLeadForms } from '@hfos/db/schema';
import { userNames } from '../calendar/load';
import { META_ACCOUNT_COLUMNS } from '../commands/social';
import { defineQuery } from '../kernel/define';
import { metaAccountLabel } from '../messaging/social';
import {
  AttributionListInput,
  AttributionListOutput,
  MetaAccountListInput,
  MetaAccountListOutput,
} from '../schemas/social';
import type { z } from 'zod';

const iso = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;

export const metaAccountList = defineQuery({
  name: 'meta_account.list',
  description:
    'The Facebook Pages and Instagram accounts whose direct messages come to this business’s inbox, how each is doing, whether its lead ads’ leads come in, and the Facebook sign-ins they came through.',
  input: MetaAccountListInput,
  output: MetaAccountListOutput,
  permission: 'channels.manage',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const accounts = await ctx.tx
      .select(META_ACCOUNT_COLUMNS)
      .from(metaAccounts)
      .where(eq(metaAccounts.workspaceId, input.workspaceId))
      .orderBy(metaAccounts.platform, metaAccounts.name);
    // Named columns, never `select()`: the sealed token is not granted to a person at all.
    const connections = await ctx.tx
      .select({
        id: metaConnections.id,
        status: metaConnections.status,
        facebookUserName: metaConnections.facebookUserName,
        scopes: metaConnections.scopes,
        createdBy: metaConnections.createdBy,
        connectedAt: metaConnections.connectedAt,
        tokenExpiresAt: metaConnections.tokenExpiresAt,
        lastError: metaConnections.lastError,
      })
      .from(metaConnections)
      .where(
        and(
          eq(metaConnections.workspaceId, input.workspaceId),
          // A sign-in nobody finished is nothing to show.
          ne(metaConnections.status, 'pending'),
          ne(metaConnections.status, 'disconnected'),
        ),
      )
      .orderBy(desc(metaConnections.connectedAt));
    const nameOf = await userNames(
      ctx.tx,
      connections.map((c) => c.createdBy).filter((v): v is string => !!v),
    );
    const counts = accounts.length
      ? await ctx.tx
          .select({ accountId: conversations.metaAccountId, n: sql<number>`count(*)::int` })
          .from(conversations)
          .where(
            and(
              eq(conversations.workspaceId, input.workspaceId),
              inArray(
                conversations.metaAccountId,
                accounts.map((a) => a.id),
              ),
            ),
          )
          .groupBy(conversations.metaAccountId)
      : [];
    const countOf = new Map(counts.map((c) => [c.accountId, c.n]));
    const forms = accounts.length
      ? await ctx.tx
          .select({
            accountId: metaLeadForms.accountId,
            name: metaLeadForms.name,
            formId: metaLeadForms.formId,
            lastLeadAt: metaLeadForms.lastLeadAt,
          })
          .from(metaLeadForms)
          .where(eq(metaLeadForms.workspaceId, input.workspaceId))
          .orderBy(desc(metaLeadForms.lastLeadAt))
      : [];
    return {
      accounts: accounts.map((a) => ({
        id: a.id,
        platform: a.platform,
        externalId: a.externalId,
        pageId: a.pageId,
        name: a.name,
        username: a.username,
        status: a.status,
        problem: a.problem,
        subscribed: !!a.subscribedAt && a.status !== 'disconnected',
        humanAgent: a.humanAgent,
        connectedAt: iso(a.connectedAt)!,
        connectionId: a.connectionId,
        conversations: countOf.get(a.id) ?? 0,
        leadsAccess: a.leadsAccess,
        lastLeadAt: iso(a.lastLeadAt),
        leadForms: forms
          .filter((f) => f.accountId === a.id)
          .map((f) => ({ name: f.name || `Form ${f.formId}`, lastLeadAt: iso(f.lastLeadAt) })),
      })),
      connections: connections.map((c) => ({
        id: c.id,
        status: c.status,
        facebookUserName: c.facebookUserName,
        connectedBy:
          c.createdBy && nameOf.has(c.createdBy)
            ? { id: c.createdBy, fullName: nameOf.get(c.createdBy)! }
            : null,
        connectedAt: iso(c.connectedAt),
        tokenExpiresAt: iso(c.tokenExpiresAt),
        readsAds: c.scopes.includes('ads_read'),
        readsLeads: c.scopes.includes('leads_retrieval'),
        lastError: c.lastError,
      })),
    };
  },
});

type TouchRow = {
  id: string;
  touched_at: Date;
  kind: 'started' | 'returned' | 'lead_form';
  platform: 'facebook' | 'instagram';
  channel: 'messenger' | 'instagram';
  source: string | null;
  referral_type: string | null;
  ref: string | null;
  ad_id: string | null;
  ad_title: string | null;
  ad_photo_url: string | null;
  post_id: string | null;
  referer_uri: string | null;
  conversation_id: string | null;
  person_id: string | null;
  lead_id: string | null;
  account_platform: 'facebook' | 'instagram' | null;
  account_name: string | null;
  account_username: string | null;
  form_name: string | null;
  ad_ref_id: string | null;
  d_external_id: string | null;
  d_status: 'pending' | 'resolved' | 'no_access' | 'not_found' | 'failed' | null;
  d_name: string | null;
  d_adset_id: string | null;
  d_adset_name: string | null;
  d_campaign_id: string | null;
  d_campaign_name: string | null;
  d_campaign_objective: string | null;
  d_creative_id: string | null;
  d_creative_name: string | null;
  d_creative_title: string | null;
  d_creative_body: string | null;
  d_creative_thumbnail_url: string | null;
  d_call_to_action: string | null;
  d_platforms: string[] | null;
};

export const attributionList = defineQuery({
  name: 'attribution.list',
  description:
    'Where a customer or a conversation came from: every Facebook or Instagram ad, link or lead ad form that brought them, newest first, with the ad’s campaign, ad set and creative once Meta has said. Each is kept as it came, so the first and the latest both stay answerable.',
  input: AttributionListInput,
  output: AttributionListOutput,
  permission: 'records.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const of = input.personId
      ? sql`t.person_id = ${input.personId}`
      : sql`t.conversation_id = ${input.conversationId!}`;
    const list = await rows<TouchRow>(
      ctx.tx,
      sql`select t.id, t.touched_at, t.kind, t.platform, t.channel::text as channel, t.source, t.referral_type, t.ref,
            t.ad_id, t.ad_title, t.ad_photo_url, t.post_id, t.referer_uri, t.conversation_id, t.person_id, t.lead_id,
            a.platform as account_platform, a.name as account_name, a.username as account_username,
            f.name as form_name, t.ad_ref_id,
            d.external_id as d_external_id, d.status as d_status, d.name as d_name, d.adset_id as d_adset_id,
            d.adset_name as d_adset_name, d.campaign_id as d_campaign_id, d.campaign_name as d_campaign_name,
            d.campaign_objective as d_campaign_objective, d.creative_id as d_creative_id,
            d.creative_name as d_creative_name, d.creative_title as d_creative_title,
            d.creative_body as d_creative_body, d.creative_thumbnail_url as d_creative_thumbnail_url,
            d.call_to_action as d_call_to_action, d.platforms as d_platforms
          from app.attribution_touches t
            left join app.meta_accounts a on a.id = t.meta_account_id
            left join app.ads d on d.id = t.ad_ref_id
            left join app.meta_lead_forms f on f.id = t.lead_form_id
          where t.workspace_id = ${input.workspaceId} and ${of}
          order by t.touched_at desc, t.id desc
          limit ${input.limit}`,
    );
    const [agg] = await rows<{ total: number; first: string | null; latest: string | null }>(
      ctx.tx,
      sql`select count(*)::int as total,
            (array_agg(t.id order by t.touched_at, t.id))[1] as first,
            (array_agg(t.id order by t.touched_at desc, t.id desc))[1] as latest
          from app.attribution_touches t
          where t.workspace_id = ${input.workspaceId} and ${of}`,
    );
    return {
      touches: list.map(touchOut),
      first: agg?.first ?? null,
      latest: agg?.latest ?? null,
      total: agg?.total ?? 0,
    };
  },
});

function touchOut(r: TouchRow): z.infer<typeof AttributionListOutput>['touches'][number] {
  return {
    id: r.id,
    touchedAt: iso(r.touched_at)!,
    kind: r.kind,
    platform: r.platform,
    channel: r.channel,
    source: r.source,
    referralType: r.referral_type,
    ref: r.ref,
    adId: r.ad_id,
    adTitle: r.ad_title,
    adPhotoUrl: r.ad_photo_url,
    postId: r.post_id,
    refererUri: r.referer_uri,
    conversationId: r.conversation_id,
    personId: r.person_id,
    leadId: r.lead_id,
    accountName:
      r.account_platform && r.account_name
        ? metaAccountLabel({
            platform: r.account_platform,
            name: r.account_name,
            username: r.account_username,
          })
        : null,
    formName: r.form_name?.trim() || null,
    ad:
      r.ad_ref_id && r.d_external_id && r.d_status
        ? {
            externalId: r.d_external_id,
            status: r.d_status,
            name: r.d_name,
            adsetId: r.d_adset_id,
            adsetName: r.d_adset_name,
            campaignId: r.d_campaign_id,
            campaignName: r.d_campaign_name,
            campaignObjective: r.d_campaign_objective,
            creativeId: r.d_creative_id,
            creativeName: r.d_creative_name,
            creativeTitle: r.d_creative_title,
            creativeBody: r.d_creative_body,
            creativeThumbnailUrl: r.d_creative_thumbnail_url,
            callToAction: r.d_call_to_action,
            platforms: r.d_platforms ?? [],
          }
        : null,
  };
}
