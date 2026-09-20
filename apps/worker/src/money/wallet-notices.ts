/**
 * What a business is told about its own balance, by email (M16).
 *
 * **Why an email at all**, when there is already a card in the Action Center and a push. Because neither is
 * guaranteed to arrive. The `wallet` push switch is a boolean a person can turn off, and at zero we
 * deliberately do not send a text — spending money to tell somebody they have none is absurd, and on an empty
 * balance it would not go out anyway. Without this, a business whose phone had stopped could have nothing but
 * a card in an app nobody had opened that day. The terms now say we tell them why rather than failing quietly.
 *
 * **One crossing is one email.** The wallet has carried `low_warned_at` and `warn_fingerprint` since step 2
 * for exactly this, and until now nothing wrote them — which also meant the Action Center's card always looked
 * brand new, because it reads `low_warned_at` as "since when". Writing the fingerprint here fixes both: the
 * email goes once per crossing, and the card can finally say how long this has been going on. A top-up that
 * works clears them (`wallet.record_recharge`), so the next crossing is a new warning rather than a silent one.
 *
 * **Nothing goes out at stage `off`.** Same rule as every other channel: `WALLET_MODE` decides whether we
 * count, the stage decides whether we speak. During a shadow week every balance in the system crosses zero and
 * not one of these is sent.
 *
 * The third thing we email about a balance — a top-up bigger than the business chose — lives in `recharge.ts`
 * instead, because it is part of making the charge rather than a warning about one.
 */
import { asWorker, rows, sql } from '@hfos/db/client';
import { walletCardDeclinedEmail, walletEmptyEmail } from '../emails/templates';
import { managers } from '../handlers/telephony';
import type { EventHandler } from '../handlers/types';
import { tenantOf, type TenantScope } from '../services';

interface NoticeWallet extends Record<string, unknown> {
  stage: string;
  balance_cents: number | string;
  has_card: boolean;
  auto_topup: boolean;
  suspended_reason: string | null;
  warn_fingerprint: string | null;
}

/**
 * What this warning is about, so the same trouble twice is one email and a *different* trouble is a new one.
 * The balance is deliberately not in it: a business sliding from -$2 to -$40 has not had a new problem, it has
 * had the same one for longer, and an email per text would be its own kind of failure.
 */
const fingerprintOf = (kind: 'empty' | 'declined', w: NoticeWallet): string =>
  kind === 'declined' ? `declined:${w.suspended_reason ?? 'no reason'}` : 'empty';

async function loadWallet(
  ctx: Parameters<EventHandler>[0],
  ws: string,
): Promise<NoticeWallet | null> {
  const [w] = await rows<NoticeWallet>(
    ctx.tx,
    sql`select stage::text as stage, balance_cents, method_token is not null as has_card, auto_topup,
          suspended_reason, warn_fingerprint
        from app.usage_wallets where workspace_id = ${ws}`,
  );
  return w ?? null;
}

/**
 * Send one, once. Returns without sending when the business is not on the wallet, when this exact trouble has
 * already been reported, or when there is nobody to tell.
 */
async function notice(
  ctx: Parameters<EventHandler>[0],
  scope: TenantScope,
  kind: 'empty' | 'declined',
): Promise<void> {
  const w = await loadWallet(ctx, scope.workspaceId);
  if (!w || w.stage === 'off') return;
  const fingerprint = fingerprintOf(kind, w);
  if (w.warn_fingerprint === fingerprint) return;

  const [ws] = await rows<{ name: string }>(
    ctx.tx,
    sql`select name from app.workspaces where id = ${scope.workspaceId}`,
  );
  const business = ws?.name ?? 'your business';
  const link = `${ctx.webUrl}/app/w/${scope.workspaceId}/settings/usage`;
  const stopping = w.stage === 'enforce';
  const mail =
    kind === 'declined'
      ? walletCardDeclinedEmail({ business, reason: w.suspended_reason, stopping, link })
      : walletEmptyEmail({
          business,
          balanceCents: Number(w.balance_cents),
          hasCard: w.has_card,
          autoTopup: w.auto_topup,
          stopping,
          link,
        });

  const to = await managers(ctx.tx, scope.workspaceId);
  if (to.length === 0) return;

  /**
   * Marked before the send, in a transaction of its own, and both halves of that are deliberate.
   *
   * **Before**, because a mailer that dies halfway through a list must not mean everybody gets it again on
   * the next crossing. One person missing an email is a smaller failure than everyone getting three.
   *
   * **Its own transaction**, even though `ctx.tx` is already the worker's, because an outbox event runs every
   * one of its handlers in one transaction and retries all of them together. If the mark rode along and a
   * later handler threw, the mark would roll back while the emails had already gone — and the retry would
   * send them a second time. Marking separately means the worst case is a fingerprint set for a crossing
   * whose other handlers failed, which costs nothing: the next *different* crossing writes a new fingerprint,
   * and a top-up that works clears it.
   */
  await asWorker(ctx.db, scope, (tx) =>
    tx.execute(
      sql`update app.usage_wallets
          set warn_fingerprint = ${fingerprint}, low_warned_at = coalesce(low_warned_at, now())
          where workspace_id = ${scope.workspaceId}`,
    ),
  );
  for (const r of to) await ctx.mailer.send({ to: r.email, ...mail });
}

/** `wallet.empty`: the balance crossed zero. */
export const onWalletEmptyNotice: EventHandler = async (ctx) => {
  const { workspaceId, organizationId } = ctx.scope;
  if (!workspaceId || !organizationId) return;
  await notice(ctx, tenantOf(ctx.scope), 'empty');
};

/** `wallet.suspended`: the decline ladder ran out of rungs and there is nothing automatic left to try. */
export const onWalletDeclinedNotice: EventHandler = async (ctx) => {
  const { workspaceId, organizationId } = ctx.scope;
  if (!workspaceId || !organizationId) return;
  await notice(ctx, tenantOf(ctx.scope), 'declined');
};
