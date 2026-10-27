'use client';
import { EXISTING_ACCOUNT_MESSAGE, isExistingAccount, signUpMessage } from '@hfos/core';
import { isAuthError, isAuthRetryableFetchError } from '@supabase/supabase-js';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { CodeStep } from '@/components/auth/code-step';
import { OrDivider } from '@/components/auth/divider';
import { GoogleButton } from '@/components/auth/google-button';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NO_CONNECTION } from '@/lib/auth/code-messages';
import { affiliateTrailData, type AffiliateTrail } from '@/lib/auth/visitor';
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

/** HandsFreeOS's own terms and privacy policy, on the website (apps/site's /terms and /privacy). */
const TERMS_URL = 'https://handsfreeos.com/terms';
const PRIVACY_URL = 'https://handsfreeos.com/privacy';

/**
 * Creating an account: Continue with Google once it's turned on, or a name, an email and a password. The email is
 * confirmed with a 6-digit code typed here, read on whichever device gets the email, and the new account carries on
 * to `next`: setting up a business, or the invitation it came from. `visitor` is the website's Opinly visitor id and
 * `affiliate` the affiliate link they came by (`lib/auth/visitor.ts`).
 */
export function SignUpForm({
  next,
  visitor,
  affiliate,
  google,
}: {
  next: string;
  visitor?: string;
  affiliate?: AffiliateTrail;
  google: boolean;
}) {
  const router = useRouter();
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
  const strength = passwordStrength(password);
  const strengthColor = ['', 'bg-danger', 'bg-warning', 'bg-success', 'bg-success'][strength.score];

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problems: typeof errors = {};
    if (name.trim().length < 2) problems.name = 'Enter your name so teammates recognize you.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim()))
      problems.email = 'Enter a valid email address.';
    if (password.length < 12)
      problems.password = 'Use at least 12 characters. A short sentence works well.';
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    const { data, error } = await supabaseBrowser().auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: {
          full_name: name.trim(),
          ...(visitor ? { opinly_anon_id: visitor } : {}),
          ...affiliateTrailData(affiliate),
        },
      },
    });
    setBusy(false);
    if (error) {
      setErrors({
        form: isAuthRetryableFetchError(error)
          ? NO_CONNECTION
          : signUpMessage(isAuthError(error) ? (error.code ?? null) : null),
      });
      return;
    }
    if (isExistingAccount(data.user)) {
      setErrors({ form: EXISTING_ACCOUNT_MESSAGE });
      return;
    }
    // Only where email confirmation is off (never on the hosted project) does signing up sign in straight away.
    if (data.session) return carryOn();
    setSent(true);
  }

  function carryOn() {
    router.replace(next);
    router.refresh();
  }

  if (sent) {
    const address = email.trim();
    return (
      <CodeStep
        inputId="sign-up-code"
        testId="check-email"
        lead={(again) => (
          <>
            {again ? 'We sent a new 6-digit code to ' : 'We sent a 6-digit code to '}
            <b className="font-semibold text-text">{address}</b>. Type it here to finish creating
            your account.
          </>
        )}
        submitLabel="Continue"
        verify={(token) =>
          supabaseBrowser().auth.verifyOtp({ email: address, token, type: 'signup' })
        }
        resend={() => supabaseBrowser().auth.resend({ type: 'signup', email: address })}
        onDone={carryOn}
        other={{
          label: 'Use a different email',
          onClick: () => {
            setSent(false);
            setPassword('');
          },
        }}
        footnote="The code works once and expires in one hour. Check your spam folder if it isn’t there."
      />
    );
  }

  return (
    <>
      <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.015em]">
        Create your account
      </h1>
      <p className="mt-1.5 text-text-2">Then you’ll set up your business.</p>
      {google ? (
        <>
          <div className="mt-6">
            <GoogleButton next={next} visitor={visitor} affiliate={affiliate} />
          </div>
          <OrDivider />
        </>
      ) : null}
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
