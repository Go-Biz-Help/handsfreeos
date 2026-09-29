import type { Metadata } from 'next';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { SignUpForm } from './sign-up-form';

// The canonical drops `?next=` and the site's `?oa=`, so search engines see one sign-up page.
export const metadata: Metadata = {
  title: 'Create your account',
  description:
    'Create your HandsFreeOS account, then set up your business: calls, texts, booking, quotes and invoices in one place.',
  alternates: { canonical: 'https://app.handsfreeos.com/sign-up' },
};

export default function SignUpPage() {
  return (
    <>
      <Card className="w-[440px] max-w-full rounded-dialog p-9">
        <SignUpForm />
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
