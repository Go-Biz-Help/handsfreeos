import type { WorkerEnv } from '../env';
import { createFakeMailboxes, type FakeMailboxes } from './fake';
import { createGmailMailbox } from './gmail';
import { createGraphMailbox } from './graph';
import type { MailboxProvider, MailboxProviderName } from './provider';

/** Connected mailboxes: the providers, and how often each mailbox is checked when nothing tells us sooner. */
export interface MailboxServices {
  readonly providers: Readonly<Record<MailboxProviderName, MailboxProvider>>;
  /** Local and tests: in-memory mailboxes, and a sign-in page on the worker. Null with the real providers. */
  readonly fake: FakeMailboxes | null;
  readonly syncEveryMs: Readonly<Record<MailboxProviderName, number>>;
  /** How far back a new mailbox's first sync looks. */
  readonly backfillDays: number;
}

/** In-memory mailboxes (local development, tests and the seed). */
export function fakeMailboxServices(
  publicUrl: string,
  syncEveryMs: number,
  backfillDays = 30,
): MailboxServices & { readonly fake: FakeMailboxes } {
  const fake = createFakeMailboxes({ publicUrl });
  return {
    providers: fake.providers,
    fake,
    syncEveryMs: { microsoft: syncEveryMs, google: syncEveryMs },
    backfillDays,
  };
}

export function createMailboxes(env: WorkerEnv): MailboxServices {
  if (env.mailboxProvider === 'fake')
    return fakeMailboxServices(env.publicUrl, env.mailboxSyncMs ?? 3_000, env.mailboxBackfillDays);
  return {
    providers: {
      microsoft: createGraphMailbox({
        clientId: env.microsoftClientId,
        clientSecret: env.microsoftClientSecret,
      }),
      google: createGmailMailbox({
        clientId: env.googleClientId,
        clientSecret: env.googleClientSecret,
      }),
    },
    fake: null,
    // Outlook also pushes change notifications, so its poll is only the safety net.
    syncEveryMs: {
      microsoft: env.mailboxSyncMs ?? 5 * 60_000,
      google: env.mailboxSyncMs ?? 2 * 60_000,
    },
    backfillDays: env.mailboxBackfillDays,
  };
}
