/**
 * The affiliate program's writes (20261027014000, HANDSFREEOS_AFFILIATES_IMPLEMENTATION_PLAN.md): people who sell
 * HandsFreeOS itself for a share of what the businesses they send pay for their plan.
 *
 * **Who may do what:**
 *
 * - **Anyone signed in** may apply for themselves (`affiliate.apply`), whether or not they have a business (decision
 *   6). They write their own row only through `private.affiliate_apply`, which refuses once somebody has decided.
 * - **Staff with `platform.affiliates.manage`** (support admins) do everything else: approve or turn down, pause, end,
 *   set the share for everyone and for one affiliate, change a link code, and credit a business by hand. Each one
 *   decides what HandsFreeOS pays out, so it isn't for whoever is answering tickets today.
 *
 * **Its events are `platform.*`**: they belong to HandsFreeOS, not to a business, and the outbox hands a handler only
 * those of them when there's no business in scope. The worker emails the person on a decision and staff on a new
 * application from them.
 *
 * Crediting a business as it's made is not here: it's `organization.create`'s own step
 * (`private.affiliate_note_signup`), in the same transaction as the business.
 */
import { rows, sql } from '@hfos/db/client';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import { affiliateRow, affiliateOfBusiness } from '../queries/affiliates';
import {
  AffiliateApplyInput,
  AffiliateApplyOutput,
  AffiliateDecideInput,
  AffiliateOutput,
  AffiliateSetBusinessInput,
  AffiliateSetBusinessOutput,
  AffiliateSetCodeInput,
  AffiliateSetRateInput,
  AffiliateSetStatusInput,
  AffiliatesSaveSettingsInput,
  AffiliatesSettingsOutput,
} from '../schemas/affiliates';

const onPlatform = () => ({ kind: 'platform' as const });

function detailOf(err: unknown): { detail: string; code: string; constraint: string } {
  let pg: unknown = err;
  while (pg instanceof Error && pg.cause instanceof Error) pg = pg.cause;
  const e = pg as { detail?: string; code?: string; constraint_name?: string } | null;
  return { detail: e?.detail ?? '', code: e?.code ?? '', constraint: e?.constraint_name ?? '' };
}

const codeTaken = (code: string) =>
  HfosError.rule(
    'affiliate_code_taken',
    409,
    `Someone already has the link code “${code}”. Pick another, like your name with a number after it.`,
  );

/** One affiliate, read as staff; refused as gone when there's no such affiliate. */
async function staffRow(ctx: CommandContext, affiliateId: string) {
  const found = await affiliateRow(ctx.tx, affiliateId);
  if (!found)
    throw HfosError.notFound(
      'That affiliate isn’t there anymore. Refresh Admin → Affiliates and try again.',
    );
  return found;
}

// ---------- applying ----------

export const affiliateApply = defineCommand({
  name: 'affiliate.apply',
  description:
    'Apply to be a HandsFreeOS affiliate: sell HandsFreeOS with your own link and earn a share of what each business you send pays for its plan in its first 12 months. While you wait, you can change what you said.',
  risk: 1,
  input: AffiliateApplyInput,
  output: AffiliateApplyOutput,
  permission: null,
  scope: () => ({ kind: 'account' as const }),
  emits: ['platform.affiliate_applied'],
  async handler(ctx, input) {
    requireHuman(ctx);
    if (!input.livesInUs)
      throw HfosError.rule(
        'affiliate_outside_us',
        409,
        'For now HandsFreeOS pays affiliates in the US only, straight to a US bank account. Other countries come later.',
      );
    let found: { affiliate_id: string; created: boolean; reapplied: boolean } | undefined;
    try {
      [found] = await rows<{ affiliate_id: string; created: boolean; reapplied: boolean }>(
        ctx.tx,
        sql`select affiliate_id, created, reapplied
            from private.affiliate_apply(${input.name}, ${input.code}, ${input.pitch}, ${input.links})`,
      );
    } catch (err) {
      const { detail, code, constraint } = detailOf(err);
      if (
        detail === 'affiliate_code_taken' ||
        (code === '23505' && constraint === 'affiliates_code_key')
      )
        throw codeTaken(input.code);
      if (detail === 'affiliate_already')
        throw HfosError.rule(
          'affiliate_already',
          409,
          'You’re already in the affiliate program, so there’s nothing to apply for. Refresh this page to see your link.',
        );
      if (detail === 'affiliate_turned_down_recently')
        throw HfosError.rule(
          'affiliate_turned_down_recently',
          409,
          'You can apply again 30 days after your last application was turned down. This page says the date.',
        );
      throw err;
    }
    if (!found)
      throw HfosError.internal(
        'Your application couldn’t be saved just now. Try again in a minute.',
      );
    await ctx.emit({
      type: 'platform.affiliate_applied',
      entityType: 'affiliate',
      entityId: found.affiliate_id,
      organizationId: null,
      workspaceId: null,
      // New, or again after being turned down: staff hear of it. A change while it waits is only kept.
      payload: {
        affiliateId: found.affiliate_id,
        created: found.created,
        reapplied: found.reapplied,
      },
      after: { name: input.name, code: input.code },
    });
    return { affiliateId: found.affiliate_id, created: found.created };
  },
});

// ---------- staff: the program ----------

export const affiliatesSaveSettings = defineCommand({
  name: 'affiliates.save_settings',
  description:
    'Set the share every affiliate earns of each plan payment, unless they have their own. It counts for payments from now on.',
  risk: 3,
  input: AffiliatesSaveSettingsInput,
  output: AffiliatesSettingsOutput,
  permission: 'platform.affiliates.manage',
  scope: onPlatform,
  emits: ['platform.affiliate_settings_saved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const [before] = await rows<{ rate_bp: number }>(
      ctx.tx,
      sql`select rate_bp from platform.affiliate_settings where id`,
    );
    if (before?.rate_bp === input.rateBp) return { rateBp: input.rateBp };
    const [after] = await rows<{ rate_bp: number }>(
      ctx.tx,
      sql`update platform.affiliate_settings set rate_bp = ${input.rateBp}, updated_by = ${me},
            updated_at = now()
          where id returning rate_bp`,
    );
    if (!after) throw HfosError.forbidden();
    await ctx.emit({
      type: 'platform.affiliate_settings_saved',
      entityType: 'affiliate_settings',
      entityId: null,
      payload: { rateBp: after.rate_bp },
      before: { rateBp: before?.rate_bp ?? null },
      after: { rateBp: after.rate_bp },
    });
    return { rateBp: after.rate_bp };
  },
});

export const affiliateDecide = defineCommand({
  name: 'affiliate.decide',
  description:
    'Approve an affiliate application, which turns their link on and emails them, or turn it down, which emails them too.',
  risk: 3,
  input: AffiliateDecideInput,
  output: AffiliateOutput,
  permission: 'platform.affiliates.manage',
  scope: onPlatform,
  emits: ['platform.affiliate_approved', 'platform.affiliate_turned_down'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const before = await staffRow(ctx, input.affiliateId);
    if (before.status !== 'applied')
      throw HfosError.rule(
        'affiliate_already_decided',
        409,
        `${before.name}’s application was already decided. Refresh Admin → Affiliates to see where they stand.`,
      );
    const status = input.decision === 'approve' ? 'approved' : 'turned_down';
    await ctx.tx.execute(
      sql`update platform.affiliates set status = ${status}, decided_at = now(), decided_by = ${me}
          where id = ${before.affiliateId}`,
    );
    await ctx.emit({
      type:
        input.decision === 'approve'
          ? 'platform.affiliate_approved'
          : 'platform.affiliate_turned_down',
      entityType: 'affiliate',
      entityId: before.affiliateId,
      payload: { affiliateId: before.affiliateId },
      before: { status: before.status },
      after: { status },
    });
    return { affiliate: await staffRow(ctx, before.affiliateId) };
  },
});

export const affiliateSetStatus = defineCommand({
  name: 'affiliate.set_status',
  description:
    'Pause an affiliate (their link stops crediting new businesses and they stop earning on new payments), bring a paused one back, or end the partnership for good.',
  risk: 3,
  input: AffiliateSetStatusInput,
  output: AffiliateOutput,
  permission: 'platform.affiliates.manage',
  scope: onPlatform,
  emits: ['platform.affiliate_status_changed'],
  async handler(ctx, input) {
    const before = await staffRow(ctx, input.affiliateId);
    if (before.status === input.status) return { affiliate: before };
    if (before.status === 'applied' || before.status === 'turned_down')
      throw HfosError.rule(
        'affiliate_not_approved',
        409,
        `${before.name} isn’t an affiliate yet. Approve their application first.`,
      );
    if (before.status === 'ended')
      throw HfosError.rule(
        'affiliate_ended',
        409,
        `${before.name}’s partnership has ended, and an ended one can’t be started again. They can apply with a new account, or ask us.`,
      );
    await ctx.tx.execute(
      sql`update platform.affiliates set status = ${input.status} where id = ${before.affiliateId}`,
    );
    await ctx.emit({
      type: 'platform.affiliate_status_changed',
      entityType: 'affiliate',
      entityId: before.affiliateId,
      payload: { affiliateId: before.affiliateId, status: input.status },
      before: { status: before.status },
      after: { status: input.status },
    });
    return { affiliate: await staffRow(ctx, before.affiliateId) };
  },
});

export const affiliateSetRate = defineCommand({
  name: 'affiliate.set_rate',
  description:
    'Give one affiliate their own share of each plan payment, or put them back on everyone’s. It counts for payments from now on.',
  risk: 3,
  input: AffiliateSetRateInput,
  output: AffiliateOutput,
  permission: 'platform.affiliates.manage',
  scope: onPlatform,
  emits: ['platform.affiliate_rate_changed'],
  async handler(ctx, input) {
    const before = await staffRow(ctx, input.affiliateId);
    if (before.ownRateBp === input.rateBp) return { affiliate: before };
    await ctx.tx.execute(
      sql`update platform.affiliates set rate_bp = ${input.rateBp} where id = ${before.affiliateId}`,
    );
    await ctx.emit({
      type: 'platform.affiliate_rate_changed',
      entityType: 'affiliate',
      entityId: before.affiliateId,
      payload: { affiliateId: before.affiliateId, rateBp: input.rateBp },
      before: { rateBp: before.ownRateBp },
      after: { rateBp: input.rateBp },
    });
    return { affiliate: await staffRow(ctx, before.affiliateId) };
  },
});

export const affiliateSetCode = defineCommand({
  name: 'affiliate.set_code',
  description:
    'Change the code an affiliate’s link carries. Their old link stops working, so tell them first.',
  risk: 3,
  input: AffiliateSetCodeInput,
  output: AffiliateOutput,
  permission: 'platform.affiliates.manage',
  scope: onPlatform,
  emits: ['platform.affiliate_code_changed'],
  async handler(ctx, input) {
    const before = await staffRow(ctx, input.affiliateId);
    if (before.code === input.code) return { affiliate: before };
    try {
      await ctx.tx.execute(
        sql`update platform.affiliates set code = ${input.code} where id = ${before.affiliateId}`,
      );
    } catch (err) {
      const { code, constraint } = detailOf(err);
      if (code === '23505' && constraint === 'affiliates_code_key') throw codeTaken(input.code);
      throw err;
    }
    await ctx.emit({
      type: 'platform.affiliate_code_changed',
      entityType: 'affiliate',
      entityId: before.affiliateId,
      payload: { affiliateId: before.affiliateId, code: input.code },
      before: { code: before.code },
      after: { code: input.code },
    });
    return { affiliate: await staffRow(ctx, before.affiliateId) };
  },
});

// ---------- staff: one business's affiliate ----------

export const affiliateSetBusiness = defineCommand({
  name: 'affiliate.set_business',
  description:
    'Credit a business to an affiliate by hand, move it to another one, or take it off the one it’s credited to.',
  risk: 3,
  input: AffiliateSetBusinessInput,
  output: AffiliateSetBusinessOutput,
  permission: 'platform.affiliates.manage',
  scope: onPlatform,
  emits: ['platform.affiliate_business_set'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const [business] = await rows<{ organization_id: string; created_by: string | null }>(
      ctx.tx,
      sql`select w.organization_id, o.created_by
          from app.workspaces w join app.organizations o on o.id = w.organization_id
          where w.id = ${input.workspaceId}`,
    );
    if (!business)
      throw HfosError.notFound(
        'That business isn’t there anymore. Refresh Admin → Businesses and try again.',
      );
    const orgId = business.organization_id;
    const before = await affiliateOfBusiness(ctx.tx, orgId);
    if ((before?.affiliateId ?? null) === input.affiliateId)
      return { organizationId: orgId, affiliate: before };

    if (input.affiliateId === null) {
      await ctx.tx.execute(
        sql`delete from platform.affiliate_referrals where organization_id = ${orgId}`,
      );
    } else {
      const to = await staffRow(ctx, input.affiliateId);
      if (to.status !== 'approved')
        throw HfosError.rule(
          'affiliate_not_approved',
          409,
          `${to.name} isn’t an approved affiliate right now, so no business can be credited to them. Approve them, or bring them back, in Admin → Affiliates first.`,
        );
      if (business.created_by && business.created_by === to.userId)
        throw HfosError.rule(
          'affiliate_own_business',
          409,
          `${to.name} made this business themselves, and nobody earns on their own business.`,
        );
      await ctx.tx.execute(
        sql`insert into platform.affiliate_referrals (organization_id, affiliate_id, how, clicked_at, marked_by)
            values (${orgId}, ${to.affiliateId}, 'by_hand', null, ${me})
            on conflict (organization_id) do update
              set affiliate_id = excluded.affiliate_id, how = 'by_hand', clicked_at = null,
                  referred_at = now(), marked_by = excluded.marked_by`,
      );
    }
    const after = await affiliateOfBusiness(ctx.tx, orgId);
    await ctx.emit({
      type: 'platform.affiliate_business_set',
      entityType: 'organization',
      entityId: orgId,
      payload: { organizationId: orgId, affiliateId: input.affiliateId },
      before: { affiliateId: before?.affiliateId ?? null },
      after: { affiliateId: input.affiliateId },
    });
    return { organizationId: orgId, affiliate: after };
  },
});

export const affiliateCommands = [
  affiliateApply,
  affiliatesSaveSettings,
  affiliateDecide,
  affiliateSetStatus,
  affiliateSetRate,
  affiliateSetCode,
  affiliateSetBusiness,
];
