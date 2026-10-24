/**
 * Facebook and Instagram lead ads (funnels): somebody sends the form on a business's lead ad, and they arrive here as
 * a customer and a lead, through Lead intake's own rules.
 *
 * The worker reads each lead with the Page's token, from Meta's webhook or its hourly catch-up, and hands it here
 * as Meta gave it. What happens next is intake's: the "Facebook lead ad" row's switch, pipeline and day, the
 * matching on phone and email, one lead however often Meta says it, and every other answer as a note on the
 * timeline. On top of that:
 *
 * - **A ticked box about texts** on the form is the customer's OK to text, with the form named as where it came
 *   from. Unticked leaves it as it was: the funnel's own contact step asks.
 * - **Where they came from** is a touch of its own (kind lead_form) with the ad and the form, so the customer's
 *   "Where they came from" shows it, and the ad is looked up like any other.
 * - **The form** is kept (app.meta_lead_forms), with which of its boxes are about texts, so a lead read when Meta
 *   wouldn't describe the form still counts its tick.
 *
 * The system actor only.
 */
import { and, eq, sql } from 'drizzle-orm';
import { attributionTouches, metaAccounts, metaLeadForms } from '@hfos/db/schema';
import { workspaceZone } from '../calendar/load';
import { LEAD_FORM_SOURCE } from '../crm/attribution-words';
import { ensureIntakeSource, submitIntake } from '../crm/intake';
import { recordSmsConsent } from '../crm/signup';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import {
  leadAgreedToTexts,
  leadConsentSource,
  leadPayload,
  textConsentKeys,
} from '../messaging/lead-ads';
import { channelOfPlatform, metaAccountLabel } from '../messaging/social';
import {
  MetaLeadReceiveInput,
  MetaLeadReceiveOutput,
  MetaLeadsAccessInput,
  MetaLeadsAccessOutput,
} from '../schemas/social';
import { adRow, META_ACCOUNT_COLUMNS } from './social';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

async function accountOf(ctx: CommandContext, accountId: string) {
  const [a] = await ctx.tx
    .select(META_ACCOUNT_COLUMNS)
    .from(metaAccounts)
    .where(
      and(eq(metaAccounts.id, accountId), eq(metaAccounts.workspaceId, ctx.scope.workspaceId!)),
    );
  if (!a)
    throw HfosError.notFound(
      'That Facebook Page isn’t connected to this business anymore. Connect it again in Settings → Facebook & Instagram.',
    );
  return a;
}

export const metaLeadReceive = defineCommand({
  name: 'meta_lead.receive',
  description:
    'Worker: somebody sent a Facebook or Instagram lead ad’s form. Opens the customer and their lead under Lead intake’s “Facebook lead ad” settings, records their OK to text when they ticked a box about texts, and keeps the ad they came from.',
  risk: 1,
  input: MetaLeadReceiveInput,
  output: MetaLeadReceiveOutput,
  permission: 'records.write',
  scope: inWorkspace,
  emits: ['person.created', 'lead.created', 'attribution.touched'],
  actors: ['system'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const account = await accountOf(ctx, input.accountId);
    const at = new Date(input.createdAt);

    // The form as we know it: its name and which of its boxes are about texts, kept fresh when Meta said.
    const keys = input.form.consentBoxes ? textConsentKeys(input.form.consentBoxes) : null;
    const [form] = await ctx.tx
      .insert(metaLeadForms)
      .values({
        workspaceId: ws,
        accountId: account.id,
        formId: input.form.id,
        name: input.form.name ?? '',
        textConsentKeys: keys ?? [],
        lastLeadAt: at,
      })
      .onConflictDoUpdate({
        target: [metaLeadForms.accountId, metaLeadForms.formId],
        set: {
          ...(input.form.name ? { name: input.form.name } : {}),
          ...(keys ? { textConsentKeys: keys } : {}),
          lastLeadAt: sql`greatest(${metaLeadForms.lastLeadAt}, ${at.toISOString()}::timestamptz)`,
        },
      })
      .returning({
        id: metaLeadForms.id,
        name: metaLeadForms.name,
        textConsentKeys: metaLeadForms.textConsentKeys,
      });
    await ctx.tx
      .update(metaAccounts)
      .set({
        leadsAccess: 'ok',
        lastLeadAt: sql`greatest(${metaAccounts.lastLeadAt}, ${at.toISOString()}::timestamptz)`,
      })
      .where(eq(metaAccounts.id, account.id));

    const p = leadPayload(input.answers, input.form.questions);
    const source = await ensureIntakeSource(ctx.tx, ws, 'facebook_lead_ad');
    const result = await submitIntake(ctx, {
      source,
      payload: {
        name: p.name,
        firstName: p.firstName,
        lastName: p.lastName,
        email: p.email,
        phone: p.phone,
        address: p.address,
        extra: {
          ...(form!.name ? { 'Lead form': form!.name } : {}),
          ...p.extra,
        },
      },
      dedupeKey: `fb-lead:${input.leadgenId}`,
      at,
      zone: await workspaceZone(ctx.tx, ws),
    });
    const agreed = leadAgreedToTexts(input.consents, form!.textConsentKeys);
    const out = {
      outcome: result.outcome,
      personId: result.personId,
      leadId: result.leadId,
      duplicate: result.duplicate,
      refusedReason: result.refusedReason,
      smsConsent: agreed,
    };
    if (result.duplicate || !result.personId) return out;

    if (agreed) await recordSmsConsent(ctx.tx, result.personId, leadConsentSource(form!.name));

    const adRefId = input.adId ? await adRow(ctx, input.adId) : null;
    const [touch] = await ctx.tx
      .insert(attributionTouches)
      .values({
        workspaceId: ws,
        network: 'meta',
        platform: input.platform,
        channel: channelOfPlatform(input.platform),
        touchedAt: at,
        kind: 'lead_form',
        personId: result.personId,
        metaAccountId: account.id,
        leadId: result.leadId,
        source: LEAD_FORM_SOURCE,
        adId: input.adId,
        adRefId,
        leadFormId: form!.id,
        raw: { leadgen_id: input.leadgenId, form_id: input.form.id, organic: input.organic },
        dedupeKey: `lead:${input.leadgenId}`,
      })
      .onConflictDoNothing()
      .returning({ id: attributionTouches.id });
    if (touch)
      await ctx.emit({
        type: 'attribution.touched',
        entityType: 'attribution_touch',
        entityId: touch.id,
        payload: {
          conversationId: null,
          personId: result.personId,
          leadId: result.leadId,
          platform: input.platform,
          channel: channelOfPlatform(input.platform),
          kind: 'lead_form',
          source: LEAD_FORM_SOURCE,
          adId: input.adId,
          ref: null,
        },
        after: {
          from: form!.name ? `Lead form “${form!.name.slice(0, 100)}”` : 'A lead form',
          account: metaAccountLabel(account),
        },
      });
    return out;
  },
});

export const metaLeadsAccess = defineCommand({
  name: 'meta_account.leads_access',
  description:
    'Worker: whether a Facebook Page’s lead ad leads can be read — allowed, not allowed at sign-in, or kept out by the Page’s Leads Access — and that the hourly look for missed leads ran.',
  risk: 1,
  input: MetaLeadsAccessInput,
  output: MetaLeadsAccessOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: [],
  actors: ['system'],
  async handler(ctx, input) {
    const a = await accountOf(ctx, input.accountId);
    const changed = !!input.access && input.access !== a.leadsAccess;
    if (changed || input.checked)
      await ctx.tx
        .update(metaAccounts)
        .set({
          ...(input.access ? { leadsAccess: input.access } : {}),
          ...(input.checked ? { leadsCheckedAt: new Date() } : {}),
        })
        .where(eq(metaAccounts.id, a.id));
    return { accountId: a.id, changed };
  },
});

export const metaLeadCommands = [metaLeadReceive, metaLeadsAccess];
