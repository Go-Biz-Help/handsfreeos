/**
 * Workflow webhooks.
 *
 * Outgoing (the webhook_out action): JSON POSTed to an https address through the safe fetch (never a private
 * address, 10 s, 64 KB), outside the step's transaction, signed with the workflow's secret (made when the
 * workflow has none). A retry of the step sends the same delivery id.
 *
 * Incoming: POST /webhooks/workflows/:token is found by its token, checked (the HMAC within 5 minutes, a
 * 64 KB JSON body, a per-token rate limit), then stored as a webhook delivery (provider 'workflow', deduped
 * by delivery id). The `workflow:inbound` processor matches or creates the customer (personBy, createPerson)
 * and starts a run. POST /v1/workflows/webhook/reveal (workflows.manage) gives the owner the URL and the
 * secret for their sender, or rotates the secret.
 *
 * Both ways: x-hfos-timestamp is Unix seconds, x-hfos-signature is sha256=<hex HMAC-SHA256(secret,
 * timestamp + "." + body)>, x-hfos-delivery-id names the delivery.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { WEBHOOK_PARTS } from '@hfos/core/server';
import {
  executeCommandIn,
  HfosError,
  matchPersonByPhone,
  normalizePhone,
  personCreate,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIdFor } from '../booking/deliver';
import type { Sealer } from '../crypto';
import type { DeliveryProcessor } from '../deliveries';
import {
  authenticate,
  header,
  parseBody,
  recordDelivery,
  requirePermission,
  type HttpDeps,
} from '../http/common';
import { SafeFetchError, type SafeFetch } from '../http/safe-fetch';
import { systemActor, tenantOf, workerMeta, type TenantScope } from '../services';
import { versionDefinition } from './defs';
import { enrol } from './enrol';
import { recordEngineEvent } from './events';
import {
  isRefusal,
  type ExecCtx,
  type Json,
  type Outcome,
  type SlowWork,
  type StepError,
} from './types';

export const WEBHOOK_TOLERANCE_S = 300;
export const WEBHOOK_MAX_BYTES = 65_536;
export const WEBHOOK_TIMEOUT_MS = 10_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{24,64}$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// ---- Signing ----

export function signBody(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** A signature made with this secret over this body, at most 5 minutes from now either way. */
export function verifyBody(
  secret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  body: string,
  nowMs: number = Date.now(),
): boolean {
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_S) return false;
  const expected = Buffer.from(signBody(secret, timestamp, body));
  const given = Buffer.from(signature.trim());
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const newSecret = () => randomBytes(32).toString('base64url');

/** A workflow's webhook: its token and (opened) secret, made the first time it's needed. */
export async function ensureWebhook(
  tx: Tx,
  sealer: Sealer,
  scope: TenantScope,
  workflowId: string,
  createdBy: string | null,
): Promise<{ id: string; token: string; secret: string }> {
  const find = () =>
    rows<{ id: string; token: string; secret_enc: string }>(
      tx,
      sql`select id, token, secret_enc from app.workflow_webhooks where workflow_id = ${workflowId}`,
    );
  const [found] = await find();
  if (found) return { id: found.id, token: found.token, secret: sealer.open(found.secret_enc) };
  const secret = newSecret();
  const [row] = await rows<{ id: string; token: string }>(
    tx,
    sql`insert into app.workflow_webhooks (workspace_id, workflow_id, token, secret_enc, key_id, created_by)
        values (${scope.workspaceId}, ${workflowId}, ${newSecret()}, ${sealer.seal(secret)}, ${sealer.keyId},
          ${createdBy})
        on conflict (workflow_id) do nothing
        returning id, token`,
  );
  if (row) return { id: row.id, token: row.token, secret };
  const [again] = await find();
  return { id: again!.id, token: again!.token, secret: sealer.open(again!.secret_enc) };
}

async function rotateSecret(tx: Tx, sealer: Sealer, webhookId: string): Promise<string> {
  const secret = newSecret();
  await tx.execute(
    sql`update app.workflow_webhooks set secret_enc = ${sealer.seal(secret)}, key_id = ${sealer.keyId}
        where id = ${webhookId}`,
  );
  return secret;
}

// ---- Outgoing ----

type WebhookPart = (typeof WEBHOOK_PARTS)[number];

async function webhookBody(
  ec: ExecCtx,
  include: readonly WebhookPart[],
  deliveryId: string,
): Promise<Json> {
  const body: Json = {
    id: deliveryId,
    type: 'workflow.step',
    workflow: { id: ec.run.workflowId, name: ec.workflow.name },
    run: { id: ec.run.id, stepKey: ec.stepKey, test: ec.run.isTest },
    sentAt: new Date(ec.now).toISOString(),
  };
  if (include.includes('person')) {
    const p = await ec.data.person();
    body['person'] = p
      ? {
          id: p.id,
          firstName: p.first_name,
          lastName: p.last_name,
          email: p.email,
          phone: p.phone_e164,
          city: p.city,
        }
      : null;
  }
  if (include.includes('lead')) {
    const l = await ec.data.lead();
    body['lead'] = l
      ? {
          id: l.id,
          title: l.title,
          value: l.value_cents / 100,
          status: l.status,
          stage: l.stage,
          pipeline: l.pipeline,
        }
      : null;
  }
  if (include.includes('appointment')) {
    const a = await ec.data.appointment();
    body['appointment'] = a
      ? {
          id: a.id,
          title: a.title,
          status: a.status,
          startsAt: a.starts_at.toISOString(),
          endsAt: a.ends_at.toISOString(),
          calendar: a.calendar,
        }
      : null;
  }
  if (include.includes('conversation')) {
    const c = await ec.data.conversation();
    body['conversation'] = c ? { id: c.id, channel: c.channel, lastMessage: c.last_message } : null;
  }
  if (include.includes('trigger')) {
    const t = ec.context['trigger'];
    body['trigger'] = isRecord(t) ? t : null;
  }
  return body;
}

/** A webhook_out step: the request, ready to go once the step's claim commits. Test runs only show it. */
export async function webhookWork(
  ec: ExecCtx,
  config: { readonly url: string; readonly include: readonly WebhookPart[] },
): Promise<Outcome> {
  const deliveryId = clientIdFor('wf', ec.run.id, ec.stepKey);
  const payload = await webhookBody(ec, config.include, deliveryId);
  const body = JSON.stringify(payload);
  const input: Json = {
    url: config.url,
    include: [...config.include],
    deliveryId,
    bytes: body.length,
  };
  if (ec.testMode)
    return { kind: 'done', input, output: { simulated: true, would: 'post', body: payload } };
  if (body.length > WEBHOOK_MAX_BYTES)
    return {
      kind: 'refused',
      input,
      error: {
        message: 'This webhook’s data is over 64 KB.',
        rule: 'webhook_too_large',
        code: 'rule_violation',
      },
    };
  const hook = await ensureWebhook(ec.tx, ec.s.sealer, ec.scope, ec.run.workflowId, null);
  return {
    kind: 'slow',
    input,
    work: { kind: 'webhook', url: config.url, body, secret: hook.secret, deliveryId },
  };
}

/** Addresses the safe fetch refuses for good: a person must change the step. */
const REFUSED_FETCH = new Set(['invalid_url', 'not_https', 'blocked_address', 'other_host']);

export type Delivered =
  { readonly ok: true; readonly output: Json } | { readonly ok: false; readonly error: StepError };

/**
 * Sends one outgoing webhook. A 2xx is done; a refused address or a 4xx is a refusal; a timeout, a network
 * failure, a 408, a 429 or a 5xx throws, so the step is tried again later.
 */
export async function deliverWebhook(
  fetchUrl: SafeFetch,
  work: Extract<SlowWork, { kind: 'webhook' }>,
): Promise<Delivered> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  let res;
  try {
    res = await fetchUrl(work.url, {
      method: 'POST',
      timeoutMs: WEBHOOK_TIMEOUT_MS,
      maxBytes: WEBHOOK_MAX_BYTES,
      headers: {
        'content-type': 'application/json',
        'x-hfos-delivery-id': work.deliveryId,
        'x-hfos-timestamp': timestamp,
        'x-hfos-signature': signBody(work.secret, timestamp, work.body),
      },
      body: work.body,
    });
  } catch (e) {
    if (e instanceof SafeFetchError && REFUSED_FETCH.has(e.code))
      return { ok: false, error: { message: e.message, rule: e.code, code: 'rule_violation' } };
    throw e;
  }
  if (res.status >= 200 && res.status < 300)
    return {
      ok: true,
      output: { status: res.status, response: res.body.slice(0, 500), truncated: res.truncated },
    };
  if (res.status === 408 || res.status === 429 || res.status >= 500)
    throw new Error(`The address answered ${res.status}.`);
  return {
    ok: false,
    error: {
      message: `The address refused the webhook (${res.status}).`,
      rule: 'webhook_rejected',
      code: 'rule_violation',
      details: { status: res.status, response: res.body.slice(0, 500) },
    },
  };
}

// ---- Incoming ----

interface Route extends Record<string, unknown> {
  webhook_id: string;
  workflow_id: string;
  workspace_id: string;
  organization_id: string;
  secret_enc: string;
}

/** Per-token limit on accepted deliveries (one worker process; a burst past it gets a 429). */
export interface InboundLimit {
  readonly max: number;
  readonly windowMs: number;
}
const DEFAULT_LIMIT: InboundLimit = { max: 120, windowMs: 60_000 };

function limiter(limit: InboundLimit) {
  const hits = new Map<string, { start: number; count: number }>();
  return (token: string, now: number): boolean => {
    const h = hits.get(token);
    if (!h || now - h.start >= limit.windowMs) {
      if (hits.size > 10_000) hits.clear();
      hits.set(token, { start: now, count: 1 });
      return true;
    }
    h.count += 1;
    return h.count <= limit.max;
  };
}

const RevealInput = z.object({
  workspaceId: z.uuid(),
  workflowId: z.uuid(),
  rotate: z.boolean().default(false),
});

/**
 * An error body shaped like the rest of the worker's (and the API's), with what a sender should do: a delivery that
 * was refused as sent never goes through (final); too many at once goes through later (retry).
 */
const errorBody = (code: string, message: string, disposition: 'final' | 'retry' = 'final') => ({
  error: { code, message, disposition },
});

export async function registerWorkflowRoutes(
  app: FastifyInstance,
  deps: HttpDeps,
  opts: { readonly inboundLimit?: InboundLimit } = {},
): Promise<void> {
  const allow = limiter(opts.inboundLimit ?? DEFAULT_LIMIT);

  await app.register(async (scoped) => {
    // The raw body is what's signed: keep JSON as the exact string that arrived, up to 64 KB.
    scoped.removeContentTypeParser(['application/json']);
    scoped.addContentTypeParser(
      'application/json',
      { parseAs: 'string', bodyLimit: WEBHOOK_MAX_BYTES },
      (_req, body, done) => done(null, body),
    );
    scoped.post<{ Params: { token: string } }>(
      '/webhooks/workflows/:token',
      { bodyLimit: WEBHOOK_MAX_BYTES },
      async (req, reply) => {
        const now = Date.now();
        const token = req.params.token;
        const missing = () =>
          reply.code(404).send(errorBody('not_found', 'No workflow listens at this address.'));
        if (!TOKEN_RE.test(token)) return missing();
        const [route] = await asWorker(deps.httpDb, {}, (tx) =>
          rows<Route>(
            tx,
            sql`select webhook_id, workflow_id, workspace_id, organization_id, secret_enc
                from private.workflow_webhook_route(${token})`,
          ),
        );
        if (!route) return missing();
        const raw = typeof req.body === 'string' ? req.body : null;
        if (raw === null)
          return reply
            .code(415)
            .send(errorBody('validation', 'Send JSON, with content-type: application/json.'));
        const timestamp = header(req, 'x-hfos-timestamp');
        if (
          !verifyBody(
            deps.sealer.open(route.secret_enc),
            timestamp,
            header(req, 'x-hfos-signature'),
            raw,
            now,
          )
        ) {
          deps.log.warn({ webhookId: route.webhook_id }, 'rejected a mis-signed workflow webhook');
          return reply
            .code(401)
            .send(errorBody('unauthenticated', 'The signature doesn’t match, or it’s too old.'));
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return reply.code(400).send(errorBody('validation', 'The body isn’t valid JSON.'));
        }
        if (!isRecord(parsed))
          return reply.code(400).send(errorBody('validation', 'Send a JSON object.'));
        if (!allow(token, now))
          return reply
            .code(429)
            .send(
              errorBody(
                'rule_violation',
                'Too many deliveries. Wait a minute and try again.',
                'retry',
              ),
            );
        const deliveryId =
          (header(req, 'x-hfos-delivery-id') ?? '').trim().slice(0, 100) ||
          createHash('sha256').update(`${timestamp}.${raw}`).digest('hex');
        await recordDelivery(deps, {
          provider: 'workflow',
          kind: 'inbound',
          dedupeKey: `${route.webhook_id}:${deliveryId}`,
          accountRef: route.webhook_id,
          url: `${deps.publicUrl}/webhooks/workflows/:token`,
          params: {
            workflowId: route.workflow_id,
            webhookId: route.webhook_id,
            deliveryId,
            body: raw,
          },
          workspaceId: route.workspace_id,
          organizationId: route.organization_id,
        });
        return reply.code(202).send({ received: true, deliveryId });
      },
    );
  });

  app.post('/v1/workflows/webhook/reveal', async (req) => {
    const actor = await authenticate(deps, req);
    const input = parseBody(RevealInput, req.body ?? {});
    await requirePermission(deps, actor.userId, input.workspaceId, 'workflows.manage');
    const [ws] = await asWorker(deps.httpDb, { workspaceId: input.workspaceId }, (tx) =>
      rows<{ organization_id: string }>(
        tx,
        sql`select organization_id from app.workspaces where id = ${input.workspaceId}`,
      ),
    );
    if (!ws) throw HfosError.notFound('Workspace not found.');
    const scope = { workspaceId: input.workspaceId, organizationId: ws.organization_id };
    return asWorker(deps.httpDb, scope, async (tx) => {
      const [wf] = await rows<{ id: string; name: string }>(
        tx,
        sql`select id, name from app.workflows where id = ${input.workflowId} and workspace_id = ${scope.workspaceId}`,
      );
      if (!wf) throw HfosError.notFound('Workflow not found.');
      const hook = await ensureWebhook(tx, deps.sealer, scope, wf.id, actor.userId);
      const secret = input.rotate ? await rotateSecret(tx, deps.sealer, hook.id) : hook.secret;
      await recordEngineEvent(tx, {
        type: input.rotate ? 'workflow.webhook_rotated' : 'workflow.webhook_revealed',
        action: input.rotate ? 'workflow.rotate_webhook' : 'workflow.reveal_webhook',
        workspaceId: scope.workspaceId,
        organizationId: scope.organizationId,
        entityType: 'workflow',
        entityId: wf.id,
        // The worker records as the system, on behalf of the person who asked (never as them).
        actor: { type: 'system' },
        payload: {
          workflowId: wf.id,
          webhookId: hook.id,
          onBehalfOf: actor.userId,
          _broadcast: false,
        },
        after: { workflow: wf.name, rotated: input.rotate, by: actor.email },
      });
      return {
        workflowId: wf.id,
        url: `${deps.publicUrl}/webhooks/workflows/${hook.token}`,
        secret,
        rotated: input.rotate,
        signing: {
          timestampHeader: 'x-hfos-timestamp',
          signatureHeader: 'x-hfos-signature',
          deliveryIdHeader: 'x-hfos-delivery-id',
          format:
            'sha256=<hex HMAC-SHA256(secret, timestamp + "." + body)>, timestamp in Unix seconds',
        },
      };
    });
  });
}

interface Contact {
  readonly phone: string | null;
  readonly email: string | null;
  readonly firstName: string;
  readonly lastName: string;
}

/** Who a delivery is about: common field names, at the top or under `contact` / `person`. */
function contactOf(body: Record<string, unknown>): Contact {
  const sources = [body, body['contact'], body['person']].filter(isRecord);
  const pick = (...keys: string[]): string | null => {
    for (const s of sources)
      for (const k of keys) {
        const v = s[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
    return null;
  };
  const email = pick('email', 'email_address', 'emailAddress')?.toLowerCase() ?? null;
  const name = pick('name', 'full_name', 'fullName');
  const [first, ...rest] = (name ?? '').split(/\s+/).filter(Boolean);
  return {
    phone: normalizePhone(pick('phone', 'phone_number', 'phoneNumber', 'mobile')),
    email: email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null,
    firstName: (pick('first_name', 'firstName') ?? first ?? 'New contact').slice(0, 80),
    lastName: (pick('last_name', 'lastName') ?? rest.join(' ')).slice(0, 80),
  };
}

async function matchPerson(
  tx: Tx,
  workspaceId: string,
  by: 'phone' | 'email' | 'phone_or_email',
  who: Contact,
): Promise<string | null> {
  if (by !== 'email' && who.phone) {
    const id = await matchPersonByPhone(tx, workspaceId, who.phone);
    if (id) return id;
  }
  if (by !== 'phone' && who.email) {
    // Their main email or one of their others (0100); the one whose main email it is first.
    const email = who.email.toLowerCase();
    const [p] = await rows<{ id: string }>(
      tx,
      sql`select id from app.people
          where workspace_id = ${workspaceId} and archived_at is null
            and (email = ${email}::extensions.citext
              or other_emails @> ${JSON.stringify([{ email }])}::jsonb)
          order by (email is not distinct from ${email}::extensions.citext) desc, updated_at desc
          limit 1`,
    );
    if (p) return p.id;
  }
  return null;
}

/** A stored inbound delivery: match or create the customer, then start the run. */
export const onWorkflowInbound: DeliveryProcessor = async (ctx) => {
  const d = ctx.delivery;
  const scope = tenantOf({ workspaceId: d.workspaceId, organizationId: d.organizationId });
  const params = isRecord(d.params) ? d.params : {};
  const workflowId = String(params['workflowId'] ?? '');
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(String(params['body'] ?? '{}'));
    body = isRecord(parsed) ? parsed : {};
  } catch {
    return 'ignored';
  }
  return asWorker(ctx.db, scope, async (tx) => {
    await tx.execute(
      sql`update app.workflow_webhooks set last_received_at = now() where workflow_id = ${workflowId}`,
    );
    const [wf] = await rows<{ id: string; name: string; status: string; version: string | null }>(
      tx,
      sql`select id, name, status::text as status, active_version_id as version from app.workflows
          where id = ${workflowId} and workspace_id = ${scope.workspaceId}`,
    );
    // A paused or archived workflow ignores what arrives (it isn't queued for later).
    if (!wf || wf.status !== 'active' || !wf.version) return 'ignored';
    const def = await versionDefinition(tx, wf.version);
    if (def.trigger.kind !== 'webhook') return 'ignored';
    const who = contactOf(body);
    let personId = await matchPerson(tx, scope.workspaceId, def.trigger.personBy, who);
    if (!personId && def.trigger.createPerson && (who.phone || who.email)) {
      try {
        const { output } = await executeCommandIn(
          tx,
          personCreate,
          {
            workspaceId: scope.workspaceId,
            firstName: who.firstName,
            lastName: who.lastName,
            email: who.email,
            phone: who.phone,
            source: 'Webhook',
            ignoreDuplicates: true,
          },
          systemActor(scope),
          workerMeta(null, d.id),
        );
        personId = output.personId;
      } catch (e) {
        if (!isRefusal(e)) throw e;
        ctx.log.info({ workflowId, err: e.message }, 'webhook contact could not be added');
      }
    }
    if (!personId) {
      ctx.log.info({ workflowId }, 'webhook named no customer this workflow can use');
      return 'ignored';
    }
    await enrol(tx, {
      scope,
      workflow: { id: wf.id, name: wf.name },
      versionId: wf.version,
      def,
      personId,
      dedupeKey: `webhook:${d.dedupeKey}`,
      context: { trigger: { event: 'webhook', deliveryId: params['deliveryId'] ?? null, body } },
      log: ctx.log,
    });
  });
};
