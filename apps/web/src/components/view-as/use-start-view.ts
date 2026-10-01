'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { rememberView } from '@/lib/view-as';

/**
 * Starts viewing the app as a teammate (20261018000100) and opens their view of the business. The API decides who may
 * view as whom and says why not; the person sees that as a toast.
 */
export function useStartView(): {
  start: (workspaceId: string, userId: string) => Promise<boolean>;
  busy: string | null;
} {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const start = async (workspaceId: string, userId: string): Promise<boolean> => {
    setBusy(userId);
    try {
      const { view } = unwrap(
        await apiBrowser().POST('/v1/commands/teammate_view.start', {
          body: { workspaceId, userId },
        }),
      );
      rememberView(workspaceId, { viewId: view.id, personId: view.person.userId });
      router.push(`/app/w/${workspaceId}`);
      router.refresh();
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(null);
      return false;
    }
  };
  return { start, busy };
}
