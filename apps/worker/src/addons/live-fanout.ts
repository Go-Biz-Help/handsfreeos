/**
 * Handing what's heard live to the add-ons that listen (`liveCalls`, like Sales Coach): a phone call
 * (telephony/live.ts), a Zoom meeting (meetings/live.ts) or a HandsFreeOS video call (video-calls/coach.ts). Each add-on hears the start, every finished line and the
 * end, in order, as the system acting for it, so its commands are refused the moment it's turned off. An add-on that
 * fails a line is logged and hears the next one; nothing it does holds up what's being heard.
 */
import { ADDON_CATALOG, type AddonManifest } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { Logger } from 'pino';
import { workerMeta, type TenantScope, type WorkerServices } from '../services';
import { addonScope } from './context';
import { ADDON_WORKER_MODULES } from './modules';
import type { AddonWorkerModule, LiveCall, LiveEnd, LiveLine } from './types';

export interface LiveFanoutDeps extends WorkerServices {
  readonly modules?: readonly AddonWorkerModule[];
  readonly catalog?: readonly AddonManifest[];
}

type Hooks = NonNullable<AddonWorkerModule['liveCalls']>;

export class LiveFanout {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly generations = new Map<string, number>();

  constructor(
    private readonly deps: LiveFanoutDeps,
    private readonly scope: TenantScope,
    /** The add-ons that hear it. */
    private readonly addons: readonly string[],
    readonly call: LiveCall,
    private readonly log: Logger,
  ) {}

  private modules(): { module: AddonWorkerModule; manifest: AddonManifest }[] {
    const modules = this.deps.modules ?? ADDON_WORKER_MODULES;
    const catalog = this.deps.catalog ?? ADDON_CATALOG;
    return this.addons.flatMap((id) => {
      const module = modules.find((m) => m.manifest.id === id);
      const manifest = catalog.find((m) => m.id === id);
      return module?.liveCalls && manifest ? [{ module, manifest }] : [];
    });
  }

  /** Runs `fn` for each add-on that hears it, after whatever it's still doing with the line before. */
  private each(
    what: string,
    fn: (hooks: Hooks, ctx: ReturnType<typeof addonScope>) => Promise<void>,
  ): Promise<void> {
    const runs = this.modules().map(({ module, manifest }) => {
      const before = this.queues.get(manifest.id) ?? Promise.resolve();
      const next = before.then(async () => {
        const generation = await this.generationOf(manifest.id);
        const ctx = addonScope(this.deps, manifest, this.scope, generation, workerMeta());
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

  /** The generation installed in the business, read once per add-on for the call. */
  private async generationOf(addonId: string): Promise<number> {
    const known = this.generations.get(addonId);
    if (known !== undefined) return known;
    const [row] = await asWorker(this.deps.db, this.scope, (tx) =>
      rows<{ generation: number | null }>(
        tx,
        sql`select generation from app.addon_installations
             where workspace_id = ${this.scope.workspaceId} and addon_id = ${addonId}`,
      ),
    );
    const generation = row?.generation ?? 1;
    this.generations.set(addonId, generation);
    return generation;
  }

  /** It started being heard. */
  start(): Promise<void> {
    return this.each('start', (hooks, ctx) => hooks.onStart?.(ctx, this.call) ?? Promise.resolve());
  }

  /** `line` was just finished; `all` is everything said so far, it included. */
  line(line: LiveLine, all: readonly LiveLine[]): Promise<void> {
    return this.each('line', (hooks, ctx) => hooks.onLine(ctx, this.call, line, all));
  }

  /** It ended: everything that was said, and how it ended. */
  end(all: readonly LiveLine[], how: LiveEnd = {}): Promise<void> {
    return this.each(
      'end',
      (hooks, ctx) => hooks.onEnd?.(ctx, this.call, all, how) ?? Promise.resolve(),
    );
  }
}
