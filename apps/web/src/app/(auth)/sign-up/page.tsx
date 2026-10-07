import type { Metadata } from 'next';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { webSignInProviders } from '@/lib/auth/providers';
import { opinlyVisitor } from '@/lib/auth/visitor';
import { safeNext } from '@/lib/utils';
import { SignUpForm } from './sign-up-form';

// The canonical drops `?next=` and the site's `?oa=`, so search engines see one sign-up page.
export const metadata: Metadata = {
  title: 'Create your account',
  description:
    'Create your HandsFreeOS account, then set up your business: calls, texts, booking, quotes and invoices in one place.',
  alternates: { canonical: 'https://app.handsfreeos.com/sign-up' },
};

/** Where a new account goes once it's made: setting up a business, or back to an invitation it came from. */
const FIRST_STOP = '/onboarding';

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = safeNext(typeof params.next === 'string' ? params.next : null, FIRST_STOP);
  const providers = await webSignInProviders();
  return (
    <>
      <Card className="w-[440px] max-w-full rounded-dialog p-9 max-md:p-6">
        <SignUpForm next={next} visitor={opinlyVisitor(params.oa)} google={providers.google} />
      </Card>
      <p className="text-[13px] text-text-2">
        Already have an account?{' '}
        <Link
          href={`/sign-in${next !== FIRST_STOP ? `?next=${encodeURIComponent(next)}` : ''}`}
          className="font-medium text-accent-text hover:underline"
        >
          Sign in
        </Link>
      </p>
    </>
  );
}
