/**
 * Texting registrations, looked at again every few hours, whether or not anything told us they changed.
 *
 * The 15-minute `registration.poll` asks Twilio about each step in review, and Twilio sends no webhook for a brand
 * or a campaign, so that poll is the only way HandsFreeOS hears. Two things slipped past it:
 *
 * - **A poll that stopped.** Five failed tries in a row (a short Twilio outage, a refused token) and the job is
 *   failed for good, so a campaign the carriers approve sits on "In review" and nobody gets the email. A poll that
 *   saw a step approved but then failed to send the next one stops the same way, with the next step never sent.
 * - **An approval taken back.** Once approved, a brand, campaign or toll-free verification was never asked about
 *   again, so one the carriers suspended later went unnoticed while every text failed.
 *
 * So every three hours `registration.sweep` gives each business with a registration in review, or an approved one
 * texting stands on, its own `registration.check`. That job runs in the business's own scope (and with a practice
 * business's stand-ins, at the job runner's door). It walks the chain again (`advanceRegistrations`, safe at any
 * time: it starts a poll that stopped and sends a step that is ready), and asks Twilio about each approved step.
 * One the carriers took back is marked turned down, which emails owners and admins and shows on the texting page.
 */
import {
  executeCommand,
  latestByKind,
  loadRegistrations,
  registrationUpdateStatus,
} from '@hfos/core/server';
import { asWorker, sql } from '@hfos/db/client';
import { telephonyAccounts } from '@hfos/db/schema';
import { eq } from 'drizzle-orm';
import { advanceRegistrations } from '../handlers/telephony';
import type { JobHandler } from '../jobs';
import { errorMessage } from '../outbox';
import { systemActor, tenantOf, workerMeta } from '../services';
import { loadAccount } from './accounts';
import type { RegistrationKind } from './provider';

export const REGISTRATION_CHECK_JOBS = {
  /** Every three hours: which businesses to look at. */
  sweep: 'registration.sweep',
  /** One business's registrations. */
  check: 'registration.check',
} as const;
export const REGISTRATION_SWEEP_KEY = 'sweep:registrations';
/** The first sweep after the worker starts. */
export const REGISTRATION_FIRST_SWEEP_MS = 5 * 60_000;
const SWEEP_EVERY_MS = 3 * 60 * 60_000;
/** Each business's check lands somewhere in the ten minutes after the sweep, so Twilio isn't asked all at once. */
const SPREAD_MS = 10 * 60_000;

const REVIEWING = new Set(['submitted', 'in_review']);
/** The approved steps texting stands on, which the carriers can still take back. */
const RECHECKED = new Set<string>(['a2p_brand', 'a2p_campaign', 'toll_free_verification']);

export const sweepRegistrations: JobHandler = async (ctx) => {
  await asWorker(ctx.db, {}, (tx) =>
    tx.execute(
      sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
          select r.organization_id, r.workspace_id, ${REGISTRATION_CHECK_JOBS.check},
            'registration-check:' || r.workspace_id::text,
            now() + (abs(hashtext(r.workspace_id::text)::bigint) % ${SPREAD_MS}::bigint)
              * interval '1 millisecond',
            '{}'::jsonb
          from private.registrations_to_check() r
          on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null do nothing`,
    ),
  );
  return { rescheduleAt: new Date(Date.now() + SWEEP_EVERY_MS) };
};

export const checkRegistrations: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const [regs, accountRow, account] = await asWorker(
    ctx.db,
    scope,
    async (tx) =>
      [
        await loadRegistrations(tx, scope.workspaceId),
        (
          await tx
            .select({ status: telephonyAccounts.status })
            .from(telephonyAccounts)
            .where(eq(telephonyAccounts.workspaceId, scope.workspaceId))
        )[0],
        await loadAccount(tx, scope.workspaceId, ctx.sealer),
      ] as const,
  );
  // Phone & texting turned off: the subaccount is closed, and walking the chain would only make a new one.
  if (accountRow?.status === 'closed') return;
  const latest = [...latestByKind(regs).values()];

  // Anything still with the carriers keeps being asked about, and a step that's ready goes.
  if (latest.some((r) => REVIEWING.has(r.status))) {
    try {
      await advanceRegistrations(ctx, scope);
    } catch (e) {
      ctx.log.warn({ err: errorMessage(e) }, 'could not walk the texting registration again');
    }
  }

  if (!account) return;
  for (const reg of latest) {
    if (reg.status !== 'approved' || !RECHECKED.has(reg.kind) || !reg.providerSid) continue;
    let state;
    try {
      state = await ctx.telephony.fetchRegistration(account, {
        kind: reg.kind as RegistrationKind,
        providerSid: reg.providerSid,
      });
    } catch (e) {
      // Twilio not answering for one business waits for the next sweep; the others go on.
      ctx.log.warn(
        { registrationId: reg.id, kind: reg.kind, err: errorMessage(e) },
        'could not ask the carrier about an approved texting registration',
      );
      continue;
    }
    // Only a clear "no" changes anything. A status we don't know reads as in review, and an approved step is
    // never moved back to waiting on a word we can't read.
    if (state.status !== 'rejected' && state.status !== 'failed') continue;
    ctx.log.warn(
      { registrationId: reg.id, kind: reg.kind, providerStatus: state.providerStatus },
      'the carriers took back an approved texting registration',
    );
    await executeCommand(
      ctx.db,
      registrationUpdateStatus,
      {
        workspaceId: scope.workspaceId,
        registrationId: reg.id,
        status: state.status,
        providerStatus: state.providerStatus,
        rejectionReason: state.rejectionReason,
        nextPollAt: null,
      },
      systemActor(scope),
      workerMeta(),
    );
  }
};

export const registrationCheckJobs = {
  [REGISTRATION_CHECK_JOBS.sweep]: sweepRegistrations,
  [REGISTRATION_CHECK_JOBS.check]: checkRegistrations,
};
