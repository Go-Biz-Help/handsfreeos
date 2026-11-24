'use client';
import { useRouter } from 'next/navigation';
import { useCallback, useState, useTransition } from 'react';
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
 * `busy` names what's running, so only its button spins; it stays busy until the page has drawn again, so nothing on
 * a row that's about to change can be pressed a second time (which was refused: "That isn't waiting for you any
 * more"). `refused` takes a refusal the screen shows itself, beside the button with its fix: it says so by returning
 * true, and no toast shows.
 *
 * A press that ends its row says so with `leaves` (true, or what the command's answer says): `gone` is then true
 * from the moment the command is done until the page has drawn again, and the row draws nothing meanwhile, so it
 * goes at once and not a redraw later (speed audit, Nov 2026). The redraw has the last word: a row still on the list
 * shows again.
 */
export function useAct(after?: () => void) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // The page drawing again after a press that worked, and which press it was.
  const [redrawing, startRedraw] = useTransition();
  const [last, setLast] = useState<{ readonly key: string; readonly leaves: boolean } | null>(null);
  const act = useCallback(
    async (
      key: string,
      run: () => Promise<unknown>,
      done?: string,
      refused?: (e: ApiError) => boolean,
      leaves: boolean | ((answer: unknown) => boolean) = false,
    ): Promise<boolean> => {
      setBusy(key);
      setErrors({});
      try {
        const answer = await run();
        if (done) toast.success(done);
        after?.();
        setLast({ key, leaves: typeof leaves === 'function' ? leaves(answer) : leaves });
        startRedraw(() => router.refresh());
        return true;
      } catch (e) {
        const fe = fieldErrors(e);
        if (Object.keys(fe).length) setErrors(fe);
        if (!(e instanceof ApiError && refused?.(e))) toast.error(errorMessage(e));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [after, router],
  );
  const drawing = redrawing ? last : null;
  return { busy: busy ?? drawing?.key ?? null, gone: drawing?.leaves ?? false, errors, act };
}
