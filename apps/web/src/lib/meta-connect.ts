import { apiBrowser, unwrap } from '@/lib/api/client';
import { publicEnv } from '@/lib/env';

/**
 * Connecting Facebook (20261025000200), shared by Settings → Facebook & Instagram and the guided setup: a one-time
 * state from `meta_connection.connect`, then the worker's `/oauth/facebook/start`. Facebook sends the browser back
 * through the worker to /app/oauth/finish, which asks which Pages when the sign-in manages several, and the worker
 * comes back to Settings → Facebook & Instagram with `?meta=` (or the setup's test, when it started the sign-in).
 */

/** What the worker came back with, from `?meta=` and its counts. */
export interface MetaResult {
  readonly meta: string;
  readonly facebook: number;
  readonly instagram: number;
  readonly skipped: number;
}

const count = (v: string | string[] | undefined) =>
  typeof v === 'string' && /^[0-9]{1,4}$/.test(v) ? Number(v) : 0;

/** The result from a page's query, or null when it isn't the way back from Facebook. */
export function metaResultOf(q: Record<string, string | string[] | undefined>): MetaResult | null {
  return typeof q['meta'] === 'string'
    ? {
        meta: q['meta'],
        facebook: count(q['facebook']),
        instagram: count(q['instagram']),
        skipped: count(q['skipped']),
      }
    : null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function metaResultWords(r: MetaResult): {
  tone: 'success' | 'info' | 'error';
  text: string;
} {
  if (r.meta === 'connected') {
    const what = [
      r.facebook ? plural(r.facebook, 'Facebook Page', 'Facebook Pages') : null,
      r.instagram ? plural(r.instagram, 'Instagram account', 'Instagram accounts') : null,
    ]
      .filter(Boolean)
      .join(' and ');
    const skipped = r.skipped
      ? ` ${plural(r.skipped, 'other was', 'others were')} connected to another business in the meantime.`
      : '';
    return {
      tone: 'success',
      text: `Connected ${what || 'Facebook'}. Their messages arrive in the inbox from now on.${skipped}`,
    };
  }
  if (r.meta === 'cancelled')
    return { tone: 'info', text: 'Sign-in cancelled. Nothing was connected.' };
  return {
    tone: 'error',
    text: 'Facebook didn’t connect. Choose Connect Facebook again in a minute.',
  };
}

/** Starts connecting: a one-time state, then Facebook's own sign-in. */
export async function connectFacebook(workspaceId: string): Promise<void> {
  const out = unwrap(
    await apiBrowser().POST('/v1/commands/meta_connection.connect', { body: { workspaceId } }),
  );
  window.location.assign(
    `${publicEnv.workerUrl}/oauth/facebook/start?state=${encodeURIComponent(out.state)}`,
  );
}
