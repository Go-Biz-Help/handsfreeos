'use client';
import {
  addDays,
  can,
  formatDuration,
  localInstant,
  moneyLabel,
  type CalendarConfig,
} from '@hfos/core';
import {
  CalendarClock,
  Check,
  FileText,
  Globe,
  Mail,
  MapPin,
  MessageCircle,
  Phone,
  Truck,
  UserX,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { MessageSheet } from '@/components/inbox/message-sheet';
import { Avatar } from '@/components/ui/avatar';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetClose, SheetContent } from '@/components/ui/sheet';
import { ApiError, apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { AppointmentDetail } from '@/lib/api/types';
import { useCalls } from '@/lib/calls/call-provider';
import { byLead, reminderKeyOf, reminderLabel, reminderWhy } from '@/lib/calendar/reminders';
import {
  dateOf,
  dayTime,
  fmtAt,
  fmtDateLong,
  fmtLength,
  fmtRange,
  fmtTime,
  todayIn,
  zoneLabel,
} from '@/lib/calendar/time';
import { telHref } from '@/lib/format';
import { useLiveVersion } from '@/lib/realtime/live-provider';
import { AddAttendeeDialog } from './add-attendee-dialog';
import { firstName, holdOf, statusOf, useNow } from './appt';
import { CancelDialog } from './cancel-dialog';
import { calendarConfig } from './config-cache';
import { MoveDialog } from './move-dialog';
import { ReassignDialog } from './reassign-dialog';
import { JobBlock } from './job-block';
import { invoiceThisVisit, useVisitMoney, VisitMoneyBlock } from './visit-money';

const Section = ({
  label,
  children,
  action,
}: {
  label: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) => (
  <div className="mt-3.5">
    <div className="mb-0.5 flex items-center justify-between">
      <span className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
        {label}
      </span>
      {action}
    </div>
    {children}
  </div>
);

type Attendee = AppointmentDetail['attendees'][number];
type Entry = NonNullable<Attendee['reminders']['confirmation']>;

/** How a booking was confirmed: a text (C, or YES while asked), the Confirm button, staff, or the AI teammate. */
type Via = NonNullable<Attendee['confirmedVia']>;
interface Confirmation {
  readonly at: string;
  readonly via: Via | null;
  /** The teammate who marked it (their name), or 'you'. */
  readonly by: string | null;
}

interface ReminderRow {
  readonly key: string;
  readonly label: string;
  readonly detail: string;
  readonly text: boolean;
  /** What the worker recorded; `replaced` is for an earlier start, `planned` is from settings alone. */
  readonly state: 'scheduled' | 'sent' | 'skipped' | 'replaced' | 'planned';
}

interface ReminderGroup {
  readonly id: string;
  /** Whose they are, when more than one customer is booked. */
  readonly name: string | null;
  readonly rows: readonly ReminderRow[];
}

const BADGE: Record<ReminderRow['state'], { label: string; variant: BadgeVariant } | null> = {
  scheduled: { label: 'Scheduled', variant: 'accent' },
  sent: { label: 'Sent', variant: 'ok' },
  skipped: { label: 'Skipped', variant: 'gray' },
  replaced: { label: 'Replaced', variant: 'gray' },
  planned: null,
};

const capital = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/**
 * What the worker recorded for each customer: the confirmation, then each reminder in the order they go.
 * Scheduled ones show when they go, sent ones when and how, skipped ones why. An entry for an earlier start
 * (the appointment moved since) shows as replaced.
 */
function recordedGroups(
  a: AppointmentDetail,
  attendees: readonly Attendee[],
  config: CalendarConfig | null,
  timeZone: string,
): ReminderGroup[] {
  const start = Date.parse(a.startsAt);
  const many = attendees.length > 1;
  return attendees
    .map((t) => {
      const name = firstName(t.fullName);
      const byText = (key: string) =>
        t.smsOk &&
        (key === 'confirmation'
          ? config?.notifications.confirmation.text
          : config?.notifications.reminderChannels.text) !== false;
      const entries: (readonly [string, Entry])[] = [
        ...(t.reminders.confirmation ? [['confirmation', t.reminders.confirmation] as const] : []),
        ...Object.keys(t.reminders.reminders)
          .sort(byLead)
          .map((k) => [k, t.reminders.reminders[k]!] as const),
      ];
      const rows = entries.map(([key, e]): ReminderRow => {
        const base = {
          key,
          label: reminderLabel(key),
          text: e.channel ? e.channel === 'sms' : byText(key),
        };
        if (Date.parse(e.startsAt) !== start)
          return { ...base, state: 'replaced', detail: `Was for ${fmtAt(e.startsAt, timeZone)}` };
        const why = reminderWhy(e.reason, name);
        if (e.status === 'sent')
          return {
            ...base,
            state: 'sent',
            detail: `${dayTime(e.at, timeZone)} by ${e.channel === 'email' ? 'email' : 'text'}${e.channel === 'email' && why ? `, since ${why}` : ''}`,
          };
        if (e.status === 'skipped')
          return { ...base, state: 'skipped', detail: capital(why ?? 'not sent') };
        return {
          ...base,
          state: 'scheduled',
          detail: e.dueAt
            ? `${dayTime(e.dueAt, timeZone)}${e.reason === 'quiet_hours' ? ', after quiet hours' : ''}`
            : 'Waiting to go',
        };
      });
      return { id: t.id, name: many ? t.fullName : null, rows };
    })
    .filter((g) => g.rows.length > 0);
}

/** Before the worker has recorded anything: the reminders the calendar's settings plan. */
function plannedRows(
  a: AppointmentDetail,
  config: CalendarConfig,
  timeZone: string,
  now: number | null,
): ReminderRow[] {
  const n = config.notifications;
  if (!n.reminderChannels.text && !n.reminderChannels.email) return [];
  const start = Date.parse(a.startsAt);
  const date = dateOf(start, timeZone);
  const booked = a.attendees.filter((x) => x.status === 'booked');
  const text = booked.some((x) => x.smsOk) && n.reminderChannels.text;
  return n.reminders.map((r) => {
    const at =
      r.kind === 'day_before'
        ? localInstant(addDays(date, -1), r.at, timeZone)
        : start - r.minutes * 60_000;
    const key = reminderKeyOf(r);
    return {
      key,
      label: reminderLabel(key),
      detail: `${dayTime(at, timeZone)}${booked.length > 1 ? `, to ${booked.length} people` : ''}`,
      text,
      state: now !== null && at > now && a.status === 'scheduled' ? 'scheduled' : 'planned',
    };
  });
}

/**
 * An appointment's details, from the right on wide screens and from the bottom on phones: the customer (or
 * the seats on a session), where, who and what's reserved, reminders and notes, then Reschedule, Complete,
 * No-show and Cancel.
 */
export function AppointmentSheet({
  workspaceId,
  appointmentId,
  timeZone,
  people,
  myUserId,
  myPermissions,
  onClose,
  onChanged,
}: {
  workspaceId: string;
  appointmentId: string;
  timeZone: string;
  people: readonly { userId: string; fullName: string }[];
  /** Who is reading: their own confirmation mark says "Confirmed by you". */
  myUserId?: string;
  /** What the business lets them do (0106): billing a visit is for whoever may bill. */
  myPermissions?: readonly string[];
  onClose: () => void;
  onChanged?: () => void;
}) {
  const version = useLiveVersion(['appointment']);
  const now = useNow();
  const router = useRouter();
  const calls = useCalls();
  const [appt, setAppt] = useState<AppointmentDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [config, setConfig] = useState<CalendarConfig | null>(null);
  const [action, setAction] = useState<'reschedule' | 'cancel' | 'reassign' | 'add' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<'sms' | 'email' | null>(null);

  const load = useCallback(async () => {
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/queries/appointment.get', {
          body: { workspaceId, appointmentId },
        }),
      );
      setAppt(out.appointment);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setMissing(true);
      else toast.error(errorMessage(e));
    }
  }, [workspaceId, appointmentId]);
  useEffect(() => {
    void load();
  }, [load, version]);

  const calendarId = appt?.calendar.id;
  useEffect(() => {
    if (!calendarId) return;
    let cancelled = false;
    calendarConfig(workspaceId, calendarId)
      .then((c) => !cancelled && setConfig(c))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId, calendarId]);

  const changed = () => {
    void load();
    onChanged?.();
  };

  /**
   * Bill this visit: a draft invoice for the job with the deposit already taken off, then straight into the
   * editor so nothing goes out before someone has read it.
   */
  async function billVisit() {
    if (!appt || !seat) return;
    setBusy('invoice');
    try {
      const invoiceId = await invoiceThisVisit(
        workspaceId,
        appt,
        seat,
        money?.deposit ?? null,
        timeZone,
      );
      toast.success('Draft invoice started for this visit.');
      router.push(`/app/w/${workspaceId}/money/invoices/${invoiceId}`);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(null);
    }
  }

  async function setStatus(status: 'completed' | 'no_show') {
    if (!appt) return;
    setBusy(status);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/appointment.set_status', {
          body: { workspaceId, appointmentId: appt.id, status },
        }),
      );
      toast.success(status === 'completed' ? 'Marked complete.' : 'Marked as a no-show.');
      changed();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  /** Mark confirmed for the customer (they said so on the phone), or take back a mark someone on the team made. */
  async function markConfirmed(seat: Attendee, confirmed: boolean) {
    setBusy(confirmed ? 'confirm' : 'unconfirm');
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/attendee.confirm', {
          body: { workspaceId, attendeeId: seat.id, confirmed },
        }),
      );
      if (confirmed)
        toast.success(`Marked ${firstName(seat.fullName)}’s visit confirmed.`, {
          action: { label: 'Undo', onClick: () => void markConfirmed(seat, false) },
        });
      else toast.success('Confirmation taken back.');
      changed();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const money = useVisitMoney(workspaceId, appt?.id ?? null);
  const status = appt ? statusOf(appt, now) : null;
  const booked = appt?.attendees.filter((x) => x.status !== 'cancelled') ?? [];
  const single = appt && appt.capacity === 1 && booked.length === 1 ? booked[0]! : null;
  // Confirming is for one-on-one bookings.
  const seat = single;
  /**
   * Held while a customer pays its deposit: a real slot nobody has been told is theirs. Everything that
   * treats this as a booking — asking the customer to confirm it, billing it — waits until it really is one.
   */
  const hold = appt ? holdOf(appt, now) : null;
  /**
   * Billing is for whoever the business lets bill (0106), one customer at a time, once the time is really
   * theirs and nobody has billed it yet — a second press would raise a second invoice for one visit.
   */
  const billable =
    can(myPermissions, 'money.bill') && !!seat && !hold && !!money && !money.jobInvoice;
  const invoiceVisitButton = (wide?: boolean) =>
    billable ? (
      <Button
        variant="secondary"
        size="sm"
        className={wide ? 'col-span-2 h-11 sm:h-8' : 'h-11 sm:h-8'}
        loading={busy === 'invoice'}
        onClick={() => void billVisit()}
        data-testid="sheet-invoice-visit"
      >
        <FileText className="h-3.5 w-3.5" strokeWidth={1.5} />
        Invoice this visit
      </Button>
    ) : null;
  const confirmation: Confirmation | null = seat?.confirmedAt
    ? {
        at: seat.confirmedAt,
        via: seat.confirmedVia,
        by: seat.confirmedBy
          ? seat.confirmedBy.id === myUserId
            ? 'you'
            : seat.confirmedBy.fullName
          : null,
      }
    : null;
  // Not while it is held: nobody has told this customer the time is theirs, so there is nothing to confirm.
  const upcoming =
    !!appt &&
    appt.status === 'scheduled' &&
    !hold &&
    Date.parse(appt.startsAt) > (now ?? Date.now());
  const seatFirst = seat ? firstName(seat.fullName) : '';
  /** "Confirmed by text 4:12 PM", "Confirmed online Wed 9:05 AM", "Confirmed by Priya 4:12 PM". */
  const confirmedWords = (c: Confirmation): string => {
    const who = c.by === 'you' ? 'you' : firstName(c.by ?? '') || 'the team';
    const how =
      c.via === 'sms'
        ? 'by text'
        : c.via === 'link'
          ? 'online'
          : c.via === 'ai'
            ? 'by the AI teammate'
            : `by ${who}`;
    const at =
      dateOf(c.at, timeZone) === todayIn(timeZone)
        ? fmtTime(c.at, timeZone)
        : dayTime(c.at, timeZone);
    return `Confirmed ${how} ${at}`;
  };
  const callSeat = () =>
    seat?.contactPhone
      ? calls.available
        ? calls.openDialer({
            name: seat.fullName,
            phone: seat.contactPhone,
            personId: seat.personId,
          })
        : window.open(telHref(seat.contactPhone) ?? '#', '_self')
      : undefined;
  const seatsLeft = appt ? Math.max(0, appt.capacity - appt.seatsTaken) : 0;
  const travel =
    config && appt?.location.kind === 'customer_address' ? config.buffers.travelMinutes : 0;
  const whenNote = [
    zoneLabel(timeZone),
    appt && appt.bufferBefore && appt.bufferBefore === appt.bufferAfter
      ? `${fmtLength(appt.bufferBefore)} ${travel ? 'travel ' : ''}before and after`
      : appt && (appt.bufferBefore || appt.bufferAfter)
        ? `${fmtLength(appt.bufferBefore)} before, ${fmtLength(appt.bufferAfter)} after`
        : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const role = (r: 'host' | 'crew') =>
    config?.team.assignment === 'collective'
      ? 'Required'
      : appt && appt.staff.length > 1
        ? r === 'host'
          ? 'Lead'
          : 'Crew'
        : appt?.kind === 'session'
          ? 'Host'
          : 'Assigned';
  const address = appt?.location.address ?? null;
  /** On a calendar that needs no staff: no people to show or change, only the equipment. */
  const staffless =
    !!appt && appt.staff.length === 0 && (!config || config.team.assignment === 'none');
  const recorded = appt && booked.length ? recordedGroups(appt, booked, config, timeZone) : [];
  const planned =
    appt && config && booked.length && !recorded.length
      ? plannedRows(appt, config, timeZone, now)
      : [];
  const reminders: readonly ReminderGroup[] = recorded.length
    ? recorded
    : planned.length
      ? [{ id: 'planned', name: null, rows: planned }]
      : [];

  return (
    <>
      <Sheet open onOpenChange={(o) => !o && onClose()}>
        <SheetContent title={appt?.title ?? 'Appointment'} hideHeader className="sm:w-[480px]">
          {!appt ? (
            <div className="py-10 text-center text-[13px] text-text-3">
              {missing ? 'This appointment isn’t there any more.' : 'Loading…'}
            </div>
          ) : (
            <div
              data-testid="appointment-sheet"
              data-status={appt.status}
              className="flex flex-col"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant={status!.variant} data-testid="sheet-status">
                    {status!.label}
                  </Badge>
                  <span className="inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full bg-card-2 px-2 text-xs font-medium text-text-2">
                    <i
                      className="inline-block h-[7px] w-[7px] rounded-full"
                      style={{ background: appt.calendar.color }}
                    />
                    {appt.calendar.name}
                  </span>
                  {appt.source === 'booking_page' || appt.source === 'ai_teammate' ? (
                    <span className="inline-flex h-[22px] items-center gap-1.5 rounded-full bg-card-2 px-2 text-xs font-medium text-text-2">
                      <Globe className="h-3 w-3" strokeWidth={1.5} />
                      {appt.source === 'ai_teammate' ? 'Booked by AI' : 'Booked online'}
                    </span>
                  ) : null}
                </div>
                <SheetClose
                  className="-mr-1.5 -mt-1 rounded-control p-1.5 text-text-2 hover:bg-card-2 hover:text-text"
                  aria-label="Close"
                >
                  <X className="h-[18px] w-[18px]" />
                </SheetClose>
              </div>
              <h2 className="mt-2.5 text-xl font-semibold tracking-tight" data-testid="sheet-title">
                {appt.title}
                {single ? ` · ${single.fullName}` : ''}
              </h2>
              <div className="mt-[3px] text-[13px]" data-testid="sheet-when">
                {fmtDateLong(dateOf(appt.startsAt, timeZone))} ·{' '}
                {fmtRange(appt.startsAt, appt.endsAt, timeZone)}
              </div>
              <div className="mt-px text-xs text-text-3">{whenNote}</div>

              {single ? (
                <Section label="Customer">
                  <div className="flex items-center gap-3 pt-1.5">
                    <Avatar name={single.fullName} seed={single.personId} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <Link
                        href={`/app/w/${workspaceId}/customers/people/${single.personId}`}
                        className="truncate text-[13px] font-medium hover:underline"
                      >
                        {single.fullName}
                      </Link>
                      <span className="truncate text-xs text-text-3">
                        {[
                          single.contactPhone ?? single.contactEmail,
                          single.smsOk ? 'Texts OK' : 'No text consent',
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                    {single.contactPhone ? (
                      calls.available ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() =>
                            calls.openDialer({
                              name: single.fullName,
                              phone: single.contactPhone!,
                              personId: single.personId,
                            })
                          }
                        >
                          <Phone className="h-3.5 w-3.5" strokeWidth={1.5} />
                          Call
                        </Button>
                      ) : (
                        <a
                          href={telHref(single.contactPhone) ?? '#'}
                          className="inline-flex h-8 items-center gap-2 rounded-control border border-border-strong bg-card px-2.5 text-[13px] font-medium shadow-1 hover:bg-card-2"
                        >
                          <Phone className="h-3.5 w-3.5" strokeWidth={1.5} />
                          Call
                        </a>
                      )
                    ) : null}
                    {single.contactPhone || single.contactEmail ? (
                      <Button
                        variant="secondary"
                        size="icon"
                        title={single.contactPhone ? 'Text' : 'Email'}
                        aria-label={single.contactPhone ? 'Text' : 'Email'}
                        onClick={() => setMessage(single.contactPhone ? 'sms' : 'email')}
                      >
                        {single.contactPhone ? (
                          <MessageCircle className="h-3.5 w-3.5" strokeWidth={1.5} />
                        ) : (
                          <Mail className="h-3.5 w-3.5" strokeWidth={1.5} />
                        )}
                      </Button>
                    ) : null}
                  </div>
                  {seat && confirmation ? (
                    <div
                      className="mt-2.5 flex flex-wrap items-center gap-2"
                      data-testid="sheet-confirmed"
                      data-via={confirmation.via ?? ''}
                    >
                      <Badge variant="ok">
                        <Check className="h-3 w-3" strokeWidth={2} aria-hidden />
                        {confirmedWords(confirmation)}
                      </Badge>
                      {confirmation.via === 'staff' ? (
                        upcoming ? (
                          <button
                            type="button"
                            className="text-xs font-medium text-accent-text hover:underline disabled:opacity-50"
                            disabled={busy === 'unconfirm'}
                            onClick={() => void markConfirmed(seat, false)}
                            data-testid="sheet-unconfirm"
                          >
                            Take back
                          </button>
                        ) : null
                      ) : (
                        <span className="text-xs text-text-3">
                          {confirmation.via === 'sms'
                            ? `${seatFirst} replied to the reminder.`
                            : confirmation.via === 'link'
                              ? `${seatFirst} pressed Confirm on their appointment page.`
                              : `${seatFirst} confirmed with the AI teammate.`}
                        </span>
                      )}
                    </div>
                  ) : seat && upcoming ? (
                    seat.smsOk || seat.contactEmail ? (
                      <div
                        className="mt-2.5 flex flex-wrap items-center gap-2"
                        data-testid="sheet-unconfirmed"
                      >
                        <Badge variant="pending">Not confirmed</Badge>
                        <span className="min-w-0 flex-1 text-xs text-text-3">
                          {seat.confirmAskedAt
                            ? `Asked ${dayTime(seat.confirmAskedAt, timeZone)}, no answer yet.`
                            : 'Not asked yet.'}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7"
                          loading={busy === 'confirm'}
                          onClick={() => void markConfirmed(seat, true)}
                          data-testid="sheet-mark-confirmed"
                        >
                          <Check className="h-3.5 w-3.5" strokeWidth={1.5} />
                          Mark confirmed
                        </Button>
                      </div>
                    ) : (
                      <>
                        <div
                          className="mt-2.5 flex flex-col gap-2 rounded-[10px] bg-warning-soft px-3 py-2.5 text-warning-text"
                          data-testid="sheet-unconfirmed"
                          data-reachable="false"
                        >
                          <span>
                            <Badge variant="pending" className="bg-card">
                              Not confirmed
                            </Badge>
                          </span>
                          <span className="text-[13px]">
                            {seat.contactPhone
                              ? `${seatFirst} can’t get texts and has no email on file, so HandsFreeOS can’t ask. Call, then mark it.`
                              : `${seatFirst} has no mobile number or email on file, so HandsFreeOS can’t ask. Mark it once they tell you.`}
                          </span>
                          <div className="flex flex-wrap gap-2">
                            {seat.contactPhone ? (
                              <Button
                                variant="secondary"
                                size="sm"
                                className="max-sm:h-11"
                                onClick={callSeat}
                              >
                                <Phone className="h-3.5 w-3.5" strokeWidth={1.5} />
                                Call {seatFirst}
                              </Button>
                            ) : null}
                            <Button
                              variant="secondary"
                              size="sm"
                              className="max-sm:h-11"
                              loading={busy === 'confirm'}
                              onClick={() => void markConfirmed(seat, true)}
                              data-testid="sheet-mark-confirmed"
                            >
                              <Check className="h-3.5 w-3.5" strokeWidth={1.5} />
                              Mark confirmed
                            </Button>
                          </div>
                        </div>
                        <p className="mt-1.5 text-[12.5px] text-text-3">
                          Marking it shows “Confirmed by you” here, and takes it off Home.
                        </p>
                      </>
                    )
                  ) : null}
                </Section>
              ) : null}

              <VisitMoneyBlock
                workspaceId={workspaceId}
                appt={appt}
                hold={hold}
                found={money}
                timeZone={timeZone}
                customerName={seatFirst || 'The customer'}
              />

              {appt.capacity > 1 ? (
                <Section
                  label="Seats"
                  action={
                    <span className="flex items-center gap-2">
                      <span className="text-xs text-text-3">
                        {seatsLeft} left
                        {config?.waitlist.enabled ? ' · waitlist on' : ''}
                      </span>
                      {appt.status === 'scheduled' && seatsLeft > 0 ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7"
                          onClick={() => setAction('add')}
                          data-testid="sheet-add-attendee"
                        >
                          Add
                        </Button>
                      ) : null}
                    </span>
                  }
                >
                  <div className="my-1 flex items-center gap-3">
                    <span
                      className="whitespace-nowrap text-[13px] font-medium"
                      data-testid="sheet-seats"
                    >
                      {appt.seatsTaken} of {appt.capacity} seats
                    </span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-card-3">
                      <i
                        className="block h-full rounded-full bg-accent"
                        style={{
                          width: `${Math.min(100, (appt.seatsTaken / appt.capacity) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                  {booked.map((t) => (
                    <div key={t.id} className="flex items-center gap-2.5 py-[5px]">
                      <Avatar name={t.fullName} seed={t.personId} size="sm" />
                      <Link
                        href={`/app/w/${workspaceId}/customers/people/${t.personId}`}
                        className="flex-1 truncate text-[13px] hover:underline"
                      >
                        {t.fullName}
                      </Link>
                      <span className="text-xs text-text-3">
                        {t.seats} {t.seats === 1 ? 'seat' : 'seats'}
                      </span>
                    </div>
                  ))}
                </Section>
              ) : null}

              {address || appt.location.meetingUrl || appt.location.kind === 'phone' ? (
                <Section label="Where">
                  <div className="flex items-start gap-2.5 pt-1.5">
                    <MapPin
                      className="mt-0.5 h-3.5 w-3.5 flex-none text-text-3"
                      strokeWidth={1.5}
                    />
                    <span className="min-w-0 flex-1 break-words text-[13px]">
                      {address ?? appt.location.meetingUrl ?? 'Phone call'}
                    </span>
                    {address ? (
                      <a
                        href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`}
                        target="_blank"
                        rel="noreferrer"
                        className="whitespace-nowrap text-[13px] font-medium text-accent-text hover:underline"
                      >
                        Directions
                      </a>
                    ) : null}
                  </div>
                </Section>
              ) : null}

              {staffless && !appt.resources.length ? null : (
                <Section
                  label={staffless ? 'Equipment' : 'People and equipment'}
                  action={
                    appt.status === 'scheduled' && !staffless ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7"
                        onClick={() => setAction('reassign')}
                        data-testid="sheet-reassign"
                      >
                        Change
                      </Button>
                    ) : undefined
                  }
                >
                  {appt.staff.map((s) => (
                    <div
                      key={s.userId}
                      className="flex items-center gap-2.5 py-[5px]"
                      data-testid="sheet-person"
                    >
                      <Avatar name={s.fullName} seed={s.userId} size="sm" />
                      <span className="flex-1 text-[13px]">{s.fullName}</span>
                      <span className="text-xs text-text-3">{role(s.role)}</span>
                    </div>
                  ))}
                  {appt.resources.map((r) => (
                    <div
                      key={r.resourceId}
                      className="flex items-center gap-2.5 py-[5px]"
                      data-testid="sheet-resource"
                    >
                      <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-card-2 text-text-2">
                        <Truck className="h-3.5 w-3.5" strokeWidth={1.5} />
                      </span>
                      <span className="flex-1 text-[13px]">{r.name}</span>
                      <span className="text-xs text-text-3">{r.quantity} reserved</span>
                    </div>
                  ))}
                </Section>
              )}

              {reminders.length ? (
                <Section label="Reminders">
                  {reminders.map((g) => (
                    <div key={g.id}>
                      {g.name ? (
                        <div className="pt-1.5 text-xs font-medium text-text-2">{g.name}</div>
                      ) : null}
                      {g.rows.map((r) => {
                        const badge = BADGE[r.state];
                        return (
                          <div
                            key={r.key}
                            className="flex items-start gap-2.5 py-1.5 text-[13px]"
                            data-testid="sheet-reminder"
                            data-state={r.state}
                          >
                            <span className="mt-0.5 text-text-3">
                              {r.text ? (
                                <MessageCircle className="h-3.5 w-3.5" strokeWidth={1.5} />
                              ) : (
                                <Mail className="h-3.5 w-3.5" strokeWidth={1.5} />
                              )}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="font-medium">{r.label}</span>
                              <span className="text-text-3"> · {r.detail}</span>
                            </span>
                            {badge ? <Badge variant={badge.variant}>{badge.label}</Badge> : null}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </Section>
              ) : null}

              {appt.extraServices.length ? (
                <Section label="Also on this visit">
                  {appt.extraServices.map((x, i) => (
                    <div
                      key={`${x.name}-${i}`}
                      className="flex items-baseline gap-2 py-1 text-[13px]"
                      data-testid="sheet-extra-service"
                    >
                      <span className="min-w-0 flex-1 font-medium">{x.name}</span>
                      <span className="text-text-3">
                        {[
                          x.durationMinutes ? formatDuration(x.durationMinutes) : null,
                          x.priceCents !== null ? moneyLabel(x.priceCents) : null,
                          x.source === 'ai_teammate' ? 'added by the AI teammate' : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </div>
                  ))}
                </Section>
              ) : null}

              {appt.job ? (
                <Section label="Job">
                  <JobBlock
                    key={`${appt.job.id}:${appt.job.customerNote ?? ''}`}
                    workspaceId={workspaceId}
                    appointmentId={appt.id}
                    job={appt.job}
                    timeZone={timeZone}
                    onChanged={changed}
                  />
                </Section>
              ) : null}

              {appt.notes ? (
                <Section label="Notes">
                  <div className="whitespace-pre-wrap pt-1 text-[13px]">{appt.notes}</div>
                </Section>
              ) : null}

              {/* Phones: a 2 × 2 grid of touch-sized buttons. Wider: one row, Cancel on the right. */}
              <div className="mt-5 grid grid-cols-2 gap-2 border-t border-border pt-4 sm:flex sm:flex-wrap">
                {appt.status === 'scheduled' ? (
                  <>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-11 sm:h-8"
                      onClick={() => setAction('reschedule')}
                      data-testid="sheet-reschedule"
                    >
                      <CalendarClock className="h-3.5 w-3.5" strokeWidth={1.5} />
                      Reschedule
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-11 sm:h-8"
                      loading={busy === 'completed'}
                      onClick={() => void setStatus('completed')}
                      data-testid="sheet-complete"
                    >
                      <Check className="h-3.5 w-3.5" strokeWidth={1.5} />
                      Complete
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-11 sm:h-8"
                      loading={busy === 'no_show'}
                      onClick={() => void setStatus('no_show')}
                      data-testid="sheet-no-show"
                    >
                      <UserX className="h-3.5 w-3.5" strokeWidth={1.5} />
                      No-show
                    </Button>
                    {invoiceVisitButton()}
                    <span className="hidden sm:block sm:flex-1" />
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-11 text-danger-text hover:text-danger-text sm:h-8 sm:border-transparent sm:bg-transparent sm:shadow-none sm:hover:bg-card-2"
                      onClick={() => setAction('cancel')}
                      data-testid="sheet-cancel"
                    >
                      <X className="h-3.5 w-3.5 sm:hidden" strokeWidth={1.5} />
                      Cancel
                    </Button>
                  </>
                ) : appt.status === 'completed' ? (
                  <>
                    {invoiceVisitButton(true)}
                    <Button
                      variant="secondary"
                      size="sm"
                      className="col-span-2 h-11 sm:h-8"
                      loading={busy === 'no_show'}
                      onClick={() => void setStatus('no_show')}
                      data-testid="sheet-no-show"
                    >
                      <UserX className="h-3.5 w-3.5" strokeWidth={1.5} />
                      Mark as a no-show instead
                    </Button>
                  </>
                ) : appt.status === 'no_show' ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="col-span-2 h-11 sm:h-8"
                    loading={busy === 'completed'}
                    onClick={() => void setStatus('completed')}
                    data-testid="sheet-complete"
                  >
                    <Check className="h-3.5 w-3.5" strokeWidth={1.5} />
                    Mark complete instead
                  </Button>
                ) : (
                  <span className="col-span-2 text-[13px] text-text-2">
                    This appointment was cancelled. It stays in the customer’s history.
                  </span>
                )}
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
      {appt && action === 'reschedule' ? (
        <MoveDialog
          workspaceId={workspaceId}
          appt={appt}
          timeZone={timeZone}
          target={{ kind: 'pick' }}
          people={people}
          onClose={() => setAction(null)}
          onDone={() => {
            setAction(null);
            changed();
          }}
        />
      ) : null}
      {appt && action === 'cancel' ? (
        <CancelDialog
          workspaceId={workspaceId}
          appt={appt}
          timeZone={timeZone}
          onClose={() => setAction(null)}
          onDone={() => {
            setAction(null);
            changed();
          }}
        />
      ) : null}
      {appt && action === 'reassign' ? (
        <ReassignDialog
          workspaceId={workspaceId}
          appt={appt}
          people={people}
          onClose={() => setAction(null)}
          onDone={() => {
            setAction(null);
            changed();
          }}
        />
      ) : null}
      {appt && action === 'add' ? (
        <AddAttendeeDialog
          workspaceId={workspaceId}
          appt={appt}
          config={config}
          onClose={() => setAction(null)}
          onDone={() => {
            setAction(null);
            changed();
          }}
        />
      ) : null}
      {single && message ? (
        <MessageSheet
          workspaceId={workspaceId}
          person={{
            id: single.personId,
            fullName: single.fullName,
            phone: single.contactPhone,
            phoneE164: single.contactPhone,
            email: single.contactEmail,
          }}
          channel={message}
          open
          onOpenChange={(o) => !o && setMessage(null)}
        />
      ) : null}
    </>
  );
}
