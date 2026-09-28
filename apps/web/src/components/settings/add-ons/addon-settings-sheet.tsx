'use client';
import { ADDON_PAGE_WORDS as W, type AddonManifest } from '@hfos/core';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ADDON_UI } from '@/addons/registry';
import { AddonBoundary } from '@/components/addons/boundary';
import { lazyOnce } from '@/components/addons/lazy';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, ApiError, errorMessage, unwrap } from '@/lib/api/client';
import type { AddonSettingsOut } from '@/lib/api/types';
import { ADDON_INACTIVE } from '@/lib/api/page-refusals';
import { SetRow } from '../set-row';

/** Whether an add-on has anything to set here: switches in its manifest, or a settings form in the web's registry. */
export const hasSettings = (m: AddonManifest): boolean =>
  Object.keys(m.settings?.flags ?? {}).length > 0 || !!ADDON_UI[m.id]?.settings;

/**
 * An add-on's settings, from its card on Settings → Add-ons, while it's on (its settings are hidden while it's off,
 * like the rest of it): its switches, each saved the moment it's flipped, and below them its own settings form
 * (`settings` in addons/registry.ts), fetched the first time it's opened and fenced off in its own boundary so a
 * broken form never takes the page with it.
 */
export function AddonSettingsSheet({
  workspaceId,
  addon,
  onClose,
  onTurnedOff,
}: {
  workspaceId: string;
  /** The add-on whose settings are open, or null. */
  addon: AddonManifest | null;
  onClose: () => void;
  /** It turned out to be off by the time a change reached it: the page is read again. */
  onTurnedOff: () => void;
}) {
  return (
    <Sheet open={addon !== null} onOpenChange={(open) => (open ? null : onClose())}>
      {addon ? (
        <SheetContent title={addon.name} description={W.settingsDescription}>
          <SettingsBody
            key={addon.id}
            workspaceId={workspaceId}
            addon={addon}
            onTurnedOff={onTurnedOff}
          />
        </SheetContent>
      ) : null}
    </Sheet>
  );
}

function SettingsBody({
  workspaceId,
  addon,
  onTurnedOff,
}: {
  workspaceId: string;
  addon: AddonManifest;
  onTurnedOff: () => void;
}) {
  const [loaded, setLoaded] = useState<AddonSettingsOut | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const declared = Object.entries(addon.settings?.flags ?? {});
  const load = ADDON_UI[addon.id]?.settings;
  const Form = load ? lazyOnce(load) : null;

  /** Refused because it's off by now: say so, and let the page catch up. */
  const turnedOff = useCallback(
    (e: unknown): boolean => {
      if (!(e instanceof ApiError) || e.rule !== ADDON_INACTIVE) return false;
      toast.error(errorMessage(e));
      onTurnedOff();
      return true;
    },
    [onTurnedOff],
  );

  const read = useCallback(async () => {
    try {
      const got = unwrap(
        await apiBrowser().POST('/v1/queries/addon.settings', {
          body: { workspaceId, addonId: addon.id },
        }),
      );
      setLoaded(got);
      setFailed(null);
    } catch (e) {
      if (!turnedOff(e)) setFailed(errorMessage(e, 'Its settings didn’t load.'));
    }
  }, [workspaceId, addon.id, turnedOff]);

  useEffect(() => {
    void read();
  }, [read]);

  /** One switch flipped: saved on its own (the others stay as they are); the rest wait until it's saved. */
  async function flip(key: string, label: string, on: boolean) {
    if (!loaded?.flags) return;
    const before = loaded;
    setLoaded({ ...loaded, flags: { ...loaded.flags, [key]: on } });
    setSaving(key);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/addon.save_settings', {
          body: { workspaceId, addonId: addon.id, flags: { [key]: on } },
        }),
      );
      toast.success(W.flipped(label, on));
    } catch (e) {
      setLoaded(before);
      if (!turnedOff(e)) toast.error(errorMessage(e));
    } finally {
      setSaving(null);
    }
  }

  /** A save from the add-on's own form: a refusal goes back to the form to show, field by field. */
  const saveSettings = async (settings: Record<string, unknown>) => {
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/addon.save_settings', {
          body: { workspaceId, addonId: addon.id, settings },
        }),
      );
    } catch (e) {
      turnedOff(e);
      throw e;
    }
    await read();
  };
  const saveMySettings = async (settings: Record<string, unknown>) => {
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/addon.save_my_settings', {
          body: { workspaceId, addonId: addon.id, settings },
        }),
      );
    } catch (e) {
      turnedOff(e);
      throw e;
    }
    await read();
  };

  if (failed)
    return (
      <div className="flex flex-col items-start gap-3" data-testid="addon-settings-failed">
        <p className="text-[13px] text-text-2">{failed}</p>
        <Button variant="secondary" size="sm" onClick={() => void read()}>
          Try again
        </Button>
      </div>
    );
  if (!loaded)
    return (
      <p className="text-[13px] text-text-3" role="status">
        Loading its settings…
      </p>
    );

  return (
    <div className="flex flex-col gap-5" data-testid={`addon-settings-${addon.id}`}>
      {declared.length ? (
        loaded.flags ? (
          <div>
            {declared.map(([key, flag], i) => (
              <SetRow key={key} title={flag.label} first={i === 0} center>
                <Switch
                  checked={loaded.flags?.[key] ?? flag.default}
                  onChange={(on) => void flip(key, flag.label, on)}
                  label={flag.label}
                  disabled={saving !== null}
                  testId={`addon-flag-${key}`}
                />
              </SetRow>
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-text-2">{W.switchesHidden(addon.name)}</p>
        )
      ) : null}
      {Form ? (
        <div className={declared.length ? 'border-t border-border pt-5' : undefined}>
          <AddonBoundary addonName={addon.name}>
            <Suspense
              fallback={
                <p className="text-[13px] text-text-3" role="status">
                  Loading its settings…
                </p>
              }
            >
              <Form
                workspaceId={workspaceId}
                settings={loaded.settings}
                mySettings={loaded.mySettings}
                saveSettings={saveSettings}
                saveMySettings={saveMySettings}
              />
            </Suspense>
          </AddonBoundary>
        </div>
      ) : null}
    </div>
  );
}
