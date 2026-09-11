import type { EmailOtpType } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { safeNext } from '@/lib/utils';

const TYPES = new Set<EmailOtpType>([
  'signup',
  'email',
  'recovery',
  'email_change',
  'invite',
  'magiclink',
]);

/** Email link landing: verifies the token hash from our templates and starts the session. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const tokenHash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type') as EmailOtpType | null;
  if (tokenHash && type && TYPES.has(type)) {
    const supabase = await supabaseServer();
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (!error) {
      const target =
        type === 'recovery'
          ? '/reset-password'
          : type === 'email_change'
            ? '/app/settings'
            : safeNext(url.searchParams.get('next'), '/onboarding');
      return NextResponse.redirect(new URL(target, url.origin));
    }
  }
  return NextResponse.redirect(new URL('/sign-in?error=link', url.origin));
}
