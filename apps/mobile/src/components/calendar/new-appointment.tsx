import {
  addDays,
  contactFromSearch,
  fmtDateShort,
  fmtLength,
  holds,
  localDateOf,
  localInstant,
  minutesPastMidnight,
  reminderScheduleWords,
  SEARCH_MIN_CHARS,
  tellNote,
  timeOptionsWith,
  type CalendarConfig,
  type ContactStart,
} from '@hfos/core';
import * as React from 'react';
import { View } from 'react-native';

import { askForTime } from '@/calendar/actions';
import {
  useCalendarMembers,
  useCalendars,
  useCalendarServices,
  useCustomers,
  type CalendarChoice,
  type CustomerChoice,
} from '@/calendar/use-calendar';
import { Chips } from '@/components/calendar/chips';
import { ZoneChips } from '@/components/calendar/zone-chips';
import { AddContactOffer, NewContactForm } from '@/components/customers/new-contact-form';
import { useBusiness } from '@/components/shell/business-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { useNetwork } from '@/lib/network';
import { matchesSearch } from '@/sync/compute';

/**
 * **Ask for a time** (the canvas's "New appointment"): what, which day, what time, who goes, and whether the customer
 * is told.
 *
 * Marco is standing in Mike Johnson's house and needs a part. He asks for Thursday at 1 PM without leaving. The change
 * reaches a customer, so it is fresh-for-30-minutes: with no signal it waits on the phone, goes by itself when signal
 * returns, and asks "Still send?" only if it sat longer than that. The line at the bottom says exactly that, so nobody
 * is surprised — and until HandsFreeOS answers, the day shows the time as "Not booked yet".
 *
 * Someone not yet a customer is added here too: the search offers "Add “Dana Smith” as a new contact" under what it
 * found, and a small form takes their name, number and email in this sheet (an iPhone shows one sheet at a time).
 * Adding works with no signal like everything else here, and the time asked for waits for them to be added first.
 *
 * The time starts on the business's clock. Time zone sets it on another one (a customer's "2 PM Pacific"), and the
 * line under it says where that lands on the calendar (core `zone-pick.ts`, as on the web).
 */
export function NewAppointmentSheet({
  open,
  onClose,
  date,
  timeZone,
  person,
  onAsked,
}: {
  open: boolean;
  onClose: () => void;
  /** The day the calendar is showing, which the sheet opens on. */
  date: string;
  timeZone: string;
  /**
   * The customer it is for, when the screen already knows (a record's Book button). From the Calendar tab nobody is
   * chosen yet, so the sheet asks — Marco is standing in Mike Johnson's house, and the visit has to be Mike's.
   */
  person: CustomerChoice | null;
  onAsked?: () => void;
}) {
  const { business, viewing } = useBusiness();
  const { online } = useNetwork();
  const calendars = useCalendars();
  const members = useCalendarMembers();
  const services = useCalendarServices();
  const customers = useCustomers();
  const [chosen, setChosen] = React.useState<CustomerChoice | null>(null);
  const [typed, setTyped] = React.useState('');
  /** The New contact form, open, with what's in its boxes. */
  const [contact, setContact] = React.useState<ContactStart | null>(null);
  /** The customer added in this sheet, and the change adding them, which asking for the time waits for. */
  const [added, setAdded] = React.useState<{ personId: string; changeId: string } | null>(null);
  const forWhom = person ?? chosen;
  const found = matching(customers, typed);
  const mayAdd = !viewing && holds(business, 'records.write');
  /** "Add “Dana” as a new contact" under what the search found, saying first when it found nobody. */
  const offer = mayAdd && typed.trim().length >= SEARCH_MIN_CHARS;

  const [calendarId, setCalendarId] = React.useState<string | null>(null);
  const [serviceId, setServiceId] = React.useState<string | null>(null);
  const [day, setDay] = React.useState(date);
  // The next half hour, which is what someone asking from a customer's house means; inside the working day, so a
  // booking made late in the evening opens on the morning rather than at 9 PM.
  const [minutes, setMinutes] = React.useState(() => nextHalfHour(timeZone));
  /** The zone the day and time are read in: the business's, or another picked under them. */
  const [zone, setZone] = React.useState(timeZone);
  const [userIds, setUserIds] = React.useState<readonly string[]>([]);
  const [title, setTitle] = React.useState('');
  const [notify, setNotify] = React.useState(true);
  const [busy, setBusy] = React.useState(false);

  const calendar: CalendarChoice | null =
    calendars.find((c) => c.id === calendarId) ?? calendars[0] ?? null;
  const service = services.find((s) => s.serviceId === serviceId) ?? null;
  const onThisCalendar = calendar ? members.filter((m) => m.calendarId === calendar.id) : [];
  const calendarServices = calendar ? services.filter((s) => s.calendarId === calendar.id) : [];
  const length = service?.defaultDuration ?? defaultLength(calendar?.config ?? null);

  React.useEffect(() => {
    if (open) {
      setDay(date);
      setMinutes(nextHalfHour(timeZone));
      setZone(timeZone);
      setTitle('');
      setChosen(null);
      setTyped('');
      setContact(null);
      setAdded(null);
      setBusy(false);
    }
  }, [open, date, timeZone]);

  /** Who the visit is for, from the list or just added: the search and the form are done with. */
  const choose = (customer: CustomerChoice) => {
    setChosen(customer);
    setTyped('');
    setContact(null);
  };

  const ask = async () => {
    if (!calendar) return;
    setBusy(true);
    try {
      await askForTime({
        workspaceId: business.id,
        calendarId: calendar.id,
        startsAt: new Date(localInstant(day, clockOf(minutes), zone)).toISOString(),
        durationMinutes: length,
        serviceId: service?.serviceId ?? null,
        personId: forWhom?.id ?? null,
        userIds: userIds.length ? userIds : null,
        title: title.trim() || service?.name || null,
        notes: null,
        address: forWhom?.address ?? null,
        leadId: null,
        notify,
        timezone: zone,
        dependsOn: added && added.personId === forWhom?.id ? [added.changeId] : [],
      });
      toast.show(
        online ? 'Asked for this time.' : 'Kept on this phone. It goes when you have signal.',
      );
      onAsked?.();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That didn’t work.');
      setBusy(false);
    }
  };

  const tell = calendar?.config
    ? tellNote(
        calendar.config.notifications,
        { name: firstWord(forWhom?.name ?? ''), phone: true, email: true, textingReady: null },
        notify,
      )
    : reminderScheduleWords([]);

  return (
    <Sheet open={open} onClose={onClose} title="New appointment" scroll testID="new-appointment">
      {forWhom ? (
        <Text className="-mt-1 mb-3 text-[13px] text-text-2" testID="new-appointment-for">
          For {forWhom.name}
          {forWhom.address ? `, at ${forWhom.address}` : ''}
        </Text>
      ) : null}

      {person ? null : (
        <Field label="Who it’s for">
          {chosen ? (
            <Button
              variant="secondary"
              size="md"
              className="self-start"
              onPress={() => setChosen(null)}
              testID="new-appointment-change-customer"
            >
              Choose someone else
            </Button>
          ) : contact ? (
            <NewContactForm
              value={contact}
              onChange={setContact}
              onCancel={() => setContact(null)}
              onAdded={(customer, changeId) => {
                choose(customer);
                setAdded({ personId: customer.id, changeId });
              }}
              onChooseExisting={(id, name) =>
                choose(
                  customers.find((c) => c.id === id) ?? { id, name, address: null, searchText: '' },
                )
              }
            />
          ) : (
            <>
              <Input
                value={typed}
                onChangeText={setTyped}
                placeholder="Search by name, number or street"
                accessibilityLabel="Who it’s for"
                autoCorrect={false}
                testID="new-appointment-customer-search"
              />
              <Chips
                options={found.map((c) => ({ value: c.id, label: c.name }))}
                value=""
                onChange={(id) => {
                  const customer = customers.find((c) => c.id === id);
                  if (customer) choose(customer);
                }}
                testID="new-appointment-customer"
              />
              {offer ? (
                <AddContactOffer
                  typed={typed.trim()}
                  nobody={!found.length}
                  onAdd={() => setContact(contactFromSearch(typed))}
                  testID="new-appointment"
                />
              ) : null}
            </>
          )}
        </Field>
      )}

      {calendars.length > 1 ? (
        <Field label="Calendar">
          <Chips
            options={calendars.map((c) => ({ value: c.id, label: c.name }))}
            value={calendar?.id ?? ''}
            onChange={(v) => {
              setCalendarId(v);
              setServiceId(null);
              setUserIds([]);
            }}
            testID="new-appointment-calendar"
          />
        </Field>
      ) : null}

      {calendarServices.length ? (
        <Field label="What">
          <Chips
            options={calendarServices.map((s) => ({ value: s.serviceId, label: s.name }))}
            value={serviceId ?? ''}
            onChange={setServiceId}
            testID="new-appointment-service"
          />
        </Field>
      ) : (
        <Field label="What">
          <Input
            value={title}
            onChangeText={setTitle}
            placeholder="AC repair"
            accessibilityLabel="What"
            testID="new-appointment-title"
          />
        </Field>
      )}

      <Field label="Day">
        <Chips
          options={nextDays(date, timeZone).map((d) => ({ value: d, label: fmtDateShort(d) }))}
          value={day}
          onChange={setDay}
          testID="new-appointment-day"
        />
      </Field>

      <Field label="Time">
        <Chips
          options={timeOptionsWith(minutes)
            .filter(([m]) => m >= 6 * 60 && m <= 20 * 60 && m % 30 === 0)
            .map(([m, label]) => ({ value: String(m), label }))}
          value={String(minutes)}
          onChange={(v) => setMinutes(Number(v))}
          testID="new-appointment-time"
        />
        <Text className="mt-1 text-xs text-text-3">{fmtLength(length)}</Text>
      </Field>

      <Field label="Time zone">
        <ZoneChips
          // A fresh one each time the sheet opens, so a search left open last time is shut.
          key={open ? 'open' : 'shut'}
          value={zone}
          onChange={setZone}
          homeZone={timeZone}
          at={localInstant(day, clockOf(minutes), zone)}
          testID="new-appointment-zone"
        />
      </Field>

      {onThisCalendar.length ? (
        <Field label="With">
          <Chips
            options={onThisCalendar.map((m) => ({ value: m.userId, label: m.fullName }))}
            value={userIds[0] ?? ''}
            onChange={(v) => setUserIds(userIds[0] === v ? [] : [v])}
            testID="new-appointment-with"
          />
        </Field>
      ) : null}

      {forWhom ? (
        <View className="mt-1 flex-row items-start justify-between gap-3 py-1">
          <View className="min-w-0 flex-1">
            <Text className="text-[15px] font-medium">Tell {firstWord(forWhom.name)}</Text>
            <Text className="mt-0.5 text-[12.5px] leading-[1.45] text-text-3">{tell}</Text>
          </View>
          <Switch
            label={`Tell ${firstWord(forWhom.name)}`}
            checked={notify}
            onCheckedChange={setNotify}
            testID="new-appointment-notify"
          />
        </View>
      ) : null}

      <Text className="mt-3 rounded-menu bg-card-2 px-3 py-2.5 text-[12.5px] leading-[1.45] text-text-2">
        {online
          ? 'This asks for the time. It is booked, and the customer is told, as soon as HandsFreeOS answers.'
          : `No signal right now. This asks for the time. It is booked, and ${
              forWhom ? firstWord(forWhom.name) : 'the customer'
            } is told, when your phone reaches HandsFreeOS.`}
      </Text>

      <View className="mt-4 gap-2">
        <Button onPress={ask} loading={busy} disabled={!calendar} testID="ask-for-this-time">
          Ask for this time
        </Button>
        <Button variant="ghost" onPress={onClose}>
          Cancel
        </Button>
      </View>
    </Sheet>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View className="mb-3">
      <Text className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
        {label}
      </Text>
      {children}
    </View>
  );
}

/** Fourteen days from today, starting at the day the calendar is showing. */
function nextDays(from: string, timeZone: string): readonly string[] {
  const today = localDateOf(Date.now(), timeZone);
  const start = from < today ? today : from;
  return Array.from({ length: 14 }, (_, i) => addDays(start, i));
}

/** The next half hour on the business's clock, kept between 7 AM and 5:30 PM. */
function nextHalfHour(timeZone: string): number {
  const now = minutesPastMidnight(Date.now(), timeZone);
  const next = Math.ceil(now / 30) * 30;
  return Math.min(Math.max(next, 7 * 60), 17 * 60 + 30);
}

const clockOf = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

const firstWord = (name: string): string => name.trim().split(/\s+/)[0] || 'the customer';

/** The six customers a search fits best: what was typed, matched the way the database matches it. */
function matching(customers: readonly CustomerChoice[], typed: string): readonly CustomerChoice[] {
  const wanted = typed.trim().toLowerCase();
  if (!wanted) return customers.slice(0, 6);
  return customers.filter((c) => matchesSearch(c.searchText, wanted)).slice(0, 6);
}

/** How long a visit takes when no service says: the calendar's first length, or an hour. */
function defaultLength(config: CalendarConfig | null): number {
  return config?.durations.minutes[0] ?? 60;
}

export { Chips, clockOf, Field, nextDays };
