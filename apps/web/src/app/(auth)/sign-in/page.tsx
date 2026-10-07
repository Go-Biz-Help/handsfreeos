import type { Metadata } from 'next';
import Link from 'next/link';
import { OrDivider } from '@/components/auth/divider';
import { GoogleButton } from '@/components/auth/google-button';
import { PasskeyButton } from '@/components/auth/passkey-button';
import { Card } from '@/components/ui/card';
import { webSignInProviders } from '@/lib/auth/providers';
import { safeNext } from '@/lib/utils';
import { SignInForm } from './sign-in-form';

// The canonical drops `?next=` and `?error=`, so search engines see one sign-in page, not one per link to it.
export const metadata: Metadata = {
  title: 'Sign in to your account',
  description:
    'Sign in to HandsFreeOS to pick up your calls, texts, jobs and invoices where you left off.',
  alternates: { canonical: 'https://app.handsfreeos.com/sign-in' },
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = safeNext(typeof params.next === 'string' ? params.next : null);
  const error = typeof params.error === 'string' ? params.error : null;
  const providers = await webSignInProviders();
  return (
    <>
      <Card className="w-[440px] max-w-full rounded-dialog p-9 max-md:p-6">
        <SignInForm
          next={next}
          intro={
            <>
              <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.015em]">
                Welcome back
              </h1>
              <p className="mt-1.5 text-text-2">Sign in to your workspaces.</p>
              {error === 'link' ? (
                <p className="mt-4 rounded-menu bg-warning-soft px-3.5 py-3 text-[13.5px] text-warning-text">
                  That link is invalid or has expired. Sign in, or request a new one.
                </p>
              ) : null}
              {error === 'account' ? (
                <p className="mt-4 rounded-menu bg-warning-soft px-3.5 py-3 text-[13.5px] text-warning-text">
                  That account is no longer available. Sign in with another one, or create a new
                  account.
                </p>
              ) : null}
              {error === 'deleted' ? (
                <p
                  className="mt-4 rounded-menu bg-accent-soft px-3.5 py-3 text-[13.5px] text-accent-text"
                  data-testid="account-deleted"
                >
                  Your account is being deleted, and you’re signed out everywhere. The businesses
                  you worked with keep what you did there.
                </p>
              ) : null}
              {error === 'oauth' ? (
                <p className="mt-4 rounded-menu bg-danger-soft px-3.5 py-3 text-[13.5px] text-danger-text">
                  Google sign-in did not complete. Try again.
                </p>
              ) : null}
              <div className="mt-6 flex flex-col gap-2.5">
                {providers.google ? <GoogleButton next={next} /> : null}
                <PasskeyButton next={next} />
              </div>
              <OrDivider />
            </>
          }
        />
      </Card>
      <p className="text-[13px] text-text-2">
        New to HandsFreeOS?{' '}
        <Link
          href={`/sign-up${next !== '/app' ? `?next=${encodeURIComponent(next)}` : ''}`}
          className="font-medium text-accent-text hover:underline"
        >
          Create an account
        </Link>
      </p>
    </>
  );
}
