'use client';
import { WIZARD_WORDS, type WizardStepKey } from '@hfos/core';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, ButtonLink } from '@/components/ui/button';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

/**
 * The wizard's footer: Back, and either Skip for now (a step still to do, whose own buttons are the way through
 * it) or Continue (a step done, waiting on someone else, or skipped before). The last step's Continue goes Home.
 */
export function WizardFooter({
  workspaceId,
  step,
  open,
  back,
  next,
  last,
}: {
  workspaceId: string;
  step: WizardStepKey;
  /** Still to do, or needs a fix. */
  open: boolean;
  back: string;
  next: string;
  last: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function skip() {
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/onboarding.skip', {
          body: { workspaceId, step, skipped: true },
        }),
      );
      router.push(next);
      router.refresh();
    } catch (e) {
      setBusy(false);
      toast.error(errorMessage(e));
    }
  }

  return (
    <footer className="sticky bottom-0 z-10 flex h-[72px] flex-none items-center gap-2 border-t border-border bg-card px-4 md:px-14">
      <ButtonLink href={back} variant="ghost" data-testid="setup-back">
        <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
        {WIZARD_WORDS.back}
      </ButtonLink>
      <div className="flex-1" />
      {open ? (
        <Button
          variant="secondary"
          size="lg"
          loading={busy}
          onClick={() => void skip()}
          data-testid="setup-skip"
        >
          {WIZARD_WORDS.skip}
        </Button>
      ) : (
        <ButtonLink href={next} variant="primary" size="lg" data-testid="setup-continue">
          {last ? WIZARD_WORDS.finish : WIZARD_WORDS.next}
          <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
        </ButtonLink>
      )}
    </footer>
  );
}
