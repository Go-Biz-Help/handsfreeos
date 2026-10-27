import {
  BIN_WORDS,
  depositInvoiceOf,
  depositWhen,
  depositWords,
  fmtAt,
  fmtDateLong,
  fmtLength,
  fmtWhen,
  heldNote,
  heldSection,
  holdOf,
  holds,
  isNotBookedYet,
  jobInvoiceOf,
  jobInvoiceWords,
  localDayOf,
  money,
  namesText,
  REQUESTED_NOTE,
  reminderLabel,
  reminderScheduleWords,
  seatsLabel,
  sourceLabel,
  statusOf,
  zoneLabel,
  type CalendarConfig,
  SAFETY_PHONE_WORDS,
} from '@hfos/core';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import * as React from 'react';
import { Linking, Platform, View } from 'react-native';

import { cancelVisit, confirmSeat, setSeatAttendance, setVisitStatus } from '@/calendar/actions';
import { addressOf, useAppointment, useNow, useVisitInvoices } from '@/calendar/use-calendar';
import { useCalendarZone } from '@/calendar/use-calendar';
import { DeleteSheet } from '@/components/bin/delete-sheet';
import { Check, CircleDollarSign, MapPin, ShieldCheck, Trash, Undo2 } from '@/components/icons';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { CallRecord, MeetingLink, meetingOf } from '@/components/calendar/meeting';
import { VisitJob } from '@/components/calendar/visit-job';
import { CheckInSheet } from '@/components/safety/check-in-sheet';
import { Screen } from '@/components/shell/screen';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { useGrants } from '@/lib/grants';
import { useNetwork } from '@/lib/network';

/**
 * **One visit** (the canvas's "A visit's sheet"): what it is and when, who it is for, where with Directions, who is
 * going, the money on it and the notes — read from the phone's copy, so it is all there in a truck with no signal.
 *
 * What can be done here works with no signal too: confirming that a customer said they'll be there
 * (`attendee.confirm`), and marking the visit done or a no-show (`appointment.set_status`). Calling it off reaches the
 * customer, so it waits for signal and goes by itself within half an hour. An owner deletes it for good, with signal
 * (the Deleted bin, 20261027000400); one still to come is cancelled first, telling its customer or not.
 *
 * Moving a visit and editing its details are the web's: this screen links out to them.
 */
export default function Appointment() {
  const { appointmentId } = useLocalSearchParams<{ appointmentId: string }>();
  const { business } = useBusiness();
  const timeZone = useCalendarZone();
  const now = useNow();
  const { appointment: a, loading } = useAppointment(appointmentId);
  const invoices = useVisitInvoices(appointmentId);
  const [cancelling, setCancelling] = React.useState(false);
  const [checkingIn, setCheckingIn] = React.useState(false);
  const [working, setWorking] = React.useState(false);
  const canDelete = holds(useGrants(), 'records.delete');
  const { online } = useNetwork();
  const [deleting, setDeleting] = React.useState(false);

  if (!a)
    return (
      <Screen title="Appointment" leading="back" testID="appointment">
        <Card className="p-6">
          <Text className="text-center text-text-2">
            {loading ? 'Loading…' : 'This appointment isn’t on this phone.'}
          </Text>
        </Card>
      </Screen>
    );

  const status = statusOf(a, now);
  const hold = holdOf(a, now);
  const unbooked = isNotBookedYet(a, now);
  const booked = a.seats.filter((s) => s.status !== 'cancelled');
  const seat = booked.length === 1 ? booked[0]! : null;
  const where = addressOf(null);
  const address = a.address;
  const meeting = meetingOf(a.location ?? null);
  const deposit = depositInvoiceOf(invoices);
  const job = jobInvoiceOf(invoices);
  const source = sourceLabel(a.source);

  const confirm = async (attendeeId: string, on: boolean) => {
    setWorking(true);
    try {
      await confirmSeat({ workspaceId: business.id, attendeeId, confirmed: on });
      toast.show(on ? 'Marked confirmed.' : 'Confirmation taken back.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That didn’t work.');
    }
    setWorking(false);
  };

  // Funnels: once a session has started, each person on it is marked on their own.
  const sessionStarted =
    a.capacity > 1 && a.status !== 'cancelled' && Date.parse(a.startsAt) <= now;
  const attendance = async (attendeeId: string, next: 'attended' | 'no_show') => {
    setWorking(true);
    try {
      await setSeatAttendance({ workspaceId: business.id, attendeeId, attendance: next });
      toast.show(next === 'attended' ? 'Marked attended.' : 'Marked as a no-show.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That didn’t work.');
    }
    setWorking(false);
  };

  const mark = async (next: 'completed' | 'no_show') => {
    setWorking(true);
    try {
      await setVisitStatus({ workspaceId: business.id, appointmentId, status: next });
      toast.show(next === 'completed' ? 'Marked complete.' : 'Marked as a no-show.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That didn’t work.');
    }
    setWorking(false);
  };

  return (
    <Screen
      title={a.title}
      subtitle={fmtWhen(a.startsAt, a.endsAt, timeZone)}
      leading="back"
      testID="appointment"
    >
      <View className="flex-row flex-wrap items-center gap-2">
        <Badge variant={status.tone} testID="appointment-status">
          <Text>{status.label}</Text>
        </Badge>
        {source ? (
          <Badge variant="gray">
            <Text>{source}</Text>
          </Badge>
        ) : null}
        {a.capacity > 1 ? (
          <Badge variant="gray">
            <Text>{seatsLabel(a.seatsTaken, a.capacity)}</Text>
          </Badge>
        ) : null}
      </View>

      {unbooked ? (
        <View className="rounded-card bg-warning-soft px-3.5 py-3" testID="appointment-not-booked">
          <Text className="text-[13px] font-semibold text-warning-text">
            {hold ? 'Waiting on a deposit' : 'Not booked yet'}
          </Text>
          <Text className="mt-1 text-[12.5px] leading-[1.45] text-warning-text">
            {hold && seat ? heldNote(seat.full_name, deposit?.total_cents ?? 0) : REQUESTED_NOTE}
          </Text>
        </View>
      ) : null}

      <Section label="When">
        <Text className="text-[15px] font-medium">
          {fmtDateLong(localDayOf(a.startsAt, timeZone))}
        </Text>
        <Text className="mt-0.5 text-[13px] text-text-2">
          {[zoneLabel(timeZone), bufferNote(a.bufferBefore, a.bufferAfter, a.config)]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </Section>

      {booked.length ? (
        <Section label={booked.length === 1 ? 'Customer' : `Customers · ${booked.length}`}>
          {booked.map((s) => (
            <View key={s.id} className="flex-row items-center gap-3 py-1.5">
              <Avatar name={s.full_name} seed={s.person_id ?? s.id} size="md" />
              <View className="min-w-0 flex-1">
                <Text className="text-[15px] font-medium" numberOfLines={1}>
                  {s.full_name}
                </Text>
                <Text className="text-[12.5px] text-text-3" numberOfLines={1}>
                  {[
                    s.status === 'attended'
                      ? 'Attended'
                      : s.status === 'no_show'
                        ? 'No-show'
                        : null,
                    s.contact_phone_e164 ?? s.phone_e164,
                    (s.sms_ok ?? s.sms_consent) ? 'Texts OK' : 'No text consent',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              </View>
              {sessionStarted ? (
                <View className="flex-row gap-1">
                  {s.status !== 'attended' ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={working}
                      onPress={() => void attendance(s.id, 'attended')}
                      testID={`mark-attended-${s.id}`}
                    >
                      Attended
                    </Button>
                  ) : null}
                  {s.status !== 'no_show' ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={working}
                      onPress={() => void attendance(s.id, 'no_show')}
                      testID={`mark-no-show-${s.id}`}
                    >
                      No-show
                    </Button>
                  ) : null}
                </View>
              ) : a.status === 'scheduled' && !unbooked ? (
                s.confirmed_at ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={Undo2}
                    loading={working}
                    onPress={() => void confirm(s.id, false)}
                    testID={`take-back-${s.id}`}
                  >
                    Take back
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={Check}
                    loading={working}
                    onPress={() => void confirm(s.id, true)}
                    testID={`mark-confirmed-${s.id}`}
                  >
                    Mark confirmed
                  </Button>
                )
              ) : null}
            </View>
          ))}
          {booked.some((s) => s.confirmed_at) ? (
            <Text className="mt-1 text-[12.5px] text-success-text" testID="appointment-confirmed">
              {confirmedLine(booked, timeZone)}
            </Text>
          ) : null}
        </Section>
      ) : null}

      {meeting ? (
        <Section label="Video call">
          <MeetingLink meeting={meeting} />
        </Section>
      ) : null}
      {meeting?.record || meeting?.video === 'handsfree' ? (
        <Section label="The call">
          <CallRecord
            workspaceId={business.id}
            appointmentId={appointmentId}
            online={online}
            ours={meeting.video === 'handsfree'}
          />
        </Section>
      ) : null}

      {meeting ? null : address ? (
        <Section label="Where">
          <Text className="text-[15px]">{address}</Text>
          <Button
            variant="secondary"
            size="sm"
            icon={MapPin}
            className="mt-2 self-start"
            onPress={() => void openMaps(address)}
            testID="appointment-directions"
          >
            Directions
          </Button>
        </Section>
      ) : where.kind === 'phone' ? (
        <Section label="Where">
          <Text className="text-[15px]">Phone call</Text>
        </Section>
      ) : null}

      {a.staff.length ? (
        <Section label="With">
          <Text className="text-[15px]">{namesText(a.staff.map((s) => s.fullName))}</Text>
        </Section>
      ) : null}

      {deposit ? (
        <Section label={hold ? heldSection : 'Deposit'}>
          <DepositBlock
            deposit={deposit}
            priceCents={a.priceCents}
            timeZone={timeZone}
            onOpen={() =>
              router.push(businessHref(business.id, `money/invoices/${deposit.id}`) as Href)
            }
          />
        </Section>
      ) : null}

      {job ? (
        <Section label="This visit’s invoice">
          <JobBlock
            job={job}
            onOpen={() =>
              router.push(businessHref(business.id, `money/invoices/${job.id}`) as Href)
            }
          />
        </Section>
      ) : null}

      {a.config && a.config.notifications.reminders.length ? (
        <Section label="Reminders">
          <Text className="text-[13px] text-text-2">
            {a.config.notifications.reminders
              .map((r) =>
                reminderLabel(r.kind === 'day_before' ? 'day_before' : `before_${r.minutes}`),
              )
              .join(' · ')}
          </Text>
          <Text className="mt-0.5 text-[12.5px] text-text-3">
            Sent {reminderScheduleWords(a.config.notifications.reminders)}.
          </Text>
        </Section>
      ) : null}

      {a.notes ? (
        <Section label="Notes">
          <Text className="text-[13.5px] leading-[1.45]">{a.notes}</Text>
        </Section>
      ) : null}

      {a.status === 'scheduled' && a.kind === 'booking' ? (
        <VisitJob appointmentId={appointmentId} timeZone={timeZone} />
      ) : null}

      {a.status === 'scheduled' ? (
        <View className="gap-2 pt-1">
          {/* Showing safety (round six): check in for the visit, with a planned end and who's told. */}
          <Button
            variant="secondary"
            icon={ShieldCheck}
            onPress={() => setCheckingIn(true)}
            testID="appointment-check-in"
          >
            {SAFETY_PHONE_WORDS.checkIn}
          </Button>
          <Button
            variant="secondary"
            loading={working}
            onPress={() => void mark('completed')}
            testID="appointment-complete"
          >
            Complete
          </Button>
          <Button
            variant="secondary"
            loading={working}
            onPress={() => void mark('no_show')}
            testID="appointment-no-show"
          >
            No-show
          </Button>
          <Button
            variant="ghostDanger"
            onPress={() => setCancelling(true)}
            testID="appointment-cancel"
          >
            Cancel
          </Button>
        </View>
      ) : a.status === 'cancelled' ? (
        <Text className="pt-1 text-[13px] text-text-3">
          This appointment was cancelled. It stays in the customer’s history.
        </Text>
      ) : null}

      {canDelete ? (
        <Button
          variant="ghostDanger"
          icon={Trash}
          onPress={() => (online ? setDeleting(true) : toast.error(BIN_WORDS.offline))}
          testID="appointment-delete"
        >
          {BIN_WORDS.menu}
        </Button>
      ) : null}

      <CheckInSheet
        open={checkingIn}
        onClose={() => setCheckingIn(false)}
        workspaceId={business.id}
        appointmentId={appointmentId}
        place={address ?? a.title}
        about={address ? `${a.title} · ${address}` : a.title}
        startsAt={a.startsAt}
        endsAt={a.endsAt}
      />
      <CancelSheet
        open={cancelling}
        onClose={() => setCancelling(false)}
        who={seat?.full_name ?? null}
        when={fmtAt(a.startsAt, timeZone)}
        onCancel={async (notify) => {
          await cancelVisit({
            workspaceId: business.id,
            appointmentId,
            reason: '',
            notify,
          });
          toast.show(
            notify ? 'Cancelled. The customer is being told.' : 'Cancelled. Nobody was told.',
          );
          setCancelling(false);
        }}
      />
      <DeleteSheet
        open={deleting}
        onClose={() => setDeleting(false)}
        workspaceId={business.id}
        kind="appointment"
        ids={[appointmentId]}
        names={[a.title]}
        tellFirst={
          booked.length === 0 ? undefined : seat ? (seat.full_name.split(' ')[0] ?? null) : null
        }
        onDeleted={() => {
          if (router.canGoBack()) router.back();
          else router.replace(businessHref(business.id, 'calendar') as Href);
        }}
      />
    </Screen>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Card className="px-3.5 py-3">
      <Text className="mb-1 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
        {label}
      </Text>
      {children}
    </Card>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-center justify-between gap-4 py-1">
      <Text className="text-[13px] text-text-2">{label}</Text>
      <Text className="text-[13px] font-medium">{value}</Text>
    </View>
  );
}

function DepositBlock({
  deposit,
  priceCents,
  timeZone,
  onOpen,
}: {
  deposit: {
    total_cents: number | null;
    amount_paid_cents: number | null;
    paid_at: string | null;
    number: string | null;
    status: string;
  };
  priceCents: number | null;
  timeZone: string;
  onOpen: () => void;
}) {
  const facts = {
    askedCents: deposit.total_cents ?? 0,
    paidCents: deposit.amount_paid_cents ?? 0,
    state: deposit.status === 'paid' ? 'paid' : deposit.status,
    paidAt: deposit.paid_at,
    priceCents,
  };
  const words = depositWords(facts);
  return (
    <View>
      <View className="mb-1 flex-row items-center gap-2">
        <Badge variant="ok">
          <Text>{words.badge}</Text>
        </Badge>
        <Text className="min-w-0 flex-1 text-[12.5px] text-text-3" numberOfLines={1}>
          {depositWhen(
            facts,
            deposit.paid_at
              ? `Paid ${fmtDateLong(localDayOf(deposit.paid_at, timeZone))} · ${fmtAt(deposit.paid_at, timeZone)}`
              : null,
          )}
        </Text>
      </View>
      <Line label={words.amountLabel} value={words.amount} />
      {words.afterLabel ? <Line label={words.afterLabel} value={words.after!} /> : null}
      <Button
        variant="ghost"
        size="sm"
        icon={CircleDollarSign}
        className="mt-1 self-start"
        onPress={onOpen}
        testID="appointment-deposit-invoice"
      >
        {`${words.invoiceLabel}${deposit.number ? ` · ${deposit.number}` : ''}`}
      </Button>
    </View>
  );
}

function JobBlock({
  job,
  onOpen,
}: {
  job: {
    total_cents: number | null;
    amount_paid_cents: number | null;
    number: string | null;
  };
  onOpen: () => void;
}) {
  const total = job.total_cents ?? 0;
  const paid = job.amount_paid_cents ?? 0;
  const words = jobInvoiceWords(Math.max(0, total - paid));
  return (
    <View>
      <Line label={words.invoicedLabel} value={money(total)} />
      {paid > 0 ? <Line label={words.paidLabel} value={money(paid)} /> : null}
      <Line label={words.balanceLabel} value={money(Math.max(0, total - paid))} />
      <Button
        variant="ghost"
        size="sm"
        icon={CircleDollarSign}
        className="mt-1 self-start"
        onPress={onOpen}
        testID="appointment-job-invoice"
      >
        {words.openLabel}
      </Button>
    </View>
  );
}

function CancelSheet({
  open,
  onClose,
  who,
  when,
  onCancel,
}: {
  open: boolean;
  onClose: () => void;
  who: string | null;
  when: string;
  onCancel: (notify: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = React.useState(false);
  const run = (notify: boolean) => {
    setBusy(true);
    void onCancel(notify).finally(() => setBusy(false));
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Cancel this appointment?"
      description={when}
      testID="cancel-appointment"
    >
      <Text className="mb-3 text-[13px] leading-[1.45] text-text-2">
        {who
          ? `${who} hears that it is cancelled, with the business’s number to pick a new time.`
          : 'Nobody is told. Tell them yourself.'}
      </Text>
      <View className="gap-2">
        <Button variant="danger" loading={busy} onPress={() => run(true)} testID="cancel-and-tell">
          {who ? `Cancel and tell ${who.split(' ')[0]}` : 'Cancel appointment'}
        </Button>
        {who ? (
          <Button
            variant="secondary"
            loading={busy}
            onPress={() => run(false)}
            testID="cancel-quietly"
          >
            Cancel without telling them
          </Button>
        ) : null}
        <Button variant="ghost" onPress={onClose}>
          Keep it
        </Button>
      </View>
    </Sheet>
  );
}

/** "Central Time · 30 min travel before and after", the web's `whenNote`. */
function bufferNote(before: number, after: number, config: CalendarConfig | null): string {
  const travel = config?.buffers.travelMinutes ? 'travel ' : '';
  if (before && before === after) return `${fmtLength(before)} ${travel}before and after`;
  if (before || after) return `${fmtLength(before)} before, ${fmtLength(after)} after`;
  return '';
}

/** "Confirmed by Priya Thu 4:12 PM" for whoever has confirmed. */
function confirmedLine(
  seats: readonly {
    full_name: string;
    confirmed_at: string | null;
    confirmed_via: string | null;
    confirmed_by_name: string | null;
  }[],
  timeZone: string,
): string {
  const done = seats.filter((s) => s.confirmed_at);
  const one = done[0]!;
  const how =
    one.confirmed_via === 'sms'
      ? 'by text'
      : one.confirmed_via === 'link'
        ? 'online'
        : one.confirmed_via === 'ai'
          ? 'by the AI teammate'
          : `by ${one.confirmed_by_name?.split(' ')[0] ?? 'the team'}`;
  return `Confirmed ${how} ${fmtAt(one.confirmed_at!, timeZone)}`;
}

/** The phone's own maps app, as the canvas's Directions does. */
async function openMaps(address: string): Promise<void> {
  const q = encodeURIComponent(address);
  const url = Platform.OS === 'ios' ? `maps://?q=${q}` : `geo:0,0?q=${q}`;
  const fallback = `https://maps.google.com/?q=${q}`;
  try {
    if (await Linking.canOpenURL(url)) await Linking.openURL(url);
    else await Linking.openURL(fallback);
  } catch {
    await Linking.openURL(fallback).catch(() => undefined);
  }
}
