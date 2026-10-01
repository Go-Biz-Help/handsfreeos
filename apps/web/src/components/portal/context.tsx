'use client';
/**
 * What every page of a customer's portal (`/c/<token>`) works with once this device is signed in: whose portal it
 * is, the add-ons with pages for them, and the worker's door for what a customer does. Add-ons' portal pages
 * (addons/registry.ts, `portal`) read it with `usePortal()`, so they never hold the bearer themselves.
 */
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '@/lib/api/errors';

/** `portal.home`: the business, the customer, and the add-ons with pages about the records they're on. */
export interface PortalHome {
  readonly business: { readonly name: string };
  readonly person: { readonly firstName: string; readonly lastName: string };
  readonly addons: readonly {
    readonly id: string;
    readonly name: string;
    readonly pages: readonly { readonly path: string; readonly title: string }[];
  }[];
}

export interface Portal {
  readonly token: string;
  readonly home: PortalHome;
  /** An address in this portal: `href('messages')`, `href('a/realestate/homes')`. */
  readonly href: (path?: string) => string;
  /** One of the operations open to a customer, as them. */
  readonly op: <T>(name: string, input?: Record<string, unknown>) => Promise<T>;
  /** Adds a file of theirs to one of their records (or to them), checked as it arrives. */
  readonly upload: (
    file: File,
    recordId: string | null,
  ) => Promise<{ fileId: string; accepted: boolean; refusal: string | null }>;
  /** Opens one of the files in their portal in a new tab. */
  readonly openFile: (fileId: string) => Promise<void>;
}

const PortalContext = createContext<Portal | null>(null);
export const PortalProvider = PortalContext.Provider;

export function usePortal(): Portal {
  const p = useContext(PortalContext);
  if (!p) throw new Error('usePortal() is for the portal’s pages, inside its shell.');
  return p;
}

/**
 * One customer look-up, read when the page opens and again on `reload()` (after something changes, or every
 * `every` ms while the page is open).
 */
export function usePortalQuery<T>(
  name: string,
  input: Record<string, unknown> = {},
  opts: { readonly every?: number } = {},
) {
  const { op } = usePortal();
  const key = JSON.stringify(input);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [turn, setTurn] = useState(0);
  const reload = useCallback(() => setTurn((n) => n + 1), []);
  useEffect(() => {
    let live = true;
    op<T>(name, JSON.parse(key) as Record<string, unknown>).then(
      (d) => {
        if (!live) return;
        setData(d);
        setError(null);
      },
      (e: unknown) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [op, name, key, turn]);
  useEffect(() => {
    if (!opts.every) return;
    const t = setInterval(reload, opts.every);
    return () => clearInterval(t);
  }, [opts.every, reload]);
  return { data, error, reload };
}

/** Runs something the customer did: busy while it runs, its refusal's own words if refused, then `after`. */
export function usePortalAct(after?: () => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const act = useCallback(
    async (key: string, run: () => Promise<unknown>, done?: string): Promise<boolean> => {
      setBusy(key);
      try {
        await run();
        if (done) toast.success(done);
        after?.();
        return true;
      } catch (e) {
        toast.error(errorMessage(e));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [after],
  );
  return { busy, act };
}
