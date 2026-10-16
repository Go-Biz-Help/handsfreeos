/**
 * Hearing a Zoom meeting as it happens, for the add-ons that listen (`liveCalls`, like Sales Coach): round three of
 * HANDSFREEOS_SALES_COACH_IMPLEMENTATION_PLAN.md.
 *
 * Someone in a meeting opens HandsFreeOS in Zoom's Apps panel. The page claims the meeting for them
 * (`live_meeting.claim`) and asks Zoom to start its Realtime Media Stream. Zoom then calls the coaching app's
 * `/webhooks/zoom-live` with `meeting.rtms_started`, naming the meeting, the stream and where to connect. `onStreamStarted` takes the newest
 * waiting claim on that meeting whose person's coaching-app Zoom account (`app.live_meeting_accounts`) started the
 * stream, and opens a `ZoomLiveSession`. Zoom's auto-start (the app starts as its person joins) usually sends the stream
 * before the app has claimed anything: then the stream's own Zoom user, when linked here, gets it claimed for them
 * (`claimForOperator`), so the coach hears it from the start and the app, opened later, names the customer.
 *
 *
 * 1. **Signaling** (a websocket to `server_urls`): a handshake signed with the coaching Zoom app's id and secret
 *    (HMAC-SHA256 of `<client id>,<meeting uuid>,<stream id>`, hex). Zoom answers with the media server.
 * 2. **Media** (a second websocket): the same signed handshake, asking for Zoom's own live transcript only
 *    (`media_type` 8, English). Once Zoom accepts, the signaling socket says ready and the words start.
 * 3. **Keep-alive**: both sockets answer Zoom's ping (12) with a pong (13) carrying its timestamp, or Zoom hangs up.
 *
 * Each transcript message is one person's words with their name in the meeting: the claim's person (by the name they
 * show) is the team's side, anyone else the customer's. Each is handed to the add-ons as a finished line
 * (addons/live-fanout.ts), like a phone call's. When the stream ends (Zoom says so, either socket closes, or
 * `meeting.rtms_stopped`), the add-ons hear the end and the claim is ended. Nothing of the meeting is kept by core.
 * What it heard is billed as live listening, one stream.
 *
 * Zoom's transcript is its own: no audio comes here and nothing goes to the speech service.
 */
import { createHmac, randomInt } from 'node:crypto';
import {
  executeCommand,
  liveMeetingAutoClaim,
  liveMeetingEnded,
  liveMeetingStarted,
  type AddonManifest,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { Logger } from 'pino';
import WebSocket from 'ws';
import { LiveFanout, type LiveFanoutDeps } from '../addons/live-fanout';
import type { AddonWorkerModule, LiveCall, LiveLine } from '../addons/types';
import { noteSpeech, speechMinutes } from '../money/speech-usage';
import { systemActor, workerMeta, type TenantScope } from '../services';
import { liveListenersFor } from '../telephony/live';
import type { ZoomLiveApp } from './zoom-live';

/** Zoom's message types on the two sockets (RTMS data types, `msg_type`). */
export const RTMS = {
  SIGNALING_HAND_SHAKE_REQ: 1,
  SIGNALING_HAND_SHAKE_RESP: 2,
  DATA_HAND_SHAKE_REQ: 3,
  DATA_HAND_SHAKE_RESP: 4,
  CLIENT_READY_ACK: 7,
  STREAM_STATE_UPDATE: 8,
  SESSION_STATE_UPDATE: 9,
  KEEP_ALIVE_REQ: 12,
  KEEP_ALIVE_RESP: 13,
  MEDIA_DATA_TRANSCRIPT: 17,
} as const;
/** `media_type` for the transcript alone; its text content type, and English. */
const MEDIA_TRANSCRIPT = 8;
const CONTENT_TEXT = 5;
const LANGUAGE_ENGLISH = 9;
/** A stream state of TERMINATED, a session state of STOPPED. */
const STREAM_TERMINATED = 4;
const SESSION_STOPPED = 5;
/** A stream that hasn't reached Zoom's transcript by now is given up. */
const CONNECT_WITHIN_MS = 30_000;

/** What both handshakes are signed with. */
export const rtmsSignature = (
  clientId: string,
  clientSecret: string,
  meetingUuid: string,
  streamId: string,
): string =>
  createHmac('sha256', clientSecret).update(`${clientId},${meetingUuid},${streamId}`).digest('hex');

export interface RtmsTranscript {
  readonly userName: string;
  readonly text: string;
}

export type OpenSocket = (url: string) => WebSocket;

export interface RtmsStreamOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly meetingUuid: string;
  readonly streamId: string;
  readonly serverUrl: string;
  readonly log: Logger;
  readonly onTranscript: (t: RtmsTranscript) => void;
  /** Once, however it ended. */
  readonly onClose: (why: string) => void;
  /** Tests connect to their own stand-in. */
  readonly open?: OpenSocket;
}

/** Only Zoom's own servers are connected to (`wss://…zoom.us`), or a stand-in on this machine in tests. */
export function trustedStreamUrl(url: unknown, allowLocal = false): url is string {
  if (typeof url !== 'string' || url.length > 2000) return false;
  try {
    const u = new URL(url);
    if (allowLocal && u.protocol === 'ws:' && ['127.0.0.1', 'localhost'].includes(u.hostname))
      return true;
    return u.protocol === 'wss:' && (u.hostname === 'zoom.us' || u.hostname.endsWith('.zoom.us'));
  } catch {
    return false;
  }
}

/** One meeting's stream from Zoom: the two sockets, their handshakes and keep-alives, and the transcript. */
export class RtmsStream {
  private signaling: WebSocket | null = null;
  private media: WebSocket | null = null;
  private closed = false;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly o: RtmsStreamOptions) {
    this.timer = setTimeout(() => {
      if (!this.media) this.close('Zoom’s stream didn’t connect in time');
    }, CONNECT_WITHIN_MS);
    this.timer.unref?.();
  }

  private get signature(): string {
    return rtmsSignature(this.o.clientId, this.o.clientSecret, this.o.meetingUuid, this.o.streamId);
  }

  private socket(url: string): WebSocket {
    return this.o.open ? this.o.open(url) : new WebSocket(url);
  }

  private static send(ws: WebSocket | null, message: Record<string, unknown>): void {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  private static parse(raw: WebSocket.RawData): Record<string, unknown> | null {
    try {
      const m = JSON.parse(String(raw)) as unknown;
      return m && typeof m === 'object' ? (m as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  start(): void {
    const ws = this.socket(this.o.serverUrl);
    this.signaling = ws;
    ws.on('open', () =>
      RtmsStream.send(ws, {
        msg_type: RTMS.SIGNALING_HAND_SHAKE_REQ,
        protocol_version: 1,
        meeting_uuid: this.o.meetingUuid,
        rtms_stream_id: this.o.streamId,
        sequence: randomInt(1, 1_000_000),
        signature: this.signature,
      }),
    );
    ws.on('message', (raw) => this.onSignaling(RtmsStream.parse(raw)));
    ws.on('error', (e) => this.o.log.warn({ err: e }, 'Zoom’s signaling socket stumbled'));
    ws.on('close', () => this.close('Zoom’s signaling socket closed'));
  }

  private onSignaling(m: Record<string, unknown> | null): void {
    if (!m || this.closed) return;
    switch (m['msg_type']) {
      case RTMS.SIGNALING_HAND_SHAKE_RESP: {
        if (m['status_code'] !== 0) {
          this.close(`Zoom refused the stream (status ${String(m['status_code'])})`);
          return;
        }
        const server = (m['media_server'] ?? {}) as { server_urls?: Record<string, unknown> };
        const url = server.server_urls?.['transcript'] ?? server.server_urls?.['all'];
        if (!trustedStreamUrl(url, Boolean(this.o.open))) {
          this.close('Zoom named no media server we connect to');
          return;
        }
        this.connectMedia(url);
        return;
      }
      case RTMS.KEEP_ALIVE_REQ:
        RtmsStream.send(this.signaling, {
          msg_type: RTMS.KEEP_ALIVE_RESP,
          timestamp: m['timestamp'],
        });
        return;
      case RTMS.STREAM_STATE_UPDATE:
        if (m['state'] === STREAM_TERMINATED) this.close('Zoom ended the stream');
        return;
      case RTMS.SESSION_STATE_UPDATE:
        if (m['state'] === SESSION_STOPPED) this.close('Zoom stopped the meeting’s session');
        return;
    }
  }

  private connectMedia(url: string): void {
    const ws = this.socket(url);
    this.media = ws;
    ws.on('open', () =>
      RtmsStream.send(ws, {
        msg_type: RTMS.DATA_HAND_SHAKE_REQ,
        protocol_version: 1,
        meeting_uuid: this.o.meetingUuid,
        rtms_stream_id: this.o.streamId,
        signature: this.signature,
        media_type: MEDIA_TRANSCRIPT,
        payload_encryption: false,
        media_params: { transcript: { content_type: CONTENT_TEXT, language: LANGUAGE_ENGLISH } },
      }),
    );
    ws.on('message', (raw) => this.onMedia(RtmsStream.parse(raw)));
    ws.on('error', (e) => this.o.log.warn({ err: e }, 'Zoom’s media socket stumbled'));
    ws.on('close', () => this.close('Zoom’s media socket closed'));
  }

  private onMedia(m: Record<string, unknown> | null): void {
    if (!m || this.closed) return;
    switch (m['msg_type']) {
      case RTMS.DATA_HAND_SHAKE_RESP:
        if (m['status_code'] !== 0) {
          this.close(`Zoom refused the transcript (status ${String(m['status_code'])})`);
          return;
        }
        clearTimeout(this.timer);
        RtmsStream.send(this.signaling, {
          msg_type: RTMS.CLIENT_READY_ACK,
          rtms_stream_id: this.o.streamId,
        });
        return;
      case RTMS.KEEP_ALIVE_REQ:
        RtmsStream.send(this.media, { msg_type: RTMS.KEEP_ALIVE_RESP, timestamp: m['timestamp'] });
        return;
      case RTMS.MEDIA_DATA_TRANSCRIPT: {
        const c = (m['content'] ?? {}) as Record<string, unknown>;
        const text = typeof c['data'] === 'string' ? c['data'].trim() : '';
        if (!text) return;
        this.o.onTranscript({
          userName: typeof c['user_name'] === 'string' ? c['user_name'].slice(0, 200) : '',
          text: text.slice(0, 2000),
        });
        return;
      }
    }
  }

  close(why: string): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    for (const ws of [this.media, this.signaling])
      if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING)
        ws.close();
    this.o.onClose(why);
  }
}

/** The meetings being heard on this machine, by Zoom's stream id. */
const sessions = new Map<string, ZoomLiveSession>();

/** The same person, by the name they show: Zoom's transcript names speakers, not accounts. */
const sameName = (a: string, b: string | null): boolean =>
  !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

export interface ZoomSessionDeps extends LiveFanoutDeps {
  readonly open?: OpenSocket;
}

interface Claim {
  readonly liveMeetingId: string;
  readonly scope: TenantScope;
  readonly userId: string;
  readonly personId: string | null;
  readonly screenName: string | null;
  readonly addons: readonly string[];
}

/** One meeting heard live: Zoom's transcript, line by line, to the add-ons that hear it. */
export class ZoomLiveSession {
  private readonly lines: LiveLine[] = [];
  private readonly started = Date.now();
  private readonly fanout: LiveFanout;
  private readonly stream: RtmsStream;
  private readonly log: Logger;
  private ended = false;
  readonly call: LiveCall;

  private constructor(
    private readonly deps: ZoomSessionDeps,
    private readonly claim: Claim,
    private readonly started_: { meetingUuid: string; streamId: string; serverUrl: string },
    credentials: { clientId: string; clientSecret: string },
  ) {
    this.call = {
      key: claim.liveMeetingId,
      kind: 'meeting',
      callId: null,
      liveMeetingId: claim.liveMeetingId,
      callSid: started_.streamId,
      teamUserId: claim.userId,
      direction: null,
      personId: claim.personId,
      conversationId: null,
    };
    this.log = deps.log.child({ liveMeetingId: claim.liveMeetingId });
    this.fanout = new LiveFanout(deps, claim.scope, claim.addons, this.call, this.log);
    this.stream = new RtmsStream({
      ...credentials,
      ...started_,
      log: this.log,
      open: deps.open,
      onTranscript: (t) => this.heard(t),
      onClose: (why) => void this.end(why),
    });
  }

  /** The session for the stream, or null when it's already heard here. */
  static open(
    deps: ZoomSessionDeps,
    claim: Claim,
    started: { meetingUuid: string; streamId: string; serverUrl: string },
    credentials: { clientId: string; clientSecret: string },
  ): ZoomLiveSession | null {
    if (sessions.has(started.streamId)) return null;
    const s = new ZoomLiveSession(deps, claim, started, credentials);
    sessions.set(started.streamId, s);
    return s;
  }

  /** The session hearing this stream on this machine. */
  static of(streamId: string): ZoomLiveSession | undefined {
    return sessions.get(streamId);
  }

  async start(): Promise<void> {
    await executeCommand(
      this.deps.db,
      liveMeetingStarted,
      {
        workspaceId: this.claim.scope.workspaceId,
        liveMeetingId: this.claim.liveMeetingId,
        streamId: this.started_.streamId,
      },
      systemActor(this.claim.scope),
      workerMeta(),
    );
    await this.fanout.start();
    this.stream.start();
  }

  private heard(t: RtmsTranscript): void {
    if (this.ended) return;
    const speaker: LiveLine['speaker'] = sameName(t.userName, this.claim.screenName)
      ? 'team'
      : 'customer';
    const last = this.lines[this.lines.length - 1];
    // Zoom can send a line again as it settles: the same words from the same side are one line.
    if (last && last.speaker === speaker && last.text === t.text) return;
    const line: LiveLine = { speaker, text: t.text, atMs: Date.now() - this.started };
    this.lines.push(line);
    void this.fanout.line(line, this.lines.slice());
  }

  /** Zoom said the stream stopped. */
  stop(why = 'Zoom stopped the stream'): void {
    this.stream.close(why);
  }

  private async end(why: string): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    sessions.delete(this.started_.streamId);
    this.log.info({ why, lines: this.lines.length }, 'a meeting stopped being heard');
    try {
      await this.fanout.end(this.lines.slice());
      await executeCommand(
        this.deps.db,
        liveMeetingEnded,
        { workspaceId: this.claim.scope.workspaceId, liveMeetingId: this.claim.liveMeetingId },
        systemActor(this.claim.scope),
        workerMeta(),
      );
      await noteSpeech(this.deps, this.claim.scope, [
        {
          key: 'speech.live.minute',
          quantity: speechMinutes((Date.now() - this.started) / 1000),
          source: 'call',
          ref: this.started_.streamId,
        },
      ]);
    } catch (e) {
      this.log.warn({ err: e }, 'could not finish a meeting heard live');
    }
  }
}

interface WaitingClaim extends Record<string, unknown> {
  readonly live_meeting_id: string;
  readonly workspace_id: string;
  readonly organization_id: string;
  readonly user_id: string;
  readonly external_user_id: string | null;
  readonly person_id: string | null;
  readonly screen_name: string | null;
}

export interface StreamStartedInput {
  readonly meetingUuid: string;
  readonly streamId: string;
  readonly serverUrl: string;
  /** The Zoom user who started it, when Zoom says. */
  readonly operatorId: string | null;
}

/**
 * Nobody claimed the meeting yet (Zoom's auto-start): the Zoom user who started the stream, where they're linked
 * here and an add-on listens for them, gets it claimed for them, in the business they linked most recently. Their
 * name in HandsFreeOS stands in for their name in the meeting until the app says it.
 */
async function claimForOperator(
  deps: Parameters<typeof onStreamStarted>[0],
  input: StreamStartedInput,
): Promise<WaitingClaim | null> {
  if (!input.operatorId) return null;
  const operatorId = input.operatorId;
  const accounts = await asWorker(deps.db, {}, (tx) =>
    rows<{ account_id: string; workspace_id: string; organization_id: string }>(
      tx,
      sql`select account_id, workspace_id, organization_id
          from private.live_meeting_accounts_by_external_user('zoom', ${operatorId})`,
    ),
  );
  const linked: { scope: TenantScope; userId: string; at: number }[] = [];
  for (const a of accounts) {
    const scope = { workspaceId: a.workspace_id, organizationId: a.organization_id };
    const [row] = await asWorker(deps.db, scope, (tx) =>
      rows<{ user_id: string; at: Date }>(
        tx,
        sql`select user_id, updated_at as at from app.live_meeting_accounts where id = ${a.account_id}`,
      ),
    );
    if (row) linked.push({ scope, userId: row.user_id, at: new Date(row.at).getTime() });
  }
  linked.sort((a, b) => b.at - a.at);
  for (const l of linked) {
    const listens = await asWorker(deps.db, l.scope, (tx) =>
      liveListenersFor(tx, l.scope.workspaceId, l.userId, deps.modules, deps.catalog),
    );
    if (listens.length === 0) continue;
    const made = await executeCommand(
      deps.db,
      liveMeetingAutoClaim,
      {
        workspaceId: l.scope.workspaceId,
        userId: l.userId,
        provider: 'zoom',
        meetingUuid: input.meetingUuid,
      },
      systemActor(l.scope),
      workerMeta(),
    );
    if (made.output.state !== 'waiting') return null;
    const [who] = await asWorker(deps.db, l.scope, (tx) =>
      rows<{ name: string | null }>(
        tx,
        sql`select full_name as name from app.users where id = ${l.userId}`,
      ),
    );
    return {
      live_meeting_id: made.output.liveMeetingId,
      workspace_id: l.scope.workspaceId,
      organization_id: l.scope.organizationId,
      user_id: l.userId,
      external_user_id: operatorId,
      person_id: null,
      screen_name: who?.name?.trim() || null,
    };
  }
  return null;
}

/**
 * `meeting.rtms_started`: the stream of a meeting someone claimed. The newest waiting claim whose person's linked
 * Zoom account started it is heard; with no claim, the Zoom user who started it gets one when they're linked here
 * (`claimForOperator`). A stream nobody here can be heard for is left alone.
 */
export async function onStreamStarted(
  deps: ZoomSessionDeps & {
    readonly calendars: { readonly zoomLive: ZoomLiveApp | null };
    readonly modules?: readonly AddonWorkerModule[];
    readonly catalog?: readonly AddonManifest[];
  },
  input: StreamStartedInput,
): Promise<ZoomLiveSession | null> {
  const app = deps.calendars.zoomLive;
  if (!app) return null;
  const credentials = { clientId: app.clientId, clientSecret: app.clientSecret };
  if (!trustedStreamUrl(input.serverUrl, Boolean(deps.open))) {
    deps.log.warn('a Zoom stream named a server we don’t connect to');
    return null;
  }
  const claims = await asWorker(deps.db, {}, (tx) =>
    rows<WaitingClaim>(
      tx,
      sql`select live_meeting_id, workspace_id, organization_id, user_id, external_user_id, person_id, screen_name
            from private.live_meetings_waiting('zoom', ${input.meetingUuid})`,
    ),
  );
  // Only someone whose Zoom is linked here, and when Zoom names who started it, that very account.
  const claim =
    claims.find(
      (c) => c.external_user_id && (!input.operatorId || c.external_user_id === input.operatorId),
    ) ?? (await claimForOperator(deps, input));
  if (!claim) {
    deps.log.info(
      { claims: claims.length, operator: Boolean(input.operatorId) },
      'a Zoom stream nobody here claimed, or whose Zoom account isn’t linked here',
    );
    return null;
  }
  const scope = { workspaceId: claim.workspace_id, organizationId: claim.organization_id };
  const addons = await asWorker(deps.db, scope, (tx) =>
    liveListenersFor(tx, scope.workspaceId, claim.user_id, deps.modules, deps.catalog),
  );
  if (addons.length === 0) return null;
  const session = ZoomLiveSession.open(
    deps,
    {
      liveMeetingId: claim.live_meeting_id,
      scope,
      userId: claim.user_id,
      personId: claim.person_id,
      screenName: claim.screen_name,
      addons,
    },
    { meetingUuid: input.meetingUuid, streamId: input.streamId, serverUrl: input.serverUrl },
    credentials,
  );
  if (!session) return null;
  await session.start();
  deps.log.info({ addons }, 'a Zoom meeting is heard live');
  return session;
}

/** `meeting.rtms_stopped`: the stream heard here, if it's this machine's, ends. */
export function onStreamStopped(streamId: string): void {
  ZoomLiveSession.of(streamId)?.stop();
}
