/**
 * Whether a business may spend money right now (M16, step 9).
 *
 * **It fails open, always.** Any error reading the wallet — a table that is not there yet, a lock timeout, a
 * connection that dropped — logs and allows the action. This is not defensive programming for its own sake: a
 * text that does not go out because a balance could not be read is a customer who never hears back, and that
 * costs the business more than the text ever would. The wallet exists to stop *deliberate* overspending, not
 * to become a new way for the phone to stop working.
 *
 * **It reads in the caller's own transaction.** A gate that opens its own connection reads a balance from
 * before the write it is guarding, which is how two texts sent at once both pass a check for one text's worth
 * of money. That is also why this takes a `Tx` rather than a `Db`: there is no correct way to call it outside
 * the transaction that does the spending.
 *
 * **It is per business, and in two steps.** `usage_wallets.stage` starts `off` for everyone. `warn` means the
 * business is told about its balance but nothing stops; only `enforce` refuses. Nothing here refuses anything
 * until somebody moves a business along — internal first, then a cohort, then everyone.
 */
import { sql, type Tx } from '@hfos/db/client';
import { HfosError } from '../errors';

/** What is being paid for, which decides how much room is needed and what a refusal says. */
export type SpendKind = 'text' | 'call' | 'ai' | 'number';

/**
 * How far along the wallet a business is. `off` is silent, `warn` speaks, only `enforce` refuses. `agency` is a
 * business its agency pays for: silent like `off` for good, never topped up, its usage recorded all the same.
 */
export type WalletStage = 'off' | 'warn' | 'enforce' | 'agency';

/** Whether the wallet says anything to this business (balance, warnings, notices): only at `warn` and `enforce`. */
export const walletSpeaks = (stage: string | null | undefined): boolean =>
  stage === 'warn' || stage === 'enforce';

export interface WalletRoom {
  /** False only when this business is at `enforce` and the balance has run out. */
  readonly allowed: boolean;
  readonly balanceCents: number;
  /** How far under zero this business may go before outbound stops. Always 0 at `enforce`. */
  readonly overdraftCents: number;
  /** True when the wallet could not be read at all, and the action was allowed because of it. */
  readonly unknown: boolean;
  /** Where this business is. Callers that only want to know whether to *say* something read this. */
  readonly stage: WalletStage;
}

const OPEN: WalletRoom = {
  allowed: true,
  balanceCents: 0,
  overdraftCents: 0,
  unknown: true,
  stage: 'off',
};

const isStage = (v: unknown): v is WalletStage =>
  v === 'off' || v === 'warn' || v === 'enforce' || v === 'agency';

/** What a business is told, per kind. Never "insufficient funds": say what stopped and how to start it again. */
export const WALLET_REFUSALS: Readonly<Record<SpendKind, string>> = {
  text: 'Your balance has run out, so texts are paused. Top up and they start going again — the ones waiting will send themselves.',
  call: 'Your balance has run out, so outgoing calls are paused. Top up and they start working again.',
  ai: 'Your balance has run out, so the AI has paused. Top up and it picks up where it left off.',
  number:
    'There isn’t enough on your balance for a phone number’s first month. Top up and try again.',
};

/**
 * How much room one kind of spending needs. A text or a minute is pennies and only needs the balance to be
 * above the overdraft; a phone number is charged a month up front, so it needs the whole month there — nobody
 * should be able to buy a number at zero and be billed for it later.
 */
const ROOM_NEEDED: Readonly<Record<SpendKind, number>> = {
  text: 0,
  call: 0,
  ai: 0,
  number: 350,
};

/**
 * Read the wallet, in this transaction. Returns room rather than throwing, so a caller that wants to degrade
 * rather than refuse (an inbound call, which is never hard-blocked) can decide for itself.
 */
export async function walletRoom(
  tx: Tx,
  workspaceId: string,
  kind: SpendKind,
  log?: (message: string, error: unknown) => void,
): Promise<WalletRoom> {
  try {
    const result = await tx.execute(sql`
      select balance_cents, overdraft_cents, stage::text as stage
      from app.usage_wallets where workspace_id = ${workspaceId}`);
    const row = (result as unknown as { rows?: unknown[] }).rows?.[0] ?? (result as unknown[])[0];
    // No wallet at all is a business that has never spent anything. That is fine, not empty.
    if (!row)
      return { allowed: true, balanceCents: 0, overdraftCents: 0, unknown: false, stage: 'off' };
    const w = row as { balance_cents: unknown; overdraft_cents: unknown; stage: unknown };
    const balanceCents = Number(w.balance_cents ?? 0);
    // An unreadable stage reads as `off`, which is the same way everything else here fails: open.
    const stage = isStage(w.stage) ? w.stage : 'off';
    // At `enforce` there is no overdraft, whatever the row says: the business can write that column, and the
    // stage is HandsFreeOS's. A business put on `enforce` stops at zero.
    const overdraftCents = stage === 'enforce' ? 0 : Number(w.overdraft_cents ?? 0);
    return {
      allowed: stage !== 'enforce' || balanceCents - ROOM_NEEDED[kind] > -overdraftCents,
      balanceCents,
      overdraftCents,
      unknown: false,
      stage,
    };
  } catch (e) {
    // Loudly, and then let it through. A wallet that cannot be read must never stop a text.
    log?.('could not read the usage wallet; allowing the spend', e);
    return OPEN;
  }
}

/**
 * Refuse a spend when the balance has run out and this business is at `enforce`. Everything else — an
 * unreadable wallet, a business without one, a business still at `off` or `warn` — goes through.
 */
export async function assertWalletHasRoom(
  tx: Tx,
  workspaceId: string,
  kind: SpendKind,
  log?: (message: string, error: unknown) => void,
): Promise<void> {
  const room = await walletRoom(tx, workspaceId, kind, log);
  if (room.allowed) return;
  throw HfosError.rule(
    kind === 'number' ? 'wallet_short' : 'wallet_empty',
    402,
    WALLET_REFUSALS[kind],
  );
}

/**
 * Whether an inbound call should still ring browsers and forwarding phones.
 *
 * Inbound is **never hard-blocked**: a customer hearing "not in service" is the business's reputation, and the
 * carrier bills us for the inbound leg whether we answer or not, so refusing saves almost nothing. What stops
 * past the overdraft is the *extra* — the outbound legs that ring somebody's cell — and the call goes to
 * voicemail instead, which still gets the customer heard.
 *
 * **The stage decides, and it is checked here.** Without that clause this read `balanceCents >
 * -overdraftCents`, and a business with no wallet at all — which is every business while `WALLET_MODE` is
 * `off` — comes back from `walletRoom` as balance 0, overdraft 0. `0 > -0` is false, so **every inbound call
 * went straight to voicemail and nobody's phone rang.** The tests missed it because each one set
 * `stage: 'enforce'` with an overdraft; none used the default a real business has.
 *
 * That is the same hazard A1 named — *the one thing that decides whether a business hears anything at all is
 * its own stage* — and this was a fifth place that spoke without asking.
 */
export const mayRingOut = (room: WalletRoom): boolean =>
  room.unknown || room.stage !== 'enforce' || room.balanceCents > -room.overdraftCents;
