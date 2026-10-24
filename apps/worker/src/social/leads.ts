/**
 * Facebook and Instagram lead ads (funnels): what the worker does when somebody sends a business's lead ad form.
 *
 * - `meta:leadgen`: Meta's webhook named a lead (routes.ts stored it once, however often Meta said it). The lead is
 *   read with the Page's token, its form is described (its name, its questions' words and its tick boxes), and
 *   core's meta_lead.receive files it under Lead intake's "Facebook lead ad" settings.
 * - `meta.leads_plan`, hourly for the whole server, queues `meta.leads` for each business with a Page connected,
 *   which reads each Page's forms for leads sent since its last look: a webhook can be lost, and this finds what it
 *   missed. A lead already filed is filed once.
 * - Meta refusing to show a Page's leads is its sign-in not allowing them, or the Page's Leads Access keeping
 *   HandsFreeOS out. The Page is marked so and Settings says which; once it's put right, the next look finds the
 *   leads that came meanwhile.
 *
 * Nothing here runs unless the server asks Meta for lead ads (META_LEAD_ADS, on with the stand-in).
 */
import { executeCommand, metaLeadReceive, metaLeadsAccess, scheduleJob } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { metaAccounts, metaConnections } from '@hfos/db/schema';
import { and, eq, ne } from 'drizzle-orm';
import type { DeliveryContext, DeliveryProcessor } from '../deliveries';
import type { JobContext, JobHandler, JobMap } from '../jobs';
import { errorMessage } from '../outbox';
import { systemActor, tenantOf, workerMeta, type TenantScope } from '../services';
import { loadMetaAccount, openToken, type MetaAccountRow } from './accounts';
import { MetaError, type MetaLead, type MetaLeadForm } from './graph';

export const META_LEAD_JOBS = { plan: 'meta.leads_plan', catchUp: 'meta.leads' } as const;
export const META_LEADS_PLAN_KEY = 'meta:leads_plan';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
/** Each look starts a little before the last one, so a lead Meta was slow to show isn't missed. */
const OVERLAP_MS = 2 * HOUR;
/** A Page looked at for the first time: its leads from the last day. Never more than a month back. */
const FIRST_LOOK_MS = DAY;
const FURTHEST_MS = 30 * DAY;
/** The most leads one form brings in one look; the next look brings the rest. */
const LEADS_PER_FORM = 200;

type Services = DeliveryContext | JobContext;

/** Why Meta won't show a Page's leads: the sign-in never allowed it, or the Page keeps us out. */
async function markRefused(
  ctx: Services,
  scope: TenantScope,
  account: MetaAccountRow,
  err: MetaError,
): Promise<void> {
  const [signIn] = account.connectionId
    ? await asWorker(ctx.db, scope, (tx) =>
        tx
          .select({ scopes: metaConnections.scopes })
          .from(metaConnections)
          .where(eq(metaConnections.id, account.connectionId!)),
      )
    : [];
  const access = signIn?.scopes.includes('leads_retrieval') ? 'blocked' : 'not_allowed';
  ctx.log.info(
    { accountId: account.id, access, err: err.message },
    'Meta won’t show a Page’s leads',
  );
  await executeCommand(
    ctx.db,
    metaLeadsAccess,
    { workspaceId: scope.workspaceId, accountId: account.id, access },
    systemActor(scope),
    workerMeta(),
  );
}

/** One lead, filed. The form's words come with it when Meta said them; otherwise what was kept counts. */
async function fileLead(
  ctx: Services,
  scope: TenantScope,
  account: MetaAccountRow,
  lead: MetaLead,
  form: MetaLeadForm | null,
): Promise<void> {
  await executeCommand(
    ctx.db,
    metaLeadReceive,
    {
      workspaceId: scope.workspaceId,
      accountId: account.id,
      leadgenId: lead.id,
      form: {
        id: lead.formId,
        name: form?.name ?? null,
        consentBoxes: form ? form.consentBoxes.map((b) => ({ ...b })) : null,
        questions: form ? form.questions.map((q) => ({ ...q })) : [],
      },
      platform: lead.platform,
      adId: lead.adId,
      organic: lead.organic,
      createdAt: lead.createdAt,
      answers: lead.answers.map((a) => ({ name: a.name, values: [...a.values] })),
      consents: lead.consents.map((c) => ({ ...c })),
    },
    systemActor(scope),
    workerMeta(),
  );
}

/** `meta:leadgen`: one lead Meta's webhook named (routes.ts). */
export const onMetaLeadgen: DeliveryProcessor = async (ctx) => {
  const { workspaceId, organizationId } = ctx.delivery;
  const p = ctx.delivery.params as Readonly<Record<string, string | undefined>>;
  if (!workspaceId || !organizationId || !p.accountId || !p.leadgenId) return 'ignored';
  if (!ctx.social.graph.leadAds) return 'ignored';
  const scope = { workspaceId, organizationId };
  const loaded = await asWorker(ctx.db, scope, (tx) =>
    loadMetaAccount(tx, ctx.sealer, scope.workspaceId, p.accountId!),
  );
  // Meta keeps sending for a while after a Page is let go.
  if (!loaded || loaded.account.status === 'disconnected' || !loaded.pageToken) return 'ignored';
  const { account, pageToken } = loaded;
  let lead: MetaLead;
  try {
    lead = await ctx.social.graph.lead({ leadId: p.leadgenId, pageToken });
  } catch (e) {
    if (!(e instanceof MetaError) || e.retryable) throw e;
    if (e.kind === 'permission') await markRefused(ctx, scope, account, e);
    // A sign-in that stopped working is the daily check's to report; the hourly look finds this lead once it's mended.
    else ctx.log.info({ err: e.message }, 'a lead Meta named could not be read');
    return 'ignored';
  }
  const form = await ctx.social.graph
    .leadForm({ formId: lead.formId, pageToken })
    .catch((e: unknown) => {
      if (e instanceof MetaError && e.retryable) throw e;
      // Without the form's words its answers keep Meta's names, and the boxes kept from before count.
      ctx.log.info({ err: errorMessage(e) }, 'a lead form could not be described');
      return null;
    });
  await fileLead(ctx, scope, account, lead, form);
};

/** Hourly: each business with a Page connected gets its look for leads the webhook missed. */
export const metaLeadsPlan: JobHandler = async (ctx) => {
  const next = { rescheduleAt: new Date(ctx.now + HOUR) };
  if (!ctx.social.graph.leadAds) return next;
  const businesses = await asWorker(ctx.db, {}, (tx) =>
    rows<{ workspace_id: string; organization_id: string }>(
      tx,
      sql`select workspace_id, organization_id from private.meta_account_workspaces()`,
    ),
  );
  for (const b of businesses)
    try {
      await asWorker(
        ctx.db,
        { workspaceId: b.workspace_id, organizationId: b.organization_id },
        (tx) =>
          scheduleJob(
            tx,
            {
              kind: META_LEAD_JOBS.catchUp,
              dedupeKey: `${META_LEAD_JOBS.catchUp}:${b.workspace_id}`,
              runAt: new Date(ctx.now),
              payload: {},
              workspaceId: b.workspace_id,
              organizationId: b.organization_id,
            },
            { pullEarlier: true },
          ),
      );
    } catch (e) {
      ctx.log.warn(
        { workspaceId: b.workspace_id, err: errorMessage(e) },
        'could not queue a business’s look for missed leads',
      );
    }
  return next;
};

/** One business's Pages, each once (by its Facebook Page, else its Instagram account), read for missed leads. */
export const metaLeadsCatchUp: JobHandler = async (ctx) => {
  if (!ctx.social.graph.leadAds) return;
  const scope = tenantOf(ctx.scope);
  const list = await asWorker(ctx.db, scope, (tx) =>
    tx
      .select()
      .from(metaAccounts)
      .where(
        and(
          eq(metaAccounts.workspaceId, scope.workspaceId),
          ne(metaAccounts.status, 'disconnected'),
        ),
      ),
  );
  const byPage = new Map<string, MetaAccountRow>();
  for (const a of list.sort(
    (x, y) => (x.platform === 'facebook' ? -1 : 0) - (y.platform === 'facebook' ? -1 : 0),
  ))
    if (!byPage.has(a.pageId)) byPage.set(a.pageId, a);
  for (const account of byPage.values())
    try {
      await catchUpPage(ctx, scope, account);
    } catch (e) {
      // Meta not answering this hour: the next look starts from the last one that worked.
      ctx.log.warn(
        { accountId: account.id, err: errorMessage(e) },
        'could not look for missed leads',
      );
    }
};

async function catchUpPage(
  ctx: JobContext,
  scope: TenantScope,
  account: MetaAccountRow,
): Promise<void> {
  const pageToken = openToken(ctx.sealer, account.tokenEnc);
  if (!pageToken) return;
  const since = new Date(
    Math.max(
      account.leadsCheckedAt
        ? account.leadsCheckedAt.getTime() - OVERLAP_MS
        : ctx.now - FIRST_LOOK_MS,
      ctx.now - FURTHEST_MS,
    ),
  );
  let forms: readonly MetaLeadForm[];
  try {
    forms = await ctx.social.graph.leadForms({ pageId: account.pageId, pageToken });
  } catch (e) {
    if (e instanceof MetaError && e.kind === 'permission') {
      await markRefused(ctx, scope, account, e);
      return;
    }
    throw e;
  }
  let read = false;
  for (const form of forms) {
    if (form.status && form.status !== 'ACTIVE') continue;
    let leads: readonly MetaLead[];
    try {
      leads = await ctx.social.graph.formLeads({
        formId: form.id,
        pageToken,
        since,
        limit: LEADS_PER_FORM,
      });
    } catch (e) {
      if (e instanceof MetaError && e.kind === 'permission') {
        await markRefused(ctx, scope, account, e);
        return;
      }
      throw e;
    }
    read = true;
    for (const lead of leads)
      try {
        await fileLead(ctx, scope, account, lead, form);
      } catch (e) {
        ctx.log.warn({ leadId: lead.id, err: errorMessage(e) }, 'a missed lead could not be filed');
      }
  }
  await executeCommand(
    ctx.db,
    metaLeadsAccess,
    {
      workspaceId: scope.workspaceId,
      accountId: account.id,
      ...(read ? { access: 'ok' as const } : {}),
      checked: true,
    },
    systemActor(scope),
    workerMeta(),
  );
}

export const metaLeadJobs: JobMap = {
  [META_LEAD_JOBS.plan]: metaLeadsPlan,
  [META_LEAD_JOBS.catchUp]: metaLeadsCatchUp,
};
