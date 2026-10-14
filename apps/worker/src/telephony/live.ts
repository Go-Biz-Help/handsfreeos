/**
 * Hearing a person's call as it happens, for the add-ons that listen (Sales Coach's live coaching).
 *
 * Until now only the AI teammate's calls streamed to the worker; a call a person answered was recorded and its words
 * were read afterwards. Now, the moment a call is first answered (`call.answered`), `onCallAnswered` asks which
 * add-ons hear it, and when any do it asks Twilio to send the call's audio here too, both sides, without changing
 * anything the call is doing (`startCallStream`). The recording and the words read afterwards go on as before.
 *
 * **Who hears it.** An add-on whose manifest says `liveCalls`, whose worker half says what it does with the words
 * (`liveCalls`), that runs in the business, where the person on the call holds the add-on's permission. Nobody
 * listens on a number whose callers aren't told the call may be recorded (the owner's decision, 2026-10-14), nor on
 * a call nobody on the team is known to be on: a forwarding phone counts when it's someone's own verified cell.
 *
 * **The stream** carries a sealed ticket (like the AI teammate's), naming the business, the call, the person on it
 * and the add-ons that hear it. `LiveCallSession` turns each side into words with the speech service the teammate
 * uses (`listen`, one per side), and hands each finished line to each add-on in order, as the system acting for it:
 * its commands are refused the moment it's turned off. What it hears is billed as live speech, both sides.
 */
import { ADDON_CATALOG, type AddonManifest } from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import type { Logger } from 'pino';
import { addonScope } from '../addons/context';
import { ADDON_WORKER_MODULES } from '../addons/modules';
import type { AddonWorkerModule, LiveCall, LiveLine } from '../addons/types';
import type { Sealer } from '../crypto';
import type { EventHandler } from '../handlers/types';
import { noteSpeech, speechMinutes } from '../money/speech-usage';
import { tenantOf, workerMeta, type TenantScope, type WorkerServices } from '../services';
import type { HeardWords, Listening, SpeechServices } from '../voice-agent/speech';
import { loadAccount } from './accounts';
import { routingOf, voiceUrls } from './voice';

/** The stream connects within seconds of being asked for. */
export const LIVE_TICKET_TTL_MS = 2 * 60_000;

/** What a live stream's ticket says: sealed by the worker, so only a stream the worker asked for is heard. */
export interface LiveTicket {
  readonly workspaceId: string;
  readonly organizationId: string;
  readonly callId: string;
  /** Twilio's sid for the call that streams. */
  readonly callSid: string;
  /** Who on the team is on the call. */
  readonly teamUserId: string;
  readonly direction: 'inbound' | 'outbound';
  readonly personId: string | null;
  readonly conversationId: string | null;
  /** The add-ons that hear it. */
  readonly addons: readonly string[];
  /** Epoch milliseconds. */
  readonly expiresAt: number;
}

export function sealLiveTicket(
  sealer: Sealer,
  t: Omit<LiveTicket, 'expiresAt'>,
  now = Date.now(),
): string {
  return sealer.seal(
    JSON.stringify({
      k: 'live',
      w: t.workspaceId,
      o: t.organizationId,
      i: t.callId,
      c: t.callSid,
      u: t.teamUserId,
      d: t.direction,
      p: t.personId,
      v: t.conversationId,
      a: t.addons,
      e: now + LIVE_TICKET_TTL_MS,
    }),
  );
}

/** The ticket, or null when it's forged, damaged, too old, or another kind of ticket. */
export function openLiveTicket(
  sealer: Sealer,
  sealed: string | undefined,
  now = Date.now(),
): LiveTicket | null {
  if (!sealed) return null;
  try {
    const v = JSON.parse(sealer.open(sealed)) as Record<string, unknown>;
    const str = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : null);
    const [w, o, i, c, u, d] = [str('w'), str('o'), str('i'), str('c'), str('u'), str('d')];
    const e = typeof v['e'] === 'number' ? v['e'] : 0;
    const addons = Array.isArray(v['a']) ? v['a'].filter((x) => typeof x === 'string') : [];
    if (v['k'] !== 'live' || !w || !o || !i || !c || !u || e < now || addons.length === 0)
      return null;
    if (d !== 'inbound' && d !== 'outbound') return null;
    return {
      workspaceId: w,
      organizationId: o,
      callId: i,
      callSid: c,
      teamUserId: u,
      direction: d,
      personId: str('p'),
      conversationId: str('v'),
      addons,
      expiresAt: e,
    };
  } catch {
    return null;
  }
}

/** The add-ons that hear a call this person is on: running here, listening, and theirs to use. */
export async function liveListenersFor(
  tx: Tx,
  workspaceId: string,
  teamUserId: string,
  modules: readonly AddonWorkerModule[] = ADDON_WORKER_MODULES,
  catalog: readonly AddonManifest[] = ADDON_CATALOG,
): Promise<string[]> {
  const out: string[] = [];
  for (const m of catalog) {
    const permission = m.liveCalls?.permission;
    if (!permission || !modules.some((w) => w.manifest.id === m.id && w.liveCalls)) continue;
    const [on] = await rows<{ ok: boolean }>(
      tx,
      sql`select private.addon_in_use(${workspaceId}::uuid, ${m.id}, false)
                 and private.user_has_permission(${teamUserId}::uuid, ${workspaceId}::uuid, ${permission}) as ok`,
    );
    if (on?.ok) out.push(m.id);
  }
  return out;
}

interface AnsweredCall extends Record<string, unknown> {
  readonly provider_sid: string | null;
  readonly direction: 'inbound' | 'outbound';
  readonly person_id: string | null;
  readonly conversation_id: string | null;
  readonly routing: unknown;
  readonly forwarded_to: string | null;
  readonly ended: boolean;
}

/**
 * `call.answered`: a call is first answered. When an add-on hears this person's calls, the call's audio streams here
 * too. Safe to run again: a retry after the stream started asks for a second one, which the session refuses
 * (one session per call).
 */
export const onCallAnswered: EventHandler = async (ctx) => {
  const callId = ctx.event.entityId;
  if (!callId) return;
  const scope = tenantOf(ctx.scope);
  const payload = (ctx.event.payload ?? {}) as Record<string, unknown>;
  const [c] = await rows<AnsweredCall>(
    ctx.tx,
    sql`select c.provider_sid, c.direction::text as direction, c.person_id, c.conversation_id, n.routing,
               c.ended_at is not null as ended,
               (select up.user_id from app.user_phones up
                  join app.workspace_memberships m on m.user_id = up.user_id and m.workspace_id = c.workspace_id
                 where c.answered_via = 'forwarding' and up.e164 = c.answered_number
                   and up.verified_at is not null
                 limit 1)::text as forwarded_to
          from app.calls c
          left join app.phone_numbers n on n.id = c.phone_number_id
         where c.id = ${callId} and c.workspace_id = ${scope.workspaceId}`,
  );
  if (!c?.provider_sid || c.ended || !c.routing) return;
  // Callers who aren't told a call may be recorded aren't listened to either.
  if (!routingOf(c.routing).announceRecording) return;
  const teamUserId =
    typeof payload['teamUserId'] === 'string' ? payload['teamUserId'] : c.forwarded_to;
  if (!teamUserId) return;
  const addons = await liveListenersFor(ctx.tx, scope.workspaceId, teamUserId);
  if (addons.length === 0) return;
  const account = await loadAccount(ctx.tx, scope.workspaceId, ctx.sealer);
  if (!account) return;
  const ticket = sealLiveTicket(ctx.sealer, {
    ...scope,
    callId,
    callSid: c.provider_sid,
    teamUserId,
    direction: c.direction,
    personId: c.person_id,
    conversationId: c.conversation_id,
    addons,
  });
  await ctx.telephony.startCallStream(account, c.provider_sid, {
    url: voiceUrls(ctx.publicUrl).live,
    params: { t: ticket },
  });
  ctx.log.info({ callId, addons }, 'a call is heard live');
};

/** The calls being heard on this machine, by call id: one session each. */
const sessions = new Map<string, LiveCallSession>();

/** Twilio's two sides of a stream, as the people on the call. */
export function speakerOfTrack(
  direction: 'inbound' | 'outbound',
  track: string | undefined,
): LiveLine['speaker'] | null {
  // `inbound` is the audio from the party whose call it is: the customer on a call they made, the person on the
  // team on one the team placed (from a browser, or through their own cell).
  if (track === 'inbound') return direction === 'inbound' ? 'customer' : 'team';
  if (track === 'outbound') return direction === 'inbound' ? 'team' : 'customer';
  return null;
}

export interface LiveSessionDeps extends WorkerServices {
  /** The speech service that hears each side (the AI teammate's). */
  readonly hearing: SpeechServices;
  readonly modules?: readonly AddonWorkerModule[];
  readonly catalog?: readonly AddonManifest[];
}

/**
 * One call heard live: both sides into words, each finished line handed to every add-on that hears it, in order.
 * An add-on that fails a line is logged and keeps hearing the next; nothing it does holds up the audio.
 */
export class LiveCallSession {
  private readonly lines: LiveLine[] = [];
  private readonly listening = new Map<LiveLine['speaker'], Listening>();
  private readonly pending = new Map<LiveLine['speaker'], string[]>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly started = Date.now();
  private stopped = false;
  readonly call: LiveCall;
  private readonly log: Logger;

  private constructor(
    private readonly deps: LiveSessionDeps,
    private readonly ticket: LiveTicket,
  ) {
    this.call = {
      callId: ticket.callId,
      callSid: ticket.callSid,
      teamUserId: ticket.teamUserId,
      direction: ticket.direction,
      personId: ticket.personId,
      conversationId: ticket.conversationId,
    };
    this.log = deps.log.child({ callId: ticket.callId });
  }

  /** The session for the ticket's call, or null when one is already running for it. */
  static open(deps: LiveSessionDeps, ticket: LiveTicket): LiveCallSession | null {
    if (sessions.has(ticket.callId)) return null;
    const s = new LiveCallSession(deps, ticket);
    sessions.set(ticket.callId, s);
    return s;
  }

  private get scope(): TenantScope {
    return { workspaceId: this.ticket.workspaceId, organizationId: this.ticket.organizationId };
  }

  private modules(): { module: AddonWorkerModule; manifest: AddonManifest }[] {
    const modules = this.deps.modules ?? ADDON_WORKER_MODULES;
    const catalog = this.deps.catalog ?? ADDON_CATALOG;
    return this.ticket.addons.flatMap((id) => {
      const module = modules.find((m) => m.manifest.id === id);
      const manifest = catalog.find((m) => m.id === id);
      return module?.liveCalls && manifest ? [{ module, manifest }] : [];
    });
  }

  /** Runs `fn` for each add-on that hears the call, after whatever it's still doing with the line before. */
  private each(
    what: string,
    fn: (
      hooks: NonNullable<AddonWorkerModule['liveCalls']>,
      ctx: ReturnType<typeof addonScope>,
    ) => Promise<void>,
  ): Promise<void> {
    const runs = this.modules().map(({ module, manifest }) => {
      const before = this.queues.get(manifest.id) ?? Promise.resolve();
      const next = before.then(async () => {
        const [row] = await asWorker(this.deps.db, this.scope, (tx) =>
          rows<{ generation: number | null }>(
            tx,
            sql`select generation from app.addon_installations
                 where workspace_id = ${this.scope.workspaceId} and addon_id = ${manifest.id}`,
          ),
        );
        const ctx = addonScope(this.deps, manifest, this.scope, row?.generation ?? 1, workerMeta());
        try {
          await fn(module.liveCalls!, ctx);
        } catch (e) {
          this.log.warn({ err: e, addon: manifest.id, what }, 'an add-on stumbled on a live call');
        }
      });
      this.queues.set(manifest.id, next);
      return next;
    });
    return Promise.all(runs).then(() => undefined);
  }

  /** Opens both sides' listening. False when the speech service can't hear: the call goes on unheard. */
  async start(): Promise<boolean> {
    try {
      for (const speaker of ['customer', 'team'] as const) {
        this.pending.set(speaker, []);
        const listening = await this.deps.hearing.listen({
          onWords: (w) => this.heard(speaker, w),
          onSpeechStarted: () => {},
          onUtteranceEnd: () => this.finishLine(speaker),
          onError: (e) => this.log.warn({ err: e, speaker }, 'live listening stumbled'),
        });
        this.listening.set(speaker, listening);
      }
    } catch (e) {
      this.log.warn({ err: e }, 'could not start hearing a call');
      await this.stop();
      return false;
    }
    void this.each('start', (hooks, ctx) => hooks.onStart?.(ctx, this.call) ?? Promise.resolve());
    return true;
  }

  /** One frame of one side's audio (8 kHz μ-law). */
  audio(speaker: LiveLine['speaker'], frame: Buffer): void {
    if (!this.stopped) this.listening.get(speaker)?.send(frame);
  }

  private heard(speaker: LiveLine['speaker'], w: HeardWords): void {
    if (w.final && w.text) this.pending.get(speaker)?.push(w.text);
    if (w.endOfTurn) this.finishLine(speaker);
  }

  private finishLine(speaker: LiveLine['speaker']): void {
    const words = this.pending.get(speaker);
    if (!words?.length) return;
    const text = words.join(' ').trim();
    words.length = 0;
    if (!text) return;
    const line: LiveLine = { speaker, text, atMs: Date.now() - this.started };
    this.lines.push(line);
    const so = this.lines.slice();
    void this.each('line', (hooks, ctx) => hooks.onLine(ctx, this.call, line, so));
  }

  /** The call ended, or its stream did: whatever was half-said is finished, and each add-on hears the end. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    sessions.delete(this.ticket.callId);
    for (const speaker of ['customer', 'team'] as const) this.finishLine(speaker);
    await Promise.all([...this.listening.values()].map((l) => l.close().catch(() => undefined)));
    const seconds = (Date.now() - this.started) / 1000;
    if (this.listening.size > 0)
      await noteSpeech(this.deps, this.scope, [
        {
          key: 'speech.live.minute',
          quantity: speechMinutes(seconds) * this.listening.size,
          source: 'call',
          ref: this.ticket.callSid,
        },
      ]);
    const all = this.lines.slice();
    await this.each('end', (hooks, ctx) => hooks.onEnd?.(ctx, this.call, all) ?? Promise.resolve());
  }
}
