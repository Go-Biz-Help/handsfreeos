'use client';
/**
 * Settings → You: Your calendars (docs/outreach.md, decision 178): the Networking calendar a networking call books on,
 * and the Lead calendar a demo books on ahead of the playbook's link. Asked as the page opens
 * (`outreach.my_calendars.get`), each pick saved as it changes (`outreach.my_calendars.set`). Each person's own.
 */
import {
  LOCAL_WORDS as L,
  myCalendarsLine,
  type MyCalendarsSetInput,
  type MyCalendarsShown,
} from '@hfos/core/addons/outreach/local';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { ChangeRow, RowsCard } from './network-settings';

const NONE = '';

export function MyCalendarsPart({ workspaceId }: { workspaceId: string }) {
  const [shown, setShown] = useState<MyCalendarsShown | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    apiBrowser()
      .POST('/v1/queries/outreach.my_calendars.get', { body: { workspaceId } })
      .then((r) => {
        if (live) setShown(unwrap(r));
      })
      .catch((e: unknown) => {
        if (live) setFailed(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [workspaceId]);

  const save = async (body: Omit<MyCalendarsSetInput, 'workspaceId'>) => {
    setBusy(true);
    try {
      setShown(
        unwrap(
          await apiBrowser().POST('/v1/commands/outreach.my_calendars.set', {
            body: { workspaceId, ...body },
          }),
        ),
      );
      toast.success(L.saved);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const picker = (
    key: 'networking' | 'lead',
    label: string,
    otherwise: string,
    field: keyof Omit<MyCalendarsSetInput, 'workspaceId'>,
  ) => (
    <Field
      label={label}
      htmlFor={`outreach-my-${key}-calendar`}
      className="min-w-0 flex-[1_1_220px]"
    >
      <Select
        id={`outreach-my-${key}-calendar`}
        value={shown?.[key]?.id ?? NONE}
        disabled={!shown || busy}
        onChange={(e) => void save({ [field]: e.target.value || null })}
        data-testid={`outreach-my-${key}-calendar`}
      >
        <option value={NONE}>{L.pickNone}</option>
        {shown?.choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </Select>
      {shown && !shown[key] ? (
        <p className="mt-1 text-[12.5px] text-text-3" data-testid={`outreach-my-${key}-otherwise`}>
          {otherwise}
        </p>
      ) : null}
    </Field>
  );

  return (
    <RowsCard testId="outreach-my-calendars">
      <ChangeRow
        title={L.calendars}
        about={shown ? myCalendarsLine(shown) : (failed ?? '…')}
        testId="outreach-my-calendars-row"
      >
        <p className="text-[13px] text-text-2">{L.calendarsHint}</p>
        {shown && !shown.choices.length ? (
          <p className="text-[13px] text-text-2" data-testid="outreach-my-calendars-none">
            {L.noCalendars}
          </p>
        ) : (
          <div className="flex flex-wrap items-start gap-3">
            {picker(
              'networking',
              L.networkingCalendar,
              L.networkingOtherwise(shown?.networkingOtherwise ?? null),
              'networkingCalendarId',
            )}
            {picker('lead', L.leadCalendar, L.leadOtherwise, 'leadCalendarId')}
          </div>
        )}
      </ChangeRow>
    </RowsCard>
  );
}
