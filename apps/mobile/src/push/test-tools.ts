import type { PushData } from '@hfos/core';

import { changes } from '@/changes';
import { testCustomer } from '@/changes/test-actions';
import { config } from '@/lib/config';
import { appFetch } from '@/lib/network';

/**
 * Test builds only: what the worker's stand-in push service was handed for this phone (`GET /test/push/sent`, the
 * worker's test route; apps/worker/src/push/README.md, "Trying it locally"), and getting a customer's texts ready to
 * reach this phone.
 */

/** One push as the stand-in keeps it. */
export interface SentPush {
  readonly to: string;
  readonly platform: 'ios' | 'android';
  readonly title: string | null;
  readonly subtitle: string | null;
  readonly body: string | null;
  readonly categoryId: string | null;
  readonly data: PushData & { title?: string; subtitle?: string | null; body?: string };
  readonly at: string;
}

function workerUrl(): string {
  if (!config.workerUrl)
    throw new Error('This build doesn’t know where the worker is (EXPO_PUBLIC_WORKER_URL).');
  return config.workerUrl;
}

/** The pushes the stand-in sent to this phone's token for a business, newest first. */
export async function sentToThisPhone(workspaceId: string, token: string): Promise<SentPush[]> {
  const response = await appFetch(
    `${workerUrl()}/test/push/sent?workspaceId=${encodeURIComponent(workspaceId)}`,
  );
  if (!response.ok) throw new Error(`The worker answered ${response.status}.`);
  const body = (await response.json()) as { sent?: SentPush[] };
  return (body.sent ?? []).filter((s) => s.to === token).reverse();
}

/** Runs the business's waiting push jobs now (`POST /test/push/run-due`). */
export async function runDuePushes(workspaceId: string): Promise<void> {
  const response = await appFetch(`${workerUrl()}/test/push/run-due`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId }),
  });
  if (!response.ok) throw new Error(`The worker answered ${response.status}.`);
}

/** A stand-in push's words and data as the phone would have them: an iPhone's words travel beside its data. */
export function dataWithWords(sent: SentPush): PushData {
  return {
    ...sent.data,
    title: sent.data.title ?? sent.title ?? undefined,
    subtitle: sent.data.subtitle ?? sent.subtitle ?? null,
    body: sent.data.body ?? sent.body ?? undefined,
  };
}

/** The customer whose texts the push flows send: Maria Lopez, with her number and her text conversation. */
export interface PushCustomer {
  readonly name: string;
  /** E.164, as the fake carrier sends it. */
  readonly phone: string;
  readonly conversationId: string;
}

/**
 * Gets Maria Lopez's texts ready to reach this phone as notifications: her text conversation open, assigned to the
 * signed-in person, and answered by a person rather than the AI teammate (which would answer her itself, and nobody
 * would be told). Each change is sent straight away.
 */
export async function readyCustomerTexts(
  workspaceId: string,
  userId: string,
): Promise<PushCustomer> {
  const open = changes.open;
  if (!open) throw new Error('This phone’s copy isn’t open.');
  const customer = await testCustomer(workspaceId);
  if (!customer?.phone_e164) throw new Error('No customer with a phone number on this phone yet.');
  const conversation = await open.db.getOptional<{ id: string }>(
    `SELECT id FROM conversations WHERE workspace_id = ? AND person_id = ? AND channel = 'sms'
     ORDER BY last_message_at DESC LIMIT 1`,
    [workspaceId, customer.id],
  );
  if (!conversation)
    throw new Error(
      'This customer has no text conversation yet: text them from Test changes first.',
    );
  const ref = { workspaceId, conversationId: conversation.id };
  for (const made of [
    await changes.change('conversation.reopen', ref),
    await changes.change('conversation.assign', { ...ref, assigneeUserId: userId }),
    await changes.change('conversation.take_over', ref),
  ]) {
    const row = await changes.sendQueuedNow(made.id);
    if (row && row.state !== 'sent')
      throw new Error(row.reason ?? `It didn’t go through (${row.state}).`);
  }
  return {
    name: [customer.first_name, customer.last_name].filter(Boolean).join(' '),
    phone: customer.phone_e164,
    conversationId: conversation.id,
  };
}
