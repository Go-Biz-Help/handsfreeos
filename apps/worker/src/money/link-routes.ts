/**
 * `POST /v1/money/link {workspaceId, kind: 'estimate' | 'invoice' | 'plan', id}` (bearer token, `money.bill`)
 * → `{url}`: a customer's own link, for the business to copy and paste wherever it talks to that customer.
 *
 * Minting one needs the worker's link key, and the API is refused that key by its own env guard on purpose, so
 * this lives beside the worker's other signed-in routes rather than as an API query. It answers with **the link
 * the customer was sent** — the same `estimateUrlFor`, `invoiceUrlFor` and `planUrlFor` the texts and emails
 * use, at the document's current version — so a pasted link and a sent one are the same link, and retiring one
 * retires both.
 *
 * Refused when there is nothing a customer could use: a draft (no link to one was ever given out), a voided
 * estimate or invoice, and a plan that has ended (what `subscription.request_card` refuses as well). Someone who
 * may not bill gets a 403 before anything is read: a link is a way to take someone's money. Someone who bills
 * without managing money (0105) gets the links of what they can see — the bills and plans of the customers
 * they're on — and "not there" for anything else, asked as them so the rules that show them a bill decide. The
 * answer is `no-store`, because it is a working link.
 *
 * Not rate-limited, like the other signed-in worker routes that spend no AI (the voice token, the number
 * search, a template update): it is one or two indexed reads and an HMAC, for someone who bills.
 */
import { HfosError } from '@hfos/core/server';
import { asUser, asWorker, rows, sql, type Tx } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  authenticate,
  hasPermission,
  parseBody,
  requirePermission,
  type HttpDeps,
} from '../http/common';
import { estimateUrlFor, invoiceUrlFor, planUrlFor, type MoneyDocumentKind } from './links';

export const MoneyLinkInput = z.object({
  workspaceId: z.uuid(),
  kind: z.enum(['estimate', 'invoice', 'plan']),
  id: z.uuid(),
});

/** Where the document or plan stands, read inside the business's own scope; null when it isn't there. */
async function statusOf(
  tx: Tx,
  kind: MoneyDocumentKind,
  workspaceId: string,
  id: string,
): Promise<string | null> {
  const table =
    kind === 'estimate'
      ? sql`app.estimates`
      : kind === 'invoice'
        ? sql`app.invoices`
        : sql`app.subscriptions`;
  const [row] = await rows<{ status: string }>(
    tx,
    sql`select status::text as status from ${table}
        where workspace_id = ${workspaceId}::uuid and id = ${id}::uuid`,
  );
  return row?.status ?? null;
}

/** Nothing a customer could use behind this link, in the words the button shows. */
function unusable(kind: MoneyDocumentKind, status: string): HfosError | null {
  if (kind === 'plan')
    return status === 'cancelled'
      ? HfosError.rule(
          'subscription_cancelled',
          409,
          'That plan has ended. Start a new one instead.',
        )
      : null;
  if (status === 'draft')
    return HfosError.rule(
      'money_document_not_sent',
      409,
      `Send the ${kind} first. A draft has no page a customer can open.`,
    );
  if (status === 'void')
    return HfosError.rule(
      'money_document_voided',
      409,
      `That ${kind} was voided, so there’s nothing left to send anyone to. Make a new one instead.`,
    );
  return null;
}

export function registerMoneyLinkRoutes(app: FastifyInstance, deps: HttpDeps): void {
  app.post('/v1/money/link', async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    const actor = await authenticate(deps, req);
    const input = parseBody(MoneyLinkInput, req.body);
    await requirePermission(deps, actor.userId, input.workspaceId, 'money.bill');
    if (!(await hasPermission(deps, actor.userId, input.workspaceId, 'money.manage'))) {
      const seen = await asUser(deps.httpDb, actor.claims, (tx) =>
        statusOf(tx, input.kind, input.workspaceId, input.id),
      );
      if (!seen) throw HfosError.notFound(`That ${input.kind} isn’t there.`);
    }
    const url = await asWorker(deps.httpDb, { workspaceId: input.workspaceId }, async (tx) => {
      const status = await statusOf(tx, input.kind, input.workspaceId, input.id);
      if (!status) throw HfosError.notFound(`That ${input.kind} isn’t there.`);
      const refused = unusable(input.kind, status);
      if (refused) throw refused;
      return input.kind === 'estimate'
        ? estimateUrlFor(tx, deps.moneyLinks, input.id)
        : input.kind === 'invoice'
          ? invoiceUrlFor(tx, deps.moneyLinks, input.id)
          : planUrlFor(tx, deps.moneyLinks, input.id);
    });
    if (!url) throw HfosError.notFound(`That ${input.kind} isn’t there.`);
    return { url };
  });
}
