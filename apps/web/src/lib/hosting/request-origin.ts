/**
 * The address a public page was asked for on, "https://go.lonestarhvac.com" or our own, read on the server. The
 * simple page shows its Chat button only where the business's website chat is set up, and that's decided by this
 * address (the worker's booking/page.ts). Null when the request doesn't say.
 */
import { headers } from 'next/headers';

const LOCAL = /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/;

export async function requestOrigin(): Promise<string | null> {
  const h = await headers();
  const host = (h.get('x-forwarded-host') ?? h.get('host'))?.split(',')[0]?.trim().toLowerCase();
  if (!host) return null;
  const proto =
    h.get('x-forwarded-proto')?.split(',')[0]?.trim() || (LOCAL.test(host) ? 'http' : 'https');
  return `${proto === 'http' ? 'http' : 'https'}://${host}`;
}
