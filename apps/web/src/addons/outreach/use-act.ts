'use client';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { ApiError, errorMessage } from '@/lib/api/client';

/**
 * A refusal's words by field: the playbook's lists say which line was wrong (`details.signs.1`), so each message goes
 * on the list it's about.
 */
function fieldErrors(e: unknown): Record<string, string> {
  if (!(e instanceof ApiError) || e.code !== 'validation' || !Array.isArray(e.details)) return {};
  const out: Record<string, string> = {};
  for (const d of e.details as { path?: unknown; message?: unknown }[]) {
    const path = Array.isArray(d.path) ? d.path.join('.') : String(d.path ?? '');
    const key =
      path
        .split(/[./]/)
        .filter((part) => part && !/^\d+$/.test(part))
        .pop() ?? '';
    if (typeof d.message === 'string' && !(key in out)) out[key] = d.message;
  }
  return out;
}

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
  return { busy, errors, act };
}
