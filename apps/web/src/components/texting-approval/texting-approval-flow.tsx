'use client';
/**
 * Texting approval on its own guided page (the owner, 22 Nov 2026): the registration wizard's eight questions in the
 * guided setup's card, with Saved and Finish later at the top like the phone number's. The questions, the checks and
 * what is sent are the wizard's own (components/settings/a2p-wizard.tsx); this is the page around them, and where it
 * goes once the registration is sent.
 */
import type { BusinessAddress, TextingFeesPaidFor } from '@hfos/core';
import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { GuidedPage, type SavedState } from '@/components/guided-setup/frame';
import {
  A2pWizard,
  type A2pWizardHandle,
  type HostedSurfaces,
} from '@/components/settings/a2p-wizard';
import { Card } from '@/components/ui/card';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { PhoneNumberInfo, PhoneSetupStatus } from '@/lib/api/types';

type Registrations = PhoneSetupStatus['registrations'];

/** What was sent last, which a registration the carriers turned down is corrected from. */
function latestSubmission(regs: Registrations): Record<string, unknown> | null {
  const withData = regs
    .filter((r) => r.submission && Object.keys(r.submission).length > 0)
    .sort((a, b) => (b.submittedAt ?? '').localeCompare(a.submittedAt ?? ''));
  return withData[0]?.submission ?? null;
}

export function TextingApprovalFlow({
  workspaceId,
  businessName,
  businessWebsite,
  businessAddress,
  industry,
  email,
  me,
  number,
  registrations,
  fix,
  draft,
  surfaces,
  feesPaidFor,
}: {
  workspaceId: string;
  businessName: string;
  businessWebsite: string | null;
  businessAddress: BusinessAddress | null;
  industry: string | null;
  /** Who's signed in, under the card. */
  email: string;
  me: { fullName: string; email: string };
  /** The number it's for; null for a local registration sent before the business has its number. */
  number: Pick<PhoneNumberInfo, 'numberType' | 'display'> | null;
  registrations: Registrations;
  /** Correcting one the carriers turned down: it starts from what was sent. */
  fix: boolean;
  draft: Record<string, unknown> | null;
  surfaces: HostedSurfaces;
  feesPaidFor: TextingFeesPaidFor | null;
}) {
  const router = useRouter();
  const settings = `/app/w/${workspaceId}/settings/texting`;
  const [saved, setSaved] = useState<SavedState>(draft ? 'saved' : 'idle');
  const [leaving, setLeaving] = useState(false);
  // Sent, with the carriers' fees to pay: their page is made a moment later, and this goes to it when it is.
  const [paying, setPaying] = useState(false);
  useEffect(() => {
    if (!paying) return;
    let over = false;
    let tries = 0;
    const look = async () => {
      tries += 1;
      try {
        const status = unwrap(
          await apiBrowser().POST('/v1/queries/phone.setup_status', { body: { workspaceId } }),
        );
        const due = status.textingFees?.due;
        if (over) return;
        if (due?.status === 'open' && due.checkoutUrl) {
          window.location.assign(due.checkoutUrl);
          return;
        }
        // Nothing owed after all (HandsFreeOS's own business, or already paid), or no page after half a minute:
        // Settings shows where it stands, with the way to pay.
        if (!due || tries >= 20) {
          router.push(`${settings}#approval`);
          return;
        }
      } catch {
        if (tries >= 20) {
          router.push(`${settings}#approval`);
          return;
        }
      }
      if (!over) setTimeout(() => void look(), 1500);
    };
    void look();
    return () => {
      over = true;
    };
  }, [paying, workspaceId, router, settings]);

  // Finish later keeps the answer typed a moment ago: the wizard saves what it hasn't yet, then the page goes.
  const wizard = useRef<A2pWizardHandle>(null);
  const leave = () => {
    setLeaving(true);
    void (wizard.current?.flush() ?? Promise.resolve()).finally(() =>
      router.push(`${settings}#approval`),
    );
  };

  return (
    <GuidedPage
      business={{ name: businessName, home: `/app/w/${workspaceId}` }}
      email={email}
      settingUp={
        number
          ? `Getting texting approved for ${number.display}`
          : `Getting texting approved for ${businessName}`
      }
      saved={saved}
      onLeave={leave}
      leaving={leaving}
    >
      {paying ? (
        <Card className="flex w-full items-center gap-3 p-8" data-testid="texting-approval-paying">
          <Loader2 className="h-5 w-5 flex-none animate-spin text-text-3" aria-hidden />
          <div>
            <p className="text-[15px] font-semibold">
              Saved. Taking you to pay the carriers’ fees.
            </p>
            <p className="text-[13.5px] text-text-2">
              Your registration goes to the carriers as soon as they’re paid.
            </p>
          </div>
        </Card>
      ) : (
        <A2pWizard
          workspaceId={workspaceId}
          businessName={businessName}
          businessWebsite={businessWebsite}
          businessAddress={businessAddress}
          industry={industry}
          number={number}
          me={me}
          initial={fix ? latestSubmission(registrations) : null}
          draft={draft}
          surfaces={surfaces}
          feesPaidFor={feesPaidFor}
          handle={wizard}
          guided={{ onSaved: setSaved, onLater: leave }}
          onSubmitted={(fee) => {
            if (fee) setPaying(true);
            else router.push(`${settings}#approval`);
          }}
        />
      )}
    </GuidedPage>
  );
}
