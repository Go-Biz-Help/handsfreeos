import type { NextRequest } from 'next/server';
import { loaderScript } from '@/lib/chat/loader';
import { lookupChat } from '@/lib/chat/lookup';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A 404 or a paused widget's empty script: a minute in browsers and on the CDN. */
const MINUTE = 'public, max-age=60, s-maxage=60';

function script(body: string, status: number, cache: string): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': cache,
      'x-content-type-options': 'nosniff',
    },
  });
}

/**
 * GET /embed/v1/<key>.js: the loader a business pastes on its site (lib/chat/loader.ts), kept for 5 minutes by
 * browsers and by the CDN. Vercel's CDN keeps a function's answer only when Cache-Control has s-maxage, and strips
 * it before the browser sees it, so browsers get `public, max-age=300`. An unknown key (or one replaced by "New key")
 * gets a 404, and a paused widget an empty script, so the button doesn't show; both are kept for a minute. proxy.ts
 * leaves /embed alone: no session work for signed-out visitors, and no cookie to stop the CDN keeping it.
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ file: string }> }) {
  const { file } = await ctx.params;
  const key = /^(wk_[A-Za-z0-9]{20})\.js$/.exec(file)?.[1];
  // The preview page (/chat-preview) loads the same script for a signed-in manager: never kept by shared caches.
  const asked = request.nextUrl.searchParams.get('preview');
  const preview = asked && UUID.test(asked) ? asked.toLowerCase() : null;
  const found = key ? await lookupChat(key, null) : ({ state: 'missing' } as const);
  if (found.state === 'missing' || found.state === 'refused')
    return script('/* HandsFreeOS: this chat isn’t available. */\n', 404, MINUTE);
  if (found.state === 'unreachable')
    return script('/* HandsFreeOS: the chat couldn’t load this time. */\n', 503, 'no-store');
  if (found.config.paused && !preview)
    return script('/* HandsFreeOS: this chat is paused. */\n', 200, MINUTE);
  const { look, business } = found.config;
  return script(
    loaderScript({
      app: request.nextUrl.origin,
      key: key!,
      business: business.name,
      label: look.launcherLabel,
      accent: look.accentColor,
      position: look.position,
      preview,
    }),
    200,
    preview ? 'private, no-store' : 'public, max-age=300, s-maxage=300',
  );
}
