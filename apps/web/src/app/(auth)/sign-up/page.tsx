import type { Metadata } from 'next';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { webSignInProviders } from '@/lib/auth/providers';
import { affiliateTrail, discountCode, opinlyVisitor } from '@/lib/auth/visitor';
import { wantedPlan } from '@/lib/founding-plan';
import { safeNext } from '@/lib/utils';
import { SignUpForm } from './sign-up-form';

// The canonical drops `?next=` and the site's `?oa=`, `?ref=` and `?code=`, so search engines see one sign-up page.
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
  // The website's buttons say which founding spot they're for (`?plan=yearly|monthly`): it rides along to the plan page.
  const plan = wantedPlan(params.plan);
  const first = plan ? `${FIRST_STOP}?plan=${plan}` : FIRST_STOP;
  const next = safeNext(typeof params.next === 'string' ? params.next : null, first);
  const providers = await webSignInProviders();
  return (
    <>
      <Card className="w-[440px] max-w-full rounded-dialog p-9 max-md:p-6">
        <SignUpForm
          next={next}
          visitor={opinlyVisitor(params.oa)}
          affiliate={affiliateTrail(params.ref, params.ref_at)}
          code={discountCode(params.code)}
          google={providers.google}
        />
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
