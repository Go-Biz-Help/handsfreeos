import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { chatWindowProxy } from './lib/chat/frame';
import { safeNext } from './lib/utils';

const PROTECTED = ['/app', '/onboarding', '/invite', '/chat-preview'];
const AUTH_PAGES = ['/sign-in', '/sign-up'];

/** Refreshes the Supabase session cookie on every request and gates protected routes. */
export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  // The website chat runs inside businesses' own sites for signed-out visitors, so the loader and the chat
  // window never touch the session. The window's frame rule is set per widget (lib/chat/frame.ts).
  if (path.startsWith('/embed/')) return NextResponse.next();
  if (path.startsWith('/chat/')) return chatWindowProxy(request);

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
    return NextResponse.redirect(url);
  }
  if (signedIn && AUTH_PAGES.includes(path)) {
    const url = request.nextUrl.clone();
    url.pathname = safeNext(request.nextUrl.searchParams.get('next'));
    url.search = '';
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
