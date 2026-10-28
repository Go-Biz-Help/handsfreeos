'use client';
import { providerSignInMessage } from '@hfos/core';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { AffiliateTrail } from '@/lib/auth/visitor';
import { supabaseBrowser } from '@/lib/supabase/client';
import { safeNext } from '@/lib/utils';

function GoogleG() {
  return (
    <svg className="h-[18px] w-[18px]" viewBox="0 0 48 48" aria-hidden>
      <path
        fill="#EA4335"
        d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.3l7.8 6C12.3 13.6 17.7 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z"
      />
      <path
        fill="#FBBC05"
        d="M10.4 28.7A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.7l-7.8-6A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.7l7.8-6z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.9 2.3-8.4 2.3-6.3 0-11.7-4.1-13.6-9.9l-7.8 6C6.5 42.6 14.6 48 24 48z"
      />
    </svg>
  );
}

/**
 * Continue with Google, on the sign-in and sign-up pages once Google is turned on in Supabase. It signs in, or makes
 * the account the first time. `visitor` is the website's Opinly visitor id from a sign-up link, `affiliate` the
 * affiliate link they came by and `code` a discount or trial code's link (`lib/auth/visitor.ts`): each kept on a new
 * account by the callback, as the email sign-up keeps them. The code goes as `promo`, since the callback's `code` is
 * Google's.
 */
export function GoogleButton({
  next,
  visitor,
  affiliate,
  code,
  label = 'Continue with Google',
}: {
  next?: string;
  visitor?: string;
  affiliate?: AffiliateTrail;
  code?: string;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="secondary"
      size="lg"
      className="w-full"
      loading={busy}
      data-testid="google-sign-in"
      onClick={async () => {
        setBusy(true);
        const back = new URLSearchParams({ next: safeNext(next) });
        if (visitor) back.set('oa', visitor);
        if (affiliate) {
          back.set('ref', affiliate.ref);
          back.set('ref_at', affiliate.refAt);
        }
        if (code) back.set('promo', code);
        const redirectTo = `${window.location.origin}/auth/callback?${back}`;
        const { data, error } = await supabaseBrowser().auth.signInWithOAuth({
          provider: 'google',
          options: { redirectTo, skipBrowserRedirect: true },
        });
        if (error || !data.url) {
          setBusy(false);
          toast.error(providerSignInMessage('google', error?.code ?? null));
          return;
        }
        window.location.assign(data.url);
      }}
    >
      <GoogleG />
      {label}
    </Button>
  );
}
