'use client';
import { Eye } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiBrowser, unwrap } from '@/lib/api/client';

/**
 * Shown across the top of a business a support person is looking at. Loud, and honest about two things: it
 * is read-only, and the business has been told.
 */
export function ViewAsBanner({
  businessName,
  expiresAt,
}: {
  businessName: string;
  expiresAt: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const minutes = Math.max(0, Math.round((Date.parse(expiresAt) - Date.now()) / 60000));
  const stop = async () => {
    setBusy(true);
    try {
      unwrap(await apiBrowser().POST('/v1/commands/platform.view_as.end', { body: {} }));
      router.push('/admin/tickets');
      router.refresh();
    } catch {
      setBusy(false);
    }
  };
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-warning-soft px-4 py-2 text-[13px] text-warning-text"
      data-testid="view-as-banner"
    >
      <Eye className="h-4 w-4 flex-none" strokeWidth={1.75} />
      <span className="font-semibold">You are looking at {businessName}.</span>
      <span>
        Read-only, for another {minutes} {minutes === 1 ? 'minute' : 'minutes'}. They can see that
        you looked, and why.
      </span>
      <button
        type="button"
        onClick={stop}
        disabled={busy}
        className="ml-auto font-semibold underline underline-offset-2"
        data-testid="view-as-stop"
      >
        Stop looking
      </button>
    </div>
  );
}
