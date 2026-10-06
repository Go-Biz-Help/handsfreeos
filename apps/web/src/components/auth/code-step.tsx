'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { CodeInput } from '@/components/auth/code-input';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/ui/field';
import {
  CODE_LENGTH,
  countdown,
  RESEND_SECONDS,
  sendCodeMessage,
  verifyCodeMessage,
} from '@/lib/auth/code-messages';

/**
 * "Check your email": the 6-digit code from the email, typed or pasted, on any device's email; it goes in as soon as
 * all six digits are there. Signing in with an emailed code and confirming a new account's email both use it, each
 * with its own way to check the code and to send another (once a minute).
 */
export function CodeStep({
  title = 'Check your email',
  lead,
  submitLabel,
  verify,
  resend,
  onDone,
  other,
  footnote,
  inputId,
  testId,
}: {
  title?: string;
  /** What was sent, and where; `sentAgain` once another code went out. */
  lead: (sentAgain: boolean) => ReactNode;
  submitLabel: string;
  verify: (token: string) => Promise<{ error: unknown }>;
  resend: () => Promise<{ error: unknown }>;
  onDone: () => void;
  /** The way out: back to the password, or to a different email. */
  other: { label: string; onClick: () => void };
  footnote?: ReactNode;
  inputId: string;
  testId: string;
}) {
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

  async function check(token: string) {
    if (token.length !== CODE_LENGTH || checking) return;
    setChecking(true);
    setError(null);
    const { error } = await verify(token);
    if (error) {
      setChecking(false);
      setError(verifyCodeMessage(error));
      return;
    }
    onDone();
  }

  async function sendAnother() {
    setError(null);
    setResending(true);
    const { error } = await resend();
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
    <div data-testid={testId}>
      <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.015em]">{title}</h1>
      <p className="mt-1.5 text-text-2">{lead(sentAgain)}</p>
      <form
        className="mt-6"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void check(code);
        }}
      >
        <CodeInput
          id={inputId}
          value={code}
          invalid={!!error}
          disabled={checking}
          describedBy={error ? 'code-error' : undefined}
          onChange={(value) => {
            setCode(value);
            if (error) setError(null);
            if (value.length === CODE_LENGTH) void check(value);
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
          {submitLabel}
        </Button>
      </form>
      <div className="mt-3.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
        <button
          type="button"
          onClick={other.onClick}
          className="text-[13px] text-accent-text hover:underline"
        >
          {other.label}
        </button>
        {wait > 0 ? (
          <span className="text-[13px] text-text-3" data-testid="resend-wait">
            Send another code in {countdown(wait)}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => void sendAnother()}
            disabled={resending}
            className="text-[13px] font-medium text-accent-text hover:underline disabled:opacity-50"
          >
            Send another code
          </button>
        )}
      </div>
      {footnote ? <p className="mt-4 text-[12.5px] text-text-3">{footnote}</p> : null}
    </div>
  );
}
