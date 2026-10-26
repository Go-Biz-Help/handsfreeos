import {
  AiProviderError,
  emptyUsage,
  type AiEffort,
  type AiErrorCode,
  type AiProvider,
  type AiRequest,
  type AiStreamOptions,
  type AiTurn,
  type AiUsage,
} from './types';

/**
 * Which provider answers: the usual one (and the backup for a request it fails), the usual one alone (someone
 * pinned it there), or the backup while the usual one is in trouble.
 */
export type AiRoute = 'primary' | 'primary_only' | 'backup';

/**
 * Decides who answers, for every FallbackProvider in the process, and hears how the usual provider is doing.
 * The worker's keeps it in step with the 5-minute status check and the admin's switch (apps/worker/src/ai/switch.ts).
 */
export interface AiSwitch {
  route(): AiRoute;
  /** A call to the usual provider failed in a way the backup can answer instead: it's down, overloaded or busy. */
  primaryFailed(error: AiProviderError): void;
  /** A call to the usual provider worked. */
  primaryWorked(): void;
}

/** Failures that say the provider is in trouble, not that the request was wrong: another provider can answer. */
export const FAILOVER_CODES: ReadonlySet<AiErrorCode> = new Set([
  'overloaded',
  'unavailable',
  'rate_limited',
]);

/**
 * Claude, with OpenAI behind it. Every request goes where the switch says. When a request to Claude fails before
 * anything of its answer arrived, the backup answers that same request at once, so nobody waits for the next
 * status check; once something has streamed, the failure goes to the caller as before (a second answer would
 * repeat the words already shown).
 */
export class FallbackProvider implements AiProvider {
  constructor(
    readonly primary: AiProvider,
    readonly backup: AiProvider,
    private readonly switcher: AiSwitch,
  ) {}

  private current(): AiProvider {
    return this.switcher.route() === 'backup' ? this.backup : this.primary;
  }

  get id(): string {
    return this.current().id;
  }

  get model(): string {
    return this.current().model;
  }

  get toolSearch(): boolean {
    return this.current().toolSearch === true;
  }

  async stream(request: AiRequest, options: AiStreamOptions = {}): Promise<AiTurn> {
    const route = this.switcher.route();
    if (route === 'backup') return answeredBy(this.backup, request, options);
    if (route === 'primary_only') return answeredBy(this.primary, request, options);
    let streamed = false;
    const seen = <A extends unknown[]>(fn?: (...args: A) => void) =>
      fn
        ? (...args: A) => {
            streamed = true;
            fn(...args);
          }
        : undefined;
    try {
      const turn = await answeredBy(this.primary, request, {
        ...options,
        onText: seen(options.onText),
        onToolInput: seen(options.onToolInput),
        onStarted: seen(options.onStarted),
      });
      this.switcher.primaryWorked();
      return turn;
    } catch (e) {
      if (!(e instanceof AiProviderError) || !FAILOVER_CODES.has(e.code)) throw e;
      this.switcher.primaryFailed(e);
      if (streamed || options.signal?.aborted) throw e;
      return answeredBy(this.backup, request, options);
    }
  }

  /** Whoever answers now; the backup, answering a request Claude failed, simply answers as it always does. */
  thinksHarderAt(effort: AiEffort): boolean {
    return this.current().thinksHarderAt?.(effort) === true;
  }

  /** Only a provider with a cache to fill warms; the backup's fills itself. */
  async warm(request: AiRequest): Promise<AiUsage> {
    const provider = this.current();
    return provider.warm ? provider.warm(request) : emptyUsage;
  }
}

async function answeredBy(
  provider: AiProvider,
  request: AiRequest,
  options: AiStreamOptions,
): Promise<AiTurn> {
  const turn = await provider.stream(request, options);
  return { ...turn, model: turn.model ?? provider.model };
}
