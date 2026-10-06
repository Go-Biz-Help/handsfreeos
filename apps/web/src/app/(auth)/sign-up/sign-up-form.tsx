'use client';
import { Mail } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { supabaseBrowser } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';

export function passwordStrength(pw: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  if (!pw) return { score: 0, label: '' };
  if (pw.length < 12) return { score: 1, label: 'Too short' };
  let s = 1;
  if (pw.length >= 16) s++;
  if (/[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  return { score: s as 1 | 2 | 3 | 4, label: ['', 'Weak', 'Okay', 'Good', 'Strong'][s]! };
}

/**
 * Who this person was on handsfreeos.com before they got here: the website adds Opinly's anonymous visitor id to
 * its "Start free" links as `?oa=`. It is kept on the new sign-in, so the worker can credit the sign-up, and
 * anything bought later, to the article or campaign that brought them (apps/worker/src/analytics/opinly.ts).
 * Only something shaped like one of Opinly's ids is kept, and deleting the account clears it with the rest of
 * the sign-in's details.
 */
function visitorFromLink(): string | undefined {
  const id = new URLSearchParams(window.location.search).get('oa');
  return id && /^[A-Za-z0-9-]{8,128}$/.test(id) ? id : undefined;
}

/** HandsFreeOS's own terms and privacy policy, on the website (apps/site's /terms and /privacy). */
const TERMS_URL = 'https://handsfreeos.com/terms';
const PRIVACY_URL = 'https://handsfreeos.com/privacy';

export function SignUpForm({ children }: { children?: ReactNode }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{
    name?: string;
    email?: string;
    password?: string;
    form?: string;
  }>({});
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [resent, setResent] = useState(false);
  const strength = passwordStrength(password);
  const strengthColor = ['', 'bg-danger', 'bg-warning', 'bg-success', 'bg-success'][strength.score];

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    if (name.trim().length < 2) next.name = 'Enter your name so teammates recognize you.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim()))
      next.email = 'Enter a valid email address.';
    if (password.length < 12)
      next.password = 'Use at least 12 characters. A short sentence works well.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setBusy(true);
    const visitor = visitorFromLink();
    const { error } = await supabaseBrowser().auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: { full_name: name.trim(), ...(visitor ? { opinly_anon_id: visitor } : {}) },
        emailRedirectTo: `${window.location.origin}/auth/confirm`,
      },
    });
    setBusy(false);
    if (error) {
      setErrors({
        form: /already registered|already exists/i.test(error.message)
          ? 'That email already has an account. Sign in instead.'
          : error.message,
      });
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <div className="text-center" data-testid="check-email">
        <div className="mx-auto mb-4 flex h-[52px] w-[52px] items-center justify-center rounded-dialog bg-accent-soft text-accent-text">
          <Mail className="h-6 w-6" />
        </div>
        <h1 className="text-[22px] font-semibold tracking-tight">Check your email</h1>
        <p className="mt-2 leading-relaxed text-text-2">
          We sent a confirmation link to{' '}
          <strong className="font-medium text-text">{email.trim()}</strong>. Open it on this device
          to finish creating your account.
        </p>
        <div className="mt-6 flex flex-col gap-2.5">
          <Button
            variant="secondary"
            size="lg"
            className="w-full"
            onClick={async () => {
              await supabaseBrowser().auth.resend({
                type: 'signup',
                email: email.trim(),
                options: { emailRedirectTo: `${window.location.origin}/auth/confirm` },
              });
              setResent(true);
            }}
          >
            {resent ? 'Sent again' : 'Resend email'}
          </Button>
          <Button
            variant="ghost"
            className="w-full"
            onClick={() => {
              setSent(false);
              setPassword('');
              setResent(false);
            }}
          >
            Use a different email
          </Button>
        </div>
        <p className="mt-4 text-[12.5px] text-text-3">The link expires in 24 hours.</p>
      </div>
    );
  }

  return (
    <>
      <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.015em]">
        Create your account
      </h1>
      <p className="mt-1.5 text-text-2">Set up your business in about two minutes.</p>
      {children}
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="Full name" htmlFor="name" error={errors.name}>
          <Input
            id="name"
            name="name"
            autoComplete="name"
            inputSize="lg"
            placeholder="Chris Martinez"
            value={name}
            onChange={(e) => setName(e.target.value)}
            invalid={!!errors.name}
          />
        </Field>
        <Field label="Work email" htmlFor="email" error={errors.email}>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            inputSize="lg"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            invalid={!!errors.email}
          />
        </Field>
        <div>
          <Field label="Password" htmlFor="password" error={errors.password}>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              inputSize="lg"
              placeholder="At least 12 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              invalid={!!errors.password}
            />
          </Field>
          <div className="mt-2 grid grid-cols-4 gap-1" aria-hidden>
            {[1, 2, 3, 4].map((n) => (
              <span
                key={n}
                className={cn(
                  'h-1 rounded-full bg-card-3',
                  password && strength.score >= n && strengthColor,
                )}
              />
            ))}
          </div>
          <div className="mt-1.5 flex items-center justify-between text-[12.5px]">
            <span className="text-text-3">A short sentence you will remember works best.</span>
            <span
              className={cn(
                'font-medium',
                strength.score <= 1
                  ? 'text-danger-text'
                  : strength.score === 2
                    ? 'text-warning-text'
                    : 'text-success-text',
              )}
              aria-live="polite"
            >
              {strength.label}
            </span>
          </div>
        </div>
        {errors.form ? (
          <p role="alert" className="text-[13px] text-danger-text">
            {errors.form}
          </p>
        ) : null}
        <Button type="submit" size="lg" className="mt-1 w-full" loading={busy}>
          Create account
        </Button>
        <p className="text-center text-xs leading-relaxed text-text-3">
          By continuing you agree to the{' '}
          {/* A new tab, so what's typed here is still here after reading them. */}
          <a
            href={TERMS_URL}
            target="_blank"
            rel="noreferrer"
            className="text-accent-text hover:underline"
            data-testid="sign-up-terms"
          >
            Terms
          </a>{' '}
          and{' '}
          <a
            href={PRIVACY_URL}
            target="_blank"
            rel="noreferrer"
            className="text-accent-text hover:underline"
            data-testid="sign-up-privacy"
          >
            Privacy Policy
          </a>
          .
        </p>
      </form>
    </>
  );
}
