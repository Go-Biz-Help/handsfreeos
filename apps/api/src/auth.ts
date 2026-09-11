import { HfosError, type HumanActor } from '@hfos/core/server';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { ApiEnv } from './env';

export type TokenVerifier = (token: string) => Promise<HumanActor>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toActor(payload: JWTPayload): HumanActor {
  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  const email = typeof payload['email'] === 'string' ? payload['email'] : '';
  if (payload['role'] !== 'authenticated') throw HfosError.unauthenticated();
  if (payload['is_anonymous'] === true)
    throw HfosError.unauthenticated('Anonymous sessions cannot use HandsFreeOS.');
  if (!UUID.test(sub) || !email) throw HfosError.unauthenticated();
  // Audience was verified above; keep it a plain string so auth.jwt() sees what PostgREST would.
  return {
    type: 'human',
    userId: sub,
    email,
    claims: { ...payload, sub, email, role: 'authenticated', aud: 'authenticated' },
  };
}

/**
 * Verifies Supabase-issued access tokens against the project's JWKS. ES256 only: a leaked legacy
 * HS256 secret can never mint a token this API accepts. Keys are cached by `kid`, so rotation needs no deploy.
 */
export function createTokenVerifier(env: Pick<ApiEnv, 'jwksUrl' | 'jwtIssuer'>): TokenVerifier {
  const jwks = createRemoteJWKSet(new URL(env.jwksUrl));
  return async (token) => {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, jwks, {
        issuer: env.jwtIssuer,
        audience: 'authenticated',
        algorithms: ['ES256'],
        clockTolerance: 30,
      }));
    } catch {
      throw HfosError.unauthenticated();
    }
    return toActor(payload);
  };
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1]?.trim() || null;
}
