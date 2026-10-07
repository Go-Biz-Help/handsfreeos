'use client';
import { isAuthApiError } from '@supabase/supabase-js';
import { Mail } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { CodeStep } from '@/components/auth/code-step';
import { Button } from '@/components/ui/button';
import { Field, FieldError, Label } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { isEmail, sendCodeMessage } from '@/lib/auth/code-messages';
import { keepHandoffFromSignIn } from '@/lib/auth/sign-in-handoff';
import { supabaseBrowser } from '@/lib/supabase/client';

/**
 * Signing in with a password, or with a 6-digit code emailed to an existing account (Email me a code). The code
 * step takes the card's place: "Check your email", the code typed or pasted, Send another code once a minute has
 * passed, and back to the password. People who only ever used Google here have the same way into the phone app.
 *
 * An account whose email was never confirmed gets a code to confirm it instead of a dead end: the right password
 * sends one, and typing it signs in.
 */
export function SignInForm({ next, intro }: { next: string; intro: ReactNode }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [step, setStep] = useState<'password' | 'code' | 'confirm'>('password');

  // Signed out when a provider sign-in came back: keep what it carried, so it finishes after this.
  useEffect(() => keepHandoffFromSignIn(next), [next]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setCodeError(null);
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    const { error } = await supabaseBrowser().auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (!error) return signedIn();
    if (
      (isAuthApiError(error) && error.code === 'email_not_confirmed') ||
      /not confirmed/i.test(error.message)
    )
      return confirmByCode();
    setBusy(false);
    setError('That email and password do not match. Try again, or use a passkey.');
  }

  /** Only the right password gets an unconfirmed account this far: a code confirms the email and signs in. */
  async function confirmByCode() {
    const { error } = await supabaseBrowser().auth.resend({ type: 'signup', email: email.trim() });
    setBusy(false);
    // A code sent a moment ago (by signing up) still works, so being told to wait still shows the code step.
    const waitABit = isAuthApiError(error) && /rate_limit/.test(error.code ?? '');
    if (error && !waitABit) setError(sendCodeMessage(error));
    else setStep('confirm');
  }

  function signedIn() {
    router.replace(next);
    router.refresh();
  }

  async function emailCode() {
    setError(null);
    setCodeError(null);
    if (!isEmail(email)) {
      setCodeError('Enter your email address first, then press Email me a code.');
      return;
    }
    setSending(true);
    const { error } = await supabaseBrowser().auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: false },
    });
    setSending(false);
    if (error) {
      setCodeError(sendCodeMessage(error));
      return;
    }
    setStep('code');
  }

  const toPassword = () => {
    setPassword('');
    setStep('password');
  };
  const address = email.trim();

  if (step === 'code')
    return (
      <CodeStep
        inputId="sign-in-code"
        testId="code-step"
        lead={(again) => (
          <>
            {again ? 'We sent a new 6-digit code to ' : 'We sent a 6-digit code to '}
            <b className="font-semibold text-text">{address}</b>.
          </>
        )}
        submitLabel="Sign in"
        verify={(token) =>
          supabaseBrowser().auth.verifyOtp({ email: address, token, type: 'email' })
        }
        resend={() =>
          supabaseBrowser().auth.signInWithOtp({
            email: address,
            options: { shouldCreateUser: false },
          })
        }
        onDone={signedIn}
        other={{ label: 'Use my password instead', onClick: toPassword }}
      />
    );

  if (step === 'confirm')
    return (
      <CodeStep
        title="Confirm your email"
        inputId="confirm-code"
        testId="confirm-email"
        lead={(again) => (
          <>
            {again
              ? 'We sent a new 6-digit code to '
              : 'Your email isn’t confirmed yet, so we sent a 6-digit code to '}
            <b className="font-semibold text-text">{address}</b>. Type it here to sign in.
          </>
        )}
        submitLabel="Sign in"
        verify={(token) =>
          supabaseBrowser().auth.verifyOtp({ email: address, token, type: 'signup' })
        }
        resend={() => supabaseBrowser().auth.resend({ type: 'signup', email: address })}
        onDone={signedIn}
        other={{ label: 'Back to sign in', onClick: toPassword }}
        footnote="The code works once and expires in one hour."
      />
    );

  return (
    <>
      {intro}
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
            invalid={(!!error && !email) || (!!codeError && !isEmail(email))}
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
      <div className="mt-2.5 flex flex-col gap-1.5 rounded-[10px] bg-accent-soft px-3.5 py-3">
        <Button
          variant="secondary"
          className="w-full border-[color-mix(in_oklab,var(--accent)_40%,var(--border-strong))]"
          loading={sending}
          onClick={() => void emailCode()}
          data-testid="email-me-a-code"
        >
          {sending ? null : <Mail className="h-4 w-4" strokeWidth={1.5} />}
          Email me a code
        </Button>
        <span className="text-center text-xs text-accent-text">
          No password needed. We email you a 6-digit code.
        </span>
        {codeError ? (
          <p
            id="code-send-error"
            role="alert"
            className="text-center text-[12.5px] text-danger-text"
          >
            {codeError}
          </p>
        ) : null}
      </div>
    </>
  );
}
