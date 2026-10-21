'use client';
import {
  EMAIL_ONLY_ROWS,
  NOTIFICATION_ROWS,
  type EmailSwitch,
  type EmailSwitches,
  type NotificationRow,
  type PushSwitch,
  type PushSwitches,
} from '@hfos/core';
import { Smartphone } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { settingAttrs } from './setting-anchor';

/** The email switches as the account keeps them, each on unless turned off (core's `EmailSwitches`). */
export type NotificationPrefs = EmailSwitches;

/** The moments, push beside email (design/m10/Web.dc.html): core's rows, the phone's too. */
const ROWS = [...NOTIFICATION_ROWS, ...EMAIL_ONLY_ROWS];

const Faint = ({ children }: { children: string }) => (
  <span className="text-[13px] text-text-3">{children}</span>
);

/**
 * Per-person notification choices, saved to the account so every business and every phone follows them: push
 * beside today's email switches. Settings save a whole top-level key at a time, so a push change sends every push
 * switch (`settings.push`) and an email change every email one (`settings.notifications`).
 */
export function NotificationsSection({
  initial,
  agency,
  staff = false,
  phones,
}: {
  initial: { readonly email: NotificationPrefs; readonly push: PushSwitches };
  /** An owner or admin of an organization: the agency digest's row shows. */
  agency: boolean;
  /** Someone who answers HandsFreeOS support: the new support tickets row shows. */
  staff?: boolean;
  /** How many phones the person gets push on now. */
  phones: number;
}) {
  const [email, setEmail] = useState(initial.email);
  const [push, setPush] = useState(initial.push);
  const [saving, setSaving] = useState(false);
  const rows = ROWS.filter((row) => (agency || !row.agencyOnly) && (staff || !row.staffOnly));

  async function save(
    change: { push: PushSwitches } | { notifications: NotificationPrefs },
    words: string,
    undo: () => void,
  ) {
    setSaving(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/user.update_profile', {
          body: { settings: change },
        }),
      );
      toast.success(words);
    } catch (e) {
      undo();
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  function togglePush(row: NotificationRow, key: PushSwitch, on: boolean) {
    const was = push;
    const next = { ...push, [key]: on };
    setPush(next);
    void save({ push: next }, on ? `${row.title}: push on` : `${row.title}: push off`, () =>
      setPush(was),
    );
  }

  function toggleEmail(row: NotificationRow, key: EmailSwitch, on: boolean) {
    const was = email;
    const next = { ...email, [key]: on };
    setEmail(next);
    void save(
      { notifications: next },
      on ? `${row.title}: email on` : `${row.title}: email off`,
      () => setEmail(was),
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight">Notifications</h2>
          <p className="mt-1 text-[13px] text-text-2">
            Push goes to the HandsFreeOS app on your phones. Email works as it does today.
          </p>
        </div>
        <Badge
          variant={phones > 0 ? 'accent' : 'gray'}
          className="h-6 px-2.5 text-[12.5px] font-semibold"
          title={
            phones > 0
              ? 'Every phone you’re signed in on gets push'
              : 'Sign in to the HandsFreeOS app on your phone to get push'
          }
          data-testid="push-phones"
        >
          <Smartphone className="h-[13px] w-[13px]" strokeWidth={1.75} />
          {phones === 0 ? 'No phones yet' : phones === 1 ? 'On 1 phone' : `On ${phones} phones`}
        </Badge>
      </div>
      <table className="mt-3 w-full border-separate border-spacing-0 text-[13.5px]">
        <thead>
          <tr className="text-left text-xs font-medium text-text-3">
            <th scope="col" className="border-b border-border py-2 font-medium">
              When
            </th>
            <th
              scope="col"
              className="w-[72px] border-b border-border py-2 text-center font-medium"
            >
              Push
            </th>
            <th
              scope="col"
              className="w-[72px] border-b border-border py-2 text-center font-medium"
            >
              Email
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const last = i === rows.length - 1;
            const cell = `py-3 align-top ${last ? '' : 'border-b border-border'}`;
            return (
              <tr key={row.title} {...settingAttrs(row.key)}>
                <th scope="row" className={`${cell} pr-3 text-left font-normal`}>
                  <span className="block font-medium">{row.title}</span>
                  <span className="mt-0.5 block max-w-[640px] text-[12.5px] leading-[1.4] text-text-3">
                    {row.description}
                  </span>
                </th>
                <td className={`${cell} text-center`}>
                  {row.push ? (
                    <Switch
                      checked={push[row.push]}
                      disabled={saving}
                      onChange={(on) => togglePush(row, row.push!, on)}
                      label={`${row.title}: push`}
                      testId={`push-${row.push}`}
                    />
                  ) : (
                    <Faint>—</Faint>
                  )}
                </td>
                <td className={`${cell} text-center`}>
                  {row.email === 'always' ? (
                    <Faint>Always</Faint>
                  ) : row.email ? (
                    <Switch
                      checked={email[row.email]}
                      disabled={saving}
                      onChange={(on) => toggleEmail(row, row.email as EmailSwitch, on)}
                      label={`${row.title}: email`}
                      testId={`email-${row.email}`}
                    />
                  ) : (
                    <Faint>—</Faint>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
