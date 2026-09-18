import type { MoneyLinkKind } from '@hfos/core';

import { change } from '@/changes';
import { appFetch } from '@/lib/network';
import { session } from '@/lib/auth';
import { config } from '@/lib/config';

/**
 * Money's changes and the one thing it asks the worker for.
 *
 * - **Record cash or a check** is `anytime`: it is money already taken off the system, so it waits on the phone for as
 *   long as it takes and shows on the invoice the moment it is pressed.
 * - **Send** a document reaches a customer: fresh for 30 minutes, then "Still send?".
 * - **Copy a payment link** needs signal, because only the worker holds the key that signs one.
 *
 * Making and editing estimates and invoices is the web's in M10 (the plan's "Drafts don't merge"), so nothing here
 * writes a document.
 */

export interface RecordCash {
  readonly workspaceId: string;
  readonly invoiceId: string;
  readonly amountCents: number;
  readonly method: 'cash' | 'check' | 'other';
  /** A check number, say. */
  readonly reference: string | null;
}

/** Record cash or a check against an unpaid invoice, in this person's name, from the doorstep. */
export function recordCash(input: RecordCash): Promise<{ id: string }> {
  return change('invoice.record_cash_payment', {
    workspaceId: input.workspaceId,
    invoiceId: input.invoiceId,
    amountCents: input.amountCents,
    method: input.method,
    reference: input.reference?.trim() || null,
  });
}

/** Send an invoice to its customer, by text, email, or both. */
export function sendInvoice(input: {
  workspaceId: string;
  invoiceId: string;
  channels: readonly ('sms' | 'email')[];
  message?: string | null;
}): Promise<{ id: string }> {
  return change('invoice.send', {
    workspaceId: input.workspaceId,
    invoiceId: input.invoiceId,
    channels: [...input.channels],
    message: input.message ?? null,
  });
}

/** Send an estimate to its customer. */
export function sendEstimate(input: {
  workspaceId: string;
  estimateId: string;
  channels: readonly ('sms' | 'email')[];
  message?: string | null;
}): Promise<{ id: string }> {
  return change('estimate.send', {
    workspaceId: input.workspaceId,
    estimateId: input.estimateId,
    channels: [...input.channels],
    message: input.message ?? null,
  });
}

/**
 * The customer's own link for a document, from the worker's `POST /v1/money/link` — the same route and the same body
 * the web's Copy link uses, because only the worker holds the signing key (the API may not).
 *
 * It needs signal: there is nothing on the phone that could mint one, so with none it says so rather than queueing
 * something that could never run.
 */
export async function moneyLink(input: {
  workspaceId: string;
  kind: MoneyLinkKind;
  id: string;
}): Promise<string> {
  // `accessToken()` is a promise: a token that ran out while the phone was offline is refreshed before it answers.
  const token = await session.accessToken();
  if (!token) throw new Error('Sign in to continue.');
  let res: Response;
  try {
    res = await appFetch(`${config.workerUrl}/v1/money/link`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
  } catch {
    throw new Error('This needs signal.');
  }
  const body = (await res.json().catch(() => null)) as {
    url?: string;
    error?: { message?: string };
  } | null;
  if (!res.ok || !body?.url)
    throw new Error(
      body?.error?.message ?? 'We couldn’t get the link just now. Try again in a minute.',
    );
  return body.url;
}
