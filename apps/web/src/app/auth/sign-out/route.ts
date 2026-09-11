import { NextResponse, type NextRequest } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';

/**
 * Clears the session cookies and returns to sign-in. Used when a still-valid token belongs to an
 * account that no longer exists (deleted, or a reset local database), where the normal sign-out
 * would need the account to answer.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const supabase = await supabaseServer();
  await supabase.auth.signOut({ scope: 'local' });
  const url = request.nextUrl.clone();
  url.pathname = '/sign-in';
  url.search = '';
  if (request.nextUrl.searchParams.get('reason') === 'account')
    url.searchParams.set('error', 'account');
  return NextResponse.redirect(url);
}
