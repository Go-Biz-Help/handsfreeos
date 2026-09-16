'use client';
import { useState } from 'react';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { SetRow } from './set-row';

export interface NotificationPrefs {
  /** Something urgent is waiting: a hot lead, a lead nobody answered, or a customer waiting for a reply. */
  readonly unansweredEmail: boolean;
  /** The Action Center's morning summary, at 7 AM where the business is. */
  readonly attentionDigest: boolean;
  /** The AI teammate handed a conversation to you, or to its list when nobody is assigned. */
  readonly aiHandoff: boolean;
  /** Online bookings and cancellations on your appointments (the calendar's team email). */
  readonly bookingEmail: boolean;
  /** An invoice was paid: the short note to whoever it is on, and to the owners and admins. */
  readonly paymentEmail: boolean;
  /** The worker's daily email to an organization's owners and admins about its businesses. */
  readonly agencyDigest: boolean;
}

const ROWS: readonly {
  readonly key: keyof NotificationPrefs;
  readonly title: string;
  readonly description: string;
  readonly testId: string;
  readonly on: string;
  readonly off: string;
  /** Shown only to organization owners and admins. */
  readonly agencyOnly?: boolean;
}[] = [
  {
    key: 'unansweredEmail',
    title: 'Urgent items',
    description:
      'One email as soon as something can’t wait: a hot lead, a new lead nobody has answered, or a customer waiting for a reply. Owners and admins also get the ones nobody is assigned to.',
    testId: 'notify-unanswered',
    on: 'You’ll get an email when something is urgent',
    off: 'You won’t get these emails',
  },
  {
    key: 'attentionDigest',
    title: 'Morning summary',
    description:
      'One email at 7 AM with what needs your attention that day, urgent first. Nothing comes on a day when nothing does.',
    testId: 'notify-attention-digest',
    on: 'You’ll get the morning summary',
    off: 'You won’t get the morning summary',
  },
  {
    key: 'aiHandoff',
    title: 'Email me when the AI teammate hands me a conversation',
    description:
      'When it hands one to you, or to everyone on its hand-off list when nobody is assigned. Emergencies always email every owner and admin.',
    testId: 'notify-ai-handoff',
    on: 'You’ll get an email when the AI teammate hands you a conversation',
    off: 'You won’t get hand-off emails',
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
  {
    key: 'paymentEmail',
    title: 'Email me when a customer pays',
    description:
      'A short note when an invoice is settled, with what it was for and how they paid. It goes to whoever the invoice is on and to every owner and admin.',
    testId: 'notify-payment',
    on: 'You’ll get an email when a customer pays',
    off: 'You won’t get these emails',
  },
  {
    key: 'agencyDigest',
    title: 'Daily agency digest',
    description:
      'One email around 8 AM about the client businesses that need a look: failed workflow runs, approvals waiting, paused workflows and template updates. It leaves out businesses where you’re an owner or admin yourself, and only comes when something needs attention.',
    testId: 'notify-agency-digest',
    on: 'You’ll get the daily agency digest',
    off: 'You won’t get the daily agency digest',
    agencyOnly: true,
  },
];

/** Per-person notification choices, saved to the account (so every workspace and device follows them). */
export function NotificationsSection({
  initial,
  agency,
}: {
  initial: NotificationPrefs;
  /** An owner or admin of an organization: the agency digest's switch shows. */
  agency: boolean;
}) {
  const [prefs, setPrefs] = useState(initial);
  const [saving, setSaving] = useState(false);
  const shown = ROWS.filter((row) => agency || !row.agencyOnly);

  async function toggle(row: (typeof ROWS)[number], value: boolean) {
    const was = prefs;
    const next = { ...prefs, [row.key]: value };
    setPrefs(next);
    setSaving(true);
    try {
      // Settings merge by their top-level key, so every choice goes every time.
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
      {shown.map((row, i) => (
        <SetRow
          key={row.key}
          first={i === 0}
          className={i === 0 ? 'mt-2' : i === shown.length - 1 ? 'pb-0' : undefined}
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
