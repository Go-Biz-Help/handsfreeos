/**
 * Opinly's publish webhook, delivered by Svix. Register this address in Opinly's dashboard (Settings →
 * Developers → Webhooks), subscribed to `content.routes-changed`:
 *
 *   https://handsfreeos.com/api/opinly-webhook
 *
 * and put the endpoint's signing secret in `OPINLY_WEBHOOK_SIGNING_SECRET`.
 *
 * Two caches hold a post, and both are cleared:
 *
 * 1. **The API answers**, every one tagged `opinly` (lib/opinly/client.ts). One `revalidateTag` drops them all.
 *    `{ expire: 0 }` matters: on Next 16 the second argument is required, and a named profile like `'max'`
 *    would keep serving the old post while it refreshed behind it. A publish should be visible now.
 * 2. **The rendered pages** that changed, by path — the same mapping the sitemap uses (`routePath`), so the
 *    two can never name different pages. Paths alone would not be enough: on a self-hosted deployment
 *    `revalidatePath` silently does nothing for a page rendered per request. Tags have no such gap.
 *
 * 200 once handled, 400 for anything unsigned or signed wrongly — Svix retries a failure, so an error here is
 * only ever returned when a retry could help. Nothing about the post is read from the body beyond its type and
 * slug; the pages refetch the post itself from the API.
 */
import { revalidatePath, revalidateTag } from 'next/cache';
import { Webhook, WebhookVerificationError } from 'svix';
import { OPINLY_CACHE_TAG } from '@/lib/opinly/client';
import { blogPaths, routePath } from '@/lib/opinly/paths';
import type { OpinlyRouteType } from '@/lib/opinly/types';

const ROUTE_TYPES: readonly OpinlyRouteType[] = ['home', 'post', 'category', 'author', 'tag'];

interface Change {
  type: OpinlyRouteType;
  slug: string;
}

/** The entries we can act on. Anything malformed is skipped rather than failing the whole delivery. */
function changesOf(payload: unknown): Change[] {
  const changed = (payload as { data?: { changed?: unknown } })?.data?.changed;
  if (!Array.isArray(changed)) return [];
  return changed.flatMap((entry: unknown) => {
    const { type, slug } = (entry ?? {}) as { type?: unknown; slug?: unknown };
    if (typeof type !== 'string' || !ROUTE_TYPES.includes(type as OpinlyRouteType)) return [];
    if (typeof slug !== 'string') return [];
    // A slug is one path segment. Anything else is not a page of ours, whatever signed it.
    if (type !== 'home' && !/^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(slug)) return [];
    return [{ type: type as OpinlyRouteType, slug }];
  });
}

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.OPINLY_WEBHOOK_SIGNING_SECRET;
  if (!secret) {
    // Ours to fix, not the sender's: 500 so Svix keeps retrying until the secret is set.
    console.error('[opinly-webhook] OPINLY_WEBHOOK_SIGNING_SECRET is not set');
    return new Response('Webhook secret not configured', { status: 500 });
  }

  // The signature covers the exact bytes sent, so the body is read raw and verified before it is parsed.
  const body = await request.text();
  const headers = {
    'svix-id': request.headers.get('svix-id') ?? '',
    'svix-timestamp': request.headers.get('svix-timestamp') ?? '',
    'svix-signature': request.headers.get('svix-signature') ?? '',
  };

  try {
    // svix 2 only checks here — it throws on a bad signature and returns nothing — unlike 1.x (and Opinly's
    // docs), which handed back the parsed event. So the body is parsed below, once it is known to be genuine.
    new Webhook(secret).verify(body, headers);
  } catch (error) {
    if (!(error instanceof WebhookVerificationError)) console.error('[opinly-webhook]', error);
    return new Response('Invalid signature', { status: 400 });
  }

  let event: unknown;
  try {
    event = JSON.parse(body);
  } catch {
    // Signed, so it came from Opinly, but unreadable: say so, and a retry will not help.
    return new Response('Unreadable payload', { status: 400 });
  }

  const type = (event as { type?: unknown })?.type;
  if (type !== 'content.routes-changed') {
    // Some other event this endpoint was subscribed to. Acknowledge it so Svix stops sending it.
    return new Response('ok', { status: 200 });
  }

  // 1. Every cached API answer, gone now.
  revalidateTag(OPINLY_CACHE_TAG, { expire: 0 });

  // 2. The pages that show what changed.
  const paths = new Set<string>();
  for (const change of changesOf(event)) {
    paths.add(routePath(change));
    if (change.type === 'home') {
      // "Something structural changed": the lists, the directories, the sitemap and the feed.
      paths.add(blogPaths.categories());
      paths.add(blogPaths.authors());
      paths.add('/sitemap.xml');
      paths.add(blogPaths.rss());
    }
  }
  // Any change can move what the blog's front page shows.
  paths.add(blogPaths.index());
  for (const path of paths) revalidatePath(path);

  console.info(`[opinly-webhook] revalidated ${paths.size} paths`, [...paths]);
  return Response.json({ ok: true, revalidated: [...paths] });
}
