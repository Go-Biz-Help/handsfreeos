'use client';
/**
 * The boxes a customer ticks on a page that takes their number, and the field no person sees: "Text me about this
 * appointment", the separate box for offers (or for calls), and the honeypot. On their own so a small page that asks
 * (a webinar's sign-up) doesn't bring the whole booking flow with it: they lived in booking-flow.tsx, and the
 * sign-up page downloaded every step of booking to draw three boxes.
 */
import { smsConsentWords } from '@hfos/core';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

/** "Text me about this appointment": starts unticked; STOP always wins on the worker's side. */
export function SmsConsent({
  checked,
  onChange,
  business,
  phone,
  emailToo,
  policyPath,
  termsPath,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  business: string;
  phone: string;
  emailToo: boolean;
  /** Where the business's privacy policy is, so the box can link to it. */
  policyPath: string | null;
  /** Where its terms are, linked beside the policy. */
  termsPath?: string | null;
}) {
  const words = smsConsentWords(business, 'booking', policyPath, termsPath ?? null);
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="flex min-h-11 items-start gap-2.5 py-1 text-left"
      >
        <span
          aria-hidden
          className={cn(
            'mt-0.5 inline-flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[5px] border',
            checked ? 'border-accent bg-accent text-white' : 'border-border-strong bg-card',
          )}
        >
          {checked ? <Check size={13} strokeWidth={2.4} /> : null}
        </span>
        {/* The words are core's (messaging/consent.ts), shared with the public form, because a carrier
            reads both and two screens that say different things is what an audit finds. */}
        <span className="flex flex-col gap-0.5">
          <span className="text-[13px] font-medium">{words.title}</span>
          <span className="text-xs text-text-3">{words.detail}</span>
        </span>
      </button>
      <span className="text-xs text-text-3">
        {checked
          ? phone.trim()
            ? `You’ll get texts at ${phone.trim()}.`
            : 'Add your mobile number to get texts.'
          : emailToo
            ? 'Leave it unticked and we’ll email you instead.'
            : 'Leave it unticked and we won’t text you.'}{' '}
        {words.policyUrl ? (
          <a className="underline" href={words.policyUrl} target="_blank" rel="noreferrer">
            Privacy policy
          </a>
        ) : null}
        {words.termsUrl ? (
          <>
            {' · '}
            <a className="underline" href={words.termsUrl} target="_blank" rel="noreferrer">
              Terms
            </a>
          </>
        ) : null}
      </span>
    </div>
  );
}

/**
 * The separate box for offers, under "Text me", for a business that sends them. Starts unticked and is never
 * required; agreeing to texts about this booking is not agreeing to offers (core's offersConsentWords). The
 * "OK to call" box, for a business that asks for one, is the same box with core's callConsentWords.
 */
export function OffersConsent({
  checked,
  onChange,
  words,
  testId = 'booking-offers-consent',
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  words: { title: string; detail: string };
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex min-h-11 items-start gap-2.5 py-1 text-left"
      data-testid={testId}
    >
      <span
        aria-hidden
        className={cn(
          'mt-0.5 inline-flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[5px] border',
          checked ? 'border-accent bg-accent text-white' : 'border-border-strong bg-card',
        )}
      >
        {checked ? <Check size={13} strokeWidth={2.4} /> : null}
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="text-[13px] font-medium">{words.title}</span>
        <span className="text-xs text-text-3">{words.detail}</span>
      </span>
    </button>
  );
}

/** People never see it, so it stays empty; bots fill it in and are turned away. */
export function Honeypot({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div aria-hidden className="absolute -left-[10000px] top-auto h-px w-px overflow-hidden">
      <label>
        Website
        <input
          name="website"
          tabIndex={-1}
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
    </div>
  );
}
