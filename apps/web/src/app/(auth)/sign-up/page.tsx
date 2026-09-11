import type { Metadata } from 'next';
import Link from 'next/link';
import { GoogleButton } from '@/components/auth/google-button';
import { OrDivider } from '@/components/auth/divider';
import { Card } from '@/components/ui/card';
import { safeNext } from '@/lib/utils';
import { SignUpForm } from './sign-up-form';

export const metadata: Metadata = { title: 'Create your account' };

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = safeNext(typeof params.next === 'string' ? params.next : null, '/onboarding');
  return (
    <>
      <Card className="w-[440px] max-w-full rounded-dialog p-9">
        <SignUpForm>
          <div className="mt-6">
            <GoogleButton next={next} />
          </div>
          <OrDivider />
        </SignUpForm>
      </Card>
      <p className="text-[13px] text-text-2">
        Already have an account?{' '}
        <Link href="/sign-in" className="font-medium text-accent-text hover:underline">
          Sign in
        </Link>
      </p>
    </>
  );
}
