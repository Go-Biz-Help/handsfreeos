'use client';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { supabaseBrowser } from '@/lib/supabase/client';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) {
      setError('Enter a valid email address.');
      return;
    }
    setBusy(true);
    setError(null);
    const { error } = await supabaseBrowser().auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/auth/confirm`,
    });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    setSent(true);
  }

  return (
    <>
      <Card className="w-[440px] max-w-full rounded-dialog p-9">
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.015em]">
          Reset your password
        </h1>
        {sent ? (
          <p className="mt-3 leading-relaxed text-text-2" data-testid="reset-sent">
            If an account exists for{' '}
            <strong className="font-medium text-text">{email.trim()}</strong>, a reset link is on
            its way. It works once and expires in one hour.
          </p>
        ) : (
          <form onSubmit={submit} className="mt-6 flex flex-col gap-4" noValidate>
            <Field label="Email" htmlFor="email" error={error}>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                inputSize="lg"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                invalid={!!error}
              />
            </Field>
            <Button type="submit" size="lg" className="w-full" loading={busy}>
              Send reset link
            </Button>
          </form>
        )}
      </Card>
      <p className="text-[13px] text-text-2">
        <Link href="/sign-in" className="font-medium text-accent-text hover:underline">
          Back to sign in
        </Link>
      </p>
    </>
  );
}
