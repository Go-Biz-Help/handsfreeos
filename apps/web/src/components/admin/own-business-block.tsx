'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

type Choice = 'yes' | 'no';

/**
 * Whether this business is HandsFreeOS's own (M19): only then may it hold handsfreeos.com, the reserved names on it
 * aside, and receive its mail there. Staff admins set it, and it takes effect at once.
 */
export function OwnBusinessBlock({
  workspaceId,
  isPlatform,
  canChange,
}: {
  workspaceId: string;
  isPlatform: boolean;
  canChange: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value: Choice = isPlatform ? 'yes' : 'no';

  const pick = async (choice: Choice) => {
    if (choice === value || busy) return;
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/own_business.set', {
          body: { workspaceId, on: choice === 'yes' },
        }),
      );
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="mt-5 rounded-card border border-border bg-card p-4"
      data-testid="admin-own-business"
    >
      <h2 className="text-sm font-semibold">HandsFreeOS’s own business</h2>
      <p className="mt-1 text-[13px] text-text-3">
        Only HandsFreeOS’s own business may use handsfreeos.com for its email and receive mail
        there. Names the support desk uses stay reserved.
      </p>
      <div className="mt-3">
        {canChange ? (
          <Segmented<Choice>
            ariaLabel="HandsFreeOS’s own business"
            value={value}
            onChange={(v) => void pick(v)}
            options={[
              { value: 'no', label: 'No', testId: 'admin-own-business-no', disabled: busy },
              { value: 'yes', label: 'Yes', testId: 'admin-own-business-yes', disabled: busy },
            ]}
          />
        ) : (
          <p className="text-[13px]">{isPlatform ? 'Yes' : 'No'}</p>
        )}
      </div>
      {error ? <p className="mt-2 text-[13px] text-danger-text">{error}</p> : null}
    </section>
  );
}
