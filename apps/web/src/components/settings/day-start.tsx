'use client';
/**
 * Settings → My calendar → Where your day starts (docs/outreach.md, decision 179): the address a person sets out
 * from, which times the drive to their first visit of a day on calendars that leave time to drive between visits.
 * Empty starts the day from the business's address. Saved with `day_start.set`.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { DayStart } from '@/lib/api/types';

export function DayStartPart({
  workspaceId,
  shown,
  isSelf,
  firstName,
}: {
  workspaceId: string;
  shown: DayStart;
  isSelf: boolean;
  firstName: string;
}) {
  const router = useRouter();
  const saved = shown.address ?? '';
  const [draft, setDraft] = useState({ saved, value: saved });
  const value = draft.saved === saved ? draft.value : saved;
  const dirty = value.trim() !== saved;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const your = isSelf ? 'your' : 'their';

  async function save(address: string | null) {
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/day_start.set', {
          body: { workspaceId, ...(isSelf ? {} : { userId: shown.userId }), address },
        }),
      );
      toast.success(
        address
          ? `Saved. Drives to ${your} first visit of a day start there.`
          : `Saved. ${isSelf ? 'Your' : `${firstName}’s`} day starts from the business’s address.`,
      );
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="day-start">
      <Field
        label={isSelf ? 'Where your day starts' : `Where ${firstName}’s day starts`}
        htmlFor="day-start-address"
        error={error}
        hint={
          shown.address
            ? `On calendars that leave time to drive between visits, the drive to ${your} first visit of a day is timed from here, and later visits from the one before.`
            : shown.businessAddress
              ? `Empty, so ${your} day starts from the business’s address, ${shown.businessAddress}. Type ${isSelf ? 'yours' : 'theirs'} if ${isSelf ? 'you set' : `${firstName} sets`} out from somewhere else, like home.`
              : `On calendars that leave time to drive between visits, the drive to ${your} first visit of a day is timed from here. The business has no address yet, so add one here or in Settings → Payments.`
        }
      >
        <Input
          id="day-start-address"
          value={value}
          maxLength={300}
          autoComplete="street-address"
          placeholder={shown.businessAddress ?? '12 Oak St, Austin, TX 78701'}
          invalid={!!error}
          onChange={(e) => setDraft({ saved, value: e.target.value })}
          data-testid="day-start-address"
        />
      </Field>
      {dirty || shown.address ? (
        <div className="mt-2 flex items-center justify-end gap-2">
          {shown.address && !dirty ? (
            <Button
              variant="ghost"
              size="sm"
              loading={busy}
              onClick={() => void save(null)}
              data-testid="day-start-clear"
            >
              Use the business’s address
            </Button>
          ) : null}
          {dirty ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => setDraft({ saved, value: saved })}>
                Undo
              </Button>
              <Button
                size="sm"
                loading={busy}
                onClick={() => void save(value.trim() || null)}
                data-testid="day-start-save"
              >
                Save
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
