/**
 * The address a business's public links should be shown on (M17).
 *
 * Every screen that hands a business a link to copy — the booking page, a calendar, a form and its QR code,
 * the chat snippet — shows it on their own domain once one is serving, because that is the address they are
 * about to put on a van or a flyer. Fetched per page rather than in the workspace layout: only the handful
 * of pages that show a public link pay for the query.
 *
 * Returns null when there is no domain, when it is not serving yet, or when the query fails — every caller
 * falls back to the address the browser is already on, which is what it showed before this existed.
 */
import type { apiServer } from '@/lib/api/server';

type Api = Awaited<ReturnType<typeof apiServer>>['api'];

export async function brandedOriginFor(api: Api, workspaceId: string): Promise<string | null> {
  try {
    const res = await api.POST('/v1/queries/branded_domain.get', { body: { workspaceId } });
    const d = res.data?.domain;
    return d && d.status === 'verified' && d.certificateReady ? `https://${d.domain}` : null;
  } catch {
    return null;
  }
}
