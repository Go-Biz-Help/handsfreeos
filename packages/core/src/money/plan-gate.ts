/**
 * A business with no plan spends nothing (the owner's decision of 2026-11-22): "A business with no plan or trial
 * can't text, email, call, buy numbers or use AI, even through the API."
 *
 * Until then the apps held the gate: a business made while a paid founding spot was on sale
 * (`app.organizations.needs_plan`) was sent to the plan page by the web and the phone, and the API ran its commands
 * anyway. So anyone could make a business, skip the page and spend its starting credit, or send email from
 * HandsFreeOS's shared domain. Now the server refuses too, for every actor: people, the system, workflows, the AI
 * teammate and the worker.
 *
 * - **Texts, calls, numbers and AI** are refused inside the wallet gate (`walletRoom` reads this beside the balance),
 *   so every place that already asks the wallet before spending asks this too.
 * - **Email** costs no balance, so it asks here itself: `message.send`, `message.retry` and
 *   `registration.email_web_person` refuse, and the worker fails a queued email that would go out after a plan
 *   ended.
 * - **A free trial is a plan.** A spot on its trial is `active` (20261027027000), and so is a practice business's
 *   (`private.practice_pay`). A business made before the founding gate was never marked, so it never asks.
 *
 * HandsFreeOS's own email to a business's people (sign-in, invitations, billing, alerts) goes through the mailer, not
 * here, and keeps working.
 */
import { sql, type Tx } from '@hfos/db/client';
import { HfosError } from '../errors';
import type { SpendKind } from './wallet-gate';

/** What a business with no plan is stopped from doing: the wallet's kinds, and email. */
export type PlanSpendKind = SpendKind | 'email';

const AFTER = 'Open it on the web and pick your founding spot, then try again.';

/** What it's told, per kind: what stopped, and where the plan is picked. */
export const PLAN_REFUSALS: Readonly<Record<PlanSpendKind, string>> = {
  text: `This business needs a plan before it can send texts. ${AFTER}`,
  email: `This business needs a plan before it can send email. ${AFTER}`,
  call: `This business needs a plan before it can make calls. ${AFTER}`,
  ai: `This business needs a plan before its AI can work. ${AFTER}`,
  number: `This business needs a plan before it can get a phone number. ${AFTER}`,
};

/**
 * Whether this business still has to pick a plan before it spends anything (`private.workspace_needs_plan`), read in
 * the caller's transaction. Unlike the wallet it doesn't fail open: an error here is an error.
 */
export async function planNeeded(tx: Tx, workspaceId: string): Promise<boolean> {
  const result = await tx.execute(
    sql`select private.workspace_needs_plan(${workspaceId}::uuid) as needs_plan`,
  );
  const row = (result as unknown as { rows?: unknown[] }).rows?.[0] ?? (result as unknown[])[0];
  return (row as { needs_plan?: unknown } | undefined)?.needs_plan === true;
}

/** Refuse a spend, of any kind, while the business still has to pick a plan. */
export async function assertPlanAllowsSpending(
  tx: Tx,
  workspaceId: string,
  kind: PlanSpendKind,
): Promise<void> {
  if (await planNeeded(tx, workspaceId))
    throw HfosError.rule('needs_plan', 402, PLAN_REFUSALS[kind]);
}
