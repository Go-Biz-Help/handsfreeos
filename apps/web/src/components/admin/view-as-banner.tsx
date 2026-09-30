'use client';
import { Eye, KeyRound } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiBrowser, unwrap } from '@/lib/api/client';

/**
 * Shown across the top of a business a support person is looking at. Loud, and honest about two things: it
 * is read-only, and the business has been told.
 *
 * The founder working in a business as its owner (20261013002100) sees a banner too, for the opposite reason:
 * what they change here is real, and nobody in the business knows they are here to ask about it.
 */
export function ViewAsBanner({
  workspaceId,
  businessName,
  expiresAt,
  acting,
}: {
  workspaceId: string;
  businessName: string;
  expiresAt: string | null;
  acting: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const minutes = expiresAt
    ? Math.max(0, Math.round((Date.parse(expiresAt) - Date.now()) / 60000))
    : null;
  const stop = async () => {
    setBusy(true);
    try {
      unwrap(await apiBrowser().POST('/v1/commands/platform.view_as.end', { body: {} }));
      router.push(acting ? `/admin/businesses/${workspaceId}` : '/admin/tickets');
      router.refresh();
    } catch {
      setBusy(false);
    }
  };
  const Icon = acting ? KeyRound : Eye;
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-warning-soft px-4 py-2 text-[13px] text-warning-text"
      data-testid="view-as-banner"
    >
      <Icon className="h-4 w-4 flex-none" strokeWidth={1.75} />
      {acting ? (
        <>
          <span className="font-semibold">You’re in {businessName} as its owner.</span>
          <span>What you change is saved for real. They aren’t told you’re here.</span>
        </>
      ) : (
        <>
          <span className="font-semibold">You are looking at {businessName}.</span>
          <span>
            Read-only, for another {minutes} {minutes === 1 ? 'minute' : 'minutes'}. They can see
            that you looked, and why.
          </span>
        </>
      )}
      <button
        type="button"
        onClick={stop}
        disabled={busy}
        className="ml-auto font-semibold underline underline-offset-2"
        data-testid="view-as-stop"
      >
        {acting ? 'Leave' : 'Stop looking'}
      </button>
    </div>
  );
}
