import type { WizardStepKey } from '@hfos/core';
import { setupHref } from './setup';

/**
 * The way back to the setup wizard from a sign-in that leaves the app (Stripe, Square, GoHighLevel). The worker
 * always sends a finished sign-in to the step's Settings page; a wizard step that starts one keeps a note in this
 * tab first, and the finishing page goes back to the step instead, with what happened (`?payments=connected`).
 * Only in this tab, only for a while, and only when the worker was sending the person to that step's own page.
 */
const KEY = 'hfos:setup-return';
const LASTS_MS = 30 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Leaves = Extract<WizardStepKey, 'payments' | 'customers'>;

/** Where the worker sends each step's sign-in back to. */
const PAGES: Record<Leaves, (workspaceId: string) => readonly RegExp[]> = {
  payments: (ws) => [new RegExp(`^/app/w/${ws}/settings/payments$`)],
  customers: (ws) => [
    new RegExp(`^/app/w/${ws}/settings/migrations$`),
    /^\/app\/org\/[0-9a-f-]{36}\/migrations$/i,
  ],
};

export function keepSetupReturn(workspaceId: string, step: Leaves): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ workspaceId, step, at: Date.now() }));
  } catch {
    // Storage off: the sign-in still finishes, on the Settings page.
  }
}

/** Where a finished sign-in goes: `next` from the worker, or the wizard step that started it. */
export function setupReturnFor(next: string): string {
  let kept: unknown = null;
  try {
    kept = JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
    sessionStorage.removeItem(KEY);
  } catch {
    return next;
  }
  if (!kept || typeof kept !== 'object') return next;
  const { workspaceId, step, at } = kept as Record<string, unknown>;
  if (
    typeof workspaceId !== 'string' ||
    !UUID.test(workspaceId) ||
    (step !== 'payments' && step !== 'customers') ||
    typeof at !== 'number' ||
    Date.now() - at > LASTS_MS
  )
    return next;
  let url: URL;
  try {
    url = new URL(next, window.location.origin);
  } catch {
    return next;
  }
  if (url.origin !== window.location.origin) return next;
  if (!PAGES[step](workspaceId).some((p) => p.test(url.pathname))) return next;
  return `${setupHref(workspaceId, step)}${url.search}`;
}
