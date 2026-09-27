/**
 * Finishing a sign-in the way the app's `/app/oauth/finish` page does (SEC-M1, SEC-M7): the callback connects
 * nothing and sends the browser to the app with a sealed handoff after the `#`; the app posts it back to the
 * worker signed in, and only then is the account connected.
 *
 * `finishSignIn` takes the callback's answer and does the app's half, so a test reads as it did before the
 * handoff: a sign-in that ends in Settings comes back as a 302 to that page, a dead end as its words.
 */
import { createTokenVerifier, type TokenVerifier } from '@hfos/core/server';
import { testEnv } from '@hfos/db/testing';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

/** The verifier the worker uses in production, pointed at the local Supabase, for the finishing POST. */
export function testTokenVerifier(): TokenVerifier {
  const env = testEnv();
  return createTokenVerifier({
    jwksUrl: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
    jwtIssuer: `${env.supabaseUrl}/auth/v1`,
  });
}

export interface Finished {
  /** 302 when it ended somewhere in the app; otherwise the status of whatever answered. */
  readonly status: number;
  readonly location: string | null;
  /** A dead end's title and words, or the page the worker itself showed. */
  readonly body: string;
  /** The review places to choose from, when the sign-in speaks for several. */
  readonly places: readonly { id: string; name: string }[] | null;
  /** The sealed handoff, for answering the chooser. */
  readonly handoff: string | null;
}

type Outcome =
  | { next: string }
  | { page: { title: string; body: string } }
  | { choose: { places: { id: string; name: string }[] } };

/** The handoff and its door, if this answer is the callback sending the browser to the app. */
export function handoffOf(
  res: LightMyRequestResponse,
): { door: 'oauth' | 'migrations'; handoff: string } | null {
  if (res.statusCode !== 302 || !res.headers.location) return null;
  const url = new URL(String(res.headers.location));
  if (url.pathname !== '/app/oauth/finish' || !url.hash) return null;
  return {
    door: url.searchParams.get('door') === 'migration' ? 'migrations' : 'oauth',
    handoff: decodeURIComponent(url.hash.slice(1)),
  };
}

const asFinished = (res: LightMyRequestResponse, handoff: string | null): Finished => {
  if (res.statusCode !== 200)
    return { status: res.statusCode, location: null, body: res.body, places: null, handoff };
  const out = res.json() as Outcome;
  if ('next' in out) return { status: 302, location: out.next, body: '', places: null, handoff };
  if ('choose' in out)
    return { status: 200, location: null, body: '', places: out.choose.places, handoff };
  return {
    status: 200,
    location: null,
    body: `${out.page.title}\n${out.page.body}`,
    places: null,
    handoff,
  };
};

/** Does the app's half of a callback's answer, signed in with `token` (null: signed out). */
export async function finishSignIn(
  app: FastifyInstance,
  callback: LightMyRequestResponse,
  token: string | null,
): Promise<Finished> {
  const h = handoffOf(callback);
  if (!h)
    return {
      status: callback.statusCode,
      location: callback.headers.location ? String(callback.headers.location) : null,
      body: callback.body,
      places: null,
      handoff: null,
    };
  const res = await app.inject({
    method: 'POST',
    url: `/v1/${h.door}/finish`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: { handoff: h.handoff },
  });
  return asFinished(res, h.handoff);
}

/** Answers the review chooser, as the app's buttons do. */
export async function choosePlace(
  app: FastifyInstance,
  handoff: string,
  place: string,
  token: string | null,
): Promise<Finished> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/oauth/place',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: { handoff, place },
  });
  return asFinished(res, handoff);
}
