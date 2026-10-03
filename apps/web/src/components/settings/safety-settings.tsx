'use client';
/**
 * Settings → Safety (round six, core; board 91): the business's times for check-ins (how long after someone's planned
 * end they're asked "Still there?", and how long with no answer before their contacts are told) and its safety person,
 * told when someone has nobody to tell. Read by everyone in the business (`safety.settings`); saved by whoever may
 * change its settings (`safety.settings_save`, `workspace.update`). Each person's own contacts are theirs alone, on
 * their phone and on their Safety page; nobody here sees them or the places.
 */
import { SAFETY_DEFAULTS, safetyTimesLines } from '@hfos/core';
import { ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { fieldErrors } from '@/lib/api/field-errors';
import type { Ok } from '@/lib/api/types';

type SafetySettings = Ok<'/v1/queries/safety.settings'>;

export function SafetySettingsPage({
  workspaceId,
  settings,
  people,
  canChange,
}: {
  workspaceId: string;
  settings: SafetySettings;
  /** Everyone on the team, for the safety person. */
  people: readonly { readonly id: string; readonly name: string; readonly role: string }[];
  canChange: boolean;
}) {
  const router = useRouter();
  const [ask, setAsk] = useState(String(settings.askAfterMinutes));
  const [tell, setTell] = useState(String(settings.alertAfterMinutes));
  const [person, setPerson] = useState(settings.safetyUserId ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const askN = Number(ask);
  const tellN = Number(tell);
  const whole = (s: string) => /^\d+$/.test(s.trim());
  const ready = whole(ask) && whole(tell);
  const changed =
    askN !== settings.askAfterMinutes ||
    tellN !== settings.alertAfterMinutes ||
    (person || null) !== settings.safetyUserId;
  // The one named now, when the list doesn't hold them: someone who left stays named until it's changed (so the page
  // never quietly says "the owners"), and someone who only reads this page sees who it is.
  const named =
    settings.safetyUserId && !people.some((p) => p.id === settings.safetyUserId)
      ? `${settings.safetyPersonName ?? 'Someone'}${canChange ? ' (no longer here)' : ''}`
      : null;

  const save = async () => {
    setSaving(true);
    setErrors({});
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/safety.settings_save', {
          body: {
            workspaceId,
            askAfterMinutes: askN,
            alertAfterMinutes: tellN,
            safetyUserId: person || null,
          },
        }),
      );
      toast.success('Saved. Check-ins use these times from now on.');
      router.refresh();
    } catch (e) {
      setErrors(fieldErrors(e));
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto grid w-full max-w-3xl gap-4" data-testid="safety-settings">
      <Card className="p-4 md:p-5">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold">
          <ShieldCheck className="h-4 w-4 text-text-3" strokeWidth={1.75} />
          Check-ins
        </h2>
        <p className="mt-1 text-[13px] text-text-2">
          Anyone here can check in from the phone app when they’re alone at a customer’s place, with
          when they plan to leave. If they don’t check out, HandsFreeOS asks them, then tells the
          people they picked. Only they and those people ever see the place. HandsFreeOS never calls
          911.
        </p>
        <form
          className="mt-4 grid gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (canChange && ready && changed) void save();
          }}
        >
          <Field
            label="Ask them after"
            htmlFor="safety-ask"
            hint="Minutes past their planned end before the phone asks “Still there?”."
            error={errors.askAfterMinutes ?? (whole(ask) ? undefined : 'Enter whole minutes.')}
          >
            <MinutesInput
              id="safety-ask"
              value={ask}
              onChange={setAsk}
              min={0}
              disabled={!canChange}
            />
          </Field>
          <Field
            label="Then tell their contacts after"
            htmlFor="safety-tell"
            hint="More minutes with no answer before the people they picked are told."
            error={errors.alertAfterMinutes ?? (whole(tell) ? undefined : 'Enter whole minutes.')}
          >
            <MinutesInput
              id="safety-tell"
              value={tell}
              onChange={setTell}
              min={1}
              disabled={!canChange}
            />
          </Field>
          <Field
            label="Who’s told when someone has nobody to tell"
            htmlFor="safety-person"
            hint="The safety person. Nobody picked: the business’s owners and admins."
            error={errors.safetyUserId}
            className="sm:col-span-2"
          >
            <Select
              id="safety-person"
              value={person}
              disabled={!canChange}
              onChange={(e) => setPerson(e.target.value)}
              data-testid="safety-person"
            >
              <option value="">The owners and admins</option>
              {named ? <option value={settings.safetyUserId!}>{named}</option> : null}
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.role}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex flex-wrap items-center justify-between gap-3 sm:col-span-2">
            <p className="text-[12.5px] text-text-3">
              Then they’re told again every {SAFETY_DEFAULTS.repeatMinutes} minutes, for an hour,
              until someone says the person is OK.
            </p>
            {canChange ? (
              <Button
                type="submit"
                disabled={!ready || !changed}
                loading={saving}
                data-testid="safety-save"
              >
                Save
              </Button>
            ) : null}
          </div>
          {!canChange ? (
            <p className="text-[12.5px] text-text-3 sm:col-span-2">
              Only someone who can change the business’s settings changes these. Ask an owner of
              this business.
            </p>
          ) : null}
        </form>
      </Card>
      <Card className="p-4 md:p-5" data-testid="safety-preview">
        <h2 className="text-[15px] font-semibold">What each person sees</h2>
        <p className="mt-1 text-[13px] text-text-2">
          Under When, on their own Safety page and in the phone app.
        </p>
        <dl className="mt-3 divide-y divide-border rounded-control border border-border">
          {safetyTimesLines({
            askAfterMinutes: whole(ask) ? askN : settings.askAfterMinutes,
            alertAfterMinutes: whole(tell) ? tellN : settings.alertAfterMinutes,
            repeatMinutes: SAFETY_DEFAULTS.repeatMinutes,
          }).map((l) => (
            <div
              key={l.label}
              className="flex items-baseline justify-between gap-3 px-3.5 py-2.5 text-[13.5px]"
            >
              <dt className="text-text-2">{l.label}</dt>
              <dd className="text-right">{l.value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-[12.5px] text-text-3">
          Each person picks their own contacts: teammates, told in the app, or someone outside by
          text and email once they’ve agreed by replying OK. Yours are on{' '}
          <Link href={`/app/w/${workspaceId}/safety`} className="text-accent-text hover:underline">
            your Safety page
          </Link>
          .
        </p>
      </Card>
    </div>
  );
}

function MinutesInput({
  id,
  value,
  onChange,
  min,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  min: number;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={60}
        step={1}
        className="w-24"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        data-testid={id}
      />
      <span className="text-[13.5px] text-text-2">minutes</span>
    </div>
  );
}
