/**
 * What a change confirmed on a card leaves for the model (runtime.ts, CommittedAction). The command's answer is kept
 * with the tool call, so a later question reads it (store.history), kept the way a command receipt keeps one
 * (kernel/receipts.ts): nothing credential-looking, and nothing the command shows only once.
 */
import { keepableAnswer } from '@hfos/core/server';

/** About how much of an answer is kept for the model, in characters of JSON. */
export const KEPT_ANSWER_MAX = 2_000;

/** The command's answer as the model reads it after Confirm, cut short when it is long. */
export function keptAnswer(output: unknown, shownOnce: readonly string[] = []): unknown {
  const kept = keepableAnswer(output ?? null, shownOnce) ?? null;
  const json = JSON.stringify(kept);
  return json.length <= KEPT_ANSWER_MAX
    ? kept
    : { data: `${json.slice(0, KEPT_ANSWER_MAX)}…`, cutShort: true };
}
