'use client';
import { BILLING_WORDS as W } from '@hfos/core';
import { CalendarClock, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { apiBrowser, unwrap } from '@/lib/api/client';

/**
 * A free trial about to end (20261027027000, the owner's pick): in its last days, whoever manages money sees a slim
 * note across the top of the business saying when the card is charged and what, with the way to Billing & Usage. The
 * worker emails them the same at the same time. Hide keeps it away on this device for that trial; lost storage only
 * shows it again.
 *
 * Only on the web: the phone never says a price (the stores' rule).
 */
export function TrialEndingNote({ workspaceId }: { workspaceId: string }) {
  const [ending, setEnding] = useState<{ endsAt: string; chargeCents: number } | null>(null);
  useEffect(() => {
    let gone = false;
    void apiBrowser()
      .POST('/v1/queries/billing.status', { body: { workspaceId } })
      .then(unwrap)
      .then((status) => {
        if (gone || !status.trialEnding) return;
        if (readHidden(workspaceId) === status.trialEnding.endsAt) return;
        setEnding(status.trialEnding);
      })
      // Only a note: when it can't be asked, nothing shows.
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [workspaceId]);
  if (!ending) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-accent-soft px-4 py-2 text-[13px] text-accent-text"
      data-testid="trial-ending-note"
    >
      <CalendarClock className="h-4 w-4 flex-none" strokeWidth={1.75} />
      <span>{W.trialEndingNote(ending.endsAt, ending.chargeCents)}</span>
      <Link
        href={`/app/w/${workspaceId}/settings/usage`}
        className="font-semibold underline underline-offset-2"
        data-testid="trial-ending-link"
      >
        {W.trialEndingLink}
      </Link>
      <button
        type="button"
        className="ml-auto rounded p-0.5 hover:bg-accent/10"
        aria-label={W.trialEndingHide}
        title={W.trialEndingHide}
        data-testid="trial-ending-hide"
        onClick={() => {
          writeHidden(workspaceId, ending.endsAt);
          setEnding(null);
        }}
      >
        <X className="h-4 w-4" strokeWidth={1.75} />
      </button>
    </div>
  );
}

const key = (workspaceId: string) => `hfos.trialEndingHidden.${workspaceId}`;

function readHidden(workspaceId: string): string | null {
  try {
    return window.localStorage.getItem(key(workspaceId));
  } catch {
    return null;
  }
}

function writeHidden(workspaceId: string, endsAt: string): void {
  try {
    window.localStorage.setItem(key(workspaceId), endsAt);
  } catch {
    // Nowhere to keep it: it shows again on the next visit.
  }
}
