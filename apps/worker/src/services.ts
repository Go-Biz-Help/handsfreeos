import { randomUUID } from 'node:crypto';
import type { RequestMeta, SystemActor } from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import type { Logger } from 'pino';
import type { BookingLinks } from './booking/links';
import type { CalendarServices } from './calendar/index';
import type { Sealer } from './crypto';
import type { EmailServices } from './email/index';
import type { MailboxServices } from './mailbox/index';
import type { Mailer } from './mailer';
import type { ObjectStore } from './storage';
import type { TelephonyProvider } from './telephony/provider';

/** Everything the worker's loops, handlers and HTTP routes share. */
export interface WorkerServices {
  readonly db: Db;
  readonly mailer: Mailer;
  readonly store: ObjectStore;
  readonly log: Logger;
  readonly webUrl: string;
  /** Where providers reach the worker (webhooks, callbacks). */
  readonly publicUrl: string;
  readonly telephony: TelephonyProvider;
  readonly sealer: Sealer;
  /** Tests and local demos shorten the reply reminder; production uses each workspace's setting. */
  readonly reminderOverrideMs: number | null;
  /** How often to ask the carrier about a registration under review. */
  readonly registrationPollMs: number;
  /** Workspace email: the transport, workspace domains, the shared subdomain and the webhook credentials. */
  readonly email: EmailServices;
  /** Connected Outlook and Gmail mailboxes (in-memory ones locally and in tests). */
  readonly mailboxes: MailboxServices;
  /** People's own Google and Outlook calendars (in-memory ones locally and in tests). */
  readonly calendars: CalendarServices;
  /** Signs and checks customers' change-or-cancel and waitlist-offer links (booking/links.ts). */
  readonly bookingLinks: BookingLinks;
}

export interface TenantScope {
  readonly workspaceId: string;
  readonly organizationId: string;
}

export function systemActor(scope: TenantScope, onBehalfOf?: string | null): SystemActor {
  return {
    type: 'system',
    workspaceId: scope.workspaceId,
    organizationId: scope.organizationId,
    onBehalfOf: onBehalfOf ?? null,
  };
}

/** Request metadata for work the worker does, chained to the event or delivery that caused it. */
export function workerMeta(
  correlationId?: string | null,
  causationId?: string | null,
): RequestMeta {
  return {
    correlationId: correlationId ?? randomUUID(),
    causationId: causationId ?? null,
    channel: 'worker',
  };
}

/** Narrows a scope from the outbox or a delivery to a workspace tenant, or throws. */
export function tenantOf(scope: {
  workspaceId?: string | null;
  organizationId?: string | null;
}): TenantScope {
  if (!scope.workspaceId || !scope.organizationId)
    throw new Error('this work needs a workspace and organization scope');
  return { workspaceId: scope.workspaceId, organizationId: scope.organizationId };
}
