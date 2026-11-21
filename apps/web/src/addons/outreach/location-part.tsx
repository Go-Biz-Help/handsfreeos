'use client';
/**
 * Settings → You: Where you are and Focus on local groups (docs/outreach.md, decision 177): the person's own town, how
 * far from it is local, and whether group searches and Today lean local. Asked as the page opens
 * (`outreach.location.get`), saved with Save or the switch (`outreach.location.set`). Each person's own.
 */
import {
  LOCAL_WORDS as L,
  locationLine,
  RADIUS_CHOICES,
  type LocationSetInput,
  type LocationShown,
} from '@hfos/core/addons/outreach/local';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { ChangeRow, PickRow, RowsCard } from './network-settings';

export function LocationPart({ workspaceId }: { workspaceId: string }) {
  const [shown, setShown] = useState<LocationShown | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [area, setArea] = useState('');
  const [radius, setRadius] = useState<number>(RADIUS_CHOICES[1]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'where' | 'focus' | null>(null);

  const show = useCallback((l: LocationShown) => {
    setShown(l);
    setArea(l.area ?? l.suggested ?? '');
    setRadius(l.radiusMiles);
  }, []);

  useEffect(() => {
    let live = true;
    apiBrowser()
      .POST('/v1/queries/outreach.location.get', { body: { workspaceId } })
      .then((r) => {
        if (live) show(unwrap(r));
      })
      .catch((e: unknown) => {
        if (live) setFailed(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [workspaceId, show]);

  const save = async (key: 'where' | 'focus', body: Omit<LocationSetInput, 'workspaceId'>) => {
    setBusy(key);
    setError(null);
    try {
      show(
        unwrap(
          await apiBrowser().POST('/v1/commands/outreach.location.set', {
            body: { workspaceId, ...body },
          }),
        ),
      );
      toast.success(L.saved);
    } catch (e) {
      // The town's refusal says how to write it, beside the box; anything else is a toast.
      if (key === 'where') setError(errorMessage(e));
      else toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <RowsCard testId="outreach-my-local">
      <ChangeRow
        title={L.where}
        about={shown ? locationLine(shown) : (failed ?? '…')}
        testId="outreach-my-where"
      >
        <p className="text-[13px] text-text-2">{L.whereHint}</p>
        <div className="flex flex-wrap items-end gap-3">
          <Field
            label={L.townLabel}
            htmlFor="outreach-my-town"
            error={error}
            className="min-w-0 flex-[1_1_220px]"
          >
            <Input
              id="outreach-my-town"
              value={area}
              placeholder={L.townPlaceholder}
              invalid={!!error}
              maxLength={80}
              autoComplete="address-level2"
              onChange={(e) => setArea(e.target.value)}
              data-testid="outreach-my-town"
            />
          </Field>
          <Field label={L.radiusLabel} htmlFor="outreach-my-radius" className="flex-none">
            <Select
              id="outreach-my-radius"
              value={String(radius)}
              onChange={(e) => setRadius(Number(e.target.value))}
              data-testid="outreach-my-radius"
            >
              {[...new Set([...RADIUS_CHOICES, radius])]
                .sort((a, b) => a - b)
                .map((m) => (
                  <option key={m} value={m}>
                    {L.miles(m)}
                  </option>
                ))}
            </Select>
          </Field>
          <Button
            size="sm"
            loading={busy === 'where'}
            disabled={busy !== null || !shown}
            onClick={() => void save('where', { area: area.trim() || null, radiusMiles: radius })}
            data-testid="outreach-my-where-save"
          >
            {L.save}
          </Button>
        </div>
        {shown?.area ? (
          <p className="text-[13px] text-text-2" data-testid="outreach-my-near">
            {L.nearLine(shown)}
          </p>
        ) : null}
      </ChangeRow>
      <PickRow
        title={L.focus}
        about={shown && !shown.area ? L.focusNeedsTown : L.focusHint}
        testId="outreach-my-local-focus"
      >
        <Switch
          checked={shown?.localFocus ?? false}
          disabled={!shown?.area || busy !== null}
          busy={busy === 'focus'}
          onChange={(on) => void save('focus', { localFocus: on })}
          label={L.focus}
          testId="outreach-my-local-focus-switch"
        />
      </PickRow>
    </RowsCard>
  );
}
