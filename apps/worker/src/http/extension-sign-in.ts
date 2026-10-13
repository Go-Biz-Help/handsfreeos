/**
 * Signing in to the browser extension with a prompt on the phone or the web (20261027002910,
 * apps/extension/README.md "Signing in with a prompt"). The extension's two doors, before anybody is signed in:
 *
 * - `POST /public/extension-sign-in/start` `{ email, browser }`: a new request. The answer is the same whether or not
 *   the email has an account (a request id, the number to show, the extension's secret and when it ends), so it
 *   tells nobody who has one. Only when it has one, and that person has a phone on, is a push queued, in the same
 *   transaction (`extension_sign_in`). Open HandsFreeOS tabs find it by asking (`extension_sign_in.pending`).
 *   Limited per address and per email.
 * - `POST /public/extension-sign-in/collect` `{ requestId, secret }`: the extension asking every couple of seconds.
 *   Waiting, refused or expired; or, once the person picked the right number, approved with a one-time sign-in token
 *   (a magic link's hashed token that is never emailed), made here with the worker's admin key and handed over once.
 *   The extension redeems it with Supabase Auth (`verifyOtp`). Nothing about the token is stored.
 *
 * Answering is the person's, signed in, through the API (`extension_sign_in.answer`). Every answer here is no-store.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import {
  ExtensionSignInCollectInput,
  ExtensionSignInStartInput,
  extensionSignInNumbers,
  extensionSignInPushWords,
  HfosError,
  PERSONAL_PUSH_PATH,
  type ExtensionSignInCollectOutput,
  type ExtensionSignInStartOutput,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { ipHmacOf } from '../chat/store';
import { KeyedLimiter } from '../chat/limiter';
import { errorMessage } from '../outbox';
import { queuePersonalPush } from '../push/queue';
import { parseBody, type HttpDeps } from './common';

const MIN = 60_000;

/** Limits, per worker machine (tests and local runs scale them with the booking page's factor). */
export const EXTENSION_SIGN_IN_LIMITS = {
  /** Requests started from one address. */
  startPerIp: { max: 10, timeWindow: MIN },
  /** Requests started for one email, from anywhere: a prompt every 30 seconds at most, on average. */
  startPerEmail: { max: 5, timeWindow: 3 * MIN },
  /** Polls from one address: one every two seconds for a couple of extensions. */
  collectPerIp: { max: 120, timeWindow: MIN },
} as const;

const secretHashOf = (secret: string): Buffer => createHash('sha256').update(secret).digest();

const tooMany = () =>
  HfosError.rule(
    'rate_limited',
    429,
    'That’s a lot of sign-in prompts. Wait a few minutes, then try again, or use an emailed code instead.',
  );

export async function registerExtensionSignInRoutes(
  app: FastifyInstance,
  deps: HttpDeps,
): Promise<void> {
  const factor = Math.max(1, Math.floor(deps.booking?.limitFactor ?? 1));
  const ipKey = deps.chat?.ipKey ?? randomBytes(32).toString('base64');
  const limiter = new KeyedLimiter();
  const scaled = (r: { max: number; timeWindow: number }) => ({
    max: r.max * factor,
    timeWindow: r.timeWindow,
  });

  await app.register(async (pub) => {
    await pub.register(rateLimit, { global: false });
    pub.addHook('onSend', async (_req, reply, payload) => {
      reply.header('cache-control', 'no-store');
      reply.header('referrer-policy', 'no-referrer');
      return payload;
    });

    pub.post(
      '/public/extension-sign-in/start',
      { config: { rateLimit: scaled(EXTENSION_SIGN_IN_LIMITS.startPerIp) } },
      async (req): Promise<ExtensionSignInStartOutput> => {
        const input = parseBody(ExtensionSignInStartInput, req.body ?? {});
        const emailKey = createHash('sha256').update(input.email).digest('hex');
        const taken = limiter.take([
          { key: `email:${emailKey}`, rule: scaled(EXTENSION_SIGN_IN_LIMITS.startPerEmail) },
        ]);
        if (!taken.ok) throw tooMany();
        const secret = randomBytes(32).toString('base64url');
        const { number, choices } = extensionSignInNumbers((below) => randomInt(below));
        const row = await asWorker(deps.httpDb, {}, async (tx) => {
          const [made] = await rows<{
            id: string;
            user_id: string | null;
            expires_at: Date | string;
          }>(
            tx,
            sql`select id, user_id, expires_at from private.start_extension_sign_in(
                  ${input.email}, ${secretHashOf(secret)}, ${number}::smallint,
                  array[${sql.join(
                    choices.map((c) => sql`${c}::smallint`),
                    sql`, `,
                  )}]::smallint[], ${input.browser}, ${ipHmacOf(ipKey, req.ip)})`,
          );
          if (!made) throw new Error('the sign-in request was not made');
          if (made.user_id) {
            // In a savepoint of its own: a push that can't be queued never costs the request (the web still asks).
            try {
              await tx.transaction(async (sp) => {
                const words = extensionSignInPushWords(input.browser);
                await queuePersonalPush(sp, {
                  key: `extension_sign_in:${made.id}`,
                  category: 'extension_sign_in',
                  userId: made.user_id!,
                  title: words.title,
                  body: words.body,
                  path: `${PERSONAL_PUSH_PATH}${made.id}`,
                  refs: { signInId: made.id },
                  collapseId: `sign-in-${made.id}`,
                });
              });
            } catch (e) {
              req.log.warn({ err: errorMessage(e) }, 'could not queue the sign-in prompt’s push');
            }
          }
          return made;
        });
        return {
          requestId: row.id,
          number,
          secret,
          expiresAt: new Date(row.expires_at).toISOString(),
        };
      },
    );

    pub.post(
      '/public/extension-sign-in/collect',
      { config: { rateLimit: scaled(EXTENSION_SIGN_IN_LIMITS.collectPerIp) } },
      async (req): Promise<ExtensionSignInCollectOutput> => {
        const input = parseBody(ExtensionSignInCollectInput, req.body ?? {});
        const [found] = await asWorker(deps.httpDb, {}, (tx) =>
          rows<{ status: string; email: string | null }>(
            tx,
            sql`select status, email from private.collect_extension_sign_in(
                  ${input.requestId}::uuid, ${secretHashOf(input.secret)})`,
          ),
        );
        const status = found?.status ?? 'expired';
        if (status === 'waiting' || status === 'refused' || status === 'expired') return { status };
        // Approved, and now marked collected: the sign-in is made once, here, for whoever holds the secret.
        const undo = () =>
          asWorker(deps.httpDb, {}, (tx) =>
            tx.execute(sql`select private.uncollect_extension_sign_in(${input.requestId}::uuid)`),
          );
        if (!deps.authAdmin || !found?.email) {
          await undo();
          throw HfosError.rule(
            'sign_in_unavailable',
            503,
            'HandsFreeOS couldn’t finish signing you in just now. Use an emailed code instead.',
          );
        }
        try {
          const tokenHash = await deps.authAdmin.mintSignIn(found.email);
          return { status: 'approved', tokenHash };
        } catch (e) {
          await undo().catch(() => undefined);
          req.log.warn({ err: errorMessage(e) }, 'could not make the extension’s sign-in');
          throw HfosError.rule(
            'sign_in_unavailable',
            503,
            'HandsFreeOS couldn’t finish signing you in just now. Try again in a minute, or use an emailed code instead.',
          );
        }
      },
    );
  });
}
