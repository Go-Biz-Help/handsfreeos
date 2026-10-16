import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { chatWindowProxy } from './lib/chat/frame';
import { brandedHostProxy } from './lib/hosting/branded-host';
import { formFrameProxy } from './lib/forms/frame';
import { sameOriginFrames } from './lib/frames';
import { zoomAppHeaders } from './lib/zoom-app';
import { safeNext } from './lib/utils';

const PROTECTED = ['/app', '/onboarding', '/invite', '/chat-preview', '/founding', '/zoom'];
const AUTH_PAGES = ['/sign-in', '/sign-up'];

/** Refreshes the Supabase session cookie on every request and gates protected routes. */
export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  // A business's own domain (M17): `go.lonestarhvac.com` is that business's booking page, and a bare
  // name on it is one of its forms. Checked first, and null on every request to our own address, so this
  // costs one header comparison for everybody else.
  const branded = await brandedHostProxy(request);
  if (branded) return branded;
  // The website chat runs inside businesses' own sites for signed-out visitors, so the loader and the chat
  // window never touch the session. The window's frame rule is set per widget (lib/chat/frame.ts).
  if (path.startsWith('/embed/')) return NextResponse.next();
  // The files that let the phone app open links (lib/app-links.ts): fetched by Apple's and Google's servers with no
  // session, and never redirected. The matcher leaves them out too; this is the belt to its braces.
  if (path.startsWith('/.well-known/')) return NextResponse.next();
  if (path.startsWith('/chat/')) return chatWindowProxy(request);
  // A public form can be embedded on the business's own site: its frame rule says which one (lib/forms/frame.ts).
  if (path.startsWith('/f/')) return formFrameProxy(request);

  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          for (const c of list) request.cookies.set(c.name, c.value);
          response = NextResponse.next({ request });
          for (const c of list) response.cookies.set(c.name, c.value, c.options);
        },
      },
    },
  );
  // getClaims verifies the token signature against JWKS and refreshes an expiring session.
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);

  if (!signedIn && PROTECTED.some((p) => path === p || path.startsWith(`${p}/`))) {
    const url = request.nextUrl.clone();
    url.pathname = '/sign-in';
    url.search = '';
    url.searchParams.set('next', safeNext(path + request.nextUrl.search));
    // Zoom checks its headers on every answer, the step to sign-in included.
    return zoomAppHeaders(request, sameOriginFrames(NextResponse.redirect(url)));
  }
  if (signedIn && AUTH_PAGES.includes(path)) {
    const url = request.nextUrl.clone();
    url.pathname = safeNext(request.nextUrl.searchParams.get('next'));
    url.search = '';
    return zoomAppHeaders(request, sameOriginFrames(NextResponse.redirect(url)));
  }
  // Nothing else is meant to be embedded: no page of the app can be framed by another site (clickjacking).
  // Inside Zoom, its app pages also carry the headers Zoom requires (lib/zoom-app.ts).
  return zoomAppHeaders(request, sameOriginFrames(response));
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|\\.well-known/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
