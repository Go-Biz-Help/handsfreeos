/**
 * Asking the phone company what a number is, just before an AI call to someone with no written yes (AI calls,
 * part 5): with **Call business landlines without a yes** on, the call goes only to a business landline (core's
 * business-line.ts).
 *
 * The line type first. Then, only for a landline that isn't a company's number in HandsFreeOS, who it's registered
 * to. Each is a Twilio Lookup request on the business's own subaccount, charged to its wallet as it's made, and kept
 * after each (`app.phone_line_checks`), so a retry doesn't ask again what it already knows. A number Twilio can't
 * place is kept as `unknown`, which isn't a business landline. Checks older than `LINE_CHECK_DAYS` are cleared as a
 * new one is kept.
 */
import { randomUUID } from 'node:crypto';
import {
  callerTypeOf,
  LINE_CHECK_DAYS,
  lineFactsOf,
  lineTypeOf,
  needsCallerName,
  type CallerType,
  type LineType,
} from '@hfos/core/server';
import { asWorker, sql } from '@hfos/db/client';
import type { JobContext } from '../jobs';
import { chargeLineCheck } from '../money/usage-capture';
import type { TenantScope } from '../services';
import { loadAccount } from '../telephony/accounts';
import { isPermanentProviderError } from '../telephony/provider';

/**
 * Asks what's still unknown about the number, and keeps it. False when the business has no phone account to ask
 * with (its call can't go either).
 */
export async function askPhoneCompany(
  ctx: Pick<JobContext, 'db' | 'sealer' | 'telephony' | 'wallet' | 'now'>,
  scope: TenantScope,
  e164: string,
): Promise<boolean> {
  const { workspaceId } = scope;
  const [facts, account] = await asWorker(ctx.db, scope, async (tx) => [
    await lineFactsOf(tx, workspaceId, e164, new Date(ctx.now)),
    await loadAccount(tx, workspaceId, ctx.sealer),
  ]);
  if (!account) return false;
  const checkId = randomUUID();
  let lineType: LineType | null = facts.lineType;
  let callerType: CallerType | null = facts.callerType;
  const keep = (fresh: boolean) =>
    asWorker(ctx.db, scope, async (tx) => {
      await tx.execute(
        sql`delete from app.phone_line_checks
            where workspace_id = ${workspaceId}
              and checked_at < now() - ${`${LINE_CHECK_DAYS} days`}::interval`,
      );
      await tx.execute(
        sql`insert into app.phone_line_checks (workspace_id, phone_e164, line_type, caller_type)
            values (${workspaceId}, ${e164}, ${lineType ?? 'unknown'}, ${callerType})
            on conflict (workspace_id, phone_e164) do update
              set line_type = excluded.line_type, caller_type = excluded.caller_type,
                checked_at = ${fresh ? sql`now()` : sql`app.phone_line_checks.checked_at`}`,
      );
    });

  if (lineType === null) {
    try {
      const line = await ctx.telephony.checkLine(account, e164, {
        lineType: true,
        callerName: false,
      });
      await chargeLineCheck(ctx.wallet, scope, { checkId, what: 'line_type', e164 });
      lineType = lineTypeOf(line.lineType);
    } catch (e) {
      // Anything but a number the phone company can't place is tried again later.
      if (!isPermanentProviderError(e)) throw e;
      lineType = 'unknown';
    }
    await keep(true);
  }
  if (needsCallerName({ lineType, callerType, companyNumber: facts.companyNumber })) {
    try {
      const line = await ctx.telephony.checkLine(account, e164, {
        lineType: false,
        callerName: true,
      });
      await chargeLineCheck(ctx.wallet, scope, { checkId, what: 'caller_name', e164 });
      callerType = callerTypeOf(line.callerType);
    } catch (e) {
      if (!isPermanentProviderError(e)) throw e;
      callerType = 'unknown';
    }
    await keep(false);
  }
  return true;
}
