import { formatClock } from '@hfos/core';

import { describe, heldWords, loadNames, refusalWords } from './describe';
import type { OutboxDb, OutboxRow, SqlRunner, Outbox } from './outbox';
import {
  blockersOf,
  isStale,
  keepTryingInPlace,
  outcomeOf,
  parseIds,
  quietHoursQuestion,
  RETRY_IN_PLACE_MS,
  type Answer,
  type Outcome,
} from './rules';
import type { CommandRequest } from './send';
import { TOO_OLD_WORDS, type VersionGate } from './version-gate';

/**
 * PowerSync's `uploadData`: the changes in the upload queue, one transaction at a time and in order, exactly as the
 * Node phone does it (`apps/sync/test/harness/phone.ts`):
 *
 * - A change whose changes or photos haven't gone through yet is **held**, and completed: nothing jams behind it.
 * - Once the API has refused this build (426), nothing is sent: each change is set aside and kept.
 * - A customer-facing change more than 30 minutes old **asks** "Still send?" first, and a text that would go inside
 *   the business's quiet hours asks "Send now, or when quiet hours end?"; both are completed and kept for the person.
 * - Otherwise it's sent with the app's headers. **Applied**: complete, and the changes held only for it are released.
 *   **`final`**: complete, and kept as refused with the API's words. **`ask`**: complete, and kept for the person.
 *   **401**: the sign-in is refreshed, and it's sent again. **426**: stop sending and keep everything.
 * - **No answer, 5xx, `retry`, or no disposition**: thrown, so PowerSync tries it again in place a few seconds later,
 *   for up to a minute; then it's set aside as `retry` and completed, so the phone keeps receiving everyone else's
 *   changes, and it's sent again later, in order.
 */

export interface BusinessClock {
  readonly timeZone: string;
  /** The business's synced settings (JSON text): its quiet hours for texts. */
  readonly settings: unknown;
}

export type Settled =
  | { readonly kind: 'sent'; readonly row: OutboxRow; readonly released: readonly string[] }
  | { readonly kind: 'aside'; readonly row: OutboxRow }
  | { readonly kind: 'held' | 'ask' | 'refused'; readonly row: OutboxRow };

export interface UploaderDeps {
  readonly outbox: Outbox;
  readonly send: (request: CommandRequest) => Promise<Answer>;
  /** Refreshes the sign-in by `SessionStore`'s rules: only a refusal from Supabase Auth signs the person out. */
  readonly refreshSession: () => Promise<void>;
  /** The phone's clock. */
  readonly now: () => number;
  /** The business's time zone and settings from its synced row, or null when its copy isn't on the phone. */
  readonly businessClock: (workspaceId: string, runner: SqlRunner) => Promise<BusinessClock | null>;
  /** The moment quiet hours are judged at in that zone: now, or in test builds a pretended local time. */
  readonly quietHoursMoment: (timeZone: string) => Date;
  readonly gate: VersionGate;
  /** A new command id, for a fixed change the API already kept a different try of. */
  readonly newId: () => string;
  readonly retryInPlaceMs?: number;
  /** A change settled: the photo track, the retry timer and the screens hear of it. */
  readonly settled?: (event: Settled) => void;
  /** A change was refused: the command's own hook (a stale draft kept as a new one, in step 16). */
  readonly refused?: (row: OutboxRow) => void | Promise<void>;
}

/** Thrown to have PowerSync try the change again in place. */
export class TryAgainInPlace extends Error {}

export function requestOf(row: OutboxRow): CommandRequest {
  return {
    name: row.name,
    commandId: row.command_id,
    input: row.input,
    madeAt: row.made_at,
    confirmedAt: row.confirmed_at,
  };
}

/** "This was done 45 minutes ago, so it waits for your OK before it goes.", as the API says it. */
export function staleWords(madeAt: number, now: number): string {
  const minutes = Math.max(1, Math.floor((now - madeAt) / 60_000));
  const wait =
    minutes < 90
      ? `${minutes} minute${minutes === 1 ? '' : 's'}`
      : minutes < 36 * 60
        ? `${Math.round(minutes / 60)} hours`
        : `${Math.round(minutes / 1440)} days`;
  return `This was done ${wait} ago, so it waits for your OK before it goes.`;
}

export class Uploader {
  /** When each change was first tried since signal last came back: its minute of tries in place. */
  private readonly firstTried = new Map<string, number>();

  constructor(private readonly deps: UploaderDeps) {}

  /** Signal came back, or the copy reconnected: every change gets a full minute of tries again. */
  resetWindows(): void {
    this.firstTried.clear();
  }

  readonly upload = async (db: OutboxDb): Promise<void> => {
    for (;;) {
      const tx = await db.getNextCrudTransaction();
      if (!tx) return;
      // Every change queued in the transaction, in order (changes sent again together share one). One that's tried
      // again in place throws, and the transaction comes back: those already handled are skipped then.
      for (const entry of tx.crud) {
        if (entry.table !== 'commands') continue;
        const row = await this.deps.outbox.get(entry.id);
        // A change discarded meanwhile, or one already handled: nothing for the server.
        if (row && (row.state === 'waiting' || row.state === 'sending')) await this.handle(row);
      }
      await tx.complete();
    }
  };

  private emit(event: Settled) {
    this.deps.settled?.(event);
  }

  private async handle(row: OutboxRow): Promise<void> {
    const { outbox } = this.deps;

    const blockers = await this.blockers(row);
    if (blockers.length > 0) {
      const names = await loadNames(outbox.db, blockers.map((b) => b.row).filter(isRow));
      const reason = heldWords(
        blockers.map((b) => ({ words: b.row ? describe(b.row, names) : null })),
      );
      await outbox.settle(row.id, { state: 'held', reason });
      this.emit({ kind: 'held', row });
      return;
    }

    if (this.deps.gate.tooOld()) {
      await outbox.settle(row.id, {
        state: 'retry',
        reason: TOO_OLD_WORDS,
        rule: 'upgrade_required',
      });
      this.emit({ kind: 'aside', row });
      return;
    }

    const now = this.deps.now();
    const stale = isStale({
      name: row.name,
      madeAt: Date.parse(row.made_at),
      confirmedAt: row.confirmed_at ? Date.parse(row.confirmed_at) : null,
      now,
    });
    // One question at a time: a text that is both old and inside quiet hours asks about quiet hours, and either answer
    // counts as "still send it".
    const quiet = await this.quietHours(row);
    if (quiet || stale) {
      await outbox.settle(row.id, {
        state: 'ask',
        rule: quiet ? 'quiet_hours' : 'stale_action',
        reason: quiet
          ? `It’s ${formatClock(quiet.localTime)} where the business is. Quiet hours end at ${formatClock(quiet.endsAt)}.`
          : staleWords(Date.parse(row.made_at), now),
        answer: quiet ? { phone: { ...quiet, stale } } : { phone: { stale: true } },
      });
      this.emit({ kind: 'ask', row });
      return;
    }

    await outbox.sending(row.id);
    const outcome = await this.attempt(row);
    await this.settle(row, outcome);
  }

  /** The changes and photos it waits for that haven't gone through. */
  private async blockers(row: OutboxRow) {
    const ids = parseIds(row.depends_on);
    if (ids.length === 0) return [];
    const found = await this.deps.outbox.states(ids);
    const byId = new Map(found.map((r) => [r.id, r]));
    return blockersOf(
      ids,
      found.map((r) => ({ id: r.id, state: r.state })),
    ).map((b) => ({ ...b, row: byId.get(b.id) ?? null }));
  }

  private async quietHours(row: OutboxRow) {
    if (row.name !== 'message.send') return null;
    const clock = await this.deps.businessClock(row.workspace_id, this.deps.outbox.db);
    if (!clock) return null;
    let input: unknown;
    try {
      input = JSON.parse(row.input);
    } catch {
      return null;
    }
    return quietHoursQuestion({
      name: row.name,
      input,
      settings: clock.settings,
      timeZone: clock.timeZone,
      now: this.deps.quietHoursMoment(clock.timeZone),
    });
  }

  /** Sends it, refreshing the sign-in once on a 401, and once under a new id if a fixed version needs one. */
  private async attempt(row: OutboxRow): Promise<Outcome> {
    const once = async (current: OutboxRow): Promise<Outcome> => {
      const outcome = outcomeOf(await this.deps.send(requestOf(current)));
      if (outcome.kind !== 'unauthorized') return outcome;
      await this.deps.refreshSession().catch(() => undefined);
      const again = outcomeOf(await this.deps.send(requestOf(current)));
      return again.kind === 'unauthorized'
        ? {
            kind: 'retry',
            message: 'Your sign-in is being checked, so it tries again.',
            body: null,
          }
        : again;
    };
    const outcome = await once(row);
    // The API kept an earlier try of this change under its id, with what it sent then. A change the person has
    // since fixed goes under a new id; anything else really is a different change.
    if (outcome.kind === 'refused' && outcome.rule === 'command_id_reused' && row.revision > 0) {
      const commandId = this.deps.newId();
      await this.deps.outbox.newCommandId(row.id, commandId);
      return once({ ...row, command_id: commandId });
    }
    return outcome;
  }

  private async settle(row: OutboxRow, outcome: Outcome): Promise<void> {
    const { outbox } = this.deps;
    switch (outcome.kind) {
      case 'sent': {
        this.firstTried.delete(row.id);
        await outbox.settle(row.id, { state: 'sent', answer: outcome.output });
        const released = await outbox.release(row.id);
        this.emit({ kind: 'sent', row, released });
        return;
      }
      case 'refused': {
        this.firstTried.delete(row.id);
        await outbox.settle(row.id, {
          state: 'refused',
          reason: refusalWords(outcome.body, outcome.message),
          disposition: 'final',
          rule: outcome.rule,
          answer: outcome.body,
        });
        const refused = await outbox.get(row.id);
        if (refused) await Promise.resolve(this.deps.refused?.(refused)).catch(() => undefined);
        this.emit({ kind: 'refused', row });
        return;
      }
      case 'ask': {
        this.firstTried.delete(row.id);
        await outbox.settle(row.id, {
          state: 'ask',
          reason: outcome.message,
          disposition: 'ask',
          rule: outcome.rule,
          answer: outcome.body,
        });
        this.emit({ kind: 'ask', row });
        return;
      }
      case 'too_old': {
        this.firstTried.delete(row.id);
        this.deps.gate.markTooOld(outcome.minVersion);
        await outbox.settle(row.id, {
          state: 'retry',
          reason: TOO_OLD_WORDS,
          rule: 'upgrade_required',
        });
        this.emit({ kind: 'aside', row });
        return;
      }
      case 'unauthorized':
      case 'retry': {
        const message =
          outcome.kind === 'retry' ? outcome.message : 'Your sign-in is being checked.';
        const now = this.deps.now();
        const first = this.firstTried.get(row.id) ?? now;
        this.firstTried.set(row.id, first);
        if (keepTryingInPlace(first, now, this.deps.retryInPlaceMs ?? RETRY_IN_PLACE_MS)) {
          await outbox.db.execute('UPDATE outbox SET reason = ? WHERE id = ?', [message, row.id]);
          throw new TryAgainInPlace(`${row.name} will be tried again: ${message}`);
        }
        this.firstTried.delete(row.id);
        await outbox.settle(row.id, {
          state: 'retry',
          reason: message,
          disposition: outcome.kind === 'retry' ? 'retry' : null,
          answer: outcome.kind === 'retry' ? outcome.body : null,
        });
        this.emit({ kind: 'aside', row });
        return;
      }
    }
  }
}

const isRow = (row: OutboxRow | null): row is OutboxRow => row !== null;
