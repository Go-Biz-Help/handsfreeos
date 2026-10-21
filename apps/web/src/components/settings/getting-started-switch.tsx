'use client';
import { GUIDE_SWITCH_WORDS, ONBOARDING_WORDS } from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { settingAttrs } from './setting-anchor';

/**
 * Getting started on or off for the whole business (`onboarding.set_enabled`). Off, nobody in the business sees the
 * guide, the setup wizard or the tour; each person's progress is kept for when it's turned on again.
 */
export function GettingStartedSwitch({
  workspaceId,
  enabled,
}: {
  workspaceId: string;
  enabled: boolean;
}) {
  const router = useRouter();
  const [on, setOn] = useState(enabled);
  const [busy, setBusy] = useState(false);

  async function flip(next: boolean) {
    setOn(next);
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/onboarding.set_enabled', {
          body: { workspaceId, enabled: next },
        }),
      );
      toast.success(next ? ONBOARDING_WORDS.turnedOn : ONBOARDING_WORDS.turnedOff);
      router.refresh();
    } catch (e) {
      setOn(!next);
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      className="flex items-start gap-4 p-6"
      data-testid="getting-started-switch"
      {...settingAttrs('workspace.getting_started')}
    >
      <div className="min-w-0 flex-1">
        <h2 className="text-lg font-semibold tracking-tight">{GUIDE_SWITCH_WORDS.title}</h2>
        <p className="mt-1 text-[13px] text-text-2">
          {on ? GUIDE_SWITCH_WORDS.on : GUIDE_SWITCH_WORDS.off}
        </p>
      </div>
      <Switch
        checked={on}
        disabled={busy}
        onChange={(next) => void flip(next)}
        label={GUIDE_SWITCH_WORDS.label}
        className="mt-1"
        testId="getting-started-enabled"
      />
    </Card>
  );
}
