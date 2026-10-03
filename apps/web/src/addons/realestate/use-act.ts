'use client';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '@/lib/api/client';
import { fieldErrors } from '@/lib/api/field-errors';

/**
 * Runs one of the add-on's commands the way every screen does: busy while it runs, the refusal's own words when it's
 * refused (field by field where the form has fields), a short toast when it's done, then the page drawn again.
 * `busy` names what's running, so only its button spins.
 */
export function useAct(after?: () => void) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const act = useCallback(
    async (key: string, run: () => Promise<unknown>, done?: string): Promise<boolean> => {
      setBusy(key);
      setErrors({});
      try {
        await run();
        if (done) toast.success(done);
        after?.();
        // Closing a dialog changes the address (useQueryState), and Next drops a refresh still loading when the
        // address changes after it starts; so the refresh waits for that change to land first.
        setTimeout(() => router.refresh(), 0);
        return true;
      } catch (e) {
        const fe = fieldErrors(e);
        if (Object.keys(fe).length) setErrors(fe);
        toast.error(errorMessage(e));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [after, router],
  );
  return { busy, errors, setErrors, act };
}
