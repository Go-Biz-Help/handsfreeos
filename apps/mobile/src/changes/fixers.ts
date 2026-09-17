import type { CommandName } from './commands';
import type { OutboxRow } from './outbox';

/**
 * Hooks the screens fill in (steps 13–17) for the changes they make:
 *
 * - **Fix and try again**, and **Edit** on "Still send?": reopens a change with what was entered, on the screen that
 *   made it. The screen calls `changes.fix(id, input)` with the corrected input, which sends it again under its own id.
 *   Changes on this phone offers "Fix and try again" only for commands with a fixer.
 * - **When a change is refused**: anything a command does beyond keeping the refusal, such as keeping a stale estimate
 *   or invoice draft as a new draft (step 16).
 *
 * The test builds' Test changes screen fills these in for the changes it makes, until the screens exist.
 */

export type Fixer = (change: OutboxRow) => void;

/** A refused change: one from the queue (with its outbox row), or an online-only command the screen just made. */
export interface Refused {
  /** The change's id. */
  readonly id: string;
  readonly name: string;
  readonly workspaceId: string | null;
  /** JSON, as it was sent. */
  readonly input: string;
  /** The API's refusal body: its words, rule and details (a stale draft's `keepAsNewDraft`, say). */
  readonly answer: unknown;
  /** Kept on the phone as refused, for a change from the queue; null for an online-only command. */
  readonly row: OutboxRow | null;
}

export type RefusalHook = (refused: Refused) => void | Promise<void>;

const fixers = new Map<string, Fixer>();
const refusalHooks = new Map<string, RefusalHook>();

/** The screen that reopens a command's changes. Returns a way to remove it. */
export function setFixer(command: CommandName, fixer: Fixer): () => void {
  fixers.set(command, fixer);
  return () => {
    if (fixers.get(command) === fixer) fixers.delete(command);
  };
}

export function fixerFor(command: string): Fixer | null {
  return fixers.get(command) ?? null;
}

/** What else happens when a command's change is refused. Returns a way to remove it. */
export function onRefused(command: CommandName, hook: RefusalHook): () => void {
  refusalHooks.set(command, hook);
  return () => {
    if (refusalHooks.get(command) === hook) refusalHooks.delete(command);
  };
}

export async function runRefusalHook(refused: Refused): Promise<void> {
  await refusalHooks.get(refused.name)?.(refused);
}

/** The hook's view of a change refused in the queue. */
export function refusedRow(row: OutboxRow): Refused {
  let answer: unknown = null;
  try {
    answer = row.answer ? (JSON.parse(row.answer) as unknown) : null;
  } catch {
    answer = null;
  }
  return {
    id: row.id,
    name: row.name,
    workspaceId: row.workspace_id,
    input: row.input,
    answer,
    row,
  };
}
