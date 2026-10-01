'use client';
import {
  DESK_PHONE_MODEL_WORDS,
  PHONE_MODEL_LABELS,
  PHONE_MODELS,
  type PhoneModel,
} from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

type Choice = PhoneModel | 'default';

/**
 * The model the AI teammate thinks with on this business's calls (the phone model). Support flips it to hear how a
 * faster model sounds on the business's calls and in its test console, without a redeploy, and flips it back. It
 * takes effect from the next call, or the next reply in a test call.
 */
export function PhoneModelBlock({
  workspaceId,
  phoneModel,
  canChange,
}: {
  workspaceId: string;
  phoneModel: PhoneModel | null;
  canChange: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value: Choice = phoneModel ?? 'default';

  const pick = async (choice: Choice) => {
    if (choice === value || busy) return;
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/phone_model.set', {
          body: { workspaceId, model: choice === 'default' ? null : choice },
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
      data-testid="admin-phone-model"
    >
      <h2 className="text-sm font-semibold">{DESK_PHONE_MODEL_WORDS.title}</h2>
      <p className="mt-1 text-[13px] text-text-3">{DESK_PHONE_MODEL_WORDS.explain}</p>
      <div className="mt-3">
        {canChange ? (
          <Segmented<Choice>
            ariaLabel={DESK_PHONE_MODEL_WORDS.label}
            value={value}
            onChange={(v) => void pick(v)}
            options={[
              {
                value: 'default',
                label: DESK_PHONE_MODEL_WORDS.default,
                testId: 'admin-phone-model-default',
              },
              ...PHONE_MODELS.map((m) => ({
                value: m,
                label: PHONE_MODEL_LABELS[m],
                testId: `admin-phone-model-${m}`,
                disabled: busy,
              })),
            ]}
          />
        ) : (
          <p className="text-[13px]">
            {phoneModel ? PHONE_MODEL_LABELS[phoneModel] : DESK_PHONE_MODEL_WORDS.default}
          </p>
        )}
      </div>
      {error ? <p className="mt-2 text-[13px] text-danger-text">{error}</p> : null}
    </section>
  );
}
