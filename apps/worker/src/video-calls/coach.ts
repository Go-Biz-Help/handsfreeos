/**
 * The Sales Coach in a HandsFreeOS video call (docs/video-calls.md, "The coach in the call"): what the AI's listener
 * (listener.ts) hears goes to the add-ons that listen (`liveCalls`), line by line, as a Zoom meeting's transcript
 * does (meetings/live.ts), so the coach's cards show beside the video, and its write-up and score come after.
 *
 * - **Who's coached.** The first person on the team in the call that an add-on listens for: the host first, then
 *   whoever joined first. Core's `video_call.coach` makes this stretch of the call a live meeting of theirs, so
 *   nobody claims it. While nobody in the call is coached, it's asked again every so often, in case someone joins.
 * - **Every line**, both sides, in order: the team's people are the team's side, everyone else the customer's.
 *   Lines kept before it began (a listener that restarted, a rep who joined late) come first, so the coach knows them.
 * - **AI notes off** ends it at once, forgotten: the add-ons keep nothing of it.
 * - **Otherwise it ends with the stretch.** A listener that leaves (alone, a deploy, another listener took over)
 *   leaves the live meeting live, so the next listener carries on with it. When the stretch is over, the job that
 *   keeps its words (handlers.ts) first finishes any coaching still live from the lines kept (`finishCoaching`): the
 *   add-ons hear the end, with everything that was said.
 */
import {
  executeCommand,
  liveMeetingEnded,
  sideOfKind,
  videoCallCoach,
  type VideoCallKind,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { Logger } from 'pino';
import { LiveFanout, type LiveFanoutDeps } from '../addons/live-fanout';
import type { LiveCall, LiveLine } from '../addons/types';
import { systemActor, workerMeta, type TenantScope } from '../services';
import { liveListenersFor } from '../telephony/live';
import type { HeardLine } from './hearing';

/** While nobody in a call is coached, it's asked again this often. */
export const COACH_AGAIN_MS = 15_000;
/** Lines heard before anyone was coached, held to hand on, at most: the oldest go first. */
const EARLY_MAX = 500;

type Side = LiveLine['speaker'];

interface Coaching {
  readonly fanout: LiveFanout;
  readonly liveMeetingId: string;
  /** When the live meeting started, epoch ms: each line's `atMs` counts from here. */
  readonly from: number;
}

interface KeptLine extends Record<string, unknown> {
  readonly line_key: string;
  readonly side: Side;
  readonly body: string;
  readonly language: string | null;
  readonly said_at: Date | string;
}

/** A line as the add-ons hear it: said at `saidAt`, in a live meeting that started at `from`. */
const liveLine = (
  speaker: Side,
  text: string,
  saidAt: Date | string,
  language: string | null,
  from: number,
): LiveLine => ({
  speaker,
  text,
  atMs: Math.max(0, new Date(saidAt).getTime() - from),
  language,
});

const ended = (deps: LiveFanoutDeps, scope: TenantScope, liveMeetingId: string) =>
  executeCommand(
    deps.db,
    liveMeetingEnded,
    { workspaceId: scope.workspaceId, liveMeetingId },
    systemActor(scope),
    workerMeta(),
  );

/** One call's coaching, on the listener hearing it. Everything it does runs in order, one thing at a time. */
export class CallCoach {
  private coaching: Coaching | null = null;
  private readonly lines: LiveLine[] = [];
  private readonly keys = new Set<string>();
  private readonly early: HeardLine[] = [];
  private readonly sides = new Map<string, Side>();
  private queue: Promise<void> = Promise.resolve();
  private askedAt: number | null = null;
  private over = false;

  constructor(
    private readonly deps: LiveFanoutDeps,
    private readonly scope: TenantScope,
    readonly callId: string,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /** The live meeting it's coaching, once someone in the call is coached. */
  get liveMeetingId(): string | null {
    return this.coaching?.liveMeetingId ?? null;
  }

  /** Asks whether anyone in the call is coached, and begins: at once, then every so often until someone is. */
  check(): Promise<void> {
    const t = this.now();
    if (this.over || this.coaching) return Promise.resolve();
    if (this.askedAt !== null && t - this.askedAt < COACH_AGAIN_MS) return Promise.resolve();
    this.askedAt = t;
    return this.then('begin', () => this.begin());
  }

  /** A line the listener just heard. */
  heard(l: HeardLine): void {
    if (this.over) return;
    void this.then('line', async () => {
      if (this.coaching) return this.add(this.coaching, l);
      this.early.push(l);
      if (this.early.length > EARLY_MAX) this.early.splice(0, this.early.length - EARLY_MAX);
    });
  }

  /** The call's AI notes were turned off: the add-ons hear it end, and keep nothing of it. */
  forget(): Promise<void> {
    this.over = true;
    return this.then('forget', async () => {
      const c = this.coaching;
      this.coaching = null;
      this.lines.length = 0;
      this.early.length = 0;
      if (!c) return;
      await c.fanout.end([], { forgotten: true });
      await ended(this.deps, this.scope, c.liveMeetingId);
      this.log.info({ liveMeetingId: c.liveMeetingId }, 'a video call’s coaching was forgotten');
    });
  }

  /** The listener left the call: the live meeting stays live, for the next listener or the stretch's end. */
  pause(): Promise<void> {
    this.over = true;
    return this.queue;
  }

  private then(what: string, fn: () => Promise<void>): Promise<void> {
    this.queue = this.queue
      .then(fn)
      .catch((e: unknown) =>
        this.log.warn(
          { callId: this.callId, what, err: e instanceof Error ? e.message : String(e) },
          'the coach stumbled on a video call',
        ),
      );
    return this.queue;
  }

  private async begin(): Promise<void> {
    if (this.over || this.coaching) return;
    const { deps, scope } = this;
    const team = await asWorker(deps.db, scope, (tx) =>
      rows<{ user_id: string }>(
        tx,
        sql`select p.user_id from app.video_call_people p
              join app.video_calls c on c.id = p.video_call_id
             where p.video_call_id = ${this.callId} and p.kind = 'team' and p.state = 'in'
               and p.user_id is not null
             order by (p.user_id = c.host_user_id) desc nulls last, p.joined_at nulls last, p.created_at`,
      ),
    );
    for (const userId of new Set(team.map((t) => t.user_id))) {
      const addons = await asWorker(deps.db, scope, (tx) =>
        liveListenersFor(tx, scope.workspaceId, userId, deps.modules, deps.catalog),
      );
      if (!addons.length) continue;
      const { output } = await executeCommand(
        deps.db,
        videoCallCoach,
        { workspaceId: scope.workspaceId, callId: this.callId, userId },
        systemActor(scope),
        workerMeta(),
      );
      if (!output.liveMeetingId || !output.startedAt || !output.stretch) continue;
      const call: LiveCall = {
        key: output.liveMeetingId,
        kind: 'meeting',
        callId: null,
        liveMeetingId: output.liveMeetingId,
        callSid: output.stretch,
        teamUserId: userId,
        direction: null,
        personId: output.personId,
        conversationId: output.conversationId,
      };
      const coaching: Coaching = {
        fanout: new LiveFanout(deps, scope, addons, call, this.log),
        liveMeetingId: output.liveMeetingId,
        from: new Date(output.startedAt).getTime(),
      };
      await this.catchUp(coaching);
      await coaching.fanout.start();
      this.coaching = coaching;
      this.log.info({ addons, liveMeetingId: coaching.liveMeetingId }, 'a video call is coached');
      return;
    }
  }

  /** What was said before it began: the lines kept so far, and those heard since, in order. */
  private async catchUp(c: Coaching): Promise<void> {
    const kept = await asWorker(this.deps.db, this.scope, (tx) =>
      rows<KeptLine>(
        tx,
        sql`select line_key, side, body, language, said_at from app.video_call_lines
             where video_call_id = ${this.callId} order by said_at, created_at`,
      ),
    );
    const before: { key: string; saidAt: number; line: LiveLine }[] = kept.map((l) => ({
      key: l.line_key,
      saidAt: new Date(l.said_at).getTime(),
      line: liveLine(l.side, l.body, l.said_at, l.language, c.from),
    }));
    for (const l of this.early.splice(0))
      before.push({
        key: l.key,
        saidAt: new Date(l.saidAt).getTime(),
        line: liveLine(await this.sideOf(l.personId), l.text, l.saidAt, l.language, c.from),
      });
    before.sort((a, b) => a.saidAt - b.saidAt);
    for (const b of before) {
      if (this.keys.has(b.key)) continue;
      this.keys.add(b.key);
      this.lines.push(b.line);
    }
  }

  private async add(c: Coaching, l: HeardLine): Promise<void> {
    if (this.keys.has(l.key)) return;
    this.keys.add(l.key);
    const line = liveLine(await this.sideOf(l.personId), l.text, l.saidAt, l.language, c.from);
    this.lines.push(line);
    // The add-ons hear each line in order, on their own: the coach thinking doesn't hold up the next line.
    void c.fanout.line(line, this.lines.slice());
  }

  /** Which side someone in the call is on, by their row of the call's people: read again for someone new. */
  private async sideOf(personRowId: string): Promise<Side> {
    const known = this.sides.get(personRowId);
    if (known) return known;
    const list = await asWorker(this.deps.db, this.scope, (tx) =>
      rows<{ id: string; kind: string }>(
        tx,
        sql`select id, kind from app.video_call_people where video_call_id = ${this.callId}`,
      ),
    );
    for (const p of list) this.sides.set(p.id, sideOfKind(p.kind as VideoCallKind));
    return this.sides.get(personRowId) ?? 'customer';
  }
}

interface OpenCoaching extends Record<string, unknown> {
  readonly id: string;
  readonly user_id: string;
  readonly person_id: string | null;
  readonly started_at: Date | string | null;
  readonly ai_notes: boolean;
  readonly conversation_id: string | null;
}

/**
 * A stretch of a call is over (the job that keeps its words, handlers.ts, before it takes the lines away): coaching
 * still live in it is finished from the lines kept, so the add-ons hear the end, with everything that was said.
 * Forgotten, when the call's AI notes are off by now. How many it finished.
 */
export async function finishCoaching(
  deps: LiveFanoutDeps,
  scope: TenantScope,
  stretch: { readonly callId: string; readonly stretch: string; readonly until: string },
): Promise<number> {
  const open = await asWorker(deps.db, scope, (tx) =>
    rows<OpenCoaching>(
      tx,
      sql`select m.id, m.user_id, m.person_id, m.started_at, c.ai_notes, c.conversation_id
            from app.live_meetings m
            join app.video_calls c on c.id = ${stretch.callId}
           where m.workspace_id = ${scope.workspaceId} and m.provider = 'handsfree'
             and m.meeting_uuid = ${stretch.stretch} and m.state = 'live'`,
    ),
  );
  if (!open.length) return 0;
  const kept = await asWorker(deps.db, scope, (tx) =>
    rows<KeptLine>(
      tx,
      sql`select line_key, side, body, language, said_at from app.video_call_lines
           where video_call_id = ${stretch.callId} and said_at <= ${stretch.until}::timestamptz
           order by said_at, created_at`,
    ),
  );
  for (const m of open) {
    const log = deps.log.child({ liveMeetingId: m.id });
    const addons = await asWorker(deps.db, scope, (tx) =>
      liveListenersFor(tx, scope.workspaceId, m.user_id, deps.modules, deps.catalog),
    );
    if (addons.length) {
      const from = m.started_at ? new Date(m.started_at).getTime() : Date.now();
      const forgotten = !m.ai_notes;
      const fanout = new LiveFanout(
        deps,
        scope,
        addons,
        {
          key: m.id,
          kind: 'meeting',
          callId: null,
          liveMeetingId: m.id,
          callSid: stretch.stretch,
          teamUserId: m.user_id,
          direction: null,
          personId: m.person_id,
          conversationId: m.conversation_id,
        },
        log,
      );
      // The coach takes the call up where it was (the same coached call), and hears it end.
      await fanout.start();
      await fanout.end(
        forgotten ? [] : kept.map((l) => liveLine(l.side, l.body, l.said_at, l.language, from)),
        { forgotten },
      );
    }
    await ended(deps, scope, m.id);
    log.info({ lines: kept.length }, 'a video call’s coaching finished with its stretch');
  }
  return open.length;
}
