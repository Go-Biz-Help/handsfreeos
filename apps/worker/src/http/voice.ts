import { and, eq, isNotNull } from 'drizzle-orm';
import {
  callUpdateStatus,
  executeCommand,
  HfosError,
  loadTeammate,
  openHoursOf,
  userPhoneVerify,
  type PhoneAnswerMode,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { calls, phoneNumbers, telephonyAccounts, userPhones } from '@hfos/db/schema';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { runtimeConfigOf } from '../ai-team/config';
import { withinHours } from '../ai-team/gates';
import { systemActor, workerMeta, type TenantScope } from '../services';
import { liveCallingKey, openAccount } from '../telephony/accounts';
import type { ProviderAccount } from '../telephony/provider';
import {
  openTestTicket,
  sealTestTicket,
  sealTicket,
  type StreamTicket,
} from '../voice-agent/ticket';
import {
  agentTwiml,
  BRIDGE_NOT_PLACED_TWIML,
  bridgeDialTwiml,
  bridgeGateTwiml,
  bridgeResultTwiml,
  CANNOT_PLACE_TWIML,
  defaultGreeting,
  HANGUP_TWIML,
  identityOf,
  isPhone,
  NOT_IN_SERVICE_TWIML,
  NOT_VERIFIED_TWIML,
  outboundTwiml,
  ringTwiml,
  routingOf,
  say,
  screenTwiml,
  spokenPhone,
  testCallTwiml,
  twiml,
  UNAVAILABLE_TWIML,
  UNAVAILABLE_VERBS,
  userIdOfIdentity,
  VERIFIED_TWIML,
  verifyTwiml,
  voiceAccessToken,
  voicemailTwiml,
  voicemailVerbs,
  voiceUrls,
  type Routing,
  type VoiceUrls,
} from '../telephony/voice';
import { mayRingOut, TEST_CALL_PARAM, TEST_CALL_TO, walletRoom } from '@hfos/core/server';
import {
  authenticate,
  hasPermission,
  parseBody,
  recordDelivery,
  requirePermission,
  verifiedTwilio,
  type HttpDeps,
  type VerifiedTwilio,
} from './common';

/** private.phone_route: the active number, its routing, and the browser identities that ring for it. */
interface Route extends Record<string, unknown> {
  phone_number_id: string;
  workspace_id: string;
  organization_id: string;
  e164: string;
  routing: unknown;
  workspace_name: string;
  client_identities: string[] | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VoiceTokenInput = z.object({ workspaceId: z.uuid() });
const TOKEN_TTL_SECONDS = 3600;

async function routeFor(deps: HttpDeps, to: string | undefined): Promise<Route | null> {
  if (!isPhone(to)) return null;
  const [r] = await asWorker(deps.httpDb, {}, (tx) =>
    rows<Route>(tx, sql`select * from private.phone_route(${to})`),
  );
  return r ?? null;
}

const scopeOf = (r: Route): TenantScope => ({
  workspaceId: r.workspace_id,
  organizationId: r.organization_id,
});

/**
 * Who is calling, for the ringing card and the forwarded-phone screen: the customer with this number (their main
 * one or another on file) and their open lead.
 */
async function callerCard(deps: HttpDeps, scope: TenantScope, phone: string) {
  const [row] = await asWorker(deps.httpDb, scope, (tx) =>
    rows<{ id: string; name: string; lead_title: string | null }>(
      tx,
      sql`select p.id, trim(p.first_name || ' ' || p.last_name) as name,
            (select l.title from app.leads l
              where l.person_id = p.id and l.status = 'open' and l.archived_at is null
              order by l.updated_at desc limit 1) as lead_title
          from app.people p
          where p.workspace_id = ${scope.workspaceId} and p.archived_at is null
            and (p.phone_e164 = ${phone} or p.other_phones @> ${JSON.stringify([{ phone }])}::jsonb)
          order by (p.phone_e164 is not distinct from ${phone}) desc, p.updated_at desc limit 1`,
    ),
  );
  return row ? { personId: row.id, name: row.name || null, leadTitle: row.lead_title } : null;
}

/** "Dale’s cell", "Dale’s cell and Office line", "A, B and C". */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** How long a call HandsFreeOS placed (to someone's cell) stays answerable: long enough to ring and be picked up. */
const PLACED_CALL_MS = 10 * 60_000;
const ENDED = new Set(['completed', 'no_answer', 'busy', 'failed', 'canceled']);
const query = (req: FastifyRequest) => req.query as Record<string, string | undefined>;

/** A call through someone's own cell that Twilio asks about: still waiting, placed by us to that person's verified cell. */
async function bridgeCall(deps: HttpDeps, v: VerifiedTwilio, callId: string | undefined) {
  const { workspaceId, organizationId } = v.account;
  if (!workspaceId || !organizationId || !callId || !UUID.test(callId)) return null;
  const scope = { workspaceId, organizationId };
  const found = await asWorker(deps.httpDb, scope, async (tx) => {
    const [c] = await tx
      .select()
      .from(calls)
      .where(and(eq(calls.id, callId), eq(calls.workspaceId, workspaceId)));
    if (!c?.placedBy) return null;
    const [cell] = await tx
      .select({ e164: userPhones.e164 })
      .from(userPhones)
      .where(and(eq(userPhones.userId, c.placedBy), isNotNull(userPhones.verifiedAt)));
    const [person] = c.personId
      ? await rows<{ name: string }>(
          tx,
          sql`select trim(first_name || ' ' || last_name) as name from app.people where id = ${c.personId}`,
        )
      : [];
    return { call: c, cell: cell?.e164 ?? null, name: person?.name || null };
  });
  if (!found) return null;
  const { call: c, cell, name } = found;
  const usable =
    c.answeredVia === 'bridge' &&
    c.direction === 'outbound' &&
    !ENDED.has(c.status) &&
    (!c.providerSid || c.providerSid === v.params['CallSid']) &&
    !!cell &&
    v.params['To'] === cell &&
    !!c.fromE164 &&
    !!c.toE164 &&
    Date.now() - c.startedAt.getTime() < PLACED_CALL_MS;
  if (!usable) {
    deps.log.warn(
      { callId, workspaceId },
      'refused a call to a cell that call.connect_me did not ask for',
    );
    return null;
  }
  return {
    scope,
    call: c,
    customer: name ?? spokenPhone(c.toE164!),
  };
}

/** The cell a verification call is for: set, not verified yet, and the phone Twilio called. */
async function verificationFor(deps: HttpDeps, v: VerifiedTwilio, userPhoneId: string | undefined) {
  const { workspaceId, organizationId } = v.account;
  if (!workspaceId || !organizationId || !userPhoneId || !UUID.test(userPhoneId)) return null;
  const scope = { workspaceId, organizationId };
  const [row] = await asWorker(deps.httpDb, scope, (tx) =>
    tx.select().from(userPhones).where(eq(userPhones.id, userPhoneId)),
  );
  const usable =
    !!row &&
    !row.verifiedAt &&
    v.params['To'] === row.e164 &&
    (!row.lastVerificationAt || Date.now() - row.lastVerificationAt.getTime() < PLACED_CALL_MS);
  return usable ? { scope, row } : null;
}

const noAnswerTwiml = (routing: Routing, route: Route, urls: ReturnType<typeof voiceUrls>) =>
  routing.voicemailEnabled
    ? voicemailTwiml(routing.voicemailGreeting ?? defaultGreeting(route.workspace_name), urls)
    : UNAVAILABLE_TWIML;

/**
 * Whether the AI teammate answers this business's calls live (M18 step 5), and when: its phone setting is on,
 * it isn't off, calls can be heard and spoken (VOICE_AGENT), a model is set up, and the balance has room for AI.
 * `closed`: the business is closed right now, for "after hours".
 */
async function aiAnswering(
  deps: HttpDeps,
  scope: TenantScope,
): Promise<{ readonly mode: PhoneAnswerMode; readonly closed: boolean } | null> {
  if (!deps.speech || !(deps.voiceAi ?? deps.ai.provider)) return null;
  return asWorker(deps.httpDb, scope, async (tx) => {
    const teammate = await loadTeammate(tx, scope.workspaceId);
    if (!teammate || teammate.status === 'off') return null;
    const config = runtimeConfigOf(teammate.config);
    if (!config.phone.enabled) return null;
    const room = await walletRoom(tx, scope.workspaceId, 'ai', (m, e) =>
      deps.log.error({ err: e }, m),
    );
    if (!room.allowed) return null;
    const [w] = await rows<{ timezone: string | null; settings: unknown }>(
      tx,
      sql`select timezone, settings from app.workspaces where id = ${scope.workspaceId}`,
    );
    const hours = openHoursOf(w?.settings as Record<string, unknown> | null);
    return {
      mode: config.phone.answer,
      closed: !withinHours(hours, w?.timezone || 'UTC', Date.now()),
    };
  });
}

/** Sends the call to the AI teammate; if its stream ends without new instructions, the voicemail follows. */
function toTeammate(
  deps: HttpDeps,
  route: Route,
  call: { readonly callSid: string; readonly from: string },
  urls: VoiceUrls,
): string {
  const routing = routingOf(route.routing);
  const ticket = sealTicket(deps.sealer, {
    workspaceId: route.workspace_id,
    organizationId: route.organization_id,
    callSid: call.callSid,
    line: route.e164,
    from: call.from,
  });
  const after = routing.voicemailEnabled
    ? voicemailVerbs(routing.voicemailGreeting ?? defaultGreeting(route.workspace_name), urls)
    : UNAVAILABLE_VERBS;
  return agentTwiml(ticket, after, urls);
}

/**
 * Rings the team for a call: every teammate's browser and each enabled forwarding phone, or the voicemail when
 * nobody can be rung (or the balance can't pay for ringing out). `dialResult` is where Twilio says how the
 * ringing went: the usual one, or the one after the AI teammate handed the call on.
 */
async function teamTwiml(
  deps: HttpDeps,
  route: Route,
  call: { readonly callSid: string; readonly from: string | undefined },
  urls: VoiceUrls,
  opts: { readonly dialResult?: string; readonly ringOut?: boolean } = {},
): Promise<{ readonly twiml: string; readonly rings: boolean }> {
  const scope = scopeOf(route);
  const routing = routingOf(route.routing);
  const from = call.from;
  // Calling the business line from a forwarding phone (the owner's cell) should not ring that phone.
  const forwarding = routing.forwarding.filter((f) => f.e164 !== from);
  const identities = (route.client_identities ?? []).slice(0, 10);
  /**
   * **Inbound is never hard-blocked** (M16, step 9). A customer hearing "not in service" is the business's
   * reputation, and Twilio bills us for the inbound leg whether we answer or not — refusing saves almost
   * nothing. What stops past the overdraft is the *extra*: the outbound legs that ring somebody's own cell,
   * which cost real money on top. The call still goes to voicemail, so the customer is still heard, and the
   * voicemail still gets transcribed and still lands in the inbox.
   */
  const ringOut =
    opts.ringOut ??
    mayRingOut(
      await asWorker(deps.db, scope, (tx) =>
        walletRoom(tx, route.workspace_id, 'call', (m, e) => deps.log.error({ err: e }, m)),
      ),
    );
  if (identities.length + forwarding.length === 0 || !ringOut)
    return { twiml: noAnswerTwiml(routing, route, urls), rings: false };
  const caller = isPhone(from) ? await callerCard(deps, scope, from) : null;
  return {
    rings: true,
    twiml: ringTwiml(
      {
        identities,
        forwarding,
        ringSeconds: routing.ringSeconds,
        line: route.e164,
        // The business number on forwarded phones, when the number is set to show it.
        callerId: routing.forwardedCallerId === 'business' ? route.e164 : null,
        params: {
          workspaceId: route.workspace_id,
          callSid: call.callSid,
          from: isPhone(from) ? from : '',
          callerName: caller?.name ?? '',
          personId: caller?.personId ?? '',
          leadTitle: caller?.leadTitle ?? '',
          lineName: route.workspace_name,
          alsoRinging: joinNames(forwarding.map((f) => f.label)),
          teammates: String(identities.length),
        },
      },
      opts.dialResult ? { ...urls, dialResult: opts.dialResult } : urls,
    ),
  };
}

/**
 * The AI teammate hands a caller to a person (M18 step 5): the team rings on the same call, and nobody
 * answering goes to voicemail, never back to the teammate.
 */
export async function transferTwimlFor(deps: HttpDeps, ticket: StreamTicket): Promise<string> {
  const urls = voiceUrls(deps.publicUrl);
  const route = await routeFor(deps, ticket.line);
  if (!route || route.workspace_id !== ticket.workspaceId) return UNAVAILABLE_TWIML;
  const { twiml: body } = await teamTwiml(
    deps,
    route,
    { callSid: ticket.callSid, from: ticket.from },
    urls,
    { dialResult: urls.dialResultAfterAi },
  );
  return body;
}

/**
 * Calls. The TwiML routes answer at once from one lookup (Twilio waits on them); every status report is
 * stored and processed by the webhook loop like the texting webhooks.
 */
export function registerVoiceRoutes(app: FastifyInstance, deps: HttpDeps): void {
  const urls = voiceUrls(deps.publicUrl);
  const xml = (reply: FastifyReply, body: string) => reply.type('text/xml').send(body);
  const store = (v: VerifiedTwilio, kind: string, dedupeKey: string, scope?: TenantScope) =>
    recordDelivery(deps, {
      provider: 'twilio',
      kind,
      dedupeKey,
      accountRef: v.params['AccountSid'] ?? null,
      url: v.url,
      params: v.params,
      workspaceId: scope?.workspaceId ?? v.account.workspaceId,
      organizationId: scope?.organizationId ?? v.account.organizationId,
    });

  // A customer calls the business number: every teammate's browser and each enabled forwarding phone ring.
  app.post('/webhooks/twilio/voice/inbound', async (req, reply) => {
    const v = await verifiedTwilio(deps, req, reply);
    if (!v) return reply;
    const p = v.params;
    const route = await routeFor(deps, p['To']);
    if (!route) return xml(reply, NOT_IN_SERVICE_TWIML);
    const scope = scopeOf(route);
    if (p['CallSid']) await store(v, 'voice.inbound', `${p['CallSid']}:inbound`, scope);
    const from = p['From'];
    const callSid = p['CallSid'] ?? '';
    const ai = callSid && isPhone(from) ? await aiAnswering(deps, scope) : null;
    // M18 step 5: the AI teammate picks up every call, or every call while the business is closed.
    if (ai && (ai.mode === 'always' || (ai.mode === 'after_hours' && ai.closed)))
      return xml(reply, toTeammate(deps, route, { callSid, from: from! }, urls));
    const team = await teamTwiml(deps, route, { callSid, from }, urls);
    // Nobody to ring: the teammate answers now rather than after ringing nobody.
    if (!team.rings && ai?.mode === 'no_answer')
      return xml(reply, toTeammate(deps, route, { callSid, from: from! }, urls));
    return xml(reply, team.twiml);
  });

  // A forwarded phone picked up: say who is calling; pressing 1 takes the call.
  app.post('/webhooks/twilio/voice/screen', async (req, reply) => {
    const v = await verifiedTwilio(deps, req, reply);
    if (!v) return reply;
    const route = await routeFor(deps, query(req)['line']);
    if (!route) return xml(reply, HANGUP_TWIML);
    // Showing the business number, this leg's own From is the business: the customer comes in the address.
    const from = isPhone(query(req)['from']) ? query(req)['from'] : v.params['From'];
    const caller = isPhone(from) ? await callerCard(deps, scopeOf(route), from) : null;
    const who = caller?.name ?? (isPhone(from) ? spokenPhone(from) : 'a hidden number');
    return xml(
      reply,
      screenTwiml(`Call for ${route.workspace_name} from ${who}.`, route.e164, urls),
    );
  });

  app.post('/webhooks/twilio/voice/screen-result', async (req, reply) => {
    const v = await verifiedTwilio(deps, req, reply);
    if (!v) return reply;
    if (v.params['Digits'] !== '1' || !v.params['CallSid']) return xml(reply, HANGUP_TWIML);
    await store(v, 'voice.screened', `${v.params['CallSid']}:screened`);
    return xml(reply, twiml(say('Connecting.')));
  });

  // The ringing ended. Answered: done. Otherwise the greeting and a voicemail, or an apology when voicemail is off.
  app.post('/webhooks/twilio/voice/dial-result', async (req, reply) => {
    const v = await verifiedTwilio(deps, req, reply);
    if (!v) return reply;
    if (v.params['DialCallStatus'] === 'completed') return xml(reply, HANGUP_TWIML);
    const route = await routeFor(deps, v.params['To']);
    if (!route) return xml(reply, HANGUP_TWIML);
    // M18 step 5: nobody picked up, so the AI teammate does, unless it's the one that rang them.
    const callSid = v.params['CallSid'];
    const from = v.params['From'];
    if (query(req)['after'] !== 'ai' && callSid && isPhone(from)) {
      const ai = await aiAnswering(deps, scopeOf(route));
      if (ai?.mode === 'no_answer')
        return xml(reply, toTeammate(deps, route, { callSid, from }, urls));
    }
    return xml(reply, noAnswerTwiml(routingOf(route.routing), route, urls));
  });

  app.post('/webhooks/twilio/voice/hangup', async (req, reply) => {
    const v = await verifiedTwilio(deps, req, reply);
    if (!v) return reply;
    return xml(reply, HANGUP_TWIML);
  });

  // A teammate's browser places a call: only the one call.start recorded for them, to that customer.
  app.post('/webhooks/twilio/voice/outbound', async (req, reply) => {
    const v = await verifiedTwilio(deps, req, reply);
    if (!v) return reply;
    const p = v.params;
    const userId = userIdOfIdentity(p['From']);
    // A live test call from the test console (ai-team/test-call.ts): straight to the AI teammate, on the machine
    // holding the console's end of it. Only the person the console gave the ticket to, in its business; nothing
    // is recorded, and nobody rings.
    const test = p[TEST_CALL_PARAM];
    if (test !== undefined) {
      const t = openTestTicket(deps.sealer, test);
      const callSid = p['CallSid'];
      if (
        !t ||
        t.callSid ||
        !callSid ||
        t.workspaceId !== v.account.workspaceId ||
        t.userId !== userId
      ) {
        deps.log.warn({ userId }, 'refused a test call without a good ticket');
        return xml(reply, CANNOT_PLACE_TWIML);
      }
      return xml(
        reply,
        testCallTwiml(sealTestTicket(deps.sealer, { ...t, callSid }), t.machine, urls),
      );
    }
    const callId = p['CallId'] ?? '';
    const { workspaceId, organizationId } = v.account;
    if (!workspaceId || !organizationId || !userId || !UUID.test(callId) || !p['CallSid'])
      return xml(reply, CANNOT_PLACE_TWIML);
    const scope = { workspaceId, organizationId };
    const [c] = await asWorker(deps.httpDb, scope, (tx) =>
      tx
        .select()
        .from(calls)
        .where(and(eq(calls.id, callId), eq(calls.workspaceId, workspaceId))),
    );
    const usable =
      !!c &&
      c.direction === 'outbound' &&
      c.status === 'initiated' &&
      !c.providerSid &&
      c.placedBy === userId &&
      !!c.fromE164 &&
      c.toE164 === p['To'] &&
      Date.now() - c.startedAt.getTime() < 10 * 60_000;
    if (!usable || !(await hasPermission(deps, userId, workspaceId, 'inbox.use'))) {
      deps.log.warn({ callId, userId }, 'refused a browser call that call.start did not record');
      return xml(reply, CANNOT_PLACE_TWIML);
    }
    await store(v, 'voice.outbound', `${p['CallSid']}:outbound`, scope);
    return xml(reply, outboundTwiml(c.fromE164!, c.toE164!, urls));
  });

  // Status reports: stored, answered at once, processed by the webhook loop.
  const report = (
    path: string,
    kind: string,
    key: (p: Record<string, string | undefined>) => string | null,
  ) =>
    app.post(path, async (req, reply) => {
      const v = await verifiedTwilio(deps, req, reply);
      if (!v) return reply;
      const dedupeKey = key(v.params);
      if (dedupeKey) await store(v, kind, dedupeKey);
      return reply.code(204).send();
    });
  // A test call from the test console isn't a call anybody made: Twilio's reports about it aren't kept.
  const byCall = (p: Record<string, string | undefined>) =>
    p['To'] !== TEST_CALL_TO && p['CallSid'] && p['CallStatus']
      ? `${p['CallSid']}:${p['CallStatus']}`
      : null;
  report('/webhooks/twilio/voice/status', 'voice.status', byCall);
  report('/webhooks/twilio/voice/leg-status', 'voice.leg_status', byCall);
  report('/webhooks/twilio/voice/recording', 'voice.recording', (p) =>
    p['RecordingSid'] && p['RecordingStatus']
      ? `${p['RecordingSid']}:${p['RecordingStatus']}`
      : null,
  );
  // A call through someone's own cell: their cell answered. "Press 1 to call Mike Johnson."
  app.post('/webhooks/twilio/voice/bridge', async (req, reply) => {
    const v = await verifiedTwilio(deps, req, reply);
    if (!v) return reply;
    const b = await bridgeCall(deps, v, query(req)['callId']);
    if (!b) return xml(reply, BRIDGE_NOT_PLACED_TWIML);
    return xml(reply, bridgeGateTwiml(b.customer, b.call.id, urls));
  });

  // They pressed a key. Only 1 dials the customer, and it is recorded first, so every report about the customer's
  // leg finds the person who placed the call.
  app.post('/webhooks/twilio/voice/bridge-gate', async (req, reply) => {
    const v = await verifiedTwilio(deps, req, reply);
    if (!v) return reply;
    if (v.params['Digits'] !== '1') return xml(reply, BRIDGE_NOT_PLACED_TWIML);
    const b = await bridgeCall(deps, v, query(req)['callId']);
    if (!b) return xml(reply, BRIDGE_NOT_PLACED_TWIML);
    const { output } = await executeCommand(
      deps.httpDb,
      callUpdateStatus,
      {
        workspaceId: b.scope.workspaceId,
        callId: b.call.id,
        status: 'ringing',
        answeredByUserId: b.call.placedBy,
      },
      systemActor(b.scope, b.call.placedBy),
      workerMeta(),
    );
    if (ENDED.has(output.status)) return xml(reply, BRIDGE_NOT_PLACED_TWIML);
    return xml(
      reply,
      bridgeDialTwiml(
        {
          callerId: b.call.fromE164!,
          to: b.call.toE164!,
          callId: b.call.id,
          customer: b.customer,
        },
        urls,
      ),
    );
  });

  // The customer's phone stopped ringing: say how it went. Their leg's own reports update the call.
  app.post('/webhooks/twilio/voice/bridge-result', async (req, reply) => {
    const v = await verifiedTwilio(deps, req, reply);
    if (!v) return reply;
    const { workspaceId, organizationId } = v.account;
    const callId = query(req)['callId'];
    let customer = 'The customer';
    if (workspaceId && organizationId && callId && UUID.test(callId)) {
      const [c] = await asWorker(deps.httpDb, { workspaceId, organizationId }, (tx) =>
        rows<{ name: string | null; to_e164: string | null }>(
          tx,
          sql`select nullif(trim(p.first_name || ' ' || p.last_name), '') as name, c.to_e164
              from app.calls c left join app.people p on p.id = c.person_id
              where c.id = ${callId} and c.workspace_id = ${workspaceId}`,
        ),
      );
      customer = c?.name ?? (c?.to_e164 ? spokenPhone(c.to_e164) : customer);
    }
    return xml(reply, bridgeResultTwiml(v.params['DialCallStatus'], customer));
  });

  // The call that confirms someone's cell: it answered. "Press 1."
  app.post('/webhooks/twilio/voice/verify', async (req, reply) => {
    const v = await verifiedTwilio(deps, req, reply);
    if (!v) return reply;
    const found = await verificationFor(deps, v, query(req)['userPhoneId']);
    if (!found) return xml(reply, NOT_VERIFIED_TWIML);
    return xml(reply, verifyTwiml(found.row.id, urls));
  });

  // They pressed 1: the cell is theirs, marked at once so the app shows it.
  app.post('/webhooks/twilio/voice/verify-result', async (req, reply) => {
    const v = await verifiedTwilio(deps, req, reply);
    if (!v) return reply;
    if (v.params['Digits'] !== '1') return xml(reply, NOT_VERIFIED_TWIML);
    const found = await verificationFor(deps, v, query(req)['userPhoneId']);
    if (!found) return xml(reply, NOT_VERIFIED_TWIML);
    await executeCommand(
      deps.httpDb,
      userPhoneVerify,
      { workspaceId: found.scope.workspaceId, userPhoneId: found.row.id },
      systemActor(found.scope, found.row.userId),
      workerMeta(),
    );
    return xml(reply, VERIFIED_TWIML);
  });

  // How a verification call went: nothing to keep (pressing 1 is what counts).
  app.post('/webhooks/twilio/voice/verify-status', async (req, reply) => {
    const v = await verifiedTwilio(deps, req, reply);
    if (!v) return reply;
    return reply.code(204).send();
  });

  // A browser asks to ring and call: a one-hour token for this teammate in this workspace.
  app.post('/v1/telephony/voice-token', async (req) => {
    const actor = await authenticate(deps, req);
    const { workspaceId } = parseBody(VoiceTokenInput, req.body);
    await requirePermission(deps, actor.userId, workspaceId, 'inbox.use');
    const [account, number] = await asWorker(deps.httpDb, { workspaceId }, async (tx) => [
      (
        await tx
          .select()
          .from(telephonyAccounts)
          .where(eq(telephonyAccounts.workspaceId, workspaceId))
      )[0],
      (
        await tx
          .select({ id: phoneNumbers.id, e164: phoneNumbers.e164 })
          .from(phoneNumbers)
          .where(and(eq(phoneNumbers.workspaceId, workspaceId), eq(phoneNumbers.status, 'active')))
      )[0],
    ]);
    if (!number)
      throw HfosError.rule(
        'no_number',
        409,
        'This business has no phone number yet, so calls can’t start. Get one in Settings → Texting & calls. Calls work as soon as you have one.',
      );
    if (
      !account?.accountSid ||
      !account.authTokenEnc ||
      !account.apiKeySid ||
      !account.apiKeySecretEnc ||
      !account.twimlAppSid
    )
      throw HfosError.rule(
        'calls_not_ready',
        409,
        'Calls are still being set up. Try again in a minute.',
      );
    let opened: ProviderAccount;
    try {
      opened = openAccount(account, deps.sealer)!;
    } catch (e) {
      // Sealed with a key this worker doesn't hold (a database copied from elsewhere, or a key rotated
      // without keeping the old one): the browser shows "Calls unavailable" rather than a server error.
      deps.log.error(
        { workspaceId, err: e instanceof Error ? e.message : String(e) },
        'the calling key could not be opened',
      );
      throw HfosError.rule(
        'calls_unavailable',
        503,
        'Calls can’t start right now, because this business’s calling key can’t be opened on our side. Ask HandsFreeOS support to look into it.',
      );
    }
    let key: { sid: string; secret: string };
    try {
      key = await liveCallingKey(
        { db: deps.httpDb, telephony: deps.telephony, sealer: deps.sealer, log: deps.log },
        workspaceId,
        opened,
      );
    } catch (e) {
      deps.log.error(
        { workspaceId, err: e instanceof Error ? e.message : String(e) },
        'the calling key was gone from Twilio and a new one could not be made',
      );
      throw HfosError.rule(
        'calls_unavailable',
        503,
        'Calls can’t start right now, because the phone carrier didn’t answer. Try again in a minute.',
      );
    }
    const identity = identityOf(actor.userId);
    const { token, expiresAt } = voiceAccessToken({
      accountSid: account.accountSid,
      apiKeySid: key.sid,
      apiKeySecret: key.secret,
      twimlAppSid: account.twimlAppSid,
      identity,
      ttlSeconds: TOKEN_TTL_SECONDS,
    });
    // The caller ID customers see, and whether the carrier is the fake one (the browser then uses a stand-in device).
    return { token, identity, expiresAt, callerId: number.e164, provider: deps.telephony.name };
  });
}
