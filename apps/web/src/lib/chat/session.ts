'use client';
/**
 * What the chat window shows, kept outside React so the stream, the polling fallback, the human check and the page
 * around the window can all update it without stale closures (the window subscribes with useSyncExternalStore).
 *
 * VisitorChatSession talks to the public chat routes (lib/chat/client.ts). PreviewChatSession talks to the AI
 * teammate's test console (lib/chat/preview.ts), for the preview page, where nothing is created or sent.
 */
import { ApiError } from '../api/errors';
import { fieldErrors } from '../api/field-errors';
import {
  chatClient,
  type ChatClient,
  type ChatMessage,
  type ChatSender,
  type Gave,
  type HumanCheck,
  type StreamEvent,
} from './client';
import { previewReply, testConsoleMissing, type PreviewTurn } from './preview';

export type ChatPhase =
  | 'starting'
  | 'ready'
  /** The widget is paused. */
  | 'paused'
  /** This visitor, or their network, is blocked. */
  | 'blocked'
  /** The widget is gone, or this site isn't one of its. */
  | 'unavailable'
  /** The worker didn't answer. */
  | 'unreachable'
  /** Preview only: the teammate's test console isn't there yet. */
  | 'test_missing';

export interface LogItem {
  /** A message's id; `pending:<clientId>` while sending; `note:…` and `local:…` in the preview. */
  readonly id: string;
  /** `note`: a line from HandsFreeOS itself (the preview's "It would have booked Thu 10 AM"). */
  readonly from: ChatSender | 'note';
  readonly name: string | null;
  readonly body: string;
  readonly at: string;
  readonly joined: boolean;
  readonly status?: 'sending' | 'failed';
  readonly clientId?: string;
  readonly error?: string;
}

export interface DetailsValues {
  readonly name: string;
  readonly phone: string;
  readonly email: string;
  readonly smsConsent: boolean;
  /** The separate box for offers, when the business sends them. */
  readonly offersConsent?: boolean;
  /** The "OK to call" box, when the business asks for one. */
  readonly callConsent?: boolean;
  /** The away form's "How can we help?". */
  readonly message: string;
}

/** Problems by field (name, phone, email, message), or `form` for the whole form. */
export type FieldProblems = Record<string, string>;

export interface ChatSnapshot {
  readonly phase: ChatPhase;
  readonly items: readonly LogItem[];
  /** Who is typing (the AI teammate), or null. */
  readonly typing: string | null;
  /** A problem that isn't about one message ("You're sending quickly"). */
  readonly notice: string | null;
  readonly gave: Gave;
  /** The visitor has written: the chat exists. */
  readonly started: boolean;
  readonly humanCheck: HumanCheck | null;
  /** Bumped after each Turnstile token is spent, so the widget makes a fresh one. */
  readonly humanReset: number;
}

export const INITIAL_SNAPSHOT: ChatSnapshot = {
  phase: 'starting',
  items: [],
  typing: null,
  notice: null,
  gave: { name: false, phone: false, email: false },
  started: false,
  humanCheck: null,
  humanReset: 0,
};

const TYPING_MS = 8_000;
const HEARTBEAT_MS = 60_000;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** A cursor's time (microseconds): cursors look like `<micros>.<message id>`. */
const micros = (cursor: string | null) => (cursor ? Number(cursor.split('.')[0]) || 0 : 0);
const byTime = (a: LogItem, b: LogItem) =>
  a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const ruleOf = (e: unknown) => (e instanceof ApiError ? e.rule : undefined);
const now = () => new Date().toISOString();

/** A per-message id the worker uses to land a resend once (crypto.randomUUID needs a secure page). */
function newClientId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

let localCount = 0;
const localId = (kind: string) => `${kind}:${Date.now()}:${++localCount}`;

function failure(e: unknown): string {
  const rule = ruleOf(e);
  if (rule === 'rate_limited') return 'You’re sending quickly. Wait a moment, then try again.';
  if (e instanceof ApiError && e.code === 'unreachable') return 'Not sent. Check your connection.';
  return e instanceof Error && e.message ? e.message : 'Not sent. Try again.';
}

export abstract class ChatSession {
  private snap: ChatSnapshot = INITIAL_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private running = false;
  private detachTimer: ReturnType<typeof setTimeout> | undefined;
  /** The window is showing: the page around it opened it and hasn't closed it. */
  protected isOpen = true;
  /** Told how many replies arrived while the window was closed (the loader's badge); a count only. */
  onUnread: (count: number) => void = () => {};
  /** The honeypot field's value: always empty from a person. */
  honeypot: () => string = () => '';

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly snapshot = (): ChatSnapshot => this.snap;

  protected get state(): ChatSnapshot {
    return this.snap;
  }

  protected set(patch: Partial<ChatSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const listener of this.listeners) listener();
  }

  /**
   * Starts once. React's development double-mount detaches and attaches again at once: the stop waits a tick, so
   * that doesn't start a second visit.
   */
  attach(): void {
    clearTimeout(this.detachTimer);
    if (this.running) return;
    this.running = true;
    this.start();
  }

  detach(): void {
    this.detachTimer = setTimeout(() => {
      this.running = false;
      this.stop();
    }, 0);
  }

  protected abstract start(): void;
  protected abstract stop(): void;
  abstract send(body: string): void;
  abstract retry(id: string): void;
  abstract identify(values: DetailsValues): Promise<FieldProblems | null>;

  /** The page opened the window (again), now on `path`; or the window was closed. */
  setOpen(open: boolean, _path?: string | null): void {
    this.isOpen = open;
  }

  /** Turnstile's one-time token; null when it expired or failed. */
  humanToken(_token: string | null): void {}

  /** Try again after the chat couldn't be reached. */
  reload(): void {}
}

/** A real visitor's chat, over the public chat routes. */
export class VisitorChatSession extends ChatSession {
  private readonly client: ChatClient;
  private cursor: string | null = null;
  private readonly ids = new Set<string>();
  private stream: AbortController | null = null;
  private stopped = false;
  private path: string | null;
  private typingTimer: ReturnType<typeof setTimeout> | undefined;
  private readTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private beat: ReturnType<typeof setInterval> | undefined;
  private spare: string | null = null;
  private waiters: ((token: string | null) => void)[] = [];
  private lastRead: string | null = null;
  private unread = 0;

  constructor(
    private readonly o: {
      readonly key: string;
      /** The page around the window (checked by the browser's frame rule). */
      readonly origin: string;
      readonly path: string | null;
      readonly teammateName: string | null;
      /** Turnstile's site key when the worker doesn't name one. */
      readonly siteKey: string | null;
    },
  ) {
    super();
    this.client = chatClient(o.key);
    this.path = o.path;
  }

  private readonly onVisibility = () => {
    if (document.visibilityState === 'visible') this.scheduleRead();
  };

  protected start(): void {
    this.stopped = false;
    void this.begin();
    this.beat = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  protected stop(): void {
    this.stopped = true;
    this.stream?.abort();
    this.stream = null;
    clearTimeout(this.typingTimer);
    clearTimeout(this.readTimer);
    clearTimeout(this.retryTimer);
    clearInterval(this.beat);
    document.removeEventListener('visibilitychange', this.onVisibility);
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }

  override reload(): void {
    this.set({ phase: 'starting', notice: null });
    void this.begin();
  }

  /** Starts a visit, or picks the last one up: its messages, and the stream when they've written before. */
  private async begin(): Promise<void> {
    clearTimeout(this.retryTimer);
    try {
      const s = await this.client.start(this.o.origin, this.path);
      if (this.stopped) return;
      this.cursor = s.cursor;
      this.merge(s.messages, true);
      this.set({
        phase: 'ready',
        gave: s.gave,
        humanCheck: s.humanCheck,
        started: s.chatStarted,
        notice: null,
      });
      if (s.typing) this.showTyping(this.o.teammateName);
      if (s.chatStarted) this.listen();
    } catch (e) {
      if (this.stopped || this.ended(e)) return;
      const rule = ruleOf(e);
      if (rule === 'rate_limited' || rule === 'network_flood') {
        this.set({ notice: failure(e) });
        this.retryTimer = setTimeout(() => void this.begin(), 15_000);
        return;
      }
      this.set({ phase: 'unreachable' });
    }
  }

  /** Refusals that end the chat for now; true when it was one. */
  private ended(e: unknown): boolean {
    const rule = ruleOf(e);
    const phase: ChatPhase | null =
      rule === 'widget_paused'
        ? 'paused'
        : rule === 'visitor_blocked' || rule === 'network_blocked'
          ? 'blocked'
          : rule === 'origin_not_allowed' || rule === 'widget_not_found'
            ? 'unavailable'
            : null;
    if (!phase) return false;
    this.stream?.abort();
    this.stream = null;
    this.set({ phase, typing: null });
    return true;
  }

  /** The token wasn't recognised: a new visit, then `then` once it's ready. */
  private async restart(): Promise<boolean> {
    this.client.forget();
    this.stream?.abort();
    this.stream = null;
    await this.begin();
    return !this.stopped && this.state.phase === 'ready';
  }

  /**
   * Live replies: the stream, reconnecting with Last-Event-ID after each ending (every 5 minutes), and polling to
   * catch up whenever it drops. While the stream keeps failing, the polls carry on, further apart each time.
   */
  private listen(): void {
    if (this.stream || this.stopped) return;
    const ctrl = new AbortController();
    this.stream = ctrl;
    void (async () => {
      let wait = 0;
      while (!this.stopped && !ctrl.signal.aborted) {
        const opened = Date.now();
        let bye: 'expired' | 'shutdown' | null = null;
        try {
          await this.client.stream(
            this.cursor,
            (event) => {
              if (event.type === 'bye') bye = event.reason;
              this.onEvent(event);
            },
            ctrl.signal,
          );
        } catch (e) {
          const rule = ruleOf(e);
          if (rule === 'chat_not_started') break;
          if (rule === 'chat_not_found') {
            if (this.stream === ctrl) this.stream = null;
            void this.restart();
            return;
          }
          if (this.ended(e)) return;
        }
        if (this.stopped || ctrl.signal.aborted) break;
        await this.catchUp();
        const lasted = Date.now() - opened > 30_000;
        wait =
          bye === 'expired' || (lasted && !bye)
            ? 0
            : bye === 'shutdown'
              ? 3_000
              : Math.min(30_000, Math.max(3_000, wait * 2));
        if (wait) await sleep(wait, ctrl.signal);
      }
      if (this.stream === ctrl) this.stream = null;
    })();
  }

  private onEvent(event: StreamEvent): void {
    if (event.type === 'ready') void this.catchUp();
    else if (event.type === 'message') {
      this.advance(event.cursor);
      this.merge([event.message]);
    } else if (event.type === 'typing') this.showTyping(event.name ?? this.o.teammateName);
  }

  /** Anything since the cursor (the polling fallback, and the gap before a stream opens). */
  private async catchUp(): Promise<void> {
    try {
      const polled = await this.client.poll(this.cursor);
      if (this.stopped) return;
      this.advance(polled.cursor);
      this.merge(polled.messages);
      if (polled.typing && !this.state.typing) this.showTyping(this.o.teammateName);
    } catch (e) {
      if (ruleOf(e) === 'chat_not_found') void this.restart();
      else this.ended(e);
    }
  }

  private advance(cursor: string | null): void {
    if (cursor && micros(cursor) >= micros(this.cursor)) this.cursor = cursor;
  }

  /** New messages in time order, one copy per id; replies count as unread while the window is closed. */
  private merge(list: readonly ChatMessage[], history = false): void {
    const fresh = list.filter((m) => !this.ids.has(m.id));
    if (!fresh.length) return;
    for (const m of fresh) this.ids.add(m.id);
    let pending = this.state.items.filter((i) => i.status);
    // The visitor's own messages come back on the stream too: each replaces its copy that's still sending.
    for (const m of fresh) {
      if (m.from !== 'visitor') continue;
      const i = pending.findIndex((p) => p.status === 'sending' && p.body === m.body.trim());
      if (i >= 0) pending = pending.filter((_, j) => j !== i);
    }
    const settled = [...this.state.items.filter((i) => !i.status), ...fresh].sort(byTime);
    const replies = fresh.filter((m) => m.from !== 'visitor');
    const patch: { items: LogItem[]; typing?: null } = { items: [...settled, ...pending] };
    if (replies.some((m) => m.from === 'teammate')) {
      clearTimeout(this.typingTimer);
      patch.typing = null;
    }
    this.set(patch);
    if (!replies.length || history) return;
    if (this.isOpen && document.visibilityState === 'visible') this.scheduleRead();
    else {
      this.unread += replies.length;
      this.onUnread(this.unread);
    }
  }

  private showTyping(name: string | null): void {
    clearTimeout(this.typingTimer);
    this.set({ typing: name ?? 'The team' });
    this.typingTimer = setTimeout(() => this.set({ typing: null }), TYPING_MS);
  }

  send(body: string): void {
    const text = body.trim();
    if (!text || this.state.phase !== 'ready') return;
    const clientId = newClientId();
    const item: LogItem = {
      id: `pending:${clientId}`,
      from: 'visitor',
      name: null,
      body: text,
      at: now(),
      joined: false,
      status: 'sending',
      clientId,
    };
    this.set({ items: [...this.state.items, item], notice: null });
    void this.deliver(item);
  }

  retry(id: string): void {
    const item = this.state.items.find((i) => i.id === id && i.status === 'failed');
    if (!item) return;
    const again: LogItem = { ...item, status: 'sending', error: undefined };
    this.replace(id, again);
    void this.deliver(again);
  }

  private async deliver(item: LogItem, attempt = 0): Promise<void> {
    const token = this.state.humanCheck?.required ? await this.checkToken() : null;
    if (this.stopped) return;
    const honeypot = this.honeypot();
    try {
      const out = await this.client.send({
        body: item.body,
        clientId: item.clientId!,
        ...(this.path ? { pagePath: this.path } : {}),
        ...(token ? { turnstileToken: token } : {}),
        ...(honeypot ? { honeypot } : {}),
      });
      if (this.stopped) return;
      this.drop(item.id);
      if (out.message) this.merge([out.message]);
      this.advance(out.cursor);
      this.set({ humanCheck: out.humanCheck, started: true });
      this.listen();
    } catch (e) {
      if (this.stopped) return;
      const rule = ruleOf(e);
      if (
        (rule === 'bot_check_required' || rule === 'bot_check_failed') &&
        attempt === 0 &&
        this.siteKey()
      ) {
        // Once more, with the human check this time (each token works once).
        this.set({
          humanCheck: { siteKey: this.state.humanCheck?.siteKey ?? null, required: true },
        });
        return this.deliver(item, attempt + 1);
      }
      if (rule === 'chat_not_found' && attempt === 0 && (await this.restart()))
        return this.deliver(item, attempt + 1);
      if (!this.ended(e)) this.fail(item.id, failure(e));
      else this.fail(item.id, 'Not sent.');
    } finally {
      if (token) this.set({ humanReset: this.state.humanReset + 1 });
    }
  }

  async identify(values: DetailsValues): Promise<FieldProblems | null> {
    const token = this.state.humanCheck?.required ? await this.checkToken() : null;
    const name = values.name.trim();
    const phone = values.phone.trim();
    const email = values.email.trim();
    const honeypot = this.honeypot();
    try {
      const gave = await this.client.identify({
        ...(name ? { name } : {}),
        ...(phone ? { phone } : {}),
        ...(email ? { email } : {}),
        smsConsent: !!phone && values.smsConsent,
        offersConsent: !!phone && !!values.offersConsent,
        callConsent: !!phone && !!values.callConsent,
        ...(token ? { turnstileToken: token } : {}),
        ...(honeypot ? { honeypot } : {}),
      });
      this.set({ gave });
      return null;
    } catch (e) {
      const rule = ruleOf(e);
      if (rule === 'bot_check_required' || rule === 'bot_check_failed') {
        this.set({
          humanCheck: { siteKey: this.state.humanCheck?.siteKey ?? null, required: true },
        });
        return {
          form: 'We need to check you’re a person first. Finish the check in this chat, then send again.',
        };
      }
      if (ruleOf(e) === 'chat_not_found') await this.restart();
      const fields = fieldErrors(e);
      return Object.keys(fields).length ? fields : { form: failure(e) };
    } finally {
      if (token) this.set({ humanReset: this.state.humanReset + 1 });
    }
  }

  private siteKey(): string | null {
    return this.state.humanCheck?.siteKey ?? this.o.siteKey;
  }

  /** Turnstile's next token: one it already made, or the next it makes (null after 20 seconds, or without a key). */
  private checkToken(): Promise<string | null> {
    if (!this.siteKey()) return Promise.resolve(null);
    if (this.spare) {
      const token = this.spare;
      this.spare = null;
      return Promise.resolve(token);
    }
    return new Promise((resolve) => {
      const done = (token: string | null) => {
        clearTimeout(timer);
        resolve(token);
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve(null);
      }, 20_000);
      this.waiters.push(done);
    });
  }

  override humanToken(token: string | null): void {
    if (!token) {
      this.spare = null;
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) waiter(token);
    else this.spare = token;
  }

  override setOpen(open: boolean, path?: string | null): void {
    super.setOpen(open);
    if (path && path.startsWith('/')) this.path = path.slice(0, 2000);
    if (!open) return;
    this.unread = 0;
    this.onUnread(0);
    this.scheduleRead();
  }

  /** "Seen": the newest reply, once the window is open and on screen. */
  private scheduleRead(): void {
    clearTimeout(this.readTimer);
    this.readTimer = setTimeout(() => void this.markRead(), 700);
  }

  private async markRead(): Promise<void> {
    if (this.stopped || !this.isOpen || document.visibilityState !== 'visible') return;
    const last = [...this.state.items]
      .reverse()
      .find((i) => !i.status && i.from !== 'visitor' && i.from !== 'note');
    if (!last || last.id === this.lastRead) return;
    this.lastRead = last.id;
    try {
      await this.client.read(last.id);
    } catch {
      this.lastRead = null;
    }
  }

  /** "On the site now", and the install check. */
  private async heartbeat(): Promise<void> {
    if (this.stopped || this.state.phase !== 'ready' || !this.client.hasToken()) return;
    if (document.visibilityState !== 'visible') return;
    try {
      await this.client.heartbeat(this.o.origin, this.path);
    } catch {
      // The next one tries again.
    }
  }

  private replace(id: string, next: LogItem): void {
    this.set({ items: this.state.items.map((i) => (i.id === id ? next : i)) });
  }

  private drop(id: string): void {
    this.set({ items: this.state.items.filter((i) => i.id !== id) });
  }

  private fail(id: string, error: string): void {
    const item = this.state.items.find((i) => i.id === id);
    if (item) this.replace(id, { ...item, status: 'failed', error });
  }
}

/**
 * The preview page's chat: the teammate answers through its test console, and nothing is created or sent. A change
 * it would make shows as a note.
 */
export class PreviewChatSession extends ChatSession {
  private run: AbortController | null = null;

  constructor(
    private readonly o: {
      readonly workspaceId: string;
      readonly teammateName: string | null;
      /** Nobody is answering right now: a real chat would only land in the inbox. */
      readonly away: boolean;
    },
  ) {
    super();
  }

  protected start(): void {
    this.set({ phase: 'ready' });
  }

  protected stop(): void {
    this.run?.abort();
  }

  retry(): void {}

  send(body: string): void {
    void this.ask(body.trim());
  }

  async identify(values: DetailsValues): Promise<FieldProblems | null> {
    this.set({
      gave: {
        name: !!values.name.trim(),
        phone: !!values.phone.trim(),
        email: !!values.email.trim(),
      },
    });
    this.note('In a real chat, these details go to your inbox.');
    return null;
  }

  private push(item: LogItem): void {
    this.set({ items: [...this.state.items, item] });
  }

  private note(text: string): void {
    this.push({
      id: localId('note'),
      from: 'note',
      name: null,
      body: text,
      at: now(),
      joined: false,
    });
  }

  private async ask(text: string): Promise<void> {
    if (!text || this.state.phase !== 'ready') return;
    this.push({
      id: localId('local'),
      from: 'visitor',
      name: null,
      body: text,
      at: now(),
      joined: false,
    });
    this.set({ started: true });
    const name = this.o.teammateName;
    if (this.o.away || !name) {
      this.note(
        this.o.away
          ? 'Nobody is answering right now, so a real chat would land in your inbox for later.'
          : 'Only your team answers this chat. A real one would land in your inbox.',
      );
      return;
    }
    this.run?.abort();
    const ctrl = new AbortController();
    this.run = ctrl;
    const turns: PreviewTurn[] = this.state.items.flatMap((i): PreviewTurn[] =>
      i.from === 'visitor'
        ? [{ from: 'customer', text: i.body }]
        : i.from === 'teammate'
          ? [{ from: 'teammate', text: i.body }]
          : [],
    );
    const replyId = localId('local');
    let written = '';
    let shown = false;
    const show = (body: string) => {
      if (!shown) {
        shown = true;
        this.push({ id: replyId, from: 'teammate', name, body, at: now(), joined: false });
      } else
        this.set({ items: this.state.items.map((i) => (i.id === replyId ? { ...i, body } : i)) });
      this.set({ typing: null });
    };
    this.set({ typing: name });
    try {
      await previewReply(
        this.o.workspaceId,
        turns,
        (event) => {
          if (ctrl.signal.aborted) return;
          if (event.type === 'delta') {
            written += event.text;
            show(written);
          } else if (event.type === 'would')
            this.note(`It would have ${event.summary}. Nothing changes in a preview.`);
          else if (event.type === 'done') {
            const reply = event.reply ?? (written || null);
            if (reply) show(reply);
            else if (event.outcome === 'handed_off')
              this.note('Here it would hand the chat to your team.');
            else this.note('It wouldn’t reply to this.');
            if (reply && event.draft)
              this.note('In training, this reply waits for an OK before it’s sent.');
          } else if (event.type === 'error') this.note(event.message);
        },
        ctrl.signal,
      );
    } catch (e) {
      if (testConsoleMissing(e)) this.set({ phase: 'test_missing' });
      else this.note(e instanceof Error && e.message ? e.message : 'The test stopped. Try again.');
    } finally {
      if (this.run === ctrl) this.run = null;
      this.set({ typing: null });
    }
  }
}
