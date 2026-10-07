import { NextResponse } from 'next/server';
import { opinlyVisitor } from '@/lib/auth/visitor';
import { supabaseServer } from '@/lib/supabase/server';
import { safeNext } from '@/lib/utils';

/** How recently an account was made for a Continue with Google to count as signing up rather than signing in. */
const NEW_ACCOUNT_MS = 10 * 60_000;

/**
 * OAuth (PKCE) return: exchange the code for a session, then continue to `next`. Continue with Google on the sign-up
 * page also carries the website's Opinly visitor id (`oa`): a new account keeps it, as the email sign-up does, so the
 * worker can credit the sign-up to what brought them. A deleted account's Google sign-in comes back banned, and the
 * sign-in page says that account is no longer available.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = safeNext(url.searchParams.get('next'));
  if (code) {
    const supabase = await supabaseServer();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const visitor = opinlyVisitor(url.searchParams.get('oa'));
      const user = data.user;
      if (
        user &&
        visitor &&
        !user.user_metadata?.opinly_anon_id &&
        Date.now() - new Date(user.created_at).getTime() < NEW_ACCOUNT_MS
      )
        await supabase.auth.updateUser({ data: { opinly_anon_id: visitor } });
      return NextResponse.redirect(new URL(next, url.origin));
    }
  }
  const refused = `${url.searchParams.get('error_code') ?? ''} ${url.searchParams.get('error_description') ?? ''}`;
  return NextResponse.redirect(
    new URL(
      /banned/i.test(refused) ? '/sign-in?error=account' : '/sign-in?error=oauth',
      url.origin,
    ),
  );
}
