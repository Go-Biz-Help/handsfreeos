'use client';
import { DESK_VIDEO_CALLS_WORDS } from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

type Choice = 'on' | 'off';

/**
 * Whether this business has HandsFreeOS video calls (docs/video-calls.md): its Online places can make them, and
 * appointments set to one show Join. Staff who manage add-ons turn them on for test businesses until every business
 * gets them (the owner's 16a). It counts from the next appointment booked.
 */
export function VideoCallsBlock({
  workspaceId,
  videoCalls,
  canChange,
}: {
  workspaceId: string;
  videoCalls: boolean;
  canChange: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value: Choice = videoCalls ? 'on' : 'off';

  const pick = async (choice: Choice) => {
    if (choice === value || busy) return;
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/video_calls.set', {
          body: { workspaceId, on: choice === 'on' },
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
      data-testid="admin-video-calls"
    >
      <h2 className="text-sm font-semibold">{DESK_VIDEO_CALLS_WORDS.title}</h2>
      <p className="mt-1 text-[13px] text-text-3">{DESK_VIDEO_CALLS_WORDS.explain}</p>
      <div className="mt-3">
        {canChange ? (
          <Segmented<Choice>
            ariaLabel={DESK_VIDEO_CALLS_WORDS.title}
            value={value}
            onChange={(v) => void pick(v)}
            options={[
              {
                value: 'off',
                label: DESK_VIDEO_CALLS_WORDS.off,
                testId: 'admin-video-calls-off',
                disabled: busy,
              },
              {
                value: 'on',
                label: DESK_VIDEO_CALLS_WORDS.on,
                testId: 'admin-video-calls-on',
                disabled: busy,
              },
            ]}
          />
        ) : (
          <p className="text-[13px]">
            {videoCalls ? DESK_VIDEO_CALLS_WORDS.on : DESK_VIDEO_CALLS_WORDS.off}
          </p>
        )}
      </div>
      {error ? <p className="mt-2 text-[13px] text-danger-text">{error}</p> : null}
    </section>
  );
}
