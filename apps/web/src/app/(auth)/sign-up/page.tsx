import type { Metadata } from 'next';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { SignUpForm } from './sign-up-form';

export const metadata: Metadata = { title: 'Create your account' };

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
