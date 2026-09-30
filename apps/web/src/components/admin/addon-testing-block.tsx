'use client';
import { ADDON_CATALOG } from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

/** Add-ons staff can hand a business to try: built but not offered to everyone yet. */
const GRANTABLE = ADDON_CATALOG.filter((m) =>
  ['development', 'beta', 'built'].includes(m.catalog.status),
);

/**
 * Add-ons in testing (Real Estate, step 2): an add-on still being built, handed to this business to try. Its owners
 * and admins then add it from their own Add-ons page, marked Testing. Taking it back stops new installs only; one
 * they already added keeps running.
 */
export function AddonTestingBlock({
  workspaceId,
  grants,
  canChange,
}: {
  workspaceId: string;
  grants: readonly { addonId: string; note: string | null; grantedAt: string }[];
  canChange: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const granted = new Set(grants.map((g) => g.addonId));

  const change = async (addonId: string, give: boolean) => {
    if (busy) return;
    setBusy(addonId);
    setError(null);
    try {
      unwrap(
        give
          ? await apiBrowser().POST('/v1/commands/addon_grant.give', {
              body: { workspaceId, addonId },
            })
          : await apiBrowser().POST('/v1/commands/addon_grant.take_back', {
              body: { workspaceId, addonId },
            }),
      );
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  if (!GRANTABLE.length && !grants.length) return null;
  return (
    <section
      className="mt-5 rounded-card border border-border bg-card p-4"
      data-testid="admin-addon-testing"
    >
      <h2 className="text-sm font-semibold">Add-ons in testing</h2>
      <p className="mt-1 text-[13px] text-text-3">
        Let this business try an add-on before it’s finished. Its owners and admins add it from
        their Add-ons page. Taking it back stops new installs; if they added it, it keeps running.
      </p>
      <ul className="mt-3 flex flex-col gap-2 text-[13px]">
        {GRANTABLE.map((m) => {
          const on = granted.has(m.id);
          return (
            <li key={m.id} className="flex items-center justify-between gap-3">
              <span className="min-w-0">
                {m.name}
                <span className="text-text-3"> · {on ? 'they can add it' : 'not handed out'}</span>
              </span>
              {canChange ? (
                <Button
                  size="sm"
                  variant={on ? 'secondary' : 'primary'}
                  disabled={busy !== null}
                  onClick={() => void change(m.id, !on)}
                  data-testid={`admin-addon-testing-${m.id}`}
                >
                  {on ? 'Take back' : 'Let them try it'}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {error ? <p className="mt-2 text-[13px] text-danger-text">{error}</p> : null}
    </section>
  );
}
