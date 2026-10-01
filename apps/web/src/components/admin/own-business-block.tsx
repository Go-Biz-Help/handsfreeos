'use client';
import { DESK_OWN_BUSINESS_WORDS } from '@hfos/core';
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
      <h2 className="text-sm font-semibold">{DESK_OWN_BUSINESS_WORDS.title}</h2>
      <p className="mt-1 text-[13px] text-text-3">{DESK_OWN_BUSINESS_WORDS.explain}</p>
      <div className="mt-3">
        {canChange ? (
          <Segmented<Choice>
            ariaLabel={DESK_OWN_BUSINESS_WORDS.title}
            value={value}
            onChange={(v) => void pick(v)}
            options={[
              {
                value: 'no',
                label: DESK_OWN_BUSINESS_WORDS.no,
                testId: 'admin-own-business-no',
                disabled: busy,
              },
              {
                value: 'yes',
                label: DESK_OWN_BUSINESS_WORDS.yes,
                testId: 'admin-own-business-yes',
                disabled: busy,
              },
            ]}
          />
        ) : (
          <p className="text-[13px]">
            {isPlatform ? DESK_OWN_BUSINESS_WORDS.yes : DESK_OWN_BUSINESS_WORDS.no}
          </p>
        )}
      </div>
      {error ? <p className="mt-2 text-[13px] text-danger-text">{error}</p> : null}
    </section>
  );
}
