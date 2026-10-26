import type { SessionTimings } from '../voice-agent/session';
import {
  bearerToken,
  HfosError,
  offersConsentWords,
  sendsOffers,
  type HumanActor,
  type TokenVerifier,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Db, type Tx } from '@hfos/db/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { AssistantServices } from '../assistant/routes';
import type { MigrationAdapters } from '../migrations/adapters/registry';
import type { WorkerServices } from '../services';
import { verifyTwilioSignature, type WebhookParams } from '../telephony/signature';
import { renewSubaccountToken } from '../telephony/tokens';
import type { AddonConnectionRouteOptions } from './addon-connections';
import type { BookingHttpOptions } from './booking';
import type { ChatHttpOptions } from './chat';
import type { FormsHttpOptions } from './forms';
import type { IntakeHttpOptions } from './intake';
import type { MoneyHttpOptions } from './money';
import type { SpeechLimits } from './speech';
import type { TestRoutes } from './test-routes';

export interface HttpDeps extends WorkerServices {
  /** A separate small pool, so the loops never starve webhooks. */
  readonly httpDb: Db;
  readonly verifyToken: TokenVerifier | null;
  readonly webOrigins: readonly string[];
  /** The Assistant, when a model is configured (null: the panel says it isn't set up). */
  readonly assistant?: AssistantServices | null;
  /** The public booking page's bot check and per-address limits (default: no bot check, production limits). */
  readonly booking?: BookingHttpOptions;
  /** The website chat's IP-hashing key, bot check and limits (default: a per-process key, no bot check). */
  readonly chat?: ChatHttpOptions;
  /** How long a live call waits on quiet and on Twilio (M18 step 5; tests shorten them). */
  readonly voiceTimings?: Partial<SessionTimings>;
  /** The public form pages: their per-address limits. */
  readonly forms?: FormsHttpOptions;
  /** Leads posted in from a website form or a connected app: their limits and the bot check. */
  readonly intake?: IntakeHttpOptions;
  /**
   * The customer's money pages: their per-address limits. `limitFactor` falls back to the booking page's, so
   * one setting scales every public page Playwright drives from one address.
   */
  readonly money?: MoneyHttpOptions;
  /** Talking out loud's allowance per person (default: SPEECH_LIMITS; tests shrink it). */
  readonly speechLimits?: Partial<SpeechLimits>;
  /** Playwright's routes (http/test-routes.ts): only with the fake providers, never in production. */
  readonly testRoutes?: TestRoutes | null;
  /** Reading the CRM a business is leaving (M11): the sign-in routes need the adapter to build its URL. */
  readonly migrationAdapters?: MigrationAdapters | null;
  /** The add-ons whose keys and updates the connection routes take (default: the real ones; tests give their own). */
  readonly addonConnections?: AddonConnectionRouteOptions;
}

/**
 * The separate box for offers a public page shows, or null when the business doesn't send offers: its texting
 * registration (the latest one sent) is for customer care and the odd promotion, or mostly promotions. The
 * carriers check those businesses for a page where a customer can say yes to one and no to the other.
 */
export async function offersBoxFor(
  tx: Tx,
  workspaceId: string,
  business: string,
): Promise<{ title: string; detail: string } | null> {
  const [row] = await rows<{ use_case: string | null }>(
    tx,
    sql`select submission->>'useCase' as use_case from app.telephony_registrations
        where workspace_id = ${workspaceId} and submission is not null and submitted_at is not null
        order by submitted_at desc, created_at desc
        limit 1`,
  );
  return sendsOffers(row?.use_case) ? offersConsentWords(business) : null;
}

export const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

export interface WebhookAccount {
  readonly token: string;
  readonly workspaceId: string | null;
  readonly organizationId: string | null;
}

/** The token that signs webhooks for an account: the master's own, or a subaccount's (opened from its seal). */
export async function webhookAccount(
  deps: HttpDeps,
  accountSid: string | undefined,
): Promise<WebhookAccount | null> {
  if (!accountSid) return null;
  if (accountSid === deps.telephony.masterAccountSid)
    return { token: deps.telephony.masterAuthToken, workspaceId: null, organizationId: null };
  const [row] = await asWorker(deps.httpDb, {}, (tx) =>
    rows<{ workspace_id: string; organization_id: string; auth_token_enc: string | null }>(
      tx,
      sql`select workspace_id, organization_id, auth_token_enc from private.telephony_account_lookup(${accountSid})`,
    ),
  );
  if (!row?.auth_token_enc) return null;
  return {
    token: deps.sealer.open(row.auth_token_enc),
    workspaceId: row.workspace_id,
    organizationId: row.organization_id,
  };
}

export async function recordDelivery(
  deps: HttpDeps,
  input: {
    provider: string;
    kind: string;
    dedupeKey: string;
    accountRef: string | null;
    url: string;
    params: WebhookParams;
    workspaceId: string | null;
    organizationId: string | null;
  },
): Promise<void> {
  await asWorker(deps.httpDb, {}, (tx) =>
    rows(
      tx,
      sql`select * from private.record_webhook_delivery(${input.provider}, ${input.kind}, ${input.dedupeKey},
            ${input.accountRef}, ${input.url}, ${JSON.stringify(input.params)}::jsonb, true,
            ${input.workspaceId}, ${input.organizationId})`,
    ),
  );
}

export interface VerifiedTwilio {
  readonly account: WebhookAccount;
  readonly params: Record<string, string>;
  /** The URL Twilio called (and signed). */
  readonly url: string;
}

/**
 * A Twilio request whose signature checks out against the URL Twilio called, built from WORKER_PUBLIC_URL and
 * never from the Host header. Anything else gets a 403 and null.
 */
export async function verifiedTwilio(
  deps: HttpDeps,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<VerifiedTwilio | null> {
  const params = (req.body ?? {}) as Record<string, string>;
  const url = `${deps.publicUrl}${req.url}`;
  const signature = header(req, 'x-twilio-signature');
  let account = await webhookAccount(deps, params['AccountSid']);
  let signed = !!account && verifyTwilioSignature(account.token, url, params, signature);
  if (account && !signed && signature) {
    // The business's token may have been rotated in the Twilio console, and Twilio signs with the new one.
    const renewed = await renewSubaccountToken(
      { ...deps, db: deps.httpDb },
      params['AccountSid']!,
      { unproven: true },
    );
    if (renewed) {
      account = { ...account, token: renewed };
      signed = verifyTwilioSignature(renewed, url, params, signature);
    }
  }
  if (!account || !signed) {
    deps.log.warn(
      { path: req.url.split('?')[0], accountSid: params['AccountSid'] },
      'rejected an unsigned or mis-signed webhook',
    );
    reply.code(403).type('text/plain').send('Invalid signature');
    return null;
  }
  return { account, params, url };
}

export async function authenticate(deps: HttpDeps, req: FastifyRequest): Promise<HumanActor> {
  const token = bearerToken(header(req, 'authorization'));
  if (!token || !deps.verifyToken) throw HfosError.unauthenticated();
  return deps.verifyToken(token);
}

export async function hasPermission(
  deps: Pick<HttpDeps, 'httpDb'>,
  userId: string,
  workspaceId: string,
  permission: string,
): Promise<boolean> {
  const [row] = await asWorker(deps.httpDb, {}, (tx) =>
    rows<{ ok: boolean }>(
      tx,
      sql`select private.user_has_permission(${userId}, ${workspaceId}, ${permission}) as ok`,
    ),
  );
  return !!row?.ok;
}

export async function requirePermission(
  deps: Pick<HttpDeps, 'httpDb'>,
  userId: string,
  workspaceId: string,
  permission: string,
): Promise<void> {
  if (!(await hasPermission(deps, userId, workspaceId, permission))) throw HfosError.forbidden();
}

/** A request body checked against its schema; failures answer like the API's validation errors. */
export function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw HfosError.validation(
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  return parsed.data;
}
