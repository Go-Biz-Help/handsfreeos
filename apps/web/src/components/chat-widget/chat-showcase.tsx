'use client';
/**
 * The website chat's sign-up page: /chat/<key> opened on its own, the page a texting registration gives the carrier's
 * reviewer. It's the chat's details form (name, mobile and email, the box to agree to texts with its wording, the
 * offers and calls boxes when the business has them, and the privacy policy and terms), and it works: Send keeps them
 * as a customer with their yes to texts, exactly as the chat does, and says they're signed up.
 *
 * **Why it has to work** (Twilio 30896, 1 Nov 2026): the reviewer filled in this page, pressed Send, and was told the
 * page only showed what the chat asks. To them the opt-in was broken, and the campaign was turned down. The worker's
 * check for the registration looks for `data-hfos-signup="live"` on this page (core's SIGN_UP_MARK), so a page that
 * stops taking sign-ups stops passing.
 */
import { CARRIER_DISCLOSURE, SIGN_UP_MARK } from '@hfos/core';
import { useRef, useState } from 'react';
import { Turnstile } from '@/components/booking/turnstile';
import { ApiError } from '@/lib/api/errors';
import { fieldErrors } from '@/lib/api/field-errors';
import { chatSignUp } from '@/lib/chat/client';
import { widgetVars } from '@/lib/chat/look';
import type { ChatConfig } from '@/lib/chat/lookup';
import type { DetailsValues, FieldProblems } from '@/lib/chat/session';
import { ChatFooter, ChatHeader, ChatStyles, DetailsForm } from './chat-parts';

const NONE = { name: false, phone: false, email: false } as const;
const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || null;

const SIGN_UP_INTRO = 'Leave your details, and tick the box if you’d like texts from us.';

export function ChatShowcase({ config, widgetKey }: { config: ChatConfig; widgetKey: string }) {
  const business = config.business.name || 'This business';
  const { colors, vars } = widgetVars(config.look);
  const { askFor } = config;
  const show = {
    name: askFor.name !== 'never',
    phone: askFor.phone !== 'never',
    email: askFor.email !== 'never',
  };
  const teammate = config.teammate?.name ?? null;
  const siteKey = config.humanCheck ? (config.humanCheck.siteKey ?? TURNSTILE_SITE_KEY) : null;
  const token = useRef<string | null>(null);
  // Who's waiting for the human check's next token: Send waits for it, as the chat does, rather than asking twice.
  const waiting = useRef<((t: string | null) => void) | null>(null);
  const honeypot = useRef<HTMLInputElement>(null);
  const [reset, setReset] = useState(0);
  const [done, setDone] = useState<{ texts: boolean; phone: string } | null>(null);

  /** The check's token: one it already made, or the next it makes (null after 20 seconds). Each works once. */
  function nextToken(): Promise<string | null> {
    const ready = token.current;
    if (ready) {
      token.current = null;
      return Promise.resolve(ready);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiting.current = null;
        resolve(null);
      }, 20_000);
      waiting.current = (t) => {
        clearTimeout(timer);
        resolve(t);
      };
    });
  }

  async function submit(values: DetailsValues): Promise<FieldProblems | null> {
    const name = values.name.trim();
    const phone = values.phone.trim();
    const email = values.email.trim();
    if ((values.smsConsent || values.offersConsent) && !phone)
      return { phone: 'Add your mobile number to get texts.' };
    if (!phone && !email) return { form: 'Add your mobile number or email.' };
    const check = siteKey ? await nextToken() : null;
    if (siteKey && !check)
      return {
        form: 'We couldn’t check you’re a person just now. Reload the page, then press Send again.',
      };
    try {
      const out = await chatSignUp(widgetKey, {
        ...(name ? { name } : {}),
        ...(phone ? { phone } : {}),
        ...(email ? { email } : {}),
        smsConsent: !!phone && values.smsConsent,
        offersConsent: !!phone && !!values.offersConsent,
        callConsent: !!phone && !!values.callConsent,
        ...(check ? { turnstileToken: check } : {}),
        ...(honeypot.current?.value ? { honeypot: honeypot.current.value } : {}),
      });
      setDone({ texts: out.texts, phone });
      return null;
    } catch (e) {
      const fields = fieldErrors(e);
      if (Object.keys(fields).length) return fields;
      const rule = e instanceof ApiError ? e.rule : undefined;
      if (rule === 'rate_limited')
        return { form: 'You’re sending quickly. Wait a moment, then try again.' };
      return {
        form: e instanceof Error && e.message ? e.message : 'That didn’t go through. Try again.',
      };
    } finally {
      // Each check's token works once.
      if (check) setReset((n) => n + 1);
    }
  }

  return (
    <main
      className="hfos-w min-h-dvh bg-bg px-4 py-10 text-text"
      style={vars}
      data-testid="chat-showcase"
      {...{ [SIGN_UP_MARK]: 'live' }}
    >
      <ChatStyles page />
      <div className="mx-auto max-w-[420px]">
        <h1 className="text-[22px] font-semibold leading-tight">Get texts from {business}</h1>
        <p className="mt-2 text-[14.5px] leading-relaxed text-text-2">
          This is the same form the chat on {business}’s website shows after a visitor’s first
          message. Fill it in and press Send to sign up. Ticking the box is up to you.
        </p>
        <div className="mt-6 flex flex-col overflow-hidden rounded-[18px] border border-border bg-card shadow-2">
          <ChatHeader
            business={business}
            logo={config.business.logo}
            subtitle={teammate ? `${teammate} (AI) and the team` : 'Chat with the team'}
            markColor={colors.mark}
            onClose={null}
          />
          <div className="flex flex-col gap-2 bg-bg px-3.5 py-3.5">
            {done ? (
              <div
                role="status"
                className="rounded-[14px] border border-border bg-card px-4 py-4 text-[14px] leading-relaxed"
                data-testid="chat-showcase-done"
              >
                <p className="font-semibold">You’re signed up.</p>
                {done.texts ? (
                  <p className="mt-1.5 text-text-2">
                    {business} may now text {done.phone}. {CARRIER_DISCLOSURE}
                  </p>
                ) : (
                  <p className="mt-1.5 text-text-2">
                    {business} has your details and will get back to you. You didn’t tick the box,
                    so you won’t get texts.
                  </p>
                )}
              </div>
            ) : (
              <>
                <DetailsForm
                  testId="chat-showcase-form"
                  intro={SIGN_UP_INTRO}
                  show={show}
                  required={NONE}
                  needContact
                  consentText={config.smsConsent?.detail ?? config.smsConsent?.text ?? null}
                  consentPolicyUrl={config.smsConsent?.policyUrl ?? null}
                  consentTermsUrl={config.smsConsent?.termsUrl ?? null}
                  offers={config.offersConsent}
                  calls={config.callConsent}
                  withMessage={false}
                  submitLabel="Send"
                  onSubmit={submit}
                />
                {/* Empty from a person; a bot fills it in. */}
                <input
                  ref={honeypot}
                  type="text"
                  name="company_website"
                  tabIndex={-1}
                  autoComplete="off"
                  aria-hidden="true"
                  className="absolute left-[-9999px] h-px w-px opacity-0"
                />
                {siteKey ? (
                  <Turnstile
                    invisible
                    siteKey={siteKey}
                    resetKey={reset}
                    onToken={(t) => {
                      const waiter = waiting.current;
                      if (waiter && t) {
                        waiting.current = null;
                        waiter(t);
                      } else token.current = t;
                    }}
                  />
                ) : null}
              </>
            )}
          </div>
          <ChatFooter />
        </div>
      </div>
    </main>
  );
}
