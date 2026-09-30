'use client';
import { WIZARD_WORDS } from '@hfos/core';
import { Phone } from 'lucide-react';
import Link from 'next/link';
import { useState, type ComponentProps } from 'react';
import { TextingPage } from '@/components/settings/texting-page';
import { Card } from '@/components/ui/card';
import { RadioCard } from '@/components/ui/radio-card';

/**
 * The wizard's number step (board 2): whether the business has an EIN, which decides the kind of number (a sole
 * proprietor can only text from a toll-free one), then Settings → Texting & calls as it is, from the search through
 * the carriers' form. Once texting is on, just the number.
 */
export function NumberSetup({ texting }: { texting: ComponentProps<typeof TextingPage> }) {
  const [ein, setEin] = useState<boolean | null>(null);
  const { status, workspaceId } = texting;

  if (status.nextStep === 'ready' && status.number)
    return (
      <Card className="flex items-center gap-3.5 p-5" data-testid="setup-number-ready">
        <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-success-soft text-success-text">
          <Phone className="h-[18px] w-[18px]" strokeWidth={1.75} />
        </span>
        <div className="min-w-0">
          <div className="font-medium">{WIZARD_WORDS.numberReady(status.number.display)}</div>
          <Link
            href={`/app/w/${workspaceId}/settings/texting`}
            className="text-[13px] text-accent-text hover:underline"
          >
            {WIZARD_WORDS.numberSettings}
          </Link>
        </div>
      </Card>
    );

  const numberType = ein ? 'local' : 'toll_free';
  return (
    <>
      {status.nextStep === 'buy_number' ? (
        <div>
          <div className="mb-2 text-[13px] font-medium" id="setup-ein">
            {WIZARD_WORDS.ein.question}
          </div>
          <div
            role="radiogroup"
            aria-labelledby="setup-ein"
            className="grid grid-cols-1 gap-3 sm:grid-cols-2"
          >
            <RadioCard
              selected={ein === true}
              onSelect={() => setEin(true)}
              title={WIZARD_WORDS.ein.yes}
              description={WIZARD_WORDS.ein.yesDetail}
              testId="setup-ein-yes"
            />
            <RadioCard
              selected={ein === false}
              onSelect={() => setEin(false)}
              title={WIZARD_WORDS.ein.no}
              description={WIZARD_WORDS.ein.noDetail}
              testId="setup-ein-no"
            />
          </div>
        </div>
      ) : null}
      {/* Keyed on the answer, so the search starts again on the kind of number it now points to. */}
      <TextingPage key={numberType} {...texting} setup={{ numberType }} />
    </>
  );
}
