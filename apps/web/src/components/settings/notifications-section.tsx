'use client';
import { useState } from 'react';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { SetRow } from './set-row';

export interface NotificationPrefs {
  /** A customer waited on a conversation (the worker's unanswered check). */
  readonly unansweredEmail: boolean;
  /** Online bookings and cancellations on your appointments (the calendar's team email). */
  readonly bookingEmail: boolean;
}

const ROWS: readonly {
  readonly key: keyof NotificationPrefs;
  readonly title: string;
  readonly description: string;
  readonly testId: string;
  readonly on: string;
  readonly off: string;
}[] = [
  {
    key: 'unansweredEmail',
    title: 'Email me when a customer is waiting',
    description:
      'When a conversation assigned to you has no reply after 10 minutes. Owners and admins also get it for conversations nobody is assigned to.',
    testId: 'notify-unanswered',
    on: 'You’ll get an email when a customer waits',
    off: 'You won’t get these emails',
  },
  {
    key: 'bookingEmail',
    title: 'Booking emails',
    description:
      'When a customer books or cancels one of your appointments online, or is booked in from the waitlist. Only on calendars set to email the team.',
    testId: 'notify-booking',
    on: 'You’ll get an email about online bookings',
    off: 'You won’t get booking emails',
  },
];

/** Per-person notification choices, saved to the account (so every workspace and device follows them). */
export function NotificationsSection({ initial }: { initial: NotificationPrefs }) {
  const [prefs, setPrefs] = useState(initial);
  const [saving, setSaving] = useState(false);

  async function toggle(row: (typeof ROWS)[number], value: boolean) {
    const was = prefs;
    const next = { ...prefs, [row.key]: value };
    setPrefs(next);
    setSaving(true);
    try {
      // Settings merge by their top-level key, so both choices go every time.
      unwrap(
        await apiBrowser().POST('/v1/commands/user.update_profile', {
          body: { settings: { notifications: next } },
        }),
      );
      toast.success(value ? row.on : row.off);
    } catch (e) {
      setPrefs(was);
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h2 className="text-lg font-semibold tracking-tight">Notifications</h2>
      {ROWS.map((row, i) => (
        <SetRow
          key={row.key}
          first={i === 0}
          className={i === 0 ? 'mt-2' : i === ROWS.length - 1 ? 'pb-0' : undefined}
          title={row.title}
          description={row.description}
        >
          <Switch
            checked={prefs[row.key]}
            disabled={saving}
            onChange={(v) => void toggle(row, v)}
            label={row.title}
            testId={row.testId}
          />
        </SetRow>
      ))}
    </div>
  );
}
