'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldError, Label } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { supabaseBrowser } from '@/lib/supabase/client';

export function SignInForm({ next }: { next: string }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    const { error } = await supabaseBrowser().auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (error) {
      setBusy(false);
      setError(
        /confirm/i.test(error.message)
          ? 'Confirm your email first. Check your inbox for the link.'
          : 'That email and password do not match. Try again, or use a passkey.',
      );
      return;
    }
    router.replace(next);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <Field label="Email" htmlFor="email">
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          inputSize="lg"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          invalid={!!error && !email}
        />
      </Field>
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <Label htmlFor="password" className="mb-0">
            Password
          </Label>
          <Link href="/forgot-password" className="text-[13px] text-accent-text hover:underline">
            Forgot password?
          </Link>
        </div>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          inputSize="lg"
          placeholder="Your password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          invalid={!!error && !password}
        />
        <FieldError id="sign-in-error">{error}</FieldError>
      </div>
      <Button type="submit" size="lg" className="mt-1 w-full" loading={busy}>
        Continue
      </Button>
    </form>
  );
}
