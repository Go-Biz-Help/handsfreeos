/**
 * Live delivery to the website chats open on this worker machine (plan M7, "Delivery"). Each open stream
 * registers under its conversation. While any are open, the hub reads private.chat_feed once a second, across
 * every business (it can't know whose chats are open here until it looks), with a few seconds of overlap
 * because a commit can land a moment after a later one. It skips what it already handed on, and gives each open
 * chat its new messages and the AI teammate's "typing". A person's messages are read again in their business,
 * to tell a person from the business's own automatic messages and to mark their first one ("Dale joined").
 * Streams close cleanly on shutdown.
 */
import { asWorker, rows, sql, type Db } from '@hfos/db/client';
import type { Logger } from 'pino';
import type { TenantScope } from '../services';
import { cursorOf, messageView, type ChatMessageOut } from './store';

export type HubEvent =
  | { readonly type: 'message'; readonly message: ChatMessageOut; readonly cursor: string }
  | { readonly type: 'typing' };

/** One open chat window's stream. */
export interface HubClient {
  readonly conversationId: string;
  readonly scope: TenantScope;
  push(event: HubEvent): void;
  close(reason: 'shutdown'): void;
}

export interface ChatHubOptions {
  readonly db: Db;
  readonly log: Logger;
  /** How often the feed is read while chats are open (default 1 s). */
  readonly intervalMs?: number;
  /** How far each read reaches back past the last one (default 5 s). */
  readonly overlapMs?: number;
}

type FeedRow = {
  kind: string;
  conversation_id: string;
  message_id: string | null;
  body: string | null;
  sender: string;
  sender_name: string | null;
  occurred_at: Date | string;
};

/** The feed never returns anything older than 5 minutes, so what was handed on is remembered a little longer. */
const SEEN_MS = 6 * 60_000;

export class ChatHub {
  private readonly db: Db;
  private readonly log: Logger;
  private readonly intervalMs: number;
  private readonly overlapMs: number;
  private readonly open = new Map<string, Set<HubClient>>();
  /** What was handed on, and when. */
  private readonly seen = new Map<string, number>();
  /** The database's time the next read starts from (null: a few seconds before now). */
  private since: Date | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(opts: ChatHubOptions) {
    this.db = opts.db;
    this.log = opts.log;
    this.intervalMs = opts.intervalMs ?? 1_000;
    this.overlapMs = opts.overlapMs ?? 5_000;
  }

  /** Registers an open chat; returns how to take it off again. After shutdown it's closed at once. */
  add(client: HubClient): () => void {
    if (this.stopped) {
      client.close('shutdown');
      return () => undefined;
    }
    const list = this.open.get(client.conversationId) ?? new Set<HubClient>();
    list.add(client);
    this.open.set(client.conversationId, list);
    this.schedule();
    return () => this.remove(client);
  }

  /** Chats open on this machine. */
  get size(): number {
    let n = 0;
    for (const list of this.open.values()) n += list.size;
    return n;
  }

  /** Shutdown: every open chat is told and closed, and the feed stops. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const all = [...this.open.values()].flatMap((list) => [...list]);
    this.open.clear();
    for (const client of all) client.close('shutdown');
    await this.running;
  }

  /** One read of the feed, handed to the open chats. Never throws. */
  async tick(): Promise<void> {
    if (this.open.size === 0) {
      this.since = null;
      return;
    }
    try {
      const since = this.since?.toISOString() ?? null;
      const { now, feed } = await asWorker(this.db, {}, async (tx) => {
        const [t] = await rows<{ now: Date | string }>(tx, sql`select now() as now`);
        const list = await rows<FeedRow>(
          tx,
          sql`select kind, conversation_id, message_id, body, sender, sender_name, occurred_at
              from private.chat_feed(coalesce(${since}::timestamptz,
                now() - ${this.overlapMs}::float8 * interval '1 millisecond'))`,
        );
        return { now: new Date(t!.now), feed: list };
      });
      this.since = new Date(now.getTime() - this.overlapMs);
      for (const row of feed) await this.hand(row);
      const old = Date.now() - SEEN_MS;
      for (const [key, when] of this.seen) if (when < old) this.seen.delete(key);
    } catch (e) {
      this.log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'reading the chat feed failed',
      );
    }
  }

  private remove(client: HubClient): void {
    const list = this.open.get(client.conversationId);
    if (!list) return;
    list.delete(client);
    if (list.size === 0) this.open.delete(client.conversationId);
  }

  private schedule(): void {
    if (this.timer || this.running || this.stopped || this.open.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.running = this.tick().finally(() => {
        this.running = null;
        this.schedule();
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  private async hand(row: FeedRow): Promise<void> {
    const open = this.open.get(row.conversation_id);
    if (!open?.size) return;
    const key =
      row.kind === 'message'
        ? `message:${row.message_id}`
        : `${row.kind}:${row.conversation_id}:${new Date(row.occurred_at).getTime()}`;
    if (this.seen.has(key)) return;
    this.seen.set(key, Date.now());
    let event: HubEvent;
    if (row.kind === 'typing') event = { type: 'typing' };
    else if (row.kind !== 'message' || !row.message_id) return;
    else if (row.sender === 'person') {
      const [first] = open;
      const view = await asWorker(this.db, first!.scope, (tx) => messageView(tx, row.message_id!));
      if (!view) return;
      event = { type: 'message', ...view };
    } else
      event = {
        type: 'message',
        cursor: cursorOf(row.occurred_at, row.message_id),
        message: {
          id: row.message_id,
          from: row.sender === 'teammate' ? 'teammate' : 'visitor',
          name: row.sender === 'teammate' ? row.sender_name : null,
          body: row.body ?? '',
          at: new Date(row.occurred_at).toISOString(),
          joined: false,
        },
      };
    for (const client of [...(this.open.get(row.conversation_id) ?? [])]) client.push(event);
  }
}
