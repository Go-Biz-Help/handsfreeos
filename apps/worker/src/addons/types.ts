/**
 * An add-on's worker half (docs/addon-architecture.md): what it does when something happens in a business, its own
 * jobs, and what it does as it arrives, turns on or off and leaves. Each is registered in ./modules.ts beside its
 * manifest. The runners hand it work only while it is on in that business, and everything it does through the
 * kernel is done as the system acting for it: refused the moment it is off, and marked as its own in history.
 */
import type { AddonManifest, RequestMeta, SystemActor } from '@hfos/core/server';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { HttpDeps } from '../http/common';
import type { ConnectionTester } from './connections';
import type { AddonOAuthProvider } from './sign-ins';
import type { AddonWebhookReceiver } from './webhooks';
import type { Tx } from '@hfos/db/client';
import type { EventRow } from '../handlers/types';
import type { JobResult, JobRow } from '../jobs';
import type { TenantScope, WorkerServices } from '../services';

/** Where an add-on's code runs: one business, as the system acting for the add-on. */
export interface AddonScopeContext extends WorkerServices {
  readonly manifest: AddonManifest;
  readonly scope: TenantScope;
  /** The system acting for this add-on: pass it to executeCommand, never a bare system actor. */
  readonly actor: SystemActor;
  /** The generation installed now. Jobs it queues carry it (scheduleAddonJob), so a reinstall leaves old ones behind. */
  readonly generation: number;
  /** Request metadata chained to whatever caused this. */
  readonly meta: RequestMeta;
}

/** Something happened that the add-on subscribes to (its manifest's `events.consumes`). */
export interface AddonEventContext extends AddonScopeContext {
  readonly event: EventRow;
  /** 1 on the first try. */
  readonly attempt: number;
}
export type AddonSubscriber = (ctx: AddonEventContext) => Promise<void>;

/** One of the add-on's own jobs (its manifest's `jobs`), queued with scheduleAddonJob. */
export interface AddonJobContext extends AddonScopeContext {
  readonly job: JobRow;
  readonly attempt: number;
  /** The moment the job runs as of. */
  readonly now: number;
}
export type AddonJobHandler = (ctx: AddonJobContext) => Promise<JobResult>;

/**
 * One step of the add-on's data, from the version before it to its own. It runs in the transaction that records
 * the new version, while the add-on is arriving, so a step that fails leaves the data where it was and is run again.
 */
export type AddonDataMigration = (ctx: AddonScopeContext & { readonly tx: Tx }) => Promise<void>;

/** Something the add-on made at a provider (app.addon_resources), to be let go of when it's uninstalled. */
export interface AddonResource {
  readonly id: string;
  /** `<id>.<kind>`, one of its manifest's `resources`. */
  readonly kind: string;
  readonly externalId: string;
  readonly label: string | null;
}

export interface AddonWorkerModule {
  readonly manifest: AddonManifest;
  /** Event type → what the add-on does when it happens. Each is one its manifest consumes. */
  readonly subscribers?: Readonly<Record<string, AddonSubscriber>>;
  /** Job kind (`<id>.…`, in its manifest's `jobs`) → what the job does. */
  readonly jobs?: Readonly<Record<string, AddonJobHandler>>;
  /** Data version → the step that brings a business's data up to it (2, 3, … up to the manifest's dataVersion). */
  readonly dataMigrations?: Readonly<Record<number, AddonDataMigration>>;
  /** A business's settings saved in an older shape, brought up to the manifest's settings version. */
  readonly migrateSettings?: (
    settings: Record<string, unknown>,
    fromVersion: number,
  ) => Record<string, unknown>;
  /**
   * The lifecycle, each called by the reconcile job (./reconcile.ts) and each safe to run again: a hook that
   * throws is retried, and the move isn't finished until it succeeds. `onInstall` runs once per installation (a
   * reinstall is a new one), then `onEnable`; `onEnable` runs every time it goes back on, and is where recurring
   * jobs are armed again — from now: nothing that came due while it was off runs late (the owner's decision,
   * 2026-09-28). `onDisable` and `onUninstall` run after its queued work is cancelled and its records hidden.
   */
  readonly onInstall?: (ctx: AddonScopeContext) => Promise<void>;
  readonly onEnable?: (ctx: AddonScopeContext) => Promise<void>;
  readonly onDisable?: (ctx: AddonScopeContext) => Promise<void>;
  readonly onUninstall?: (ctx: AddonScopeContext) => Promise<void>;
  /** Lets go of one thing it holds outside HandsFreeOS. Must be safe to repeat (already gone is fine). */
  readonly releaseResource?: (ctx: AddonScopeContext, resource: AddonResource) => Promise<void>;
  /**
   * Connector key → service → how to try a key a business pasted (its manifest's `connectors`, for each service
   * that connects by key). Nothing is kept until it works.
   */
  readonly connectors?: Readonly<Record<string, Readonly<Record<string, ConnectionTester>>>>;
  /**
   * Connector key → service → how to read the service's updates (its manifest's `connectors`, for each service with
   * `webhooks`): checked and kept once by the worker's route, then handed here one at a time.
   */
  readonly webhooks?: Readonly<Record<string, Readonly<Record<string, AddonWebhookReceiver>>>>;
  /**
   * Connector key → service → how a business signs in to it (its manifest's `connectors`, for each service with
   * `oauth`): the sign-in page, the code's swap for tokens, and their renewal.
   */
  readonly oauth?: Readonly<Record<string, Readonly<Record<string, AddonOAuthProvider>>>>;
  /**
   * Action name (`<id>.…`) → something a person needs from a connected service right now, which only the worker can
   * ask (http/addon-actions.ts). Each asks one of the add-on's permissions.
   */
  readonly actions?: Readonly<Record<string, AddonWorkerAction>>;
  /**
   * Sealed value (its manifest's `sealed`) → where one is kept: the sealed value of one of its rows (`itemId`) on a
   * record, read as the worker, or null when there's none (round seven, http/addon-sealed.ts).
   */
  readonly sealed?: Readonly<Record<string, AddonSealedReader>>;
  /**
   * Round seven: what's wrong with the AI teammate's reply before it goes (its manifest's `teammate.checksReplies`),
   * while the teammate uses the add-on. Each problem in words for the person who'll look; none when it's fine. A
   * flagged reply waits for a person, even when the teammate answers on its own.
   */
  readonly checkTeammateReply?: (
    ctx: AddonScopeContext,
    reply: TeammateReplyToCheck,
  ) => Promise<readonly string[]>;
  /**
   * Its own Playwright routes (`/test/<id>/…`), registered with the worker's other test routes: only with the fake
   * providers, never in production.
   */
  readonly testRoutes?: (app: FastifyInstance, deps: HttpDeps) => void;
}

/** The AI teammate's reply an add-on checks (round seven). */
export interface TeammateReplyToCheck {
  readonly text: string;
  readonly channel: 'sms' | 'email' | 'chat';
  /** The customer it answers. */
  readonly personId: string | null;
}

/** Reads one sealed value of an add-on's: the row's, if it's on that record in that business. */
export type AddonSealedReader = (
  tx: Tx,
  at: { readonly workspaceId: string; readonly recordId: string; readonly itemId: string },
) => Promise<string | null>;

/** One of an add-on's worker actions: who may ask, what they give, and what it does (as the add-on, for them). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each action's own input; the route parses it first.
export interface AddonWorkerAction<I = any> {
  readonly permission: string;
  readonly input: z.ZodType<I>;
  readonly run: (
    ctx: AddonScopeContext & { readonly userId: string },
    input: I,
  ) => Promise<unknown>;
}
