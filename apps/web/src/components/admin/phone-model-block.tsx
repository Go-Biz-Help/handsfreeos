'use client';
import {
  DESK_PHONE_LISTENER_WORDS,
  DESK_PHONE_MODEL_WORDS,
  PHONE_LISTENER_LABELS,
  PHONE_LISTENERS,
  PHONE_MODEL_LABELS,
  PHONE_MODELS,
  type PhoneListener,
  type PhoneModel,
} from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

type Choice = PhoneModel | 'default';
type ListenerChoice = PhoneListener | 'default';

/**
 * The AI on this business's calls: the model the AI teammate thinks with (the phone model), and who hears the caller
 * (the phone listener, Nova-3 or Flux). Support flips either to hear how it does on the business's calls and in its
 * test console, without a redeploy, and flips it back. Each takes effect from the next call, or the next reply in a
 * test call.
 */
export function PhoneModelBlock({
  workspaceId,
  phoneModel,
  phoneListener,
  canChange,
}: {
  workspaceId: string;
  phoneModel: PhoneModel | null;
  phoneListener: PhoneListener | null;
  canChange: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value: Choice = phoneModel ?? 'default';
  const heard: ListenerChoice = phoneListener ?? 'default';

  const save = async (
    send: () => Promise<{ data?: unknown; error?: unknown; response: Response }>,
  ) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      unwrap(await send());
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const pick = (choice: Choice) => {
    if (choice === value) return;
    void save(() =>
      apiBrowser().POST('/v1/commands/phone_model.set', {
        body: { workspaceId, model: choice === 'default' ? null : choice },
      }),
    );
  };
  const pickListener = (choice: ListenerChoice) => {
    if (choice === heard) return;
    void save(() =>
      apiBrowser().POST('/v1/commands/phone_listener.set', {
        body: { workspaceId, listener: choice === 'default' ? null : choice },
      }),
    );
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
            onChange={pick}
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
      <h3 className="mt-4 text-[13px] font-semibold">{DESK_PHONE_LISTENER_WORDS.label}</h3>
      <p className="mt-1 text-[13px] text-text-3">{DESK_PHONE_LISTENER_WORDS.explain}</p>
      <div className="mt-3" data-testid="admin-phone-listener">
        {canChange ? (
          <Segmented<ListenerChoice>
            ariaLabel={DESK_PHONE_LISTENER_WORDS.label}
            value={heard}
            onChange={pickListener}
            options={[
              {
                value: 'default',
                label: DESK_PHONE_LISTENER_WORDS.default,
                testId: 'admin-phone-listener-default',
                disabled: busy,
              },
              ...PHONE_LISTENERS.map((l) => ({
                value: l,
                label: PHONE_LISTENER_LABELS[l],
                testId: `admin-phone-listener-${l}`,
                disabled: busy,
              })),
            ]}
          />
        ) : (
          <p className="text-[13px]">
            {phoneListener
              ? PHONE_LISTENER_LABELS[phoneListener]
              : DESK_PHONE_LISTENER_WORDS.default}
          </p>
        )}
      </div>
      {error ? <p className="mt-2 text-[13px] text-danger-text">{error}</p> : null}
    </section>
  );
}
