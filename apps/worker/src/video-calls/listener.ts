/**
 * The AI's listener for HandsFreeOS video calls (docs/video-calls.md, "The AI hears it"), run by the media process
 * (media.ts). Every few seconds it asks which calls to hear (`private.video_calls_to_hear()`: live, AI notes on, in
 * a business with calls on), joins those it isn't in, and leaves those it shouldn't be in any more.
 *
 * - **One listener a call.** LiveKit lets one participant have an identity, and every listener's is the same, so
 *   a second listener joining takes the first one's place. A listener checks the room before joining, leaves a
 *   call another listener has to it for a while, and so does one that was replaced.
 * - **Only with people there.** It joins a room with someone in it, and leaves once it has been alone a few
 *   seconds, so an empty room closes and the stretch of the call ends.
 * - **AI notes off** (the team's, for one call) drops the call from the list: the listener leaves, and the room
 *   stops saying the AI is on. What it heard is forgotten by the command that turned them off.
 * - **"AI notes on"** shows in the call while the listener is in it: it says so in the room's metadata as it
 *   joins (`markAi`).
 * - **The coach** (coach.ts): with the worker's services, what it hears goes to the add-ons that listen, for someone
 *   on the team in the call they're on for. AI notes off forgets their coaching too; leaving otherwise doesn't end it.
 * - **The live poll** (poll-cues.ts): with the worker's services too, what the team says is matched to the call's
 *   live poll, and a question pops up, or the team is offered it, when they reach its moment.
 */
import {
  executeCommand,
  HfosError,
  VIDEO_CALL_POLLS_TOPIC,
  videoCallHeard,
  videoCallPollCueState,
  videoCallPollOpen,
  videoCallRoom,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Db } from '@hfos/db/client';
import type { Logger } from 'pino';
import type { LiveFanoutDeps } from '../addons/live-fanout';
import { noteSpeech, speechMinutes } from '../money/speech-usage';
import { systemActor, workerMeta, type TenantScope } from '../services';
import type { SpeechServices } from '../voice-agent/speech';
import { AiAskError, askStructured } from '../ai/ask';
import { CallCoach } from './coach';
import {
  CallPollCues,
  POLL_CUE_MATCH_SCHEMA,
  POLL_CUE_SYSTEM,
  PollCueMatch,
  PollCuesOutOfRoom,
  pollCueContext,
} from './poll-cues';
import { CallHearing, type HeardLine, type JoinRoom, type ListenerRoom } from './hearing';
import type { VideoCallProvider } from './provider';

export interface ListenerDeps {
  readonly db: Db;
  readonly log: Logger;
  readonly speech: SpeechServices;
  readonly video: VideoCallProvider;
  readonly join: JoinRoom;
  readonly now?: () => number;
  /**
   * The worker's services, for the add-ons that listen (the coach) and the AI asking the live poll. Without them,
   * nobody is coached and no question pops up on its own.
   */
  readonly coach?: LiveFanoutDeps;
}

/** The calls one listener hears at once, at most: more wait for a pass with room. */
export const LISTENER_MAX_CALLS = 40;
/**
 * Calls looked at (and joined) in one pass, at most, newest first: a burst of calls starting doesn't all connect in
 * the same second, and a call LiveKit never said had closed isn't asked about every pass.
 */
const CHECKS_A_PASS = 10;
/** A call another listener has is left to it this long; one whose join failed is tried again after this. */
const REPLACED_WAIT_MS = 60_000;
const FAILED_WAIT_MS = 10_000;
/** A call with nobody in its room yet (everyone dropped for a moment) is looked at again after this. */
const EMPTY_WAIT_MS = 5_000;

interface Heard {
  readonly scope: TenantScope;
  readonly hearing: CallHearing;
  readonly room: ListenerRoom;
  readonly coach: CallCoach | null;
  readonly cues: CallPollCues | null;
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
    h.cues?.stop();
    await h.room.leave().catch(() => undefined);
    await h.hearing.stop();
    if (why === 'off') await deps.video.markAi(videoCallRoom(callId), false).catch(() => undefined);
    // The coaching is forgotten only when the AI notes went off; otherwise it's carried on or finished elsewhere.
    if (h.coach && why === 'off' && !(await aiNotesOn(h.scope, callId))) await h.coach.forget();
    else await h.coach?.pause();
    deps.log.info({ callId, why }, 'stopped hearing a video call');
  }

  /** Whether the call's AI notes are on now; on, when it can't tell. */
  async function aiNotesOn(scope: TenantScope, callId: string): Promise<boolean> {
    try {
      const [c] = await asWorker(deps.db, scope, (tx) =>
        rows<{ ai_notes: boolean }>(
          tx,
          sql`select ai_notes from app.video_calls where id = ${callId}`,
        ),
      );
      return c?.ai_notes ?? true;
    } catch {
      return true;
    }
  }

  async function join(callId: string, scope: TenantScope): Promise<void> {
    const room = videoCallRoom(callId);
    const there = await deps.video.whoIsIn(room);
    // Another listener is hearing it, or there's nobody to hear yet.
    if (there.listener) return void notBefore.set(callId, now() + REPLACED_WAIT_MS);
    if (!there.people) return void notBefore.set(callId, now() + EMPTY_WAIT_MS);
    // Set once the room is joined; nothing is heard before then.
    let inRoom: ListenerRoom | null = null;
    const log = deps.log.child({ callId });
    const coach = deps.coach ? new CallCoach(deps.coach, scope, callId, log, now) : null;
    const cues = deps.coach ? pollCues(deps.coach, scope, callId, log) : null;
    const hearing = new CallHearing(callId, {
      speech: deps.speech,
      log,
      now,
      keep: (lines) => keep(scope, callId, lines),
      onLine: (line) => {
        coach?.heard(line);
        cues?.heard(line);
      },
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
    heard.set(callId, { scope, hearing, room: inRoom, coach, cues });
    await deps.video
      .markAi(room, true)
      .catch((e: unknown) =>
        deps.log.warn(
          { callId, err: e instanceof Error ? e.message : String(e) },
          'couldn’t tell a video call the AI is on',
        ),
      );
    deps.log.info({ callId }, 'hearing a video call');
    await coach?.check();
  }

  /** The call's live poll matched to what the team says (poll-cues.ts), on the quick model calls think with. */
  function pollCues(
    services: LiveFanoutDeps,
    scope: TenantScope,
    callId: string,
    log: Logger,
  ): CallPollCues {
    const ai = { provider: services.voiceAi ?? services.ai.provider };
    return new CallPollCues(callId, {
      log,
      now,
      load: () => asWorker(deps.db, scope, (tx) => videoCallPollCueState(tx, callId)),
      ask: async (questions, lines) => {
        try {
          const { value } = await askStructured({ ...services, ai }, scope, {
            system: POLL_CUE_SYSTEM,
            context: pollCueContext(questions),
            messages: [
              {
                role: 'user',
                content: `What the team just said, oldest first:\n${lines.map((l) => `- ${l}`).join('\n')}`,
              },
            ],
            schema: POLL_CUE_MATCH_SCHEMA,
            zod: PollCueMatch,
            maxTokens: 300,
            usage: { source: 'meetings' },
          });
          return value;
        } catch (e) {
          if (
            e instanceof AiAskError &&
            (e.code === 'budget_reached' ||
              e.code === 'wallet_empty' ||
              e.code === 'ai_unavailable')
          )
            throw new PollCuesOutOfRoom(e.message);
          throw e;
        }
      },
      open: async (questionId) => {
        try {
          await executeCommand(
            deps.db,
            videoCallPollOpen,
            { workspaceId: scope.workspaceId, callId, questionId },
            systemActor(scope),
            workerMeta(),
          );
        } catch (e) {
          // Asked by the team a moment ago, skipped, or too soon after the last: the AI lets it go.
          if (e instanceof HfosError && e.status >= 400 && e.status < 500) return;
          throw e;
        }
      },
      offer: (message, to) =>
        deps.video.send(videoCallRoom(callId), VIDEO_CALL_POLLS_TOPIC, message, to),
    });
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
        .slice(0, Math.max(0, Math.min(CHECKS_A_PASS, LISTENER_MAX_CALLS - heard.size)));
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
          if (!(await h.hearing.tick())) return leave(callId, 'alone');
          // Nobody coached yet: someone who is may have come in.
          await h.coach?.check();
        }),
      );
    },

    async stop() {
      await Promise.all([...heard.keys()].map((callId) => leave(callId, 'stopping')));
    },
  };
}
