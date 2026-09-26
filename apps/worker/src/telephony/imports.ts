/**
 * Watching for a number that is on its way here inside Twilio (20261010000900).
 *
 * A business asks for its number to be sent — from its own Twilio account, or by HighLevel's support for an LC
 * Phone number — into the workspace's own subaccount. Twilio's API only moves numbers between accounts under
 * one parent, so the sending is theirs; this file is the other half: **look in the subaccount until the number
 * is there, then set it up without anybody pressing anything.**
 *
 * Setting it up is the same three things a bought number gets, done after the fact because a transferred number
 * arrives still pointed at its old owner (HighLevel, usually):
 *
 *   1. our SMS, voice and status webhooks on the number, with the old owner's apps and fallbacks cleared;
 *   2. the number on the workspace's messaging service, which is what lets it send — and what puts it under the
 *      workspace's 10DLC campaign, if it has one;
 *   3. `number_import.complete`, which makes it one of the business's numbers.
 *
 * **What this never does is register the number for texting.** HighLevel's A2P registration is HighLevel's
 * brand's and does not move with the number; the workspace's own lives on app.telephony_registrations and is
 * shown beside the import, not folded into it.
 *
 * Every provider call is a job, never an outbox handler, as with ports. And the job **never gives up on its
 * own**: a transfer can take a week because somebody forgot to send the request, and a watch that died after
 * five failed looks would leave the number arriving with nobody listening. Trouble is written on the import
 * for the business to see, and the next look is scheduled regardless.
 */
import {
  carrierIsTwilio,
  executeCommand,
  nextImportCheckMs,
  numberImportComplete,
  numberImportFail,
  numberImportRecordCheck,
  numberTypeOf,
  scheduleJob,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { eq } from 'drizzle-orm';
import { numberImports } from '@hfos/db/schema';
import type { EventHandler, HandlerContext } from '../handlers/types';
import type { JobHandler, JobMap } from '../jobs';
import { errorMessage } from '../outbox';
import {
  systemActor,
  tenantOf,
  workerMeta,
  type TenantScope,
  type WorkerServices,
} from '../services';
import { ensureAccount, webhookUrls } from './accounts';
import { ProviderError, type ProviderAccount } from './provider';

export const IMPORT_JOBS = { check: 'number_import.check' } as const;

type ImportRow = typeof numberImports.$inferSelect;

const readImport = (services: WorkerServices, scope: TenantScope, importId: string) =>
  asWorker(services.db, scope, async (tx) => {
    const [row] = await tx.select().from(numberImports).where(eq(numberImports.id, importId));
    return row;
  });

/** Looks now: when an import starts, and when a person says it should be there. */
async function lookNow(ctx: HandlerContext, correlationId: string | null): Promise<void> {
  const { workspaceId, organizationId } = ctx.scope;
  const importId = ctx.event.entityId;
  if (!workspaceId || !organizationId || !importId) return;
  await scheduleJob(
    ctx.tx,
    {
      kind: IMPORT_JOBS.check,
      dedupeKey: `import:${importId}`,
      runAt: new Date(),
      payload: { importId, correlationId },
      workspaceId,
      organizationId,
    },
    // "It should be there now" pulls the next look forward rather than waiting behind it.
    { pullEarlier: true },
  );
}

export const onImportStarted: EventHandler = (ctx) => lookNow(ctx, ctx.event.correlationId);
export const onImportCheckRequested: EventHandler = (ctx) => lookNow(ctx, ctx.event.correlationId);

/** What a business is told when something stopped one look. Always says the next one is coming. */
const TROUBLE = {
  account:
    'We could not get your HandsFreeOS Twilio account ready yet, so there is nowhere to send the number to. We are still trying.',
  look: 'We could not reach Twilio to look for the number just now. We will look again shortly.',
  setup:
    'The number has arrived, but we could not point it at HandsFreeOS yet. We are still trying — nothing has changed for your customers.',
} as const;

/**
 * Who hosts the number, once. For a number picked from a connected Twilio account the answer is already known
 * — it is sitting in a Twilio account — so nothing is spent asking. A lookup that fails is simply asked again
 * next time: it is information for the business, never a reason to stop watching.
 */
async function carrierOf(
  services: WorkerServices,
  row: ImportRow,
): Promise<{ name: string | null; hostedInTwilio: boolean } | null> {
  if (row.lookedUpAt) return null;
  if (row.connectionId) return { name: 'Twilio', hostedInTwilio: true };
  try {
    const found = await services.telephony.lookupNumber(row.e164);
    return { name: found.carrierName, hostedInTwilio: carrierIsTwilio(found.carrierName) };
  } catch (e) {
    services.log.warn(
      { importId: row.id, err: errorMessage(e) },
      'the carrier lookup did not answer',
    );
    return null;
  }
}

/** Writes one look down, and says when the next one is. */
async function record(
  services: WorkerServices,
  scope: TenantScope,
  row: ImportRow,
  input: {
    readonly account: ProviderAccount | null;
    readonly carrier: { name: string | null; hostedInTwilio: boolean } | null;
    readonly lastError: string | null;
  },
): Promise<{ rescheduleAt: Date }> {
  const at = new Date(
    Date.now() +
      nextImportCheckMs({
        startedAt: row.createdAt,
        now: Date.now(),
        baseMs: services.numberImportPollMs,
      }),
  );
  await executeCommand(
    services.db,
    numberImportRecordCheck,
    {
      workspaceId: scope.workspaceId,
      importId: row.id,
      destination: input.account
        ? { accountId: input.account.id, accountSid: input.account.sid }
        : null,
      carrier: input.carrier,
      lastError: input.lastError,
      nextPollAt: at.toISOString(),
    },
    systemActor(scope),
    workerMeta(),
  );
  return { rescheduleAt: at };
}

/**
 * Another business still holds this number live. It cannot be both theirs and this one's, and routing reads
 * one row per number, so this one stops and says why rather than taking the number off them.
 */
async function heldElsewhere(
  services: WorkerServices,
  scope: TenantScope,
  e164: string,
): Promise<boolean> {
  const held = await asWorker(services.db, {}, (tx) =>
    rows<{ workspace_id: string }>(
      tx,
      sql`select workspace_id from private.number_held_by(${e164})`,
    ),
  );
  return held.some((h) => h.workspace_id !== scope.workspaceId);
}

/** Looks for the number in the workspace's subaccount, and sets it up the moment it is there. */
export const importCheck: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const importId = String(ctx.job.payload['importId'] ?? '');
  const row = await readImport(ctx, scope, importId);
  if (!row || row.status !== 'waiting') return;

  const carrier = await carrierOf(ctx, row);

  // Where it is going. Made now if this is the business's first number, so the page can say where to send it
  // before anything has been sent.
  let account: ProviderAccount;
  try {
    account = await ensureAccount(ctx, scope);
  } catch (e) {
    ctx.log.warn({ importId: row.id, err: errorMessage(e) }, 'no subaccount to receive the number');
    return record(ctx, scope, row, { account: null, carrier, lastError: TROUBLE.account });
  }

  let owned;
  try {
    owned = await ctx.telephony.findOwnedNumber(account, row.e164);
  } catch (e) {
    ctx.log.warn({ importId: row.id, err: errorMessage(e) }, 'could not look for the number');
    return record(ctx, scope, row, { account, carrier, lastError: TROUBLE.look });
  }
  if (!owned) return record(ctx, scope, row, { account, carrier, lastError: null });

  // It is here. Nothing below is allowed to leave it half set up and the import saying "waiting" with no
  // reason: every failure is written down and looked at again.
  if (await heldElsewhere(ctx, scope, row.e164)) {
    ctx.log.warn({ importId: row.id }, 'the number arrived but another business still holds it');
    await executeCommand(
      ctx.db,
      numberImportFail,
      {
        workspaceId: scope.workspaceId,
        importId: row.id,
        reason:
          'The number arrived, but another business on HandsFreeOS still has it. Contact support and we will sort out which business it belongs to.',
      },
      systemActor(scope),
      workerMeta(),
    );
    return;
  }
  try {
    await ctx.telephony.configureNumber(account, owned.sid, webhookUrls(ctx.publicUrl));
    if (account.messagingServiceSid)
      await ctx.telephony.addNumberToService(account, account.messagingServiceSid, owned.sid);
  } catch (e) {
    ctx.log.warn(
      {
        importId: row.id,
        err: errorMessage(e),
        code: e instanceof ProviderError ? e.code : undefined,
      },
      'the number arrived but could not be set up',
    );
    return record(ctx, scope, row, { account, carrier, lastError: TROUBLE.setup });
  }
  await executeCommand(
    ctx.db,
    numberImportComplete,
    {
      workspaceId: scope.workspaceId,
      importId: row.id,
      accountId: account.id,
      providerSid: owned.sid,
      numberType: numberTypeOf(row.e164),
      capabilities: { ...owned.capabilities },
    },
    systemActor(scope),
    workerMeta(),
  );
  ctx.log.info({ importId: row.id }, 'a number brought over from Twilio is set up');
};

export const importJobs: JobMap = {
  [IMPORT_JOBS.check]: importCheck,
};
