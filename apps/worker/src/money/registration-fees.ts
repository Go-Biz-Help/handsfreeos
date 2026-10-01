/**
 * The carriers' fees for texting from a local number (A2P 10DLC), on the wallet at exactly what they cost us.
 *
 * Twilio charges us The Campaign Registry's and the carriers' fees as a business registers, and nothing passed
 * them on before: the nightly reconciliation saw `a2p-registration-fees`, didn't know it, and only said so. They
 * are charged here when they happen, priced by the card like every other event:
 *
 * - **The brand**, once, when it's first sent. Sending a turned-down brand again keeps its sid and is free at
 *   Twilio (three times), so the key, which is the brand's sid, makes it free here too.
 * - **The brand's extra check** (secondary vetting), once, unless the business sends under 1,000 texts a month.
 *   That is the `SkipAutomaticSecVet` choice `telephony/twilio.ts` makes when it sends the brand.
 * - **The campaign review**, each time a campaign is sent. A turned-down campaign is replaced by a new one with a
 *   new sid, and Twilio charges the review again, so this does too.
 * - **The campaign**, a month at a time from the day it's approved, for as long as it stays registered: at
 *   approval (`chargeCampaignMonths` from the status change), then a daily sweep for every business with one.
 *
 * **Months follow the campaign, not the calendar.** Twilio charges on the day of the month the campaign was
 * approved, so each month's row is dated to the day its period began. The first row for a campaign is the
 * anchor the later ones count from, which keeps a replaced campaign on its own approval day rather than the
 * first one's.
 *
 * Like every charge, these never stop anything: a charge that can't be written is logged and lost, and the
 * registration goes ahead regardless.
 */
import {
  a2pBrandUsageKey,
  a2pBrandVettingUsageKey,
  a2pCampaignMonthUsageKey,
  a2pCampaignVettingUsageKey,
  campaignPeriod,
  type UsagePart,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobHandler } from '../jobs';
import type { TenantScope } from '../services';
import type { RegistrationKind } from '../telephony/provider';
import { chargeUsage, type WalletDeps } from './wallet';

/** What the statement says for each fee. */
export const REGISTRATION_FEE_SUBJECTS = {
  brand: 'Registering your business for texting',
  vetting: 'Extra check on your business for texting',
  review: 'The carriers reviewing your texts',
  month: (startsAt: Date) =>
    `Texting registration, the month from ${startsAt.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    })}`,
} as const;

export interface RegistrationSent {
  readonly kind: RegistrationKind;
  /** The sid the carrier gave what was just sent: the brand's, or the new campaign's. */
  readonly providerSid: string;
  /** True when this sent a turned-down brand again, which keeps its sid and is free. */
  readonly again: boolean;
  /** The business's own answer, `under_1000` and up. Anything else gets the brand's extra check. */
  readonly monthlyVolume?: string | null;
  readonly registrationId: string;
}

/** Charges what sending a registration step cost us. Nothing for the steps that are free. */
export async function chargeRegistrationSent(
  deps: WalletDeps,
  scope: TenantScope,
  sent: RegistrationSent,
): Promise<void> {
  const one = (key: UsagePart['key'], idempotencyKey: string, subject: string) =>
    chargeUsage(deps, scope, {
      parts: [{ key, quantity: 1 }],
      idempotencyKey,
      subject,
      providerRef: sent.providerSid,
      meta: { registration_id: sent.registrationId },
    });
  if (sent.kind === 'a2p_brand') {
    if (sent.again) return;
    await one(
      'a2p.brand.registration',
      a2pBrandUsageKey(sent.providerSid),
      REGISTRATION_FEE_SUBJECTS.brand,
    );
    if (sent.monthlyVolume !== 'under_1000')
      await one(
        'a2p.brand.vetting',
        a2pBrandVettingUsageKey(sent.providerSid),
        REGISTRATION_FEE_SUBJECTS.vetting,
      );
    return;
  }
  if (sent.kind === 'a2p_campaign')
    await one(
      'a2p.campaign.vetting',
      a2pCampaignVettingUsageKey(sent.providerSid),
      REGISTRATION_FEE_SUBJECTS.review,
    );
}

/**
 * Charges the month a business's campaign is in, if it has an approved one and hasn't paid for this month yet.
 * `justApproved` is the status change itself: a campaign with no month charged yet counts from now rather than
 * from `approved_at`, which keeps the first approval of the registration and not this campaign's.
 */
export async function chargeCampaignMonths(
  deps: WalletDeps,
  scope: TenantScope,
  now: number,
  justApproved = false,
): Promise<boolean> {
  if (deps.mode === 'off') return false;
  const found = await asWorker(deps.db, scope, async (tx) => {
    // The registration's latest campaign row, which is the one the app treats as current, in an open account.
    const [campaign] = await rows<{
      id: string;
      status: string;
      provider_sid: string | null;
      approved_at: Date | string | null;
    }>(
      tx,
      sql`select r.id, r.status::text as status, r.provider_sid, r.approved_at
          from app.telephony_registrations r
          join app.telephony_accounts a on a.workspace_id = r.workspace_id and a.status <> 'closed'
          where r.workspace_id = ${scope.workspaceId} and r.kind = 'a2p_campaign'
          order by r.created_at desc
          limit 1`,
    );
    if (!campaign || campaign.status !== 'approved' || !campaign.provider_sid) return null;
    const [first] = await rows<{ occurred_at: Date | string }>(
      tx,
      sql`select occurred_at from app.usage_ledger
          where workspace_id = ${scope.workspaceId} and rate_key = 'a2p.campaign.month'
            and provider_ref = ${campaign.provider_sid}
          order by occurred_at
          limit 1`,
    );
    return { campaign, first: first?.occurred_at ?? null };
  });
  if (!found) return false;
  const { campaign, first } = found;
  const anchor = first
    ? new Date(first)
    : justApproved
      ? new Date(now)
      : campaign.approved_at
        ? new Date(campaign.approved_at)
        : null;
  if (!anchor) return false;
  const period = campaignPeriod(anchor, now);
  if (!period) return false;
  const charged = await chargeUsage(deps, scope, {
    parts: [{ key: 'a2p.campaign.month', quantity: 1 }],
    idempotencyKey: a2pCampaignMonthUsageKey(campaign.provider_sid!, period.month),
    subject: REGISTRATION_FEE_SUBJECTS.month(period.startsAt),
    providerRef: campaign.provider_sid,
    // Dated to the day its month began, so the next month counts from the same day.
    occurredAt: period.startsAt,
    meta: { registration_id: campaign.id, month: period.month },
  });
  return charged.recorded;
}

/** Every business with an approved campaign has this month's fee charged. Returns how many were charged. */
export async function chargeAllCampaignMonths(deps: WalletDeps, now: number): Promise<number> {
  if (deps.mode === 'off') return 0;
  const live = await asWorker(deps.db, {}, (tx) =>
    rows<{ workspace_id: string; organization_id: string }>(
      tx,
      sql`select workspace_id, organization_id from private.a2p_campaigns_live()`,
    ),
  );
  let charged = 0;
  for (const b of live) {
    const scope: TenantScope = { workspaceId: b.workspace_id, organizationId: b.organization_id };
    try {
      if (await chargeCampaignMonths(deps, scope, now)) charged++;
    } catch (e) {
      deps.log.error(
        { err: e, workspaceId: scope.workspaceId },
        'could not charge a campaign’s month',
      );
    }
  }
  return charged;
}

/** The job: daily, for the whole server. A month starts on a day, so once a day is soon enough. */
export const REGISTRATION_FEE_JOBS = { months: 'wallet.campaign_months' } as const;
export const CAMPAIGN_MONTHS_KEY = 'wallet:campaign-months';
const EVERY_MS = 24 * 60 * 60_000;

export const nextCampaignMonthsAt = (now: number): Date => new Date(now + EVERY_MS);

export const runCampaignMonths: JobHandler = async (ctx) => {
  await chargeAllCampaignMonths(ctx.wallet, ctx.now);
  return { rescheduleAt: nextCampaignMonthsAt(ctx.now) };
};
