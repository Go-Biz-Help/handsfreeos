'use client';
import { VIEW_AS_WORDS, type TeammateViewSession } from '@hfos/core';
import { UserRoundSearch } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { forgetView } from '@/lib/view-as';

/**
 * Across the top of a business while someone views it as a teammate (20261016000200): whose view it is, that nothing
 * can be changed, and the way back. Stopping ends the view everywhere, so another tab carrying it goes back too.
 */
export function TeammateViewBanner({
  workspaceId,
  view,
}: {
  workspaceId: string;
  view: TeammateViewSession;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const stop = async () => {
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/teammate_view.end', { body: { viewId: view.id } }),
      );
      forgetView(workspaceId);
      // Back where they picked the person: the team page, or HandsFreeOS's page for the business.
      router.push(
        view.by === 'team' ? `/app/w/${workspaceId}/members` : `/admin/businesses/${workspaceId}`,
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-accent-soft px-4 py-2 text-[13px] text-accent-text"
      data-testid="teammate-view-banner"
    >
      <UserRoundSearch className="h-4 w-4 flex-none" strokeWidth={1.75} />
      <span className="font-semibold">{VIEW_AS_WORDS.banner(view.person)}</span>
      <span>{VIEW_AS_WORDS.bannerDetail(view.by)}</span>
      <button
        type="button"
        onClick={stop}
        disabled={busy}
        className="ml-auto font-semibold underline underline-offset-2"
        data-testid="teammate-view-stop"
      >
        {busy ? VIEW_AS_WORDS.stopping : VIEW_AS_WORDS.stop}
      </button>
    </div>
  );
}

/** The page carried a view that no longer holds: forget it, say so once, and draw the page as the person's own. */
export function ForgetStaleView({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  useEffect(() => {
    forgetView(workspaceId);
    toast(VIEW_AS_WORDS.ended);
    router.refresh();
  }, [router, workspaceId]);
  return null;
}
