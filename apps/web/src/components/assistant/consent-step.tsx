'use client';
import { Check, MessageCircle, ShieldCheck, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useAssistant } from './assistant-provider';
import { AssistantMark } from './mark';

const POINTS: readonly { readonly icon: LucideIcon; readonly text: string }[] = [
  {
    icon: MessageCircle,
    text: 'Your question, and the customers, messages, appointments or money it looks up to answer it.',
  },
  {
    icon: ShieldCheck,
    text: 'Nothing goes to a customer, and nothing is booked or changed, until you say OK.',
  },
  {
    icon: Check,
    text: 'Your OK is kept with your account, so you won’t be asked again here or on your phone.',
  },
];

/**
 * The Assistant's consent step (M10), before the first question: what someone asks about goes to Anthropic's
 * Claude. OK, continue keeps the OK with their account (one OK covers the web and the phone) and asks any question
 * that was waiting; Not now closes the panel and asks again next time.
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
      <h2 className="text-xl font-semibold leading-[1.3] tracking-[-0.01em]">
        The Assistant uses Anthropic’s Claude
      </h2>
      <p className="text-[14.5px] leading-normal">
        What you ask about is sent to Anthropic’s Claude to answer you.
      </p>
      <ul className="flex flex-col gap-3">
        {POINTS.map(({ icon: Icon, text }) => (
          <li key={text} className="flex items-start gap-[11px] text-sm leading-[1.45]">
            <Icon className="mt-0.5 h-[18px] w-[18px] flex-none text-text-2" strokeWidth={1.5} />
            <span>{text}</span>
          </li>
        ))}
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
          OK, continue
        </Button>
        <Button size="lg" variant="ghost" onClick={a.declineConsent}>
          Not now
        </Button>
      </div>
      <p className="text-xs text-text-3">Anthropic is the company that makes Claude.</p>
    </div>
  );
}
