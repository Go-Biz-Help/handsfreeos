import { randomUUID } from 'node:crypto';
import type { AiProvider } from '@hfos/ai';
import type { RequestMeta, SystemActor } from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import type { Logger } from 'pino';
import type { AuthAdmin } from './account/auth-admin';
import type { BookingLinks } from './booking/links';
import type { CalendarServices } from './calendar/index';
import type { Sealer } from './crypto';
import type { EmailServices } from './email/index';
import type { SafeFetch } from './http/safe-fetch';
import type { MailboxServices } from './mailbox/index';
import type { Mailer } from './mailer';
import type { UnsubscribeLinks } from './email/unsubscribe';
import type { MoneyLinks } from './money/links';
import type { WalletDeps } from './money/wallet';
import type { PaymentServices } from './payments/index';
import type { PushServices } from './push/index';
import type { ReviewServices } from './reviews/index';
import type { ObjectStore } from './storage';
import type { SiteHost } from './hosting';
import type { Opinly } from './opinly';
import type { TelephonyProvider } from './telephony/provider';
import type { DriveTimer } from './geo/driving';
import type { Geocoder } from './geo/geocoder';
import type { Transcriber } from './telephony/transcriber';
import type { SpeechServices } from './voice-agent/speech';

/** HandsFreeOS's own support desk (M13): where its mail arrives and who it comes from. */
export interface SupportServices {
  /** The bare domain support mail arrives on, kept apart from the businesses' sending subdomain. */
  readonly mailDomain: string;
  /** The local parts that open a ticket, the first of which is the one we send from. */
  readonly addresses: readonly string[];
  readonly fromName: string;
  /** Always support admins, whatever the database says: there is always a way back in. */
  readonly ownerEmails: readonly string[];
}

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
  /** Turns a call recording into words. Separate from the carrier: it reads our own copy of the audio. */
  readonly transcriber: Transcriber;
  /** Where an address is, for distance and drawn service areas (M18); `off` without a key. */
  readonly geocoder: Geocoder;
  /** How long a drive takes, for On my way's arrival time (M18). */
  readonly driving: DriveTimer;
  /**
   * Hearing and speaking when the AI teammate answers a call live (M18 step 5). **Null when it's off**
   * (production with no Deepgram key): every call rings the team and goes to voicemail, as before.
   */
  readonly speech: SpeechServices | null;
  /** The model that thinks on a call, when it isn't the usual one (VOICE_MODEL); null uses `ai.provider`. */
  readonly voiceAi: AiProvider | null;
  /**
   * The AI thinking with a model named at run time: a business's phone model, which support picks in /admin
   * (voice-agent/index.ts callModel). Null when only the usual models can answer (the scripted stand-in).
   */
  readonly aiFor: ((model: string) => AiProvider) | null;
  /**
   * Where a business's own domain is served from (M17). **Null when nobody has turned it on**, which every
   * handler checks: the feature is absent rather than present and failing.
   */
  readonly siteHost: SiteHost | null;
  /**
   * The website's marketing analytics, told about the money it cannot see from a browser (opinly.ts). **Null
   * without OPINLY_API_KEY**, and every handler checks: nothing is queued, rather than queued and refused.
   */
  readonly opinly: Opinly | null;
  readonly sealer: Sealer;
  /** Tests and local demos shorten the reply reminder; production uses each workspace's setting. */
  readonly reminderOverrideMs: number | null;
  /** How often to ask the carrier about a registration under review. */
  readonly registrationPollMs: number;
  /** How often to ask the carrier about a port. Slower than a registration: these take weeks, not hours. */
  readonly portPollMs: number;
  /** How often to look for a number being brought over from Twilio or HighLevel (20261010000900). */
  readonly numberImportPollMs: number;
  /** Workspace email: the transport, workspace domains, the shared subdomain and the webhook credentials. */
  readonly email: EmailServices;
  /** Connected Outlook and Gmail mailboxes (in-memory ones locally and in tests). */
  readonly mailboxes: MailboxServices;
  /** People's own Google and Outlook calendars (in-memory ones locally and in tests). */
  readonly calendars: CalendarServices;
  /** The Google Business Profile and Facebook Page reviews are read from (a stand-in locally and in tests). */
  readonly reviews: ReviewServices;
  /** The accounts businesses are paid into: Stripe and Square (the stand-in locally and in tests). */
  readonly payments: PaymentServices;
  /** Signs and checks customers' change-or-cancel and waitlist-offer links (booking/links.ts). */
  readonly bookingLinks: BookingLinks;
  /** Signs and checks customers' estimate and invoice links, `/e/…` and `/i/…` (money/links.ts). */
  readonly moneyLinks: MoneyLinks;
  /** Signs and checks the unsubscribe link every campaign email carries (email/unsubscribe.ts). */
  readonly unsubscribeLinks: UnsubscribeLinks;
  /**
   * Fetches addresses businesses typed in (website scans, outgoing workflow webhooks): https only, never a
   * private address, every redirect checked again (http/safe-fetch.ts).
   */
  readonly fetchUrl: SafeFetch;
  /**
   * The model behind workflow AI steps, the AI builder and the knowledge base (none without a key), and the
   * daily token limit per workspace they share with the Assistant (ai/ask.ts, ai/budget.ts).
   */
  readonly ai: { readonly provider: AiProvider | null; readonly dailyTokens: number };
  /** Push notifications to the phone app: Expo's service, or the stand-in locally and in tests (push/index.ts). */
  readonly push: PushServices;
  /**
   * Supabase Auth with the worker's secret key: deleting an account ends its sessions and blocks sign-in
   * (account/auth-admin.ts). Missing without SUPABASE_URL and SUPABASE_SECRET_KEY; that job then waits and retries.
   */
  readonly authAdmin?: AuthAdmin;
  /** HandsFreeOS's own support desk: the addresses its mail arrives on and sends from. */
  readonly support: SupportServices;
  /**
   * The usage wallet (M16). `off` records nothing; `shadow` prices and records every event and stops nothing,
   * which is how the rate card gets proved against a real week; `on` warns and, per business, enforces.
   */
  readonly wallet: WalletDeps;
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
