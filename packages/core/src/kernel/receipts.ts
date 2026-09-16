/**
 * Command receipts (M10, 0054): a command from the phone runs once. The phone gives every command its own id, and
 * `executeCommand` alone claims that id in app.command_receipts at the top of the command's transaction: a repeat
 * (a retry whose first answer never arrived, even one that lands while the first is still running) waits on the
 * unique key and then gets the first answer back instead of running again. The same id with a different command
 * or input is refused. The answer is stored before the transaction ends (the database refuses to commit a receipt
 * without one); a final refusal is stored on its own afterwards, since the command's transaction rolled back.
 * Refusals a person can answer ("Still send?", quiet hours) and ones worth retrying are never stored, or they would
 * come back forever. Commands run inside another command never read or write receipts.
 *
 * The phone syncs its person's receipts, so a stored answer never keeps a secret: credential-looking keys go at
 * any depth, and each command's `shownOnce` keys (a one-time OAuth state) too. A repeat whose stored answer can no
 * longer be its output is refused as done-but-not-kept rather than answered with something missing.
 */
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { asUser, type Db, type Tx } from '@hfos/db/client';
import { commandReceipts } from '@hfos/db/schema';
import { HfosError, type HfosErrorCode } from '../errors';
import { isDenylistedKey } from './redact';
import type { CommandDef, HumanActor, RequestMeta } from './types';

/** What a command from the app claims its receipt with. */
export interface ReceiptClaim {
  readonly userId: string;
  readonly commandId: string;
  readonly command: string;
  readonly inputHash: string;
  readonly occurredAt: Date;
}

/** The database holds answers up to 256 KB; past this, the output isn't kept (its events still are). */
const ANSWER_MAX_CHARS = 200_000;

/** JSON with every object's keys in order, so the same input always hashes the same however it was built. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)
      ? Object.fromEntries(
          Object.keys(v as Record<string, unknown>)
            .sort()
            .map((k) => [k, (v as Record<string, unknown>)[k]]),
        )
      : v,
  );
}

/** The input as the app sent it, hashed: defaults a later release adds can't make a repeat look different. */
export const inputHashOf = (rawInput: unknown): string =>
  createHash('sha256')
    .update(canonicalJson(rawInput ?? null))
    .digest('hex');

/** A person's command that carries the app's id has a receipt; nothing else does. */
export function receiptClaim(
  cmd: CommandDef,
  rawInput: unknown,
  actor: HumanActor,
  meta: RequestMeta,
): ReceiptClaim | null {
  if (!meta.commandId) return null;
  return {
    userId: actor.userId,
    commandId: meta.commandId,
    command: cmd.name,
    inputHash: inputHashOf(rawInput),
    occurredAt: meta.occurredAt ?? new Date(),
  };
}

/** Drops credential-looking keys at any depth (arrays too) and the command's own one-time keys at the top. */
export function keepableAnswer(value: unknown, drop: readonly string[] = []): unknown {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v instanceof Date) return v.toISOString();
    if (!v || typeof v !== 'object') return v;
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([k]) => !isDenylistedKey(k))
        .map(([k, x]) => [k, walk(x)]),
    );
  };
  const kept = walk(value);
  if (!drop.length || !kept || typeof kept !== 'object' || Array.isArray(kept)) return kept;
  return Object.fromEntries(Object.entries(kept).filter(([k]) => !drop.includes(k)));
}

/** A stored applied answer. */
interface AppliedAnswer {
  readonly output?: unknown;
  readonly eventIds?: readonly string[];
}
/** A stored final refusal: the body the client saw, and its status. */
interface RefusedAnswer {
  readonly status: number;
  readonly error: {
    readonly code: HfosErrorCode;
    readonly message: string;
    readonly rule?: string;
    readonly details?: unknown;
  };
}

export type Claimed<T> =
  | { readonly kind: 'claimed'; readonly receiptId: string }
  | { readonly kind: 'answered'; readonly result: { output: T; eventIds: readonly string[] } }
  | { readonly kind: 'refused'; readonly error: HfosError };

/**
 * Claims the command's id as the first write of its transaction. A repeat gets what the first one did: its
 * answer, or its final refusal. The same id with a different command or input is refused.
 */
export async function claimReceipt<T>(
  tx: Tx,
  cmd: CommandDef,
  claim: ReceiptClaim,
  workspaceId: string | null,
): Promise<Claimed<T>> {
  const [mine] = await tx
    .insert(commandReceipts)
    .values({
      userId: claim.userId,
      commandId: claim.commandId,
      workspaceId,
      command: claim.command,
      inputHash: claim.inputHash,
      outcome: 'applied',
      answer: null,
      occurredAt: claim.occurredAt,
    })
    .onConflictDoNothing({ target: [commandReceipts.userId, commandReceipts.commandId] })
    .returning({ id: commandReceipts.id });
  if (mine) return { kind: 'claimed', receiptId: mine.id };
  // Someone got here first (and, having waited on the key, has committed): their receipt is the answer.
  const [earlier] = await tx
    .select()
    .from(commandReceipts)
    .where(
      and(eq(commandReceipts.userId, claim.userId), eq(commandReceipts.commandId, claim.commandId)),
    );
  if (!earlier) throw HfosError.internal();
  if (earlier.command !== claim.command || earlier.inputHash !== claim.inputHash)
    throw HfosError.rule(
      'command_id_reused',
      409,
      'The app already sent a different change with this id, so this one wasn’t done.',
    );
  if (earlier.outcome === 'refused') {
    const stored = earlier.answer as RefusedAnswer;
    return {
      kind: 'refused',
      error: new HfosError(
        stored.error.code,
        stored.status,
        stored.error.message,
        stored.error.details,
        stored.error.rule,
      ),
    };
  }
  const stored = (earlier.answer ?? {}) as AppliedAnswer;
  const output = cmd.output.safeParse(stored.output);
  if (!output.success)
    throw HfosError.rule(
      'answer_not_kept',
      409,
      'This was already done, but what it showed can only be shown once. Start it again to see it.',
    );
  return {
    kind: 'answered',
    result: { output: output.data as T, eventIds: stored.eventIds ?? [] },
  };
}

/** The answer, stored before the command's transaction ends. */
export async function storeAnswer(
  tx: Tx,
  cmd: CommandDef,
  receiptId: string,
  result: { output: unknown; eventIds: readonly string[] },
): Promise<void> {
  const kept = { output: keepableAnswer(result.output, cmd.shownOnce), eventIds: result.eventIds };
  const answer: AppliedAnswer =
    canonicalJson(kept).length > ANSWER_MAX_CHARS ? { eventIds: result.eventIds } : kept;
  await tx.update(commandReceipts).set({ answer }).where(eq(commandReceipts.id, receiptId));
}

/**
 * A final refusal, stored in a short transaction of its own (the command's rolled back). The receipt names the
 * business only once the person was found to work in it. Best effort: if this can't be stored, a repeat simply
 * runs again and is refused again.
 */
export async function recordRefusal(
  db: Db,
  actor: HumanActor,
  claim: ReceiptClaim,
  workspaceId: string | null,
  error: HfosError,
): Promise<void> {
  const body = error.toBody().error;
  const answer: RefusedAnswer = {
    status: error.status,
    error: keepableAnswer({
      code: body.code,
      message: body.message,
      ...(body.rule ? { rule: body.rule } : {}),
      ...(body.details !== undefined ? { details: body.details } : {}),
    }) as RefusedAnswer['error'],
  };
  try {
    await asUser(db, actor.claims, (tx) =>
      tx
        .insert(commandReceipts)
        .values({
          userId: claim.userId,
          commandId: claim.commandId,
          workspaceId,
          command: claim.command,
          inputHash: claim.inputHash,
          outcome: 'refused',
          answer,
          occurredAt: claim.occurredAt,
        })
        .onConflictDoNothing({ target: [commandReceipts.userId, commandReceipts.commandId] }),
    );
  } catch {
    // Not stored: a repeat runs again, and gets the same refusal.
  }
}
