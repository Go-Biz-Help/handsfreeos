/**
 * A business's own privacy policy or terms, given back whole with the texting section the carriers look for in
 * place (the registration wizard's "Add it to my policy for me"; packages/core/src/messaging/policy-update.ts).
 *
 * The worker does it because it can fetch the business's page, which a browser can't, and because it holds the
 * AI. Core decides everything else: how the page's words become blocks, what the model is asked, what of its
 * answer is used, and the document that comes back. The model only says where things go, so the tokens are
 * few; they count as `texting_policy` usage for the person asking, against the daily AI limit.
 *
 * POST /v1/telephony/policy-update {workspaceId, kind, url?, text?, business} → {blocks, changes, url}
 * 403 without channels.manage; 422 `policy_missing`, `policy_unreachable`, `policy_unreadable`,
 * `policy_too_long` or `policy_not_a_policy`; 429 `budget_reached` or `rate_limited`; 402 `wallet_empty`;
 * 503 `ai_not_configured` or `ai_busy`; 502 `ai_failed`.
 */
import rateLimit from '@fastify/rate-limit';
import {
  checkedPolicyPlan,
  HfosError,
  POLICY_PLACE_SCHEMA,
  POLICY_PLACE_SYSTEM,
  policyBlocks,
  PolicyPlaceAnswer,
  policyPlacePrompt,
  policyReadRefusal,
  PolicyUpdateInput,
  textingSection,
  updatedPolicy,
  type PolicyKind,
  type PolicyUpdateOutput,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AI_BUDGET_MESSAGE,
  AI_BUSY_MESSAGE,
  AI_UNAVAILABLE_MESSAGE,
  AiAskError,
  askStructured,
} from '../ai/ask';
import { pageText } from '../knowledge/crawl';
import type { TenantScope } from '../services';
import { authenticate, parseBody, requirePermission, type HttpDeps } from './common';
import { SafeFetchError } from './safe-fetch';

/** Asks one address may make a minute. The daily AI limit applies on top. */
export const POLICY_UPDATE_PER_MINUTE = 10;

const Body = PolicyUpdateInput.extend({ workspaceId: z.uuid() });

const NAMES: Readonly<Record<PolicyKind, string>> = { privacy: 'privacy policy', terms: 'terms' };

const FAILED =
  'The AI couldn’t place the section just now. Try again, or add the section yourself.';

function aiError(e: unknown): unknown {
  if (!(e instanceof AiAskError)) return e;
  switch (e.code) {
    case 'ai_unavailable':
      return HfosError.rule('ai_not_configured', 503, AI_UNAVAILABLE_MESSAGE);
    case 'budget_reached':
      // The business's own limit, with its amount, in the words the check that reached it wrote.
      return HfosError.rule('budget_reached', 429, e.message || AI_BUDGET_MESSAGE);
    case 'wallet_empty':
      return HfosError.rule('wallet_empty', 402, e.message);
    case 'provider_error':
      return e.retryable
        ? HfosError.rule('ai_busy', 503, AI_BUSY_MESSAGE)
        : HfosError.rule('ai_failed', 502, FAILED);
    case 'bad_output':
      return HfosError.rule('ai_failed', 502, FAILED);
  }
}

/** The business as the worker acts in it. */
async function scopeOf(deps: HttpDeps, workspaceId: string): Promise<TenantScope> {
  const [ws] = await asWorker(deps.httpDb, { workspaceId }, (tx) =>
    rows<{ organization_id: string }>(
      tx,
      sql`select organization_id from app.workspaces where id = ${workspaceId}`,
    ),
  );
  if (!ws)
    throw HfosError.notFound('This workspace isn’t there anymore. Refresh the page and try again.');
  return { workspaceId, organizationId: ws.organization_id };
}

/** The policy's words from its page, as the knowledge scan reads a page: menus, headers and footers left out. */
async function readPage(
  deps: HttpDeps,
  kind: PolicyKind,
  raw: string,
): Promise<{ text: string; url: string }> {
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return raw;
    }
  })();
  const unreachable = (why: string) =>
    HfosError.rule(
      'policy_unreachable',
      422,
      `${why} Check the address of your ${NAMES[kind]}, or copy it from the page and paste it here instead.`,
    );
  let res;
  try {
    res = await deps.fetchUrl(url, { timeoutMs: 10_000, maxBytes: 1_500_000 });
  } catch (e) {
    const code = e instanceof SafeFetchError ? e.code : 'network';
    throw unreachable(
      code === 'timeout'
        ? `${host} took too long to answer.`
        : code === 'invalid_url'
          ? 'That isn’t a web address we can open.'
          : `We couldn’t reach ${host}.`,
    );
  }
  if (res.status >= 400)
    throw unreachable(
      res.status === 404
        ? `There’s no page at ${url}.`
        : `${host} wouldn’t show us that page (it answered ${res.status}).`,
    );
  const type = res.headers['content-type'] ?? '';
  if (/pdf/i.test(type) || /\.pdf$/i.test(new URL(res.finalUrl).pathname))
    throw HfosError.rule(
      'policy_unreadable',
      422,
      `That address is a PDF, which we can’t read and carriers often turn down. Copy the words of your ${NAMES[kind]} and paste them here, and put them on a page of your website.`,
    );
  return { text: pageText(res.body), url: res.finalUrl };
}

export async function policyUpdate(
  deps: HttpDeps,
  userId: string,
  input: z.output<typeof Body>,
): Promise<PolicyUpdateOutput> {
  await requirePermission(deps, userId, input.workspaceId, 'channels.manage');
  if (!deps.ai.provider) throw HfosError.rule('ai_not_configured', 503, AI_UNAVAILABLE_MESSAGE);

  const pasted = !!input.text?.trim();
  if (!pasted && !input.url?.trim())
    throw HfosError.rule(
      'policy_missing',
      422,
      `Give the address of your ${NAMES[input.kind]}, or paste it here.`,
    );
  const read = pasted
    ? { text: input.text!, url: null }
    : await readPage(deps, input.kind, input.url!.trim());

  const blocks = policyBlocks(read.text);
  const refused = policyReadRefusal(input.kind, blocks, pasted);
  if (refused) throw HfosError.rule(refused.rule, 422, refused.message);

  const section = textingSection(input.kind, input.business);
  const scope = await scopeOf(deps, input.workspaceId);
  const today = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(
    new Date(),
  );
  let answer: PolicyPlaceAnswer;
  try {
    ({ value: answer } = await askStructured(
      { db: deps.httpDb, ai: deps.ai, log: deps.log, wallet: deps.wallet },
      scope,
      {
        system: POLICY_PLACE_SYSTEM,
        messages: [
          {
            role: 'user',
            content: policyPlacePrompt({
              kind: input.kind,
              businessName: input.business.name,
              today,
              section,
              blocks,
            }),
          },
        ],
        schema: POLICY_PLACE_SCHEMA,
        zod: PolicyPlaceAnswer,
        maxTokens: 3000,
        usage: { source: 'texting_policy', userId },
      },
    ));
  } catch (e) {
    throw aiError(e);
  }
  const plan = checkedPolicyPlan(answer, blocks);
  if (!plan)
    throw HfosError.rule(
      'policy_not_a_policy',
      422,
      pasted
        ? `That doesn’t look like a ${NAMES[input.kind]}. Paste the whole of yours, from its title to its contact details.`
        : `${read.url} doesn’t look like a ${NAMES[input.kind]}. Check the address, or copy yours from its page and paste it here instead.`,
    );
  return { ...updatedPolicy(blocks, plan, section), url: read.url };
}

export async function registerPolicyUpdateRoutes(
  app: FastifyInstance,
  deps: HttpDeps,
): Promise<void> {
  await app.register(async (scoped) => {
    await scoped.register(rateLimit, {
      global: false,
      errorResponseBuilder: () =>
        new HfosError(
          'rule_violation',
          429,
          'That’s a lot of asks in a row. Wait a minute and try again.',
          undefined,
          'rate_limited',
        ),
    });
    scoped.post(
      '/v1/telephony/policy-update',
      { config: { rateLimit: { max: POLICY_UPDATE_PER_MINUTE, timeWindow: 60_000 } } },
      async (req) => {
        const actor = await authenticate(deps, req);
        return policyUpdate(deps, actor.userId, parseBody(Body, req.body));
      },
    );
  });
}
