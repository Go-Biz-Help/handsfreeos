'use client';
import type { PushSwitch, PushSwitches } from '@hfos/core';
import { Smartphone } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

export interface NotificationPrefs {
  /** Something urgent is waiting: a hot lead, a lead nobody answered, or a customer waiting for a reply. */
  readonly unansweredEmail: boolean;
  /** The Action Center's morning summary, at 7 AM where the business is. */
  readonly attentionDigest: boolean;
  /** Automations' end-of-day email, to owners and admins. */
  readonly eveningSummary: boolean;
  /** The AI teammate handed a conversation to you, or to its list when nobody is assigned. */
  readonly aiHandoff: boolean;
  /** Online bookings and cancellations on your appointments (the calendar's team email). */
  readonly bookingEmail: boolean;
  /** An invoice was paid: the short note to whoever it is on, and to the owners and admins. */
  readonly paymentEmail: boolean;
  /** The worker's daily email to an organization's owners and admins about its businesses. */
  readonly agencyDigest: boolean;
  /** What an add-on the business uses needs you to see (Real Estate step 5). */
  readonly addonEmail: boolean;
}

type EmailKey = keyof NotificationPrefs;

interface Row {
  readonly title: string;
  readonly description: string;
  /** The phone's switch, or null when this moment never pushes. */
  readonly push: PushSwitch | null;
  /** The email switch, 'always' for an email that always goes, or null when it never emails. */
  readonly email: EmailKey | 'always' | null;
  /** Shown only to organization owners and admins. */
  readonly agencyOnly?: boolean;
  /** Shown only to people who answer HandsFreeOS support. */
  readonly staffOnly?: boolean;
}

/** The moments, push beside email (design/m10/Web.dc.html). */
const ROWS: readonly Row[] = [
  {
    title: 'A customer waiting on a reply',
    description: 'A new text, email or website chat that nobody has answered yet.',
    push: 'customerWaiting',
    email: null,
  },
  {
    title: 'A call nobody took',
    description:
      'A missed call, and the voicemail if one was left, with what the caller said. It goes to whoever the conversation is assigned to, else the owners and admins.',
    push: 'missedCall',
    email: null,
  },
  {
    title: 'Urgent items',
    description:
      'As soon as something can’t wait: a hot lead, a new lead nobody has answered, or a customer left waiting. Owners and admins also get the ones nobody is assigned to.',
    push: 'urgent',
    email: 'unansweredEmail',
  },
  {
    title: 'Approvals',
    description:
      'A draft from the AI teammate, or a workflow step waiting for your OK. The email always goes.',
    push: 'approval',
    email: 'always',
  },
  {
    title: 'Your appointments',
    description:
      'When one of your appointments is booked, moved or cancelled, online or by the team.',
    push: 'booking',
    email: 'bookingEmail',
  },
  {
    title: 'Assigned to you',
    description: 'When someone gives you a lead, a conversation, a task or an item on Home.',
    push: 'assigned',
    email: null,
  },
  {
    title: 'Your AI teammate’s qualifying',
    description:
      'When a lead qualifies, or a customer sends a file one of its questions asked for, like a photo of a bill. Only to the people its settings name, under AI teammate → Qualify. The email always goes.',
    push: 'qualifying',
    email: 'always',
  },
  {
    title: 'A customer pays',
    description: 'A short note when an invoice is settled, with what it was for and how they paid.',
    push: 'payment',
    email: 'paymentEmail',
  },
  {
    title: 'Your balance runs out',
    description:
      'When there is nothing left to send texts and make calls with, or the card that tops it up is declined. Owners and admins only, since they are the ones who can fix it.',
    push: 'wallet',
    email: null,
  },
  {
    title: 'A job you were on is over',
    description:
      'Half an hour after a visit you were on ends, if nobody has said how it went: mark it done, or say it didn’t happen, from the notification.',
    push: 'jobs',
    email: null,
  },
  {
    title: 'A connection stops working',
    description:
      'When something you connected stops working: payments, a calendar, your email, reviews or a phone number. Owners and admins, and whoever the calendar or inbox belongs to.',
    push: 'connections',
    email: null,
  },
  {
    title: 'An add-on needs you',
    description:
      'What an add-on your business uses needs you to see, like a duty running late or a deal at risk. Critical ones at any hour; the rest while the business is open.',
    push: 'addons',
    email: 'addonEmail',
  },
  {
    title: 'New support tickets',
    description:
      'When someone writes to HandsFreeOS support, in the app or by email. Only people who answer support get these.',
    push: 'supportTickets',
    email: null,
    staffOnly: true,
  },
  {
    title: 'Morning summary',
    description:
      'One email at 7 AM with today’s jobs, who to call, and what needs your attention, urgent first.',
    push: null,
    email: 'attentionDigest',
  },
  {
    title: 'End-of-day email',
    description:
      'One email in the evening with the day in numbers and what’s still open. Owners and admins only.',
    push: null,
    email: 'eveningSummary',
  },
  {
    title: 'The AI teammate hands you a conversation',
    description: 'When the AI teammate hands one to you, or to everyone on its hand-off list.',
    push: null,
    email: 'aiHandoff',
  },
  {
    title: 'Daily agency digest',
    description:
      'One email around 8 AM about the client businesses that need a look: failed workflow runs, approvals waiting, paused workflows and template updates.',
    push: null,
    email: 'agencyDigest',
    agencyOnly: true,
  },
];

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

  function togglePush(row: Row, key: PushSwitch, on: boolean) {
    const was = push;
    const next = { ...push, [key]: on };
    setPush(next);
    void save({ push: next }, on ? `${row.title}: push on` : `${row.title}: push off`, () =>
      setPush(was),
    );
  }

  function toggleEmail(row: Row, key: EmailKey, on: boolean) {
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
              <tr key={row.title}>
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
                      onChange={(on) => toggleEmail(row, row.email as EmailKey, on)}
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
