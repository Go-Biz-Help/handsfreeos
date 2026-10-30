'use client';
/**
 * What the website chat asks visitors, shown on its own (/chat/<key> opened in a tab): the page a carrier's reviewer is
 * given for a texting registration, because a reviewer rarely starts a chat to find the box. It shows the details form
 * exactly as the chat does after a visitor's first message: name, mobile and email, the box to agree to texts with its
 * wording, the offers and calls boxes when the business has them, and the privacy policy and terms. It sends nothing.
 */
import type { CSSProperties } from 'react';
import { widgetColors } from '@/lib/chat/look';
import type { ChatConfig } from '@/lib/chat/lookup';
import { AFTER_FIRST_INTRO, ChatFooter, ChatHeader, ChatStyles, DetailsForm } from './chat-parts';

const NONE = { name: false, phone: false, email: false } as const;

export function ChatShowcase({ config }: { config: ChatConfig }) {
  const business = config.business.name || 'This business';
  const colors = widgetColors(config.look.accentColor);
  const vars = {
    '--wacc-l': colors.light.accent,
    '--wacc-on-l': colors.light.on,
    '--wacc-d': colors.dark.accent,
    '--wacc-on-d': colors.dark.on,
  } as CSSProperties;
  const { askFor } = config;
  const show = {
    name: askFor.name !== 'never',
    phone: askFor.phone !== 'never',
    email: askFor.email !== 'never',
  };
  const teammate = config.teammate?.name ?? null;
  return (
    <main
      className="hfos-w min-h-dvh bg-bg px-4 py-10 text-text"
      style={vars}
      data-testid="chat-showcase"
    >
      <ChatStyles page />
      <div className="mx-auto max-w-[420px]">
        <h1 className="text-[22px] font-semibold leading-tight">
          How {business}’s website chat asks to text you
        </h1>
        <p className="mt-2 text-[14.5px] leading-relaxed text-text-2">
          After a visitor sends their first message, the chat on {business}’s website asks how to
          reach them, as shown below. Ticking a box is up to them, and they can carry on chatting
          without giving anything.
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
            <p className="self-center text-xs text-text-3">After the visitor’s first message</p>
            <DetailsForm
              testId="chat-showcase-form"
              intro={AFTER_FIRST_INTRO}
              show={show}
              required={NONE}
              needContact={false}
              consentText={config.smsConsent?.detail ?? config.smsConsent?.text ?? null}
              consentPolicyUrl={config.smsConsent?.policyUrl ?? null}
              consentTermsUrl={config.smsConsent?.termsUrl ?? null}
              offers={config.offersConsent}
              calls={config.callConsent}
              withMessage={false}
              submitLabel="Send"
              onSubmit={async () => ({
                form: `This page only shows what the chat asks. To reach ${business}, use the chat on their website.`,
              })}
            />
          </div>
          <ChatFooter />
        </div>
      </div>
    </main>
  );
}
