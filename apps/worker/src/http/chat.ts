/**
 * The website chat's public routes (plan M7, "Website chat"). The chat window (the /chat/<key> page on our own
 * site, framed by the business's) calls them with the widget's public key; every route after `start` also sends
 * the visitor's token as `Authorization: Bearer <token>`. Everything runs as the system actor on the
 * `chat_widget` channel, inside the business the key names, through core's chat commands.
 *
 * - Tokens: 32 random bytes, returned once; only their SHA-256 is stored. A week-old token is swapped at the
 *   next start, and the previous one keeps working for 10 minutes.
 * - Where it's embedded: the window reports the host page's origin and path in `start` and in heartbeats.
 *   Origins that aren't on the widget's list are refused (the browser's frame-ancestors is the real guard), and
 *   the install check is recorded.
 * - IP addresses: only an HMAC-SHA256 under CHAT_IP_KEY is stored; the address is never stored or logged.
 * - Abuse: limits per address, per visitor, per widget and per business; the invisible human check (Turnstile)
 *   on the first message, every 50th and after a new token; a honeypot; repeated messages; floods of new
 *   visitors from one network; and the widget's daily cap (core). When Cloudflare can't answer, the message
 *   still lands in the inbox, but the AI teammate leaves it to people (chat.receive's `aiReply: false`).
 * - Live: GET stream (server-sent events, 5 minutes at a time) fed by the ChatHub; GET messages is the polling
 *   fallback. No response ever carries a matched customer's details.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import {
  bearerToken,
  CHAT_MESSAGE_MAX,
  chatAskForOf,
  chatIdentify,
  chatMarkRead,
  chatReceive,
  chatVisitorRecordSeen,
  chatVisitorResume,
  chatVisitorRotateToken,
  chatVisitorStart,
  chatWidgetRecordSeen,
  executeCommand,
  HfosError,
  openHoursOf,
  readableTextOn,
  type CommandDef,
  type RequestMeta,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { passThroughBotCheck, type BotCheck } from '../booking/bot-check';
import { ChatHub, type HubClient, type HubEvent } from '../chat/hub';
import {
  chatLimitsFor,
  KeyedLimiter,
  rateLimited,
  type ChatLimits,
  type Hit,
} from '../chat/limiter';
import {
  answeringTeammate,
  inboundCount,
  ipHmacOf,
  listMessages,
  loadWidget,
  messageView,
  networkBlocked,
  newVisitorsFrom,
  newVisitorToken,
  originAllowed,
  originOf,
  parseCursor,
  teammateWorkingNow,
  TOKEN_RE,
  tokenHashOf,
  typingNow,
  visitorByToken,
  visitorHistory,
  widgetRoute,
  withinHours,
  type ChatMessageOut,
  type VisitorAuth,
  type WidgetRoute,
  type WidgetRow,
} from '../chat/store';
import { systemActor, type TenantScope } from '../services';
import { header, parseBody, type HttpDeps } from './common';
import { openStream } from './sse';

// ---- Options ----

export interface ChatHttpOptions {
  /**
   * CHAT_IP_KEY: visitors' IP addresses are kept only as an HMAC under it. Default: a random key for this process
   * (tests); production always passes its own.
   */
  readonly ipKey?: string;
  /** Cloudflare Turnstile, shared with the booking page (default: none, every message passes). */
  readonly botCheck?: BotCheck;
  /** Multiplies every volume limit; 10 outside production, where one address runs everything. */
  readonly limitFactor?: number;
  /** Replaces limits outright (tests). */
  readonly limits?: Partial<ChatLimits>;
  /** How often open chats read the live feed (default 1 s). */
  readonly feedIntervalMs?: number;
  /** How long one stream lasts before the chat window reconnects (default 5 minutes). */
  readonly streamMs?: number;
}

/** One stream's life; the chat window then reconnects with Last-Event-ID. */
export const CHAT_STREAM_MS = 5 * 60_000;
/** The invisible human check comes back every this many messages. */
export const HUMAN_CHECK_EVERY = 50;
/** Next to the texts box (the booking page's wording, for a chat). */
export const CHAT_SMS_CONSENT_TEXT =
  'Text me about my request. Msg & data rates may apply. Reply STOP to opt out.';

// ---- What the chat window gets ----

/** The stream's events, each a `data:` line of JSON; `message` events carry an `id:` (the cursor). */
export type ChatStreamEvent =
  | { readonly type: 'ready' }
  | { readonly type: 'message'; readonly message: ChatMessageOut }
  /** The AI teammate is writing; show it for up to 8 seconds, or until its message arrives. */
  | { readonly type: 'typing'; readonly name: string | null }
  /** A person's first message in this chat follows ("Dale joined"). */
  | { readonly type: 'joined'; readonly name: string | null }
  /** The stream is ending: reconnect with Last-Event-ID (expired), or after a pause (shutdown). */
  | { readonly type: 'bye'; readonly reason: 'expired' | 'shutdown' };

// ---- Refusals ----

const widgetNotFound = () =>
  new HfosError('not_found', 404, 'This chat isn’t available.', undefined, 'widget_not_found');
const chatNotFound = () =>
  HfosError.rule('chat_not_found', 404, 'This chat has ended. Start a new one.');
const chatNotStarted = () =>
  HfosError.rule('chat_not_started', 409, 'Send a message to start the chat.');
const widgetPaused = () =>
  HfosError.rule('widget_paused', 409, 'This chat is paused right now. Please try again later.');
const blocked = (why: 'visitor' | 'network') =>
  HfosError.forbidden(
    'This chat isn’t available right now.',
    why === 'visitor' ? 'visitor_blocked' : 'network_blocked',
  );
const originRefused = () =>
  HfosError.forbidden('This chat isn’t set up for this website.', 'origin_not_allowed');
const networkFlood = () =>
  HfosError.rule(
    'network_flood',
    429,
    'Lots of chats are starting from this network. Please try again later.',
  );
const repeated = () =>
  HfosError.rule(
    'repeated_message',
    429,
    'You’ve sent that already. We’ll reply as soon as we can.',
  );
const checkRequired = () =>
  HfosError.rule('bot_check_required', 400, 'Please confirm you’re a person, then send again.');
const checkFailed = () =>
  HfosError.rule('bot_check_failed', 400, 'Please confirm you’re a person, then try again.');

/** A filled honeypot is a bot: a plain 400, nothing saved. */
function refuseHoneypot(body: unknown): void {
  const honeypot = (body as { honeypot?: unknown } | null)?.honeypot;
  if (typeof honeypot === 'string' && honeypot.trim() !== '')
    throw HfosError.validation([], 'Please check the message and try again.');
}

/** The page, without its query or fragment (they can carry what people typed into forms). */
function pathOnly(raw: string | undefined): string | undefined {
  const path = (raw ?? '').split(/[?#]/, 1)[0]!.trim().slice(0, 2000);
  return path.startsWith('/') ? path : undefined;
}

// ---- Request bodies ----

const Where = {
  /** The host page's origin, like https://www.acme.com. */
  origin: z.string().trim().min(1, 'Send the page’s origin.').max(300),
  /** Its path, like /services/ac-repair. */
  pagePath: z.string().max(4000).optional(),
};
const StartBody = z.object(Where);
const HeartbeatBody = z.object(Where);
const MessageBody = z.object({
  body: z
    .string()
    .trim()
    .min(1, 'Write a message.')
    .max(CHAT_MESSAGE_MAX, 'Keep chat messages under 1,000 characters.'),
  /** Made by the chat window per message, so a resend lands once. */
  clientId: z.string().trim().min(8).max(64),
  pagePath: z.string().max(4000).optional(),
  turnstileToken: z.string().max(2048).optional(),
  honeypot: z.string().max(500).optional(),
});
const IdentifyBody = z
  .object({
    name: z.string().max(200).optional(),
    phone: z.string().max(40).optional(),
    email: z.string().max(320).optional(),
    smsConsent: z.boolean().default(false),
    turnstileToken: z.string().max(2048).optional(),
    honeypot: z.string().max(500).optional(),
  })
  .refine((v) => !!(v.name?.trim() || v.phone?.trim() || v.email?.trim()), {
    path: ['name'],
    error: 'Tell us your name, number or email.',
  });
const ReadBody = z.object({ through: z.uuid() });

const filled = (v: string | undefined): string | undefined => v?.trim() || undefined;

// ---- Routes ----

type Params = { Params: { key: string } };

export async function registerChatRoutes(app: FastifyInstance, deps: HttpDeps): Promise<ChatHub> {
  const opts = deps.chat ?? {};
  const ipKey = opts.ipKey ?? randomBytes(32).toString('base64');
  const botCheck = opts.botCheck ?? passThroughBotCheck;
  const limits = chatLimitsFor(opts);
  const limiter = new KeyedLimiter();
  const streamMs = opts.streamMs ?? CHAT_STREAM_MS;
  const hub = new ChatHub({ db: deps.httpDb, log: deps.log, intervalMs: opts.feedIntervalMs });
  // Open streams are told and closed before the server stops listening (it waits for open connections).
  app.addHook('preClose', async () => {
    await hub.stop();
  });

  const reminderAfterMs =
    deps.reminderOverrideMs && deps.reminderOverrideMs > 0
      ? Math.min(86_400_000, Math.max(1_000, Math.round(deps.reminderOverrideMs)))
      : undefined;
  const meta = (): RequestMeta => ({
    correlationId: randomUUID(),
    causationId: null,
    channel: 'chat_widget',
  });
  const worker = <T>(scope: TenantScope, fn: (tx: Tx) => Promise<T>) =>
    asWorker(deps.httpDb, scope, fn);
  const run = <I extends z.ZodType, O extends z.ZodType>(
    scope: TenantScope,
    cmd: CommandDef<I, O>,
    input: unknown,
  ) => executeCommand(deps.httpDb, cmd, input, systemActor(scope), meta()).then((r) => r.output);
  const scopeOf = (r: WidgetRoute): TenantScope => ({
    workspaceId: r.workspaceId,
    organizationId: r.organizationId,
  });
  const ipOf = (req: FastifyRequest) => ipHmacOf(ipKey, req.ip);

  async function findWidget(key: string): Promise<WidgetRoute> {
    const route = await widgetRoute(deps.httpDb, key);
    if (!route) throw widgetNotFound();
    return route;
  }

  function limit(reply: FastifyReply, hits: readonly Hit[]): void {
    const r = limiter.take(hits);
    if (r.ok) return;
    void reply.header('retry-after', String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))));
    throw rateLimited();
  }

  /** The human check is owed: never passed, a new token since, or this is a 50th message. */
  const checkOwed = (v: Pick<VisitorAuth, 'turnstilePassedAt' | 'tokenIssuedAt'>, n: number) =>
    botCheck.enabled &&
    (!v.turnstilePassedAt ||
      v.tokenIssuedAt.getTime() > v.turnstilePassedAt.getTime() ||
      (n > 0 && n % HUMAN_CHECK_EVERY === 0));
  const humanCheckOut = (required: boolean) =>
    botCheck.enabled ? { siteKey: botCheck.siteKey, required } : null;

  /** Runs the check when it's owed: `pass`, `unavailable` (Cloudflare didn't answer) or `skipped`. */
  async function humanCheck(
    req: FastifyRequest,
    owed: boolean,
    token: string | undefined,
  ): Promise<'pass' | 'unavailable' | 'skipped'> {
    if (!owed) return 'skipped';
    if (!token) throw checkRequired();
    const verdict = await botCheck.verify(token, req.ip);
    if (verdict === 'fail') throw checkFailed();
    return verdict;
  }

  interface Visit {
    readonly route: WidgetRoute;
    readonly scope: TenantScope;
    readonly widget: WidgetRow;
    readonly visitor: VisitorAuth;
    readonly ip: string;
  }

  /** The visitor a bearer token names on this widget, after the refusals and their limits. */
  async function visit(
    req: FastifyRequest,
    reply: FastifyReply,
    key: string,
    kind: 'send' | 'identify' | 'read',
  ): Promise<Visit> {
    const route = await findWidget(key);
    const token = bearerToken(header(req, 'authorization'));
    if (!token || !TOKEN_RE.test(token)) throw chatNotFound();
    const scope = scopeOf(route);
    const ip = ipOf(req);
    const { widget, visitor } = await worker(scope, async (tx) => ({
      widget: await loadWidget(tx, route.widgetId),
      visitor: await visitorByToken(tx, {
        workspaceId: route.workspaceId,
        widgetId: route.widgetId,
        tokenHash: tokenHashOf(token),
        ipHmac: ip,
      }),
    }));
    if (!widget || !visitor) throw chatNotFound();
    if (visitor.blocked) throw blocked(visitor.blocked);
    if (widget.pausedAt) throw widgetPaused();
    const own = `v:${visitor.id}`;
    limit(
      reply,
      kind === 'send'
        ? [
            { key: `${own}:send`, rule: limits.visitorSend },
            { key: `w:${widget.id}:send`, rule: limits.widgetSend },
            { key: `b:${route.workspaceId}:send`, rule: limits.businessSend },
          ]
        : kind === 'identify'
          ? [{ key: `${own}:identify`, rule: limits.visitorIdentify }]
          : [{ key: `${own}:read`, rule: limits.visitorRead }],
    );
    return { route, scope, widget, visitor, ip };
  }

  await app.register(async (pub) => {
    await pub.register(rateLimit, {
      global: false,
      errorResponseBuilder: () => rateLimited(),
    });
    // Tokens and chats never sit in a cache.
    pub.addHook('onRequest', async (_req, reply) => {
      void reply.header('cache-control', 'no-store');
    });

    // ---------- the widget's settings: what the chat window shows before anyone writes ----------
    // Counted per address and widget, under a looser ceiling per address: the web server asks for every business's
    // from a few addresses (the loader when the CDN doesn't have it, and each chat window's frame rule), so one
    // business's lookups mustn't use up another's. Keys that name no widget count toward the ceiling too.
    pub.get<Params & { Querystring: { origin?: string } }>(
      '/public/chat/:key/config',
      async (req, reply) => {
        const ip = ipOf(req);
        limit(reply, [
          { key: `a:${ip}:config`, rule: limits.ipConfig },
          { key: `a:${ip}:config:${req.params.key}`, rule: limits.ipWidgetConfig },
        ]);
        const route = await findWidget(req.params.key);
        return worker(scopeOf(route), async (tx) => {
          const widget = await loadWidget(tx, route.widgetId);
          if (!widget) throw widgetNotFound();
          const origin = typeof req.query.origin === 'string' ? req.query.origin : '';
          if (origin && !originAllowed(widget, origin)) throw originRefused();
          const [ws] = await rows<{ name: string; timezone: string | null; settings: unknown }>(
            tx,
            sql`select name, timezone, settings from app.workspaces where id = ${route.workspaceId}`,
          );
          const timeZone = ws?.timezone || 'UTC';
          const openHours = openHoursOf(ws?.settings as Record<string, unknown> | null);
          const teammate = await answeringTeammate(tx, widget);
          const now = Date.now();
          const aiAnswering =
            !!teammate && teammateWorkingNow(teammate.config, openHours, timeZone, now);
          return {
            business: { name: ws?.name ?? '' },
            /** The AI teammate that answers here: its name, nothing else. */
            teammate: teammate ? { name: teammate.name } : null,
            greeting: widget.greeting,
            awayMessage: widget.awayMessage,
            /** Nobody is answering right now (the AI isn't working and the business is closed). */
            away: !aiAnswering && !withinHours(openHours, timeZone, now),
            look: {
              launcherLabel: widget.launcherLabel,
              accentColor: widget.accentColor,
              textColor: readableTextOn(widget.accentColor),
              position: widget.position === 'left' ? 'left' : 'right',
            },
            askFor: chatAskForOf(widget.askFor),
            smsConsent: widget.smsConsent ? { text: CHAT_SMS_CONSENT_TEXT } : null,
            humanCheck: botCheck.enabled ? { siteKey: botCheck.siteKey } : null,
            paused: widget.pausedAt !== null,
            maxMessageLength: CHAT_MESSAGE_MAX,
          };
        });
      },
    );

    // ---------- start a visit, or pick one up again ----------
    pub.post<Params>(
      '/public/chat/:key/start',
      { config: { rateLimit: limits.ipStart } },
      async (req, reply) => {
        const route = await findWidget(req.params.key);
        const body = parseBody(StartBody, req.body ?? {});
        const scope = scopeOf(route);
        const ws = route.workspaceId;
        const ip = ipOf(req);
        const pagePath = pathOnly(body.pagePath);
        const presented = bearerToken(header(req, 'authorization'));
        const shown = presented && TOKEN_RE.test(presented) ? presented : null;
        const known = await worker(scope, async (tx) => ({
          widget: await loadWidget(tx, route.widgetId),
          visitor: shown
            ? await visitorByToken(tx, {
                workspaceId: ws,
                widgetId: route.widgetId,
                tokenHash: tokenHashOf(shown),
                ipHmac: ip,
              })
            : null,
        }));
        if (!known.widget) throw widgetNotFound();
        if (!originAllowed(known.widget, body.origin)) throw originRefused();
        if (known.widget.pausedAt) throw widgetPaused();
        if (known.visitor?.blocked) throw blocked(known.visitor.blocked);
        limit(reply, [
          { key: `w:${route.widgetId}:start`, rule: limits.widgetStart },
          { key: `b:${ws}:start`, rule: limits.businessStart },
        ]);
        let token: string | null = null;
        if (known.visitor && shown) {
          const resumed = await run(scope, chatVisitorResume, {
            workspaceId: ws,
            widgetId: route.widgetId,
            tokenHash: tokenHashOf(shown),
            ipHmac: ip,
            ...(pagePath ? { pagePath } : {}),
          });
          // A week old, or the previous token (the window lost the new one): a fresh token.
          if (resumed.rotateDue || resumed.viaPreviousToken) {
            token = newVisitorToken();
            await run(scope, chatVisitorRotateToken, {
              workspaceId: ws,
              visitorId: resumed.visitorId,
              tokenHash: tokenHashOf(token),
            });
          }
        } else {
          const network = await worker(scope, async (tx) => ({
            blocked: await networkBlocked(tx, ws, ip),
            recent: await newVisitorsFrom(tx, ws, ip, limits.networkNewVisitors.timeWindow),
          }));
          if (network.blocked) throw blocked('network');
          if (network.recent >= limits.networkNewVisitors.max) throw networkFlood();
          token = newVisitorToken();
          const started = await run(scope, chatVisitorStart, {
            workspaceId: ws,
            widgetId: route.widgetId,
            tokenHash: tokenHashOf(token),
            ipHmac: ip,
            ...(pagePath ? { pagePath } : {}),
          });
          if (started.blocked) throw blocked('network');
        }
        await run(scope, chatWidgetRecordSeen, {
          workspaceId: ws,
          widgetId: route.widgetId,
          origin: originOf(body.origin),
        });
        return worker(scope, async (tx) => {
          const v = await visitorByToken(tx, {
            workspaceId: ws,
            widgetId: route.widgetId,
            tokenHash: tokenHashOf(token ?? shown!),
            ipHmac: ip,
          });
          if (!v) throw chatNotFound();
          const sent = v.conversationId ? await inboundCount(tx, v.conversationId) : 0;
          const list = v.conversationId ? await listMessages(tx, v.conversationId) : [];
          return {
            /** The visitor's token: only when it's new; otherwise keep the one sent. */
            token,
            resumed: !!known.visitor,
            /** They've written: open the stream. */
            chatStarted: v.conversationId !== null,
            gave: v.gave,
            humanCheck: humanCheckOut(checkOwed(v, sent + 1)),
            messages: list.map((l) => l.message),
            cursor: list.at(-1)?.cursor ?? null,
            typing: v.conversationId ? await typingNow(tx, v.conversationId) : false,
          };
        });
      },
    );

    // ---------- a message from the visitor ----------
    pub.post<Params>(
      '/public/chat/:key/messages',
      { config: { rateLimit: limits.ipSend } },
      async (req, reply) => {
        const v = await visit(req, reply, req.params.key, 'send');
        refuseHoneypot(req.body);
        const body = parseBody(MessageBody, req.body);
        const ws = v.route.workspaceId;
        const conversationId = v.visitor.conversationId;
        const before = conversationId
          ? await worker(v.scope, (tx) =>
              visitorHistory(tx, conversationId, {
                clientId: body.clientId,
                body: body.body,
                repeatWindowMs: limits.repeats.timeWindow,
              }),
            )
          : { sent: 0, resend: false, same: 0 };
        const n = before.sent + 1;
        let verdict: 'pass' | 'unavailable' | 'skipped' = 'skipped';
        // A resend of a message that arrived lands once (core finds its clientId): no checks again.
        if (!before.resend) {
          if (before.same >= limits.repeats.max) throw repeated();
          verdict = await humanCheck(req, checkOwed(v.visitor, n), body.turnstileToken);
        }
        const pagePath = pathOnly(body.pagePath);
        const received = await run(v.scope, chatReceive, {
          workspaceId: ws,
          visitorId: v.visitor.id,
          body: body.body,
          clientId: body.clientId,
          ...(pagePath ? { pagePath } : {}),
          ...(reminderAfterMs ? { reminderAfterMs } : {}),
          aiReply: verdict !== 'unavailable',
        });
        if (verdict === 'pass')
          await run(v.scope, chatVisitorRecordSeen, {
            workspaceId: ws,
            visitorId: v.visitor.id,
            turnstilePassed: true,
            ipHmac: v.ip,
          });
        // The database stamps the pass, and the token's own time came from the same clock, so the pass is read
        // back rather than stamped here: this process's clock runs a little behind, and a pass it stamped could
        // look older than the token it belongs to, asking the visitor to prove themselves all over again.
        const stamped =
          verdict === 'pass'
            ? (
                await worker(v.scope, (tx) =>
                  rows<{ at: Date | string | null }>(
                    tx,
                    sql`select turnstile_passed_at as at from app.chat_visitors where id = ${v.visitor.id}`,
                  ),
                )
              )[0]?.at
            : null;
        const passedAt = stamped ? new Date(stamped) : v.visitor.turnstilePassedAt;
        const view = await worker(v.scope, (tx) => messageView(tx, received.messageId));
        return {
          message: view?.message ?? null,
          cursor: view?.cursor ?? null,
          duplicate: received.duplicate,
          newChat: received.newChat,
          /** Whether the next message needs the human check first. */
          humanCheck: humanCheckOut(
            checkOwed(
              { tokenIssuedAt: v.visitor.tokenIssuedAt, turnstilePassedAt: passedAt },
              received.duplicate ? n : n + 1,
            ),
          ),
        };
      },
    );

    // ---------- who the visitor says they are ----------
    pub.post<Params>(
      '/public/chat/:key/identify',
      { config: { rateLimit: limits.ipSend } },
      async (req, reply) => {
        const v = await visit(req, reply, req.params.key, 'identify');
        refuseHoneypot(req.body);
        const body = parseBody(IdentifyBody, req.body);
        // Details can add a customer, so the check runs here too when it's owed (not the every-50th one).
        const verdict = await humanCheck(req, checkOwed(v.visitor, 0), body.turnstileToken);
        const name = filled(body.name);
        const phone = filled(body.phone);
        const email = filled(body.email);
        await run(v.scope, chatIdentify, {
          workspaceId: v.route.workspaceId,
          visitorId: v.visitor.id,
          ...(name ? { name } : {}),
          ...(phone ? { phone } : {}),
          ...(email ? { email } : {}),
          smsConsent: body.smsConsent,
        });
        if (verdict === 'pass')
          await run(v.scope, chatVisitorRecordSeen, {
            workspaceId: v.route.workspaceId,
            visitorId: v.visitor.id,
            turnstilePassed: true,
            ipHmac: v.ip,
          });
        // Flags only: whether a customer matched (or was added) never comes back.
        return {
          gave: {
            name: v.visitor.gave.name || !!name,
            phone: v.visitor.gave.phone || !!phone,
            email: v.visitor.gave.email || !!email,
          },
        };
      },
    );

    // ---------- live: replies, "typing" and "joined" as they happen ----------
    pub.get<Params & { Querystring: { after?: string } }>(
      '/public/chat/:key/stream',
      { config: { rateLimit: limits.ipRead } },
      async (req, reply) => {
        const v = await visit(req, reply, req.params.key, 'read');
        const conversationId = v.visitor.conversationId;
        if (!conversationId) throw chatNotStarted();
        const after = parseCursor(
          header(req, 'last-event-id') ??
            (typeof req.query.after === 'string' ? req.query.after : null),
        );
        const teammate = await worker(v.scope, (tx) => answeringTeammate(tx, v.widget));
        const stream = openStream<ChatStreamEvent>(reply);
        const sent = new Set<string>();
        const early: HubEvent[] = [];
        let ready = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const deliver = (e: HubEvent) => {
          if (e.type === 'typing') {
            stream.send({ type: 'typing', name: teammate?.name ?? null });
            return;
          }
          if (sent.has(e.message.id)) return;
          sent.add(e.message.id);
          if (e.message.joined) stream.send({ type: 'joined', name: e.message.name });
          stream.send({ type: 'message', message: e.message }, { id: e.cursor });
        };
        const client: HubClient = {
          conversationId,
          scope: v.scope,
          push: (e) => {
            if (ready) deliver(e);
            else early.push(e);
          },
          close: (reason) => {
            stream.send({ type: 'bye', reason });
            stream.end();
          },
        };
        // Registered before catching up, so nothing lands between the two; repeats are dropped by id.
        const leave = hub.add(client);
        stream.onClose(() => {
          if (timer) clearTimeout(timer);
          leave();
        });
        stream.send({ type: 'ready' });
        try {
          if (after)
            for (const m of await worker(v.scope, (tx) =>
              listMessages(tx, conversationId, { after, limit: 500 }),
            ))
              deliver({ type: 'message', ...m });
        } catch (e) {
          deps.log.warn(
            { err: e instanceof Error ? e.message : String(e) },
            'catching a chat stream up failed',
          );
          stream.send({ type: 'bye', reason: 'expired' });
          stream.end();
          return;
        }
        ready = true;
        for (const e of early.splice(0)) deliver(e);
        if (!stream.closed)
          timer = setTimeout(() => {
            stream.send({ type: 'bye', reason: 'expired' });
            stream.end();
          }, streamMs);
      },
    );

    // ---------- polling, when a stream can't stay open ----------
    pub.get<Params & { Querystring: { after?: string } }>(
      '/public/chat/:key/messages',
      { config: { rateLimit: limits.ipRead } },
      async (req, reply) => {
        const v = await visit(req, reply, req.params.key, 'read');
        const raw = typeof req.query.after === 'string' ? req.query.after : '';
        const after = parseCursor(raw);
        if (raw && !after)
          throw HfosError.validation([
            { path: 'after', message: 'Use the cursor from the last response.' },
          ]);
        const conversationId = v.visitor.conversationId;
        if (!conversationId) return { messages: [], cursor: raw || null, typing: false };
        return worker(v.scope, async (tx) => {
          const list = await listMessages(tx, conversationId, { after, limit: 500 });
          return {
            messages: list.map((l) => l.message),
            cursor: list.at(-1)?.cursor ?? (raw || null),
            typing: await typingNow(tx, conversationId),
          };
        });
      },
    );

    // ---------- the chat window showed the replies up to this one ----------
    pub.post<Params>(
      '/public/chat/:key/read',
      { config: { rateLimit: limits.ipRead } },
      async (req, reply) => {
        const v = await visit(req, reply, req.params.key, 'read');
        const body = parseBody(ReadBody, req.body);
        await run(v.scope, chatMarkRead, {
          workspaceId: v.route.workspaceId,
          visitorId: v.visitor.id,
          throughMessageId: body.through,
        });
        return { ok: true };
      },
    );

    // ---------- still here: the page they're on ("On the site now") and the install check ----------
    pub.post<Params>(
      '/public/chat/:key/heartbeat',
      { config: { rateLimit: limits.ipRead } },
      async (req, reply) => {
        const v = await visit(req, reply, req.params.key, 'read');
        const body = parseBody(HeartbeatBody, req.body ?? {});
        if (!originAllowed(v.widget, body.origin)) throw originRefused();
        const pagePath = pathOnly(body.pagePath);
        await run(v.scope, chatVisitorRecordSeen, {
          workspaceId: v.route.workspaceId,
          visitorId: v.visitor.id,
          ipHmac: v.ip,
          ...(pagePath ? { pagePath } : {}),
        });
        await run(v.scope, chatWidgetRecordSeen, {
          workspaceId: v.route.workspaceId,
          widgetId: v.widget.id,
          origin: originOf(body.origin),
        });
        return { ok: true };
      },
    );
  });
  return hub;
}
