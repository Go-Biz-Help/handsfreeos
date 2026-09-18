'use client';
import { assistantConsentWords, type ConsentPointIcon } from '@hfos/core';
import { Check, MessageCircle, ShieldCheck, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useAssistant } from './assistant-provider';
import { AssistantMark } from './mark';

/** The words are core's (M10 step 17), so the phone's screen asks in exactly the same way. */
const WORDS = assistantConsentWords('web');
const ICONS: Record<ConsentPointIcon, LucideIcon> = {
  chat: MessageCircle,
  shield: ShieldCheck,
  check: Check,
};

/**
 * The Assistant's consent step (M10), before the first question: what someone asks about goes to an AI service.
 * OK, continue keeps the OK with their account (one OK covers the web and the phone) and asks any
 * question that was waiting; Not now closes the panel and asks again next time.
 */
export function ConsentStep({ phone }: { phone: boolean }) {
  const a = useAssistant();
  const [busy, setBusy] = useState(false);
  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto',
        phone ? 'px-5 pb-[calc(env(safe-area-inset-bottom)+20px)] pt-6' : 'px-6 py-[26px]',
      )}
      data-testid="assistant-consent"
    >
      <span className="inline-flex h-[52px] w-[52px] flex-none items-center justify-center rounded-[14px] bg-accent-soft">
        <AssistantMark size={30} />
      </span>
      <h2 className="text-xl font-semibold leading-[1.3] tracking-[-0.01em]">{WORDS.title}</h2>
      <p className="text-[14.5px] leading-normal">{WORDS.lead}</p>
      <ul className="flex flex-col gap-3">
        {WORDS.points.map(({ icon, text }) => {
          const Icon = ICONS[icon];
          return (
            <li key={text} className="flex items-start gap-[11px] text-sm leading-[1.45]">
              <Icon className="mt-0.5 h-[18px] w-[18px] flex-none text-text-2" strokeWidth={1.5} />
              <span>{text}</span>
            </li>
          );
        })}
      </ul>
      <span className="min-h-2 flex-1" />
      <div className="flex gap-2">
        <Button
          size="lg"
          className="flex-1"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            await a.giveConsent();
            setBusy(false);
          }}
          data-testid="assistant-consent-ok"
        >
          {WORDS.ok}
        </Button>
        <Button size="lg" variant="ghost" onClick={a.declineConsent}>
          {WORDS.notNow}
        </Button>
      </div>
    </div>
  );
}
