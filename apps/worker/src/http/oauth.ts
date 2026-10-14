/**
 * Connecting mailboxes, calendars and the accounts a business is paid into: the browser comes here from
 * Settings (Email, My calendar, or Payments) with a one-time state, goes on to the provider's sign-in, and
 * comes back to the callback, which seals the tokens and connects the mailbox, the person's calendar or the
 * payment account (the state says which). Outlook's change notifications land here too (only as a nudge to
 * sync). With the stand-in providers, the sign-in page is this server's own, and tests can drop mail into a
 * fake mailbox, busy time into a fake calendar, or connect a stand-in Stripe or Square account.
 *
 * **No PKCE on the payment providers.** Stripe's Connect OAuth doesn't offer it at all, and Square's PKCE flow
 * trades the 30-day refresh token for rotating short-lived ones, which is the wrong trade for a connection that
 * has to stay alive for years. The one-time state — random, hashed, ten minutes — is what ties a callback back
 * to the business that started it, exactly as it does for the other two.
 *
 * **The callback connects nothing.** A state travels in a link, and a link can be forwarded to somebody in another
 * business, whose approval would then connect their account to the sender's. So the callback seals what came back
 * and hands it to the app (`handoff.ts`), and `/v1/oauth/finish` exchanges the code only when the app posts it
 * back signed in as the person who pressed Connect (SEC-M1).
 */
import { timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  calendarConnectionActivate,
  meetingConnectionActivate,
  reviewConnectionActivate,
  executeCommand,
  HfosError,
  mailboxActivate,
  paymentConnectionActivate,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import {
  calendarConnections,
  meetingConnections,
  mailboxConnections,
  metaConnections,
  paymentConnections,
  reviewConnections,
} from '@hfos/db/schema';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { GOOGLE_MEET_TRANSCRIPT_SCOPE } from '@hfos/core';
import { CALENDAR_NAME } from '../calendar/provider';
import { isMeetingProvider, MEETING_NAME, type MeetingProviderName } from '../meetings/provider';
import { REVIEW_NAME, type ReviewProviderName } from '../reviews/provider';
import { escapeHtml } from '../emails/templates';
import { fakeCode } from '../mailbox/fake';
import { party, pkcePair, type MailboxProviderName } from '../mailbox/provider';
import { PROVIDER_NAME, sha256Hex, syncSoon } from '../mailbox/sync';
import { fakePaymentCode } from '../payments/fake';
import {
  ACCOUNT_HELD_ELSEWHERE,
  isPaymentProvider,
  PAYMENT_NAME,
  PaymentAuthError,
  type PaymentProviderName,
} from '../payments/provider';
import { nextRefreshAt } from '../payments/refresh';
import { errorMessage } from '../outbox';
import { systemActor, workerMeta, type TenantScope } from '../services';
import {
  answerMetaPick,
  finishMetaSignIn,
  META_PICK_ANSWER,
  metaSettingsUrl,
} from '../social/connect';
import { authenticate, parseBody, type HttpDeps } from './common';
import {
  finishUrl,
  HandoffBody,
  NOT_YOURS,
  openHandoff,
  sealHandoff,
  type FinishOutcome,
  type FinishPage,
} from './handoff';

const isProvider = (p: string): p is MailboxProviderName => p === 'microsoft' || p === 'google';

/**
 * A sign-in's one-time state, as private.oauth_connection_by_state finds it. All three kinds share it, and all
 * three share /oauth/:provider/start and /callback.
 */
type StateRow = {
  /** `meta`: a business's Facebook Pages and Instagram accounts for the inbox (20261025000200). */
  kind: 'mailbox' | 'calendar' | 'payment' | 'reviews' | 'meta' | 'meeting';
  connection_id: string;
  workspace_id: string;
  organization_id: string;
  /**
   * Mailboxes and calendars name their providers the same way; payments name Stripe and Square; reviews
   * name Google and Facebook; the inbox's Pages are always Facebook's.
   */
  provider: MailboxProviderName | PaymentProviderName | ReviewProviderName | MeetingProviderName;
  status: string;
  state_expires_at: Date | string | null;
};
type CallbackQuery = { state?: string; code?: string; error?: string; error_description?: string };

interface GraphItem {
  subscriptionId?: string;
  clientState?: string;
  lifecycleEvent?: string;
}

export const shell = (title: string, inner: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>` +
  `<body style="font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color: #191d25; background: #f7f8fa; margin: 0;">` +
  `<main style="max-width: 440px; margin: 12vh auto; background: #fff; border: 1px solid #e3e6eb; border-radius: 12px; padding: 28px 30px;">${inner}</main></body></html>`;

/** A plain page for the rare dead ends (an expired link, a provider that isn't set up). */
export function deadEnd(
  reply: FastifyReply,
  status: number,
  title: string,
  body: string,
  link?: { href: string; label: string },
) {
  return reply
    .code(status)
    .type('text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .send(
      shell(
        title,
        `<h1 style="font-size: 18px; margin: 0 0 8px;">${escapeHtml(title)}</h1>` +
          `<p style="font-size: 14px; line-height: 1.5; color: #5b616a; margin: 0;">${escapeHtml(body)}</p>` +
          (link
            ? `<p style="margin: 20px 0 0;"><a href="${escapeHtml(link.href)}" style="color: #2d69d8; font-weight: 600; text-decoration: none;">${escapeHtml(link.label)}</a></p>`
            : ''),
      ),
    );
}

/** A page from the dead ends a sign-in can reach, shown by the worker itself (a dead link to /start). */
const sendPage = (reply: FastifyReply, status: number, page: FinishPage) =>
  deadEnd(reply, status, page.title, page.body, page.link);

/** The chooser's answer, posted by the app. */
const PlaceBody = HandoffBody.extend({ place: z.string().min(1).max(500) });
/** The Facebook checklist's answer: the Pages and Instagram accounts ticked. */
const PickBody = HandoffBody.extend({
  ids: z.array(z.string().regex(/^(facebook|instagram):[0-9]{1,40}$/)).max(200),
});

export function registerOAuthRoutes(app: FastifyInstance, deps: HttpDeps): void {
  const { providers, fake } = deps.mailboxes;
  const calendars = deps.calendars;
  const payments = deps.payments;
  const callbackUrl = (
    p: MailboxProviderName | PaymentProviderName | ReviewProviderName | MeetingProviderName,
  ) => `${deps.publicUrl}/oauth/${p}/callback`;
  const settingsUrl = (workspaceId: string) => `${deps.webUrl}/app/w/${workspaceId}/settings/email`;
  const myCalendarUrl = (workspaceId: string) =>
    `${deps.webUrl}/app/w/${workspaceId}/settings/my-calendar`;
  const paymentsUrl = (workspaceId: string) =>
    `${deps.webUrl}/app/w/${workspaceId}/settings/payments`;
  const reviewsUrl = (workspaceId: string) => `${deps.webUrl}/app/w/${workspaceId}/reviews`;
  const scopeOf = (row: StateRow): TenantScope => ({
    workspaceId: row.workspace_id,
    organizationId: row.organization_id,
  });

  /** The mailbox, calendar or payment sign-in a state belongs to, still good or not. */
  async function lookup(provider: string, state: string | undefined): Promise<StateRow | null> {
    if (!state || state.length > 200) return null;
    return lookupHash(provider, sha256Hex(state));
  }
  /** The same, by the state's hash: what a handoff carries back. */
  async function lookupHash(provider: string, stateHash: string): Promise<StateRow | null> {
    if (
      !isProvider(provider) &&
      !isPaymentProvider(provider) &&
      !isReviewProvider(provider) &&
      !isMeetingProvider(provider)
    )
      return null;
    const [row] = await asWorker(deps.httpDb, {}, (tx) =>
      rows<StateRow>(
        tx,
        sql`select kind, connection_id, workspace_id, organization_id, provider, status, state_expires_at
            from private.oauth_connection_by_state(${stateHash})`,
      ),
    );
    return row ?? null;
  }
  /** Waiting on this sign-in: pending, for this provider, and within its ten minutes. */
  function waiting(provider: string, row: StateRow | null): StateRow | null {
    if (!row || row.provider !== provider || row.status !== 'pending' || !row.state_expires_at)
      return null;
    return new Date(row.state_expires_at).getTime() > Date.now() ? row : null;
  }
  const SETTINGS_PAGE: Record<StateRow['kind'], string> = {
    mailbox: 'Email',
    calendar: 'My calendar',
    payment: 'Payments',
    reviews: 'Reviews',
    meta: 'Facebook & Instagram',
    meeting: 'My calendar',
  };
  /**
   * Which Settings page to send someone back to when their link is dead. A used or expired state has no row
   * left to ask, but Stripe and Square are only ever payments, so the answer is still right; Microsoft and
   * Google could be either a mailbox or a calendar, so those fall back to Email as they always have.
   */
  const kindOf = (provider: string, found: StateRow | null): StateRow['kind'] | undefined =>
    found?.kind ??
    (isPaymentProvider(provider) ? 'payment' : isMeetingProvider(provider) ? 'meeting' : undefined);

  const expiredPage = (kind?: StateRow['kind'], provider?: string): FinishPage => ({
    title: 'This sign-in link has expired',
    body:
      !kind && provider === 'facebook'
        ? // Facebook signs in for the inbox and for reviews, and a used link no longer says which.
          'Sign-in links last ten minutes. Go back to where you pressed Connect (Settings → Facebook & Instagram, or Reviews), and choose Connect again.'
        : `Sign-in links last ten minutes. Go back to Settings, open ${SETTINGS_PAGE[kind ?? 'mailbox']}, and choose Connect again.`,
  });
  const expired = (reply: FastifyReply, kind?: StateRow['kind'], provider?: string) =>
    sendPage(reply, 400, expiredPage(kind, provider));
  /** A dead end, for the app to show. */
  const page = (title: string, body: string, link?: FinishPage['link']): FinishOutcome => ({
    page: { title, body, ...(link ? { link } : {}) },
  });
  /** Where the app goes next, when a sign-in ends somewhere in Settings. */
  const next = (url: string): FinishOutcome => ({ next: url });

  app.get('/oauth/:provider/start', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const { state } = req.query as { state?: string };
    const found = await lookup(provider, state);
    const row = waiting(provider, found);
    if (!row || !state) return expired(reply, kindOf(provider, found), provider);
    if (row.kind === 'meta') return startMeta(row, state, reply);
    if (row.kind === 'payment') return startPayment(row, state, reply);
    if (row.kind === 'calendar') return startCalendar(row, state, reply);
    if (row.kind === 'meeting') return startMeeting(row, state, reply);
    if (row.kind === 'reviews') return startReviews(row, state, reply);
    if (!isProvider(row.provider)) return expired(reply, row.kind);
    const p = providers[row.provider];
    const name = PROVIDER_NAME[row.provider];
    if (!p.configured)
      return deadEnd(
        reply,
        503,
        `${name} isn’t set up yet`,
        `This server can’t connect ${name} mailboxes yet.`,
        {
          href: settingsUrl(row.workspace_id),
          label: 'Back to Settings',
        },
      );
    // PKCE: the verifier stays here, sealed; only its hash travels with the browser.
    const { verifier, challenge } = pkcePair();
    await asWorker(deps.httpDb, scopeOf(row), (tx) =>
      tx
        .update(mailboxConnections)
        .set({ pkceVerifierEnc: deps.sealer.seal(verifier) })
        .where(eq(mailboxConnections.id, row.connection_id)),
    );
    return reply
      .header('referrer-policy', 'no-referrer')
      .redirect(
        p.authorizeUrl({ state, codeChallenge: challenge, redirectUri: callbackUrl(row.provider) }),
        302,
      );
  });

  /**
   * The provider's answer. Nothing is exchanged here: whoever this browser belongs to is not known, so what came
   * back is sealed and handed to the app, which finishes it signed in (`/v1/oauth/finish`).
   */
  app.get('/oauth/:provider/callback', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const q = req.query as CallbackQuery;
    const found = await lookup(provider, q.state);
    const row = waiting(provider, found);
    if (!row || !q.state) return expired(reply, kindOf(provider, found), provider);
    const sealed = sealHandoff(deps.sealer, {
      door: 'oauth',
      provider,
      stateHash: sha256Hex(q.state),
      code: q.code?.slice(0, 4000) ?? null,
      error: q.error?.slice(0, 200) ?? null,
      errorDescription: q.error_description?.slice(0, 500) ?? null,
    });
    return reply
      .header('referrer-policy', 'no-referrer')
      .header('cache-control', 'no-store')
      .redirect(finishUrl(deps.webUrl, 'oauth', sealed), 302);
  });

  /**
   * The app, signed in, finishing what the callback handed it. Only the person who pressed Connect gets any
   * further; anybody else ends the sign-in, so a forwarded link can't be tried twice.
   */
  async function finishing(
    req: FastifyRequest,
    sealed: string,
  ): Promise<{ row: StateRow; q: CallbackQuery } | { outcome: FinishOutcome }> {
    const actor = await authenticate(deps, req);
    const h = openHandoff(deps.sealer, sealed, 'oauth');
    if (!h) return { outcome: { page: expiredPage() } };
    const found = await lookupHash(h.provider, h.stateHash);
    const row = waiting(h.provider, found);
    if (!row) return { outcome: { page: expiredPage(kindOf(h.provider, found), h.provider) } };
    const [started] = await asWorker(deps.httpDb, {}, (tx) =>
      rows<{ by: string | null }>(
        tx,
        sql`select private.oauth_state_started_by(${h.stateHash}) as by`,
      ),
    );
    if (!started?.by || started.by !== actor.userId) {
      deps.log.warn(
        { connectionId: row.connection_id, kind: row.kind },
        'a sign-in came back to somebody other than the person who started it',
      );
      await abandon(row);
      return { outcome: { page: NOT_YOURS } };
    }
    return {
      row,
      q: {
        ...(h.code ? { code: h.code } : {}),
        ...(h.error ? { error: h.error } : {}),
        ...(h.errorDescription ? { error_description: h.errorDescription } : {}),
      },
    };
  }

  /** Ends a sign-in somebody else tried to finish: its state stops working, and the reason is kept. */
  async function abandon(row: StateRow): Promise<void> {
    const ended = {
      oauthStateHash: null,
      oauthStateExpiresAt: null,
      lastError: 'The sign-in was finished by somebody other than the person who started it.',
    };
    await asWorker(deps.httpDb, scopeOf(row), async (tx) => {
      if (row.kind === 'mailbox')
        await tx
          .update(mailboxConnections)
          .set(ended)
          .where(eq(mailboxConnections.id, row.connection_id));
      else if (row.kind === 'calendar')
        await tx
          .update(calendarConnections)
          .set(ended)
          .where(eq(calendarConnections.id, row.connection_id));
      else if (row.kind === 'meeting')
        await tx
          .update(meetingConnections)
          .set(ended)
          .where(eq(meetingConnections.id, row.connection_id));
      else if (row.kind === 'payment')
        await tx
          .update(paymentConnections)
          .set(ended)
          .where(eq(paymentConnections.id, row.connection_id));
      else if (row.kind === 'meta')
        // The person's own token may already wait on it, for the checklist: it goes too.
        await tx
          .update(metaConnections)
          .set({ ...ended, tokenEnc: null, tokenKeyId: null })
          .where(eq(metaConnections.id, row.connection_id));
      else
        await tx
          .update(reviewConnections)
          .set(ended)
          .where(eq(reviewConnections.id, row.connection_id));
    });
  }

  app.post('/v1/oauth/finish', async (req, reply) => {
    const { handoff } = parseBody(HandoffBody, req.body);
    const got = await finishing(req, handoff);
    reply.header('cache-control', 'no-store');
    if ('outcome' in got) return got.outcome;
    const { row, q } = got;
    if (row.kind === 'meta') return finishMetaSignIn(deps, row, q);
    if (row.kind === 'payment') return paymentCallback(row, q);
    if (row.kind === 'calendar') return calendarCallback(row, q);
    if (row.kind === 'meeting') return meetingCallback(row, q);
    if (row.kind === 'reviews') return reviewsCallback(row, q);
    return mailboxCallback(row, q);
  });

  async function mailboxCallback(row: StateRow, q: CallbackQuery): Promise<FinishOutcome> {
    if (!isProvider(row.provider)) return { page: expiredPage(row.kind) };
    const scope = scopeOf(row);
    const back = (result: string) => next(`${settingsUrl(row.workspace_id)}?mailbox=${result}`);
    const note = (error: string) =>
      asWorker(deps.httpDb, scope, (tx) =>
        tx
          .update(mailboxConnections)
          .set({ lastError: error.slice(0, 2000) })
          .where(eq(mailboxConnections.id, row.connection_id)),
      );
    if (q.error || !q.code) {
      await note(`The sign-in ended without access (${(q.error ?? 'no code').slice(0, 80)}).`);
      return back(q.error === 'access_denied' ? 'cancelled' : 'failed');
    }
    const [m] = await asWorker(deps.httpDb, scope, (tx) =>
      tx
        .select({ verifier: mailboxConnections.pkceVerifierEnc })
        .from(mailboxConnections)
        .where(eq(mailboxConnections.id, row.connection_id)),
    );
    if (!m?.verifier) return back('failed');
    const p = providers[row.provider];
    try {
      const tokens = await p.exchangeCode({
        code: q.code,
        codeVerifier: deps.sealer.open(m.verifier),
        redirectUri: callbackUrl(row.provider),
      });
      if (p.missingScopes(tokens.scopes).length > 0) {
        await note('Some permissions were left unticked on the sign-in screen.');
        return back('missing_permissions');
      }
      const account = await p.account(tokens.accessToken);
      await executeCommand(
        deps.httpDb,
        mailboxActivate,
        {
          workspaceId: row.workspace_id,
          connectionId: row.connection_id,
          accountEmail: account.email,
          displayName: account.displayName,
          scopes: tokens.scopes.slice(0, 50).map((s) => s.slice(0, 200)),
          tokenEnc: deps.sealer.seal(JSON.stringify(tokens)),
          tokenKeyId: deps.sealer.keyId,
          tokenExpiresAt: tokens.expiresAt,
        },
        systemActor(scope),
        workerMeta(),
      );
      return back('connected');
    } catch (e) {
      deps.log.warn(
        { connectionId: row.connection_id, err: errorMessage(e) },
        'a mailbox did not connect',
      );
      await note(errorMessage(e));
      return back('failed');
    }
  }

  // ---------- a person's own calendar: the same sign-in, back to Settings → My calendar ----------

  async function startCalendar(row: StateRow, state: string, reply: FastifyReply) {
    if (!isProvider(row.provider)) return expired(reply, row.kind);
    const p = calendars.providers[row.provider];
    const name = CALENDAR_NAME[row.provider];
    if (!p.configured)
      return deadEnd(
        reply,
        503,
        `${name} isn’t set up yet`,
        `This server can’t connect ${name} calendars yet.`,
        { href: myCalendarUrl(row.workspace_id), label: 'Back to My calendar' },
      );
    const { verifier, challenge } = pkcePair();
    const [asked] = await asWorker(deps.httpDb, scopeOf(row), (tx) =>
      tx
        .update(calendarConnections)
        .set({ pkceVerifierEnc: deps.sealer.seal(verifier) })
        .where(eq(calendarConnections.id, row.connection_id))
        .returning({ meetTranscripts: calendarConnections.meetTranscripts }),
    );
    return reply.header('referrer-policy', 'no-referrer').redirect(
      p.authorizeUrl({
        state,
        codeChallenge: challenge,
        redirectUri: callbackUrl(row.provider),
        extraScopes:
          row.provider === 'google' && asked?.meetTranscripts ? [GOOGLE_MEET_TRANSCRIPT_SCOPE] : [],
      }),
      302,
    );
  }

  async function calendarCallback(row: StateRow, q: CallbackQuery): Promise<FinishOutcome> {
    if (!isProvider(row.provider)) return { page: expiredPage(row.kind) };
    const provider = row.provider;
    const scope = scopeOf(row);
    const back = (result: 'connected' | 'cancelled' | 'missing_permissions' | 'failed') =>
      next(`${myCalendarUrl(row.workspace_id)}?calendar=${result}`);
    const note = (error: string) =>
      asWorker(deps.httpDb, scope, (tx) =>
        tx
          .update(calendarConnections)
          .set({ lastError: error.slice(0, 2000) })
          .where(eq(calendarConnections.id, row.connection_id)),
      );
    if (q.error || !q.code) {
      await note(`The sign-in ended without access (${(q.error ?? 'no code').slice(0, 80)}).`);
      return back(q.error === 'access_denied' ? 'cancelled' : 'failed');
    }
    const [c] = await asWorker(deps.httpDb, scope, (tx) =>
      tx
        .select({
          verifier: calendarConnections.pkceVerifierEnc,
          meetTranscripts: calendarConnections.meetTranscripts,
        })
        .from(calendarConnections)
        .where(eq(calendarConnections.id, row.connection_id)),
    );
    if (!c?.verifier) return back('failed');
    const p = calendars.providers[provider];
    try {
      const tokens = await p.exchangeCode({
        code: q.code,
        codeVerifier: deps.sealer.open(c.verifier),
        redirectUri: callbackUrl(provider),
      });
      if (
        p.missingScopes(tokens.scopes).length > 0 ||
        // Asked for Meet transcripts, and that box was left unticked.
        (provider === 'google' &&
          c.meetTranscripts &&
          !tokens.scopes.includes(GOOGLE_MEET_TRANSCRIPT_SCOPE))
      ) {
        await note('Some permissions were left unticked on the sign-in screen.');
        return back('missing_permissions');
      }
      const account = await p.account(tokens.accessToken);
      await executeCommand(
        deps.httpDb,
        calendarConnectionActivate,
        {
          workspaceId: row.workspace_id,
          connectionId: row.connection_id,
          accountEmail: account.email,
          scopes: tokens.scopes.slice(0, 50).map((s) => s.slice(0, 200)),
          tokenEnc: deps.sealer.seal(JSON.stringify(tokens)),
          tokenKeyId: deps.sealer.keyId,
          tokenExpiresAt: tokens.expiresAt,
        },
        systemActor(scope),
        workerMeta(),
      );
      return back('connected');
    } catch (e) {
      deps.log.warn(
        { connectionId: row.connection_id, err: errorMessage(e) },
        'a calendar did not connect',
      );
      await note(errorMessage(e));
      return back('failed');
    }
  }

  // ---------- a person's own Zoom account: the same sign-in, back to Settings → My calendar ----------

  async function startMeeting(row: StateRow, state: string, reply: FastifyReply) {
    if (!isMeetingProvider(row.provider)) return expired(reply, row.kind);
    const p = calendars.meetings[row.provider];
    const name = MEETING_NAME[row.provider];
    if (!p.configured)
      return deadEnd(
        reply,
        503,
        `${name} isn’t set up yet`,
        `This server can’t connect ${name} accounts yet.`,
        { href: myCalendarUrl(row.workspace_id), label: 'Back to My calendar' },
      );
    const { verifier, challenge } = pkcePair();
    await asWorker(deps.httpDb, scopeOf(row), (tx) =>
      tx
        .update(meetingConnections)
        .set({ pkceVerifierEnc: deps.sealer.seal(verifier) })
        .where(eq(meetingConnections.id, row.connection_id)),
    );
    return reply
      .header('referrer-policy', 'no-referrer')
      .redirect(
        p.authorizeUrl({ state, codeChallenge: challenge, redirectUri: callbackUrl(row.provider) }),
        302,
      );
  }

  async function meetingCallback(row: StateRow, q: CallbackQuery): Promise<FinishOutcome> {
    if (!isMeetingProvider(row.provider)) return { page: expiredPage(row.kind) };
    const provider = row.provider;
    const scope = scopeOf(row);
    const back = (result: 'connected' | 'cancelled' | 'missing_permissions' | 'failed') =>
      next(`${myCalendarUrl(row.workspace_id)}?meeting=${result}`);
    const note = (error: string) =>
      asWorker(deps.httpDb, scope, (tx) =>
        tx
          .update(meetingConnections)
          .set({ lastError: error.slice(0, 2000) })
          .where(eq(meetingConnections.id, row.connection_id)),
      );
    if (q.error || !q.code) {
      await note(`The sign-in ended without access (${(q.error ?? 'no code').slice(0, 80)}).`);
      return back(q.error === 'access_denied' ? 'cancelled' : 'failed');
    }
    const [c] = await asWorker(deps.httpDb, scope, (tx) =>
      tx
        .select({ verifier: meetingConnections.pkceVerifierEnc })
        .from(meetingConnections)
        .where(eq(meetingConnections.id, row.connection_id)),
    );
    if (!c?.verifier) return back('failed');
    const p = calendars.meetings[provider];
    try {
      const tokens = await p.exchangeCode({
        code: q.code,
        codeVerifier: deps.sealer.open(c.verifier),
        redirectUri: callbackUrl(provider),
      });
      if (p.missingScopes(tokens.scopes).length > 0) {
        await note('Some permissions were left out of the Zoom sign-in.');
        return back('missing_permissions');
      }
      const account = await p.account(tokens.accessToken);
      await executeCommand(
        deps.httpDb,
        meetingConnectionActivate,
        {
          workspaceId: row.workspace_id,
          connectionId: row.connection_id,
          accountEmail: account.email,
          externalUserId: account.id.slice(0, 200),
          scopes: tokens.scopes.slice(0, 50).map((s) => s.slice(0, 200)),
          tokenEnc: deps.sealer.seal(JSON.stringify(tokens)),
          tokenKeyId: deps.sealer.keyId,
          tokenExpiresAt: tokens.expiresAt,
        },
        systemActor(scope),
        workerMeta(),
      );
      return back('connected');
    } catch (e) {
      deps.log.warn(
        { connectionId: row.connection_id, err: errorMessage(e) },
        'a Zoom account did not connect',
      );
      await note(errorMessage(e));
      return back('failed');
    }
  }

  // ---------- where the public reviews live: back to Reviews ----------

  /**
   * Google and Facebook both hand back a sign-in that can speak for several places — nine branches, or one
   * page among a dozen somebody administers. One place needs no question; several do, and the chooser below
   * is that question. Nothing is connected until it has been answered.
   */
  const isReviewProvider = (p: string): p is ReviewProviderName =>
    p === 'google' || p === 'facebook';

  async function startReviews(row: StateRow, state: string, reply: FastifyReply) {
    if (!isReviewProvider(row.provider)) return expired(reply, row.kind);
    const p = deps.reviews.providers[row.provider];
    const name = REVIEW_NAME[row.provider];
    if (!p.configured)
      return deadEnd(
        reply,
        503,
        `${name} isn’t set up yet`,
        `This server can’t read ${name} reviews yet.`,
        { href: reviewsUrl(row.workspace_id), label: 'Back to Reviews' },
      );
    const { verifier, challenge } = pkcePair();
    await asWorker(deps.httpDb, scopeOf(row), (tx) =>
      tx
        .update(reviewConnections)
        .set({ pkceVerifierEnc: deps.sealer.seal(verifier) })
        .where(eq(reviewConnections.id, row.connection_id)),
    );
    return reply
      .header('referrer-policy', 'no-referrer')
      .redirect(
        p.authorizeUrl({ state, codeChallenge: challenge, redirectUri: callbackUrl(row.provider) }),
        302,
      );
  }

  /** The chooser: the places that sign-in speaks for, for the app to ask which one (answered at /v1/oauth/place). */
  const choosePlace = (
    places: readonly { externalId: string; displayName: string }[],
  ): FinishOutcome => ({
    choose: {
      places: places
        .slice(0, 50)
        .map((place) => ({ id: place.externalId, name: place.displayName })),
    },
  });

  async function reviewsCallback(row: StateRow, q: CallbackQuery): Promise<FinishOutcome> {
    if (!isReviewProvider(row.provider)) return { page: expiredPage(row.kind) };
    const provider = row.provider;
    const scope = scopeOf(row);
    const back = (result: 'connected' | 'cancelled' | 'failed') =>
      next(`${reviewsUrl(row.workspace_id)}?reviews=${result}`);
    const note = (error: string) =>
      asWorker(deps.httpDb, scope, (tx) =>
        tx
          .update(reviewConnections)
          .set({ lastError: error.slice(0, 2000) })
          .where(eq(reviewConnections.id, row.connection_id)),
      );
    if (q.error || !q.code) {
      await note(`The sign-in ended without access (${(q.error ?? 'no code').slice(0, 80)}).`);
      return back(q.error === 'access_denied' ? 'cancelled' : 'failed');
    }
    const [c] = await asWorker(deps.httpDb, scope, (tx) =>
      tx
        .select({ verifier: reviewConnections.pkceVerifierEnc })
        .from(reviewConnections)
        .where(eq(reviewConnections.id, row.connection_id)),
    );
    if (!c?.verifier) return back('failed');
    const p = deps.reviews.providers[provider];
    try {
      const tokens = await p.exchangeCode({
        code: q.code,
        codeVerifier: deps.sealer.open(c.verifier),
        redirectUri: callbackUrl(provider),
      });
      const places = await p.places(tokens.accessToken);
      if (places.length === 0) {
        await note('That sign-in does not manage any place with reviews.');
        return page(
          'Nothing to read reviews from',
          `That ${REVIEW_NAME[provider]} account does not manage a business page. Sign in with the account that does.`,
          { href: reviewsUrl(row.workspace_id), label: 'Back to Reviews' },
        );
      }
      /**
       * The token is kept now, still pending, so the chooser's answer does not have to carry it. The handoff is
       * what the answer proves, signed in as the same person, and it expires on the same ten-minute clock.
       */
      await asWorker(deps.httpDb, scope, (tx) =>
        tx
          .update(reviewConnections)
          .set({
            tokenEnc: deps.sealer.seal(JSON.stringify(tokens)),
            tokenKeyId: deps.sealer.keyId,
            tokenExpiresAt: new Date(tokens.expiresAt),
            lastError: null,
          })
          .where(eq(reviewConnections.id, row.connection_id)),
      );
      if (places.length > 1) return choosePlace(places);
      const only = places[0]!;
      await connectPlace(row, only.externalId, only.displayName, only.publicUrl, tokens.scopes);
      return back('connected');
    } catch (e) {
      deps.log.warn(
        { connectionId: row.connection_id, err: errorMessage(e) },
        'a review place did not connect',
      );
      await note(errorMessage(e));
      return back('failed');
    }
  }

  const connectPlace = (
    row: StateRow,
    externalId: string,
    displayName: string | null,
    publicUrl: string | null,
    scopes: readonly string[],
  ) =>
    executeCommand(
      deps.httpDb,
      reviewConnectionActivate,
      {
        workspaceId: row.workspace_id,
        connectionId: row.connection_id,
        externalAccountId: externalId.slice(0, 200),
        displayName: displayName?.slice(0, 200) ?? null,
        publicUrl: publicUrl?.slice(0, 500) ?? null,
        scopes: scopes.slice(0, 50).map((s) => s.slice(0, 120)),
      },
      systemActor(scopeOf(row)),
      workerMeta(),
    );

  /** The chooser's answer, from the app: the same handoff, the same person, still within its ten minutes. */
  app.post('/v1/oauth/place', async (req, reply) => {
    const { handoff, place } = parseBody(PlaceBody, req.body);
    const got = await finishing(req, handoff);
    reply.header('cache-control', 'no-store');
    if ('outcome' in got) return got.outcome;
    const { row } = got;
    if (row.kind !== 'reviews' || !isReviewProvider(row.provider))
      return { page: expiredPage('reviews') };
    const [c] = await asWorker(deps.httpDb, scopeOf(row), (tx) =>
      tx
        .select({ tokenEnc: reviewConnections.tokenEnc })
        .from(reviewConnections)
        .where(eq(reviewConnections.id, row.connection_id)),
    );
    if (!c?.tokenEnc) return { page: expiredPage('reviews') };
    try {
      const tokens = JSON.parse(deps.sealer.open(c.tokenEnc)) as {
        accessToken: string;
        scopes?: string[];
      };
      const places = await deps.reviews.providers[row.provider].places(tokens.accessToken);
      // Only a place that sign-in really manages: the answer is a parameter, and a parameter is a guess.
      const chosen = places.find((x) => x.externalId === place);
      if (!chosen) return { page: expiredPage('reviews') };
      await connectPlace(
        row,
        chosen.externalId,
        chosen.displayName,
        chosen.publicUrl,
        tokens.scopes ?? [],
      );
      return next(`${reviewsUrl(row.workspace_id)}?reviews=connected`);
    } catch (e) {
      deps.log.warn(
        { connectionId: row.connection_id, err: errorMessage(e) },
        'a review place did not connect',
      );
      return next(`${reviewsUrl(row.workspace_id)}?reviews=failed`);
    }
  });

  // ---------- the inbox's Facebook Pages and Instagram accounts: back to Settings → Facebook & Instagram ----------

  async function startMeta(row: StateRow, state: string, reply: FastifyReply) {
    const graph = deps.social.graph;
    if (!graph.configured)
      return deadEnd(
        reply,
        503,
        'Facebook isn’t set up yet',
        'This server can’t connect Facebook Pages or Instagram accounts yet.',
        { href: metaSettingsUrl(deps, row.workspace_id), label: 'Back to Settings' },
      );
    // No PKCE: Facebook's own sign-in is finished with the app's secret, and the one-time state, hashed on the row
    // with ten minutes to live, is what ties the answer back to the business.
    return reply
      .header('referrer-policy', 'no-referrer')
      .redirect(graph.authorizeUrl({ state, redirectUri: callbackUrl('facebook') }), 302);
  }

  /** The checklist's answer, from the app: the same handoff, the same person, still within its ten minutes. */
  app.post(META_PICK_ANSWER, async (req, reply) => {
    const { handoff, ids } = parseBody(PickBody, req.body);
    const got = await finishing(req, handoff);
    reply.header('cache-control', 'no-store');
    if ('outcome' in got) return got.outcome;
    if (got.row.kind !== 'meta') return { page: expiredPage('meta') };
    return answerMetaPick(deps, got.row, ids);
  });

  // ---------- the account a business is paid into: back to Settings → Payments ----------

  /**
   * Stripe won't attach `read_write` to a Standard account another platform already controls, and pushes the
   * seller towards a second account. That is a real dead end rather than a failure to retry, so it gets a page
   * that says what happened and offers Square instead; the provider's own code stays in `last_error`.
   */
  const heldElsewhere = (row: StateRow) =>
    page(
      'That Stripe account is connected to another platform',
      'Stripe only lets one platform manage an account. Either disconnect the other one in your Stripe ' +
        'dashboard and try again, create a second Stripe account for HandsFreeOS, or connect Square instead.',
      { href: paymentsUrl(row.workspace_id), label: 'Back to Payments' },
    );

  async function startPayment(row: StateRow, state: string, reply: FastifyReply) {
    if (!isPaymentProvider(row.provider)) return expired(reply, row.kind);
    const p = payments.providers[row.provider];
    const name = PAYMENT_NAME[row.provider];
    if (!p?.configured)
      return deadEnd(
        reply,
        503,
        `${name} isn’t set up yet`,
        `This server can’t connect ${name} accounts yet.`,
        { href: paymentsUrl(row.workspace_id), label: 'Back to Payments' },
      );
    // No PKCE here (see the file's header), so there is nothing to seal before sending the browser on: the
    // one-time state, already hashed on the row with ten minutes to live, is what ties the callback back.
    return reply
      .header('referrer-policy', 'no-referrer')
      .redirect(p.authorizeUrl({ state, redirectUri: callbackUrl(row.provider) }), 302);
  }

  async function paymentCallback(row: StateRow, q: CallbackQuery): Promise<FinishOutcome> {
    if (!isPaymentProvider(row.provider)) return { page: expiredPage(row.kind) };
    const provider = row.provider;
    const scope = scopeOf(row);
    const back = (result: 'connected' | 'cancelled' | 'missing_permissions' | 'failed') =>
      next(`${paymentsUrl(row.workspace_id)}?payments=${result}`);
    const note = (error: string) =>
      asWorker(deps.httpDb, scope, (tx) =>
        tx
          .update(paymentConnections)
          .set({ lastError: error.slice(0, 2000) })
          .where(eq(paymentConnections.id, row.connection_id)),
      );
    if (q.error || !q.code) {
      const raw = (q.error ?? 'no code').slice(0, 80);
      await note(`The sign-in ended without access (${raw}).`);
      // Stripe can refuse on the way back as well as in the exchange.
      if (/platform/i.test(`${q.error ?? ''} ${q.error_description ?? ''}`))
        return heldElsewhere(row);
      return back(q.error === 'access_denied' ? 'cancelled' : 'failed');
    }
    const p = payments.providers[provider];
    try {
      const tokens = await p.exchangeCode({ code: q.code, redirectUri: callbackUrl(provider) });
      // The account's own name and what it can actually do, read once, here.
      const account = await p.describe(tokens);
      if (account.missingScopes.length > 0) {
        await note(
          `Some permissions were left unticked on the sign-in screen (${account.missingScopes
            .slice(0, 5)
            .join(', ')}).`,
        );
        return back('missing_permissions');
      }
      await executeCommand(
        deps.httpDb,
        paymentConnectionActivate,
        {
          workspaceId: row.workspace_id,
          connectionId: row.connection_id,
          externalAccountId: account.externalAccountId,
          locationId: account.locationId,
          displayName: account.displayName,
          scopes: tokens.scopes.slice(0, 50).map((s) => s.slice(0, 200)),
          capabilities: { ...account.capabilities },
          tokenEnc: deps.sealer.seal(JSON.stringify(tokens)),
          tokenKeyId: deps.sealer.keyId,
          tokenExpiresAt: tokens.expiresAt,
          // Square's token lapses in 30 days, so its first renewal is booked now; Stripe's needs none.
          nextRefreshAt:
            nextRefreshAt(
              tokens.expiresAt,
              payments.refreshEveryMs,
              payments.refreshAheadMs,
            )?.toISOString() ?? null,
        },
        systemActor(scope),
        workerMeta(),
      );
      return back('connected');
    } catch (e) {
      // The provider's own code goes in beside the message: the page says it in plain words, and whoever has
      // to work out why has the word the provider actually used.
      await note(
        e instanceof PaymentAuthError ? `${errorMessage(e)} (${e.code})` : errorMessage(e),
      );
      if (e instanceof PaymentAuthError && e.code === ACCOUNT_HELD_ELSEWHERE)
        return heldElsewhere(row);
      // Another business here already has it, and its payments must keep reaching that business.
      if (e instanceof HfosError && e.rule === 'payment_account_connected_elsewhere')
        return page(
          'That account is connected to another business',
          'This account is already connected to another business on HandsFreeOS. Disconnect it there first, ' +
            'or connect a different account.',
          { href: paymentsUrl(row.workspace_id), label: 'Back to Payments' },
        );
      deps.log.warn(
        { connectionId: row.connection_id, provider, err: errorMessage(e) },
        'a payment account did not connect',
      );
      return back('failed');
    }
  }

  // Graph checks a new subscription's URLs with an empty text/plain POST.
  if (!app.hasContentTypeParser('text/plain'))
    app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) =>
      done(null, body),
    );
  /** The validation handshake: echo the token back as plain text within ten seconds. */
  const handshake = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const token = (req.query as { validationToken?: string }).validationToken;
    if (token === undefined) return false;
    void reply.code(200).type('text/plain; charset=utf-8').send(token);
    return true;
  };
  /** The mailbox a notification is for, if its clientState matches the one we made (compared as hashes). */
  async function verified(item: GraphItem): Promise<{ id: string; scope: TenantScope } | null> {
    if (!item.subscriptionId || !item.clientState) return null;
    const [row] = await asWorker(deps.httpDb, {}, (tx) =>
      rows<{
        connection_id: string;
        workspace_id: string;
        organization_id: string;
        client_state_hash: string | null;
      }>(tx, sql`select * from private.mailbox_connection_by_subscription(${item.subscriptionId})`),
    );
    if (!row?.client_state_hash) return null;
    const given = Buffer.from(sha256Hex(item.clientState));
    const expected = Buffer.from(row.client_state_hash);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      deps.log.warn('ignored an Outlook notification with the wrong clientState');
      return null;
    }
    return {
      id: row.connection_id,
      scope: { workspaceId: row.workspace_id, organizationId: row.organization_id },
    };
  }
  const items = (req: FastifyRequest): GraphItem[] =>
    (((req.body ?? {}) as { value?: GraphItem[] }).value ?? []).slice(0, 100);

  // Answer fast (Graph wants 2xx within three seconds): a notification only brings the sync forward.
  app.post('/webhooks/graph/notifications', async (req, reply) => {
    if (handshake(req, reply)) return reply;
    for (const item of items(req)) {
      const box = await verified(item);
      if (box) await syncSoon(deps.httpDb, box.scope, box.id);
    }
    return reply.code(202).send();
  });

  app.post('/webhooks/graph/lifecycle', async (req, reply) => {
    if (handshake(req, reply)) return reply;
    for (const item of items(req)) {
      const box = await verified(item);
      if (!box) continue;
      // Removed: the next sync makes a new subscription. Needs reauthorizing: renewing does that.
      if (
        item.lifecycleEvent === 'subscriptionRemoved' ||
        item.lifecycleEvent === 'reauthorizationRequired'
      )
        await asWorker(deps.httpDb, box.scope, (tx) =>
          tx
            .update(mailboxConnections)
            .set(
              item.lifecycleEvent === 'subscriptionRemoved'
                ? { subscriptionId: null, subscriptionExpiresAt: null }
                : { subscriptionExpiresAt: new Date(Date.now() + 60_000) },
            )
            .where(eq(mailboxConnections.id, box.id)),
        );
      await syncSoon(deps.httpDb, box.scope, box.id);
    }
    return reply.code(202).send();
  });

  // ---------- the stand-in payment sign-in (development and tests only) ----------
  // It stands apart from the mailbox and calendar one because it has no PKCE and because what it pretends is
  // different: which account signed in, whether the seller ticked everything, and Stripe's refusal to attach to
  // an account another platform controls.
  if (payments.fake) {
    const payCallback = (p: PaymentProviderName) => callbackUrl(p);
    app.get('/oauth/fake/payments/:provider/authorize', async (req, reply) => {
      const { provider } = req.params as { provider: string };
      const q = req.query as Record<string, string | undefined>;
      if (!isPaymentProvider(provider) || !q.state || q.redirect_uri !== payCallback(provider))
        return deadEnd(
          reply,
          400,
          'That sign-in link doesn’t work',
          'Go back to Settings → Payments and try again.',
        );
      const name = PAYMENT_NAME[provider];
      const hidden = (k: string, v: string) =>
        `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`;
      const suggested = `${provider === 'stripe' ? 'acct' : 'merchant'}_${Math.random().toString(36).slice(2, 10)}`;
      return reply
        .type('text/html; charset=utf-8')
        .send(
          shell(
            `Sign in to ${name}`,
            `<h1 style="font-size: 18px; margin: 0 0 8px;">Sign in to ${escapeHtml(name)}</h1>` +
              `<p style="font-size: 14px; line-height: 1.5; color: #5b616a; margin: 0 0 18px;">` +
              `A stand-in for ${escapeHtml(name)}’s sign-in on this development server. No real account is touched and no real money moves.</p>` +
              `<form method="get" action="/oauth/fake/payments/${provider}/approve">` +
              hidden('state', q.state) +
              hidden('redirect_uri', q.redirect_uri) +
              `<label for="account" style="display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px;">Account</label>` +
              `<input id="account" name="account" required value="${escapeHtml(suggested)}" ` +
              `style="width: 100%; box-sizing: border-box; height: 38px; padding: 0 10px; border: 1px solid #c9ced6; border-radius: 8px; font-size: 15px;">` +
              `<label style="display: block; font-size: 13px; margin-top: 12px;"><input type="checkbox" name="partial" value="1"> Leave a permission unticked</label>` +
              (provider === 'stripe'
                ? `<label style="display: block; font-size: 13px; margin-top: 6px;"><input type="checkbox" name="held" value="1"> This account is controlled by another platform</label>`
                : '') +
              `<div style="display: flex; gap: 8px; margin-top: 18px;">` +
              `<button type="submit" name="decision" value="allow" data-testid="fake-connect" style="height: 36px; padding: 0 16px; border: 0; border-radius: 8px; background: #2d69d8; color: #fff; font-weight: 600;">Connect</button>` +
              `<button type="submit" name="decision" value="deny" formnovalidate data-testid="fake-connect-cancel" style="height: 36px; padding: 0 16px; border: 1px solid #c9ced6; border-radius: 8px; background: #fff;">Cancel</button>` +
              `</div></form>`,
          ),
        );
    });

    app.get('/oauth/fake/payments/:provider/approve', async (req, reply) => {
      const { provider } = req.params as { provider: string };
      const q = req.query as Record<string, string | undefined>;
      // The stand-in only ever answers our own callback.
      if (!isPaymentProvider(provider) || !q.state || q.redirect_uri !== payCallback(provider))
        return deadEnd(
          reply,
          400,
          'That sign-in link doesn’t work',
          'Go back to Settings → Payments and try again.',
        );
      const target = new URL(q.redirect_uri);
      target.searchParams.set('state', q.state);
      const account = (q.account ?? '').trim();
      if (q.decision !== 'allow' || !account) target.searchParams.set('error', 'access_denied');
      else {
        if (q.held === '1') payments.fake?.holdAccount(account);
        target.searchParams.set(
          'code',
          fakePaymentCode({
            provider,
            accountId: account,
            displayName: account,
            partialScopes: q.partial === '1',
          }),
        );
      }
      return reply.redirect(target.toString(), 302);
    });
  }

  const fakeCalendars = calendars.fake;
  if (!fake && !fakeCalendars) return;

  // ---------- the fake providers (development and tests only; production refuses them) ----------
  app.get('/oauth/fake/:provider/authorize', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const q = req.query as Record<string, string | undefined>;
    if (
      (!isProvider(provider) && !isReviewProvider(provider) && !isMeetingProvider(provider)) ||
      !q.state ||
      !q.code_challenge ||
      q.redirect_uri !== callbackUrl(provider)
    )
      return deadEnd(
        reply,
        400,
        'That sign-in link doesn’t work',
        'Go back to Settings and try again.',
      );
    // One stand-in for all three: the state says whether a mailbox, a calendar or a review place is
    // signing in, and only a mailbox and a calendar have an email address to ask for.
    const kind = (await lookup(provider, q.state))?.kind;
    const reviewSignIn = kind === 'reviews' && isReviewProvider(provider);
    const name = isMeetingProvider(provider)
      ? MEETING_NAME[provider]
      : reviewSignIn
        ? REVIEW_NAME[provider]
        : kind === 'calendar' && isProvider(provider)
          ? CALENDAR_NAME[provider]
          : isProvider(provider)
            ? PROVIDER_NAME[provider]
            : provider;
    const intro = isMeetingProvider(provider)
      ? `A stand-in for ${name}’s sign-in on this development server. No real ${name} account is touched.`
      : reviewSignIn
        ? `A stand-in for ${name}’s sign-in on this development server. No real page or profile is touched.`
        : kind === 'calendar'
          ? `A stand-in for ${provider === 'google' ? 'Google' : 'Microsoft'}’s sign-in on this development server. No real calendar is touched.`
          : `A stand-in for ${name}’s sign-in on this development server. No real mailbox is touched.`;
    const hidden = (k: string, v: string) =>
      `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`;
    return reply.type('text/html; charset=utf-8').send(
      shell(
        `Sign in to ${name}`,
        `<h1 style="font-size: 18px; margin: 0 0 8px;">Sign in to ${name}</h1>` +
          `<p style="font-size: 14px; line-height: 1.5; color: #5b616a; margin: 0 0 18px;">${intro}</p>` +
          `<form method="get" action="/oauth/fake/${provider}/approve">` +
          hidden('state', q.state) +
          hidden('code_challenge', q.code_challenge) +
          hidden('redirect_uri', q.redirect_uri) +
          // A review place has no mailbox to name, so the field it would fill in is not asked for.
          (reviewSignIn
            ? hidden('email', `reviews@${provider}.fake`)
            : `<label for="email" style="display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px;">Email address</label>` +
              `<input id="email" name="email" type="email" required value="owner@${provider === 'microsoft' ? 'outlook' : provider === 'zoom' ? 'zoom' : 'gmail'}.fake" style="width: 100%; box-sizing: border-box; height: 38px; padding: 0 10px; border: 1px solid #c9ced6; border-radius: 8px; font-size: 15px;">`) +
          `<div style="display: flex; gap: 8px; margin-top: 18px;">` +
          `<button type="submit" name="decision" value="allow" style="height: 36px; padding: 0 16px; border: 0; border-radius: 8px; background: #2d69d8; color: #fff; font-weight: 600;">Allow</button>` +
          `<button type="submit" name="decision" value="deny" formnovalidate style="height: 36px; padding: 0 16px; border: 1px solid #c9ced6; border-radius: 8px; background: #fff;">Cancel</button>` +
          `</div></form>`,
      ),
    );
  });

  app.get('/oauth/fake/:provider/approve', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const q = req.query as Record<string, string | undefined>;
    // The fake only ever answers our own callback.
    if (
      (!isProvider(provider) && !isReviewProvider(provider) && !isMeetingProvider(provider)) ||
      !q.state ||
      q.redirect_uri !== callbackUrl(provider)
    )
      return deadEnd(
        reply,
        400,
        'That sign-in link doesn’t work',
        'Go back to Settings and try again.',
      );
    const target = new URL(q.redirect_uri);
    target.searchParams.set('state', q.state);
    if (q.decision !== 'allow' || !q.email) target.searchParams.set('error', 'access_denied');
    else target.searchParams.set('code', fakeCode(provider, q.email, q.code_challenge ?? ''));
    return reply.redirect(target.toString(), 302);
  });

  /** Someone emails a fake mailbox. Its next sync (every few seconds) brings it in. */
  if (fake)
    app.post('/test/mailboxes/deliver', async (req, reply) => {
      const b = (req.body ?? {}) as {
        account?: string;
        from?: { address?: string; name?: string };
        subject?: string;
        text?: string;
        html?: string;
        attachments?: { name: string; contentType: string; content: string }[];
      };
      const from = party(b.from?.address, b.from?.name);
      if (!b.account || !from)
        return reply.code(400).send({ error: 'account and from.address are required' });
      const id = fake.deliver(b.account, {
        from,
        subject: b.subject ?? '(no subject)',
        text: b.text ?? '',
        html: b.html ?? null,
        files: (b.attachments ?? []).slice(0, 10).map((a) => ({
          name: a.name,
          contentType: a.contentType,
          content: Buffer.from(a.content, 'base64'),
          contentId: null,
        })),
      });
      return reply.send({ providerMessageId: id });
    });

  if (!fakeCalendars) return;

  /** Something else in a fake calendar (a dentist appointment): the next refresh reads it as busy. */
  app.post('/test/calendars/busy', async (req, reply) => {
    const b = (req.body ?? {}) as { account?: string; start?: string; end?: string };
    const start = new Date(b.start ?? '');
    const end = new Date(b.end ?? '');
    if (!b.account || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start)
      return reply
        .code(400)
        .send({ error: 'account, start and end (ISO times, end after start) are required' });
    fakeCalendars.addBusy(b.account, start, end);
    return reply.send({ ok: true });
  });

  /** What HandsFreeOS wrote into a fake calendar. */
  app.get('/test/calendars/events', async (req, reply) => {
    const { account } = req.query as { account?: string };
    if (!account) return reply.code(400).send({ error: 'account is required' });
    return reply.send({ events: fakeCalendars.events(account) });
  });
}
