'use client';
import { Mail } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { CodeInput } from '@/components/auth/code-input';
import { Button } from '@/components/ui/button';
import { Field, FieldError, Label } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  CODE_LENGTH,
  countdown,
  isEmail,
  RESEND_SECONDS,
  sendCodeMessage,
  verifyCodeMessage,
} from '@/lib/auth/code-messages';
import { supabaseBrowser } from '@/lib/supabase/client';

/**
 * Signing in with a password, or with a 6-digit code emailed to an existing account (Email me a code). The code
 * step takes the card's place: "Check your email", the code typed or pasted, Send another code once a minute has
 * passed, and back to the password. People who only ever used Google here have the same way into the phone app.
 */
export function SignInForm({ next, intro }: { next: string; intro: ReactNode }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [step, setStep] = useState<'password' | 'code'>('password');

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

  if (step === 'code')
    return (
      <CodeStep
        email={email.trim()}
        next={next}
        onPassword={() => {
          setPassword('');
          setStep('password');
        }}
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

/** "Check your email": the code from the email, typed or pasted; it signs in as soon as all six digits are in. */
function CodeStep({
  email,
  next,
  onPassword,
}: {
  email: string;
  next: string;
  onPassword: () => void;
}) {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [wait, setWait] = useState(RESEND_SECONDS);
  const [resending, setResending] = useState(false);
  const [sentAgain, setSentAgain] = useState(false);

  useEffect(() => {
    if (wait <= 0) return;
    const timer = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(timer);
  }, [wait]);

  async function verify(token: string) {
    if (token.length !== CODE_LENGTH || checking) return;
    setChecking(true);
    setError(null);
    const { error } = await supabaseBrowser().auth.verifyOtp({ email, token, type: 'email' });
    if (error) {
      setChecking(false);
      setError(verifyCodeMessage(error));
      return;
    }
    router.replace(next);
    router.refresh();
  }

  async function resend() {
    setError(null);
    setResending(true);
    const { error } = await supabaseBrowser().auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false },
    });
    setResending(false);
    if (error) {
      setError(sendCodeMessage(error));
      return;
    }
    setCode('');
    setSentAgain(true);
    setWait(RESEND_SECONDS);
  }

  return (
    <div data-testid="code-step">
      <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.015em]">
        Check your email
      </h1>
      <p className="mt-1.5 text-text-2">
        {sentAgain ? 'We sent a new 6-digit code to ' : 'We sent a 6-digit code to '}
        <b className="font-semibold text-text">{email}</b>.
      </p>
      <form
        className="mt-6"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void verify(code);
        }}
      >
        <CodeInput
          id="sign-in-code"
          value={code}
          invalid={!!error}
          disabled={checking}
          describedBy={error ? 'code-error' : undefined}
          onChange={(value) => {
            setCode(value);
            if (error) setError(null);
            if (value.length === CODE_LENGTH) void verify(value);
          }}
        />
        <FieldError id="code-error">{error}</FieldError>
        <Button
          type="submit"
          size="lg"
          className="mt-5 w-full"
          loading={checking}
          disabled={code.length !== CODE_LENGTH}
        >
          Sign in
        </Button>
      </form>
      <div className="mt-3.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
        <button
          type="button"
          onClick={onPassword}
          className="text-[13px] text-accent-text hover:underline"
        >
          Use my password instead
        </button>
        {wait > 0 ? (
          <span className="text-[13px] text-text-3" data-testid="resend-wait">
            Send another code in {countdown(wait)}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => void resend()}
            disabled={resending}
            className="text-[13px] font-medium text-accent-text hover:underline disabled:opacity-50"
          >
            Send another code
          </button>
        )}
      </div>
    </div>
  );
}
