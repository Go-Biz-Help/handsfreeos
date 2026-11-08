'use client';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '@/lib/api/errors';

/**
 * Runs one of the add-on's commands the way every screen does: busy while it runs, the refusal's own words when it's
 * refused, a short toast when it's done, then the page drawn again. `busy` names what's running, so only its button
 * spins.
 */
export function useAct() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const act = useCallback(
    async <T>(
      key: string,
      run: () => Promise<T>,
      done?: string | ((out: T) => string),
    ): Promise<T | null> => {
      setBusy(key);
      try {
        const out = await run();
        const words = typeof done === 'function' ? done(out) : done;
        if (words) toast.success(words);
        setTimeout(() => router.refresh(), 0);
        return out;
      } catch (e) {
        toast.error(errorMessage(e));
        return null;
      } finally {
        setBusy(null);
      }
    },
    [router],
  );
  return { busy, act };
}
