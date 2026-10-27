/**
 * The AI's listener for HandsFreeOS video calls (docs/video-calls.md, "The AI hears it"), run by the media process
 * (media.ts). Every few seconds it asks which calls to hear (`private.video_calls_to_hear()`: live, AI notes on, in
 * a business with calls on), joins those it isn't in, and leaves those it shouldn't be in any more.
 *
 * - **One listener a call.** LiveKit lets one participant have an identity, and every listener's is the same, so
 *   a second listener joining takes the first one's place. A listener checks the room before joining, and one
 *   that was replaced leaves the call to the other for a while.
 * - **Only with people there.** It joins a room with someone in it, and leaves once it has been alone a few
 *   seconds, so an empty room closes and the stretch of the call ends.
 * - **AI notes off** (the team's, for one call) drops the call from the list: the listener leaves, and the room
 *   stops saying the AI is on. What it heard is forgotten by the command that turned them off.
 * - **"AI notes on"** shows in the call while the listener is in it: it says so in the room's metadata as it
 *   joins (`markAi`).
 */
import { executeCommand, HfosError, videoCallHeard, videoCallRoom } from '@hfos/core/server';
import { asWorker, rows, sql, type Db } from '@hfos/db/client';
import type { Logger } from 'pino';
import { noteSpeech, speechMinutes } from '../money/speech-usage';
import { systemActor, workerMeta, type TenantScope } from '../services';
import type { SpeechServices } from '../voice-agent/speech';
import { CallHearing, type HeardLine, type JoinRoom, type ListenerRoom } from './hearing';
import type { VideoCallProvider } from './provider';

export interface ListenerDeps {
  readonly db: Db;
  readonly log: Logger;
  readonly speech: SpeechServices;
  readonly video: VideoCallProvider;
  readonly join: JoinRoom;
  readonly now?: () => number;
}

/** The calls one listener hears at once, at most: more wait for a pass with room. */
export const LISTENER_MAX_CALLS = 40;
/** Calls joined in one pass, at most, so a burst of calls starting doesn't all connect in the same second. */
const JOINS_A_PASS = 5;
/** A call another listener took is left to it this long; one whose join failed is tried again after this. */
const REPLACED_WAIT_MS = 60_000;
const FAILED_WAIT_MS = 10_000;

interface Heard {
  readonly scope: TenantScope;
  readonly hearing: CallHearing;
  readonly room: ListenerRoom;
}

export interface Listener {
  /** Which calls to hear, and joining and leaving them. */
  pass(): Promise<void>;
  /** Every second: each call's lines kept, its balance, and leaving the ones it's alone in. */
  tick(): Promise<void>;
  /** Leaves every call, keeping what was heard (a deploy). */
  stop(): Promise<void>;
  /** The calls it's in (tests). */
  readonly calls: ReadonlyMap<string, unknown>;
}

export function createListener(deps: ListenerDeps): Listener {
  const now = deps.now ?? Date.now;
  const heard = new Map<string, Heard>();
  const joining = new Set<string>();
  /** Calls not to join before a time: another listener has them, or joining just failed. */
  const notBefore = new Map<string, number>();

  async function leave(callId: string, why: 'off' | 'alone' | 'gone' | 'stopping'): Promise<void> {
    const h = heard.get(callId);
    if (!h) return;
    heard.delete(callId);
    await h.room.leave().catch(() => undefined);
    await h.hearing.stop();
    if (why === 'off') await deps.video.markAi(videoCallRoom(callId), false).catch(() => undefined);
    deps.log.info({ callId, why }, 'stopped hearing a video call');
  }

  async function join(callId: string, scope: TenantScope): Promise<void> {
    const room = videoCallRoom(callId);
    const there = await deps.video.whoIsIn(room);
    // Nobody to hear yet, or another listener is hearing it.
    if (!there.people || there.listener) return;
    // Set once the room is joined; nothing is heard before then.
    let inRoom: ListenerRoom | null = null;
    const hearing = new CallHearing(callId, {
      speech: deps.speech,
      log: deps.log.child({ callId }),
      now,
      keep: (lines) => keep(scope, callId, lines),
      bill: (seconds) =>
        noteSpeech(deps, scope, [
          {
            key: 'speech.live.minute',
            quantity: speechMinutes(seconds),
            source: 'call',
            ref: `video:${callId}`,
          },
        ]),
      say: (topic, payload) => inRoom?.say(topic, payload) ?? Promise.resolve(),
      people: () => inRoom?.people() ?? 0,
    });
    inRoom = await deps.join(await deps.video.listenerTicket(room), {
      onVoice: (v) => hearing.voice(v),
      onGone: (why) => {
        if (heard.get(callId)?.hearing !== hearing) return;
        if (why === 'replaced') notBefore.set(callId, now() + REPLACED_WAIT_MS);
        void leave(callId, 'gone');
      },
    });
    heard.set(callId, { scope, hearing, room: inRoom });
    await deps.video
      .markAi(room, true)
      .catch((e: unknown) =>
        deps.log.warn(
          { callId, err: e instanceof Error ? e.message : String(e) },
          'couldn’t tell a video call the AI is on',
        ),
      );
    deps.log.info({ callId }, 'hearing a video call');
  }

  /** Lines into the call's keeping. A refusal (the call is gone) drops them; anything else is tried again. */
  async function keep(
    scope: TenantScope,
    callId: string,
    lines: readonly HeardLine[],
  ): Promise<void> {
    try {
      await executeCommand(
        deps.db,
        videoCallHeard,
        { workspaceId: scope.workspaceId, callId, lines },
        systemActor(scope),
        workerMeta(),
      );
    } catch (e) {
      if (e instanceof HfosError && e.status >= 400 && e.status < 500) {
        deps.log.warn({ callId, err: e.message }, 'a video call’s lines were refused');
        return;
      }
      throw e;
    }
  }

  return {
    calls: heard,

    async pass() {
      const list = await asWorker(deps.db, {}, (tx) =>
        rows<{ video_call_id: string; workspace_id: string; organization_id: string }>(
          tx,
          sql`select video_call_id, workspace_id, organization_id from private.video_calls_to_hear()`,
        ),
      );
      const wanted = new Map(list.map((c) => [c.video_call_id, c]));
      for (const callId of [...heard.keys()]) if (!wanted.has(callId)) await leave(callId, 'off');
      const t = now();
      for (const [callId, until] of notBefore) if (until <= t) notBefore.delete(callId);
      const toJoin = [...wanted.values()]
        .filter((c) => !heard.has(c.video_call_id) && !joining.has(c.video_call_id))
        .filter((c) => !notBefore.has(c.video_call_id))
        .slice(0, Math.max(0, Math.min(JOINS_A_PASS, LISTENER_MAX_CALLS - heard.size)));
      await Promise.all(
        toJoin.map(async (c) => {
          joining.add(c.video_call_id);
          try {
            await join(c.video_call_id, {
              workspaceId: c.workspace_id,
              organizationId: c.organization_id,
            });
          } catch (e) {
            notBefore.set(c.video_call_id, now() + FAILED_WAIT_MS);
            deps.log.warn(
              { callId: c.video_call_id, err: e instanceof Error ? e.message : String(e) },
              'couldn’t join a video call to hear it',
            );
          } finally {
            joining.delete(c.video_call_id);
          }
        }),
      );
    },

    async tick() {
      await Promise.all(
        [...heard.entries()].map(async ([callId, h]) => {
          if (!(await h.hearing.tick())) await leave(callId, 'alone');
        }),
      );
    },

    async stop() {
      await Promise.all([...heard.keys()].map((callId) => leave(callId, 'stopping')));
    },
  };
}
