/**
 * The two doors a lead arrives through from outside HandsFreeOS (M14 slice B).
 *
 * `POST /intake/f/:key` is a form on the business's own website. Its key sits in the page's HTML, so it is
 * not a secret: what makes it safe is the list of sites it may be posted from (the browser's Origin header,
 * which it sets on every cross-site POST and a page cannot forge), a honeypot field, the rate limits here,
 * and the source's own limit for the day. It takes a classic HTML form post or JSON from a script, and it
 * answers a classic post with a redirect to the business's thank-you page when they have set one.
 *
 * `POST /v1/intake` is a service — Zapier, a lead-ad forwarder, somebody's own code — sending one over with
 * a secret key. Only its SHA-256 is stored, so a key is checked by hashing what arrives and never by looking
 * one up.
 *
 * Neither ever says whether a customer was already here. Both are safe to call twice: a sender that retries
 * gets the answer it got the first time, and no second lead.
 */
import { createHash, randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import {
  bearerToken,
  executeCommand,
  HfosError,
  intakeSubmit,
  type RequestMeta,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { BotCheck } from '../booking/bot-check';
import { KeyedLimiter, type Hit } from '../chat/limiter';
import { systemActor } from '../services';
import { header, type HttpDeps } from './common';

export interface IntakeHttpOptions {
  /** Playwright turns the limits down; production leaves them alone. */
  readonly limitFactor?: number;
  /** Cloudflare Turnstile, shared with the booking page. Checked only when a form sends a token. */
  readonly botCheck?: BotCheck;
}

/** The names a form is likely to give its boxes, and what each one is filed under. */
const FIELD = {
  name: ['name', 'fullname', 'full_name', 'your-name', 'yourname'],
  firstName: ['firstname', 'first_name', 'fname', 'given-name'],
  lastName: ['lastname', 'last_name', 'lname', 'surname', 'family-name'],
  email: ['email', 'email_address', 'emailaddress', 'your-email', 'e-mail'],
  phone: ['phone', 'telephone', 'tel', 'mobile', 'phone_number', 'phonenumber', 'your-phone'],
  message: [
    'message',
    'comments',
    'comment',
    'notes',
    'enquiry',
    'inquiry',
    'details',
    'your-message',
  ],
  title: ['title', 'subject', 'service', 'job'],
} as const;

/** What a page hides from people: filled in means a robot, and the form answers as if all was well. */
const HONEYPOTS = new Set(['website', '_gotcha', 'url', 'company_website']);
/** Sent by the bot check and by form builders; never part of what the business asked. */
const IGNORED = new Set([
  'cf-turnstile-response',
  'g-recaptcha-response',
  'h-captcha-response',
  '_id',
  'id',
  'dedupekey',
  'dedupe_key',
  'redirect',
  'redirect_to',
  'redirecturl',
]);

const KEY_RE = /^ik_[A-Za-z0-9]{20}$/;
const notFound = () =>
  new HfosError(
    'not_found',
    404,
    'This form isn’t taking answers anymore, so nothing was sent. Contact the business by phone or email instead.',
    undefined,
    'intake_not_found',
  );
const originRefused = () =>
  HfosError.forbidden(
    'This form isn’t set up to send from this website, so nothing was sent. Contact the business by phone or email instead.',
    'origin_not_allowed',
  );

interface FormRoute extends Record<string, unknown> {
  readonly source_id: string;
  readonly workspace_id: string;
  readonly organization_id: string;
  readonly active: boolean;
  readonly allowed_origins: string[];
  readonly redirect_url: string | null;
}
interface KeyRoute extends Record<string, unknown> {
  readonly source_id: string;
  readonly workspace_id: string;
  readonly organization_id: string;
  readonly active: boolean;
}

const originOf = (raw: string | undefined): string =>
  (raw ?? '').trim().toLowerCase().replace(/\/+$/, '');

/** What the sender posted, sorted into the fields we know and everything else. */
function readPayload(body: Record<string, unknown>): {
  payload: Record<string, unknown>;
  honeypot: boolean;
  turnstile: string | undefined;
} {
  const named: Record<string, string> = {};
  const extra: Record<string, string> = {};
  let honeypot = false;
  let turnstile: string | undefined;
  for (const [rawKey, rawValue] of Object.entries(body)) {
    const key = rawKey.trim().toLowerCase();
    const value = typeof rawValue === 'string' ? rawValue : String(rawValue ?? '');
    if (key === 'cf-turnstile-response') turnstile = value;
    if (HONEYPOTS.has(key)) {
      if (value.trim()) honeypot = true;
      continue;
    }
    if (IGNORED.has(key)) continue;
    const known = (Object.keys(FIELD) as (keyof typeof FIELD)[]).find((f) =>
      (FIELD[f] as readonly string[]).includes(key),
    );
    if (known && !named[known] && value.trim()) named[known] = value.trim();
    else if (!known && value.trim() && Object.keys(extra).length < 30)
      extra[rawKey.slice(0, 80)] = value.slice(0, 2000);
  }
  return {
    payload: { ...named, ...(Object.keys(extra).length ? { extra } : {}) },
    honeypot,
    turnstile,
  };
}

/** The sender's own id for this submission, or one made from what it sent, so a retry finds its row. */
function dedupeKeyOf(body: Record<string, unknown>, sourceId: string, payload: unknown): string {
  for (const key of ['dedupeKey', 'dedupe_key', '_id', 'id']) {
    const given = body[key];
    if (typeof given === 'string' && given.trim()) return given.trim().slice(0, 200);
  }
  const day = new Date().toISOString().slice(0, 10);
  return createHash('sha256')
    .update(`${sourceId}:${day}:${JSON.stringify(payload)}`)
    .digest('hex');
}

/**
 * The sites a form's key allows, for the app's CORS delegate (http/server.ts). A script on the business's
 * own page can then read the answer; a page anywhere else is refused by the browser before it sees one.
 */
export async function formOrigins(deps: HttpDeps, key: string): Promise<string[]> {
  if (!KEY_RE.test(key)) return [];
  const [row] = await asWorker(deps.httpDb, {}, (tx) =>
    rows<{ allowed_origins: string[] }>(
      tx,
      sql`select allowed_origins from private.intake_form_lookup(${key})`,
    ),
  );
  return row?.allowed_origins ?? [];
}

export async function registerIntakeRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  const factor = deps.intake?.limitFactor ?? 1;
  const limits = {
    form: { max: Math.ceil(10 * factor), timeWindow: '1 minute' },
    api: { max: Math.ceil(60 * factor), timeWindow: '1 minute' },
  };
  // A website form can't demand the human check, so a script spread over many addresses is bounded by these, in
  // memory on each machine like the chat's, on top of the per-minute limit above and the source's daily cap:
  // an address over an hour, one form in a burst, and the business across all its forms.
  const formLimits = {
    ipHour: { max: Math.ceil(30 * factor), timeWindow: 60 * 60_000 },
    formMinute: { max: Math.ceil(20 * factor), timeWindow: 60_000 },
    businessMinute: { max: Math.ceil(40 * factor), timeWindow: 60_000 },
    businessHour: { max: Math.ceil(300 * factor), timeWindow: 60 * 60_000 },
  };
  const limiter = new KeyedLimiter();
  const limitForm = (reply: FastifyReply, ip: string, route: FormRoute): void => {
    const hits: Hit[] = [
      { key: `ip:${ip}`, rule: formLimits.ipHour },
      { key: `f:${route.source_id}`, rule: formLimits.formMinute },
      { key: `b:${route.workspace_id}:m`, rule: formLimits.businessMinute },
      { key: `b:${route.workspace_id}:h`, rule: formLimits.businessHour },
    ];
    const r = limiter.take(hits);
    if (r.ok) return;
    void reply.header('retry-after', String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))));
    const minutes = Math.max(1, Math.ceil(r.retryAfterMs / 60_000));
    throw HfosError.rule(
      'rate_limited',
      429,
      `Too many forms were sent from here, so this one wasn’t. Try again in ${minutes === 1 ? 'a minute' : `${minutes} minutes`}.`,
    );
  };
  const botCheck = deps.intake?.botCheck ?? null;
  const meta = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'booking_page' });

  const formRoute = async (key: string): Promise<FormRoute | null> => {
    if (!KEY_RE.test(key)) return null;
    const [row] = await asWorker(deps.httpDb, {}, (tx) =>
      rows<FormRoute>(tx, sql`select * from private.intake_form_lookup(${key})`),
    );
    return row ?? null;
  };

  const keyRoute = async (secret: string): Promise<KeyRoute | null> => {
    const hash = createHash('sha256').update(secret).digest();
    const [row] = await asWorker(deps.httpDb, {}, (tx) =>
      rows<KeyRoute>(tx, sql`select * from private.intake_key_lookup(${hash})`),
    );
    return row ?? null;
  };

  const submit = async (
    route: { source_id: string; workspace_id: string; organization_id: string },
    body: Record<string, unknown>,
    payload: Record<string, unknown>,
  ) => {
    const scope = { workspaceId: route.workspace_id, organizationId: route.organization_id };
    const { output } = await executeCommand(
      deps.httpDb,
      intakeSubmit,
      {
        workspaceId: route.workspace_id,
        sourceId: route.source_id,
        dedupeKey: dedupeKeyOf(body, route.source_id, payload),
        payload,
      },
      systemActor(scope),
      meta(),
    );
    return output;
  };

  await app.register(async (pub) => {
    await pub.register(rateLimit, { global: false });
    /** A form on the business's own website. */
    pub.post<{ Params: { key: string }; Body: unknown }>(
      '/intake/f/:key',
      { config: { rateLimit: limits.form } },
      async (req, reply) => {
        const route = await formRoute(req.params.key);
        if (!route) throw notFound();
        const body = (req.body ?? {}) as Record<string, unknown>;
        const { payload, honeypot, turnstile } = readPayload(body);
        // The Origin header comes from the browser on every cross-site POST, and a page cannot change it.
        const origin = originOf(header(req, 'origin'));
        if (!origin || !route.allowed_origins.includes(origin)) throw originRefused();
        limitForm(reply, req.ip, route);

        const done = (outcome: string) => answer(reply, req, route.redirect_url, outcome);
        // A robot filled in the field people can't see: it is told all is well, and nothing is written.
        if (honeypot) return done('opened');
        // A script can send any Origin it likes, yet a token can't be demanded: the form is on their own site,
        // which needn't carry our widget, and a cf-turnstile-response it does send is usually their own widget's,
        // which fails against our secret. So main.ts leaves this check off, and the source's daily cap and the
        // limits here are what bound a script.
        if (botCheck?.enabled && turnstile) {
          const verdict = await botCheck.verify(turnstile, req.ip);
          if (verdict === 'fail') return done('opened');
        }
        const out = await submit(route, body, payload);
        return done(out.outcome);
      },
    );

    /** A service sending one over with its secret key. */
    pub.post<{ Body: unknown }>(
      '/v1/intake',
      { config: { rateLimit: limits.api } },
      async (req) => {
        const secret = bearerToken(header(req, 'authorization'));
        if (!secret)
          throw HfosError.unauthenticated(
            'This needs your secret key. Settings → Lead intake shows how to send it, under How an app sends one.',
          );
        const route = await keyRoute(secret);
        if (!route)
          throw HfosError.unauthenticated(
            'That secret key doesn’t match any connected app. Check that you copied all of it, or connect the app again in Settings → Lead intake to get a new one.',
          );
        const body = (req.body ?? {}) as Record<string, unknown>;
        const { payload } = readPayload(body);
        const out = await submit(route, body, payload);
        // A developer is on the other end of this one: it says plainly what happened and why.
        return {
          ok: out.outcome !== 'refused',
          outcome: out.outcome,
          reason: out.refusedReason,
          duplicate: out.duplicate,
          personId: out.personId,
          leadId: out.leadId,
        };
      },
    );
  });
}

/**
 * A page that posted a form is taken to the business's thank-you page; a script gets JSON. Neither is told
 * whether the customer was already here, or whether a lead opened — that is the business's own.
 */
function answer(
  reply: FastifyReply,
  req: FastifyRequest,
  redirectUrl: string | null,
  outcome: string,
): unknown {
  const wantsHtml = (header(req, 'accept') ?? '').includes('text/html');
  if (redirectUrl && wantsHtml) return reply.code(303).redirect(redirectUrl);
  return reply.send({ ok: outcome !== 'refused', received: true });
}
