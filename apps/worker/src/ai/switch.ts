/**
 * Which AI answers: Claude, or OpenAI while Claude is in trouble. Every AI feature's provider is a
 * FallbackProvider that asks this before each request (`route`), so one switch moves them all at once.
 *
 * Three things move it, and one row (`platform.ai_provider`) keeps every worker machine in step:
 *   - the check every 5 minutes (`aiProviderCheck`): Claude's status page showing anything but "operational"
 *     moves it to OpenAI, and two good checks in a row (the page and a test question both fine) bring it back;
 *   - Claude's own answers: TRIP_FAILURES failures within TRIP_WINDOW_MS move it to OpenAI at once, without
 *     waiting for the page, which is often slow to say so;
 *   - support's switch in /admin (`mode`), which pins it on either one whatever the checks say.
 * Each move to OpenAI and back emails AI_ALERT_EMAILS, while the mode is auto.
 */
import { AiProviderError, type AiProvider, type AiRoute, type AiSwitch } from '@hfos/ai';
import { asWorker, rows, sql, type Db } from '@hfos/db/client';
import type { Logger } from 'pino';
import { aiSwitchEmail } from '../emails/templates';
import type { JobHandler } from '../jobs';
import type { Mailer } from '../mailer';
import { errorMessage } from '../outbox';

export type AiAnswerer = 'claude' | 'openai';
export type AiMode = 'auto' | AiAnswerer;

/** Failures of Claude's that move everything to OpenAI, and the time they must fall within. */
export const TRIP_FAILURES = 3;
export const TRIP_WINDOW_MS = 2 * 60_000;
/** How often Claude's status page is read, and how many good checks in a row bring Claude back. */
export const CHECK_EVERY_MS = 5 * 60_000;
export const GOOD_CHECKS_TO_RETURN = 2;
/** How often each worker machine reads the row, for a switch another machine or support made. */
export const REFRESH_EVERY_MS = 30_000;

export const AI_PROVIDER_CHECK_JOB = 'ai.provider_check';
export const AI_PROVIDER_CHECK_KEY = 'ai:provider_check';

/** Claude's status page, and the part of it that is the API every feature here calls. */
export const CLAUDE_STATUS_URL = 'https://status.claude.com/api/v2/components.json';
const CLAUDE_API_COMPONENT = /^Claude API\b/;

export interface AiSwitchboardDeps {
  readonly db: Db;
  readonly log: Logger;
  readonly mailer: Mailer;
  /** Who is told when it moves (AI_ALERT_EMAILS). */
  readonly alertEmails: readonly string[];
  readonly webUrl: string;
  /** Claude, for the test question a check asks while the AI is on OpenAI. */
  readonly claude: AiProvider;
  /** Tests pass their own. */
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

type Row = {
  mode: AiMode;
  active: AiAnswerer;
  reason: 'status' | 'errors' | null;
  claude_status: string | null;
  good_checks: number;
  switched_at: Date | string | null;
};

export class AiSwitchboard implements AiSwitch {
  private mode: AiMode = 'auto';
  private active: AiAnswerer = 'claude';
  private failures: number[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: AiSwitchboardDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Who answers right now, as support and the checks left it. */
  answering(): AiAnswerer {
    return this.mode === 'auto' ? this.active : this.mode;
  }

  route(): AiRoute {
    if (this.mode === 'claude') return 'primary_only';
    return this.answering() === 'openai' ? 'backup' : 'primary';
  }

  primaryFailed(error: AiProviderError): void {
    const now = this.now();
    this.failures = [...this.failures.filter((t) => now - t < TRIP_WINDOW_MS), now];
    if (this.failures.length < TRIP_FAILURES || this.active === 'openai') return;
    this.failures = [];
    // At once on this machine; the row carries it to the others within REFRESH_EVERY_MS.
    this.active = 'openai';
    this.deps.log.warn(
      { code: error.code, status: error.status, failures: TRIP_FAILURES },
      'Claude kept failing: the AI moves to OpenAI',
    );
    void this.moveToOpenAi('errors', null).catch((e: unknown) =>
      this.deps.log.error({ err: errorMessage(e) }, 'couldn’t record the move to OpenAI'),
    );
  }

  primaryWorked(): void {
    if (this.failures.length) this.failures = [];
  }

  /** Reads the row: a move another machine made, or support's switch. */
  async refresh(): Promise<void> {
    const row = await this.read();
    if (!row) return;
    this.mode = row.mode;
    this.active = row.active;
  }

  /** Keeps reading the row until `stop`. The timer never holds the process open. */
  watch(everyMs = REFRESH_EVERY_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.refresh().catch((e: unknown) =>
        this.deps.log.warn({ err: errorMessage(e) }, 'couldn’t read which AI answers'),
      );
    }, everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One check: what Claude's status page says, and, while on OpenAI, whether Claude answers a test question.
   * Anything but "operational" moves it to OpenAI; two good checks in a row bring it back. A page that can't
   * be read changes nothing: it proves nothing either way.
   */
  async check(): Promise<{ status: string | null; answering: AiAnswerer }> {
    const status = await this.claudeStatus();
    const row = await this.read();
    if (!row) return { status, answering: this.answering() };
    if (status === null) {
      this.deps.log.warn('couldn’t read Claude’s status page: nothing changes this time');
      return { status, answering: this.answering() };
    }
    if (row.active === 'claude') {
      if (status !== 'operational') await this.moveToOpenAi('status', status);
      else await this.note(status, 0);
    } else if (status !== 'operational' || !(await this.claudeAnswers())) {
      await this.note(status, 0);
    } else if (row.good_checks + 1 >= GOOD_CHECKS_TO_RETURN) {
      await this.moveToClaude(status, row);
    } else await this.note(status, row.good_checks + 1);
    await this.refresh();
    return { status, answering: this.answering() };
  }

  private async read(): Promise<Row | null> {
    const [row] = await asWorker(this.deps.db, {}, (tx) =>
      rows<Row>(
        tx,
        sql`select mode, active, reason, claude_status, good_checks, switched_at
            from platform.ai_provider`,
      ),
    );
    return row ?? null;
  }

  private async note(status: string, goodChecks: number): Promise<void> {
    await asWorker(this.deps.db, {}, (tx) =>
      rows(
        tx,
        sql`update platform.ai_provider
            set claude_status = ${status}, good_checks = ${goodChecks}, checked_at = now()`,
      ),
    );
  }

  /** Only the machine whose update finds Claude still answering tells anyone, so it's said once. */
  private async moveToOpenAi(reason: 'status' | 'errors', status: string | null): Promise<void> {
    const [moved] = await asWorker(this.deps.db, {}, (tx) =>
      rows<{ mode: AiMode; claude_status: string | null }>(
        tx,
        sql`update platform.ai_provider
            set active = 'openai', reason = ${reason}, good_checks = 0, switched_at = now(),
                claude_status = coalesce(${status}, claude_status),
                checked_at = case when ${status}::text is null then checked_at else now() end
            where active = 'claude'
            returning mode, claude_status`,
      ),
    );
    this.active = 'openai';
    if (!moved) return;
    this.deps.log.warn({ reason, claudeStatus: moved.claude_status }, 'the AI moved to OpenAI');
    if (moved.mode === 'auto')
      await this.tell(
        aiSwitchEmail({
          to: 'openai',
          reason,
          claudeStatus: moved.claude_status,
          link: this.healthLink(),
        }),
      );
  }

  private async moveToClaude(status: string, row: Row): Promise<void> {
    const [moved] = await asWorker(this.deps.db, {}, (tx) =>
      rows<{ mode: AiMode }>(
        tx,
        sql`update platform.ai_provider
            set active = 'claude', reason = null, good_checks = 0, switched_at = now(),
                claude_status = ${status}, checked_at = now()
            where active = 'openai'
            returning mode`,
      ),
    );
    this.active = 'claude';
    this.failures = [];
    if (!moved) return;
    const since = row.switched_at ? new Date(row.switched_at).getTime() : null;
    const minutes = since === null ? null : Math.max(1, Math.round((this.now() - since) / 60_000));
    this.deps.log.info({ minutes }, 'the AI is back on Claude');
    if (moved.mode === 'auto')
      await this.tell(aiSwitchEmail({ to: 'claude', minutes, link: this.healthLink() }));
  }

  /** The Claude API's line on the status page (operational, degraded_performance, …), or null if unreadable. */
  private async claudeStatus(): Promise<string | null> {
    try {
      const res = await (this.deps.fetch ?? fetch)(CLAUDE_STATUS_URL, {
        signal: AbortSignal.timeout(10_000),
        headers: { accept: 'application/json' },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        components?: readonly { name?: unknown; status?: unknown }[];
      };
      const api = body.components?.find(
        (c) => typeof c.name === 'string' && CLAUDE_API_COMPONENT.test(c.name),
      );
      return typeof api?.status === 'string' ? api.status : null;
    } catch {
      return null;
    }
  }

  /** A one-word question to Claude: the page can say all is well while the answers still fail. */
  private async claudeAnswers(): Promise<boolean> {
    try {
      await this.deps.claude.stream(
        {
          system: 'Answer with one word.',
          messages: [{ role: 'user', content: 'Are you there?' }],
          maxTokens: 16,
        },
        { signal: AbortSignal.timeout(20_000) },
      );
      return true;
    } catch (e) {
      this.deps.log.warn(
        { err: e instanceof AiProviderError ? e.code : errorMessage(e) },
        'Claude didn’t answer the check’s test question',
      );
      return false;
    }
  }

  private healthLink(): string {
    return `${this.deps.webUrl.replace(/\/$/, '')}/admin/health`;
  }

  private async tell(mail: ReturnType<typeof aiSwitchEmail>): Promise<void> {
    for (const to of this.deps.alertEmails) {
      try {
        await this.deps.mailer.send({ to, ...mail });
      } catch (e) {
        this.deps.log.error({ err: errorMessage(e), to }, 'couldn’t email about the AI’s switch');
      }
    }
  }
}

/**
 * The check every 5 minutes. It never fails as a job: a check that couldn't finish is simply the next one's to
 * do, and a job that ran out of retries would stop the checks until the worker restarts.
 */
export const aiProviderCheck: JobHandler = async (ctx) => {
  const next = { rescheduleAt: new Date(ctx.now + CHECK_EVERY_MS) };
  // No backup (no OPENAI_API_KEY): nothing to check. The next start with one arms it again.
  if (!ctx.aiSwitch) return;
  try {
    const { status, answering } = await ctx.aiSwitch.check();
    ctx.log.debug({ claudeStatus: status, answering }, 'AI provider checked');
  } catch (e) {
    ctx.log.warn({ err: errorMessage(e) }, 'the AI provider check didn’t finish');
  }
  return next;
};
