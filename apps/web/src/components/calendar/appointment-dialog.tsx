'use client';
import {
  localInstant,
  minutesToClock,
  parseClock,
  resolveTerms,
  type CalendarConfig,
  type LocationKind,
} from '@hfos/core';
import { AlertTriangle, CircleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { ApiError, apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type {
  AppointmentLocationIn,
  AppointmentWarning,
  CalendarSummary,
  ResourceItem,
  ServiceItem,
} from '@/lib/api/types';
import { serviceCatalog } from '@/lib/calendar/catalogs';
import { joinWords } from '@/lib/calendar/describe';
import {
  dateOf,
  fmtAt,
  fmtLength,
  fmtTime,
  minutesOf,
  timeOptionsWith,
  todayIn,
  weekdayShort,
  zoneLabel,
} from '@/lib/calendar/time';
import { addressLine } from '@/lib/format';
import { firstName, freshTimes, namesText, reservedText } from './appt';
import { calendarConfig } from './config-cache';
import { CustomerPicker, type PickedCustomer } from './customer-picker';
import { TellField, useTextingReady } from './tell-field';

const LOCATION_LABEL: Record<LocationKind, string> = {
  customer_address: 'Customer’s address',
  business: 'Business',
  virtual: 'Video call',
  phone: 'Phone call',
};

/** The open times offered after a 409 resource_full; picking one fills in the date and start. */
export function FreshTimes({
  times,
  date,
  timeZone,
  onPick,
  testId,
}: {
  times: readonly string[];
  /** The date being asked about: times on it show just the clock. */
  date: string;
  timeZone: string;
  onPick: (startsAt: string) => void;
  testId: string;
}) {
  return (
    <div role="group" aria-label="Open times nearby" className="flex flex-col gap-1.5">
      <span className="text-[12.5px] text-text-3">Open times nearby</span>
      <div className="grid grid-cols-3 gap-1.5">
        {times.map((t) => (
          <button
            key={t}
            type="button"
            data-testid={testId}
            onClick={() => onPick(t)}
            className="inline-flex h-[34px] items-center justify-center whitespace-nowrap rounded-control border border-border-strong bg-card px-1.5 text-[13px] font-medium hover:border-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
          >
            {dateOf(t, timeZone) === date
              ? fmtTime(t, timeZone)
              : `${weekdayShort(dateOf(t, timeZone))} ${fmtTime(t, timeZone)}`}
          </button>
        ))}
      </div>
    </div>
  );
}

export interface BookedResult {
  readonly appointmentId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly userIds: readonly string[];
}

export interface AppointmentPrefill {
  readonly date?: string | null;
  /** 'HH:MM' in the workspace's zone. */
  readonly time?: string | null;
  readonly userId?: string | null;
  readonly calendarId?: string | null;
  readonly serviceId?: string | null;
  readonly person?: PickedCustomer | null;
  readonly personId?: string | null;
  readonly leadId?: string | null;
  /** The pet, vehicle or property the visit is for (0101), booked from its own page. */
  readonly customRecordId?: string | null;
}

/**
 * New appointment: customer, calendar, service, who, date, start, length and place. Warnings (outside hours,
 * busy, time off, buffers, a past time) come back from the server and can be booked over with "Book
 * anyway"; another appointment at the same time never can. Times are the workspace's zone, labelled. Tell
 * (ticked by default) sends the customer a confirmation; the reminders follow the calendar's settings either
 * way.
 */
export function AppointmentDialog({
  workspaceId,
  timeZone,
  open,
  onOpenChange,
  people,
  myUserId,
  prefill,
  lockCustomer,
  calendars: given,
  onBooked,
}: {
  workspaceId: string;
  timeZone: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  people: readonly { userId: string; fullName: string }[];
  myUserId: string;
  prefill: AppointmentPrefill;
  lockCustomer?: boolean;
  calendars?: readonly CalendarSummary[];
  onBooked: (result: BookedResult) => void;
}) {
  const [calendars, setCalendars] = useState<readonly CalendarSummary[] | null>(given ?? null);
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [resources, setResources] = useState<ResourceItem[]>([]);
  const [person, setPerson] = useState<PickedCustomer | null>(prefill.person ?? null);
  const [address, setAddress] = useState('');
  const [postalCode, setPostalCode] = useState<string | null>(null);
  const [contact, setContact] = useState<{ id: string; phone: boolean; email: boolean } | null>(
    null,
  );
  const [calendarId, setCalendarId] = useState(prefill.calendarId ?? '');
  const [config, setConfig] = useState<{ id: string; config: CalendarConfig } | null>(null);
  const [serviceId, setServiceId] = useState(prefill.serviceId ?? '');
  const [userId, setUserId] = useState(prefill.userId ?? '');
  const [date, setDate] = useState(prefill.date ?? todayIn(timeZone));
  const [time, setTime] = useState(prefill.time ? parseClock(prefill.time) : 9 * 60);
  const [duration, setDuration] = useState(60);
  const [locationIdx, setLocationIdx] = useState(0);
  const [tell, setTell] = useState(true);
  const [warnings, setWarnings] = useState<AppointmentWarning[] | null>(null);
  /** A 409 resource_full: its message and the nearest open times. Never booked over. */
  const [full, setFull] = useState<{ message: string; times: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const clientId = useRef(crypto.randomUUID());
  const textingReady = useTextingReady(workspaceId, open);

  // Calendars and services, once per opening (keyed by the calendars' ids: the page hands in a new array
  // on every render, and that alone shouldn't fetch again).
  const givenKey = given ? given.map((c) => c.id).join() : null;
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const [cals, svcs, res] = await Promise.all([
          given
            ? Promise.resolve({ items: given })
            : apiBrowser()
                .POST('/v1/queries/calendar.list', { body: { workspaceId } })
                .then(unwrap),
          apiBrowser().POST('/v1/queries/service.list', { body: { workspaceId } }).then(unwrap),
          apiBrowser().POST('/v1/queries/resource.list', { body: { workspaceId } }).then(unwrap),
        ]);
        if (cancelled) return;
        setCalendars(cals.items);
        setServices(svcs.items);
        setResources(res.items);
        setCalendarId((current) => {
          if (current && cals.items.some((c) => c.id === current)) return current;
          const who = prefill.userId ?? myUserId;
          return cals.items.find((c) => c.memberIds.includes(who))?.id ?? cals.items[0]?.id ?? '';
        });
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // `given` is read through its ids (givenKey).
  }, [open, workspaceId, givenKey, prefill.userId, myUserId]);

  // The customer's address, for visits at their place, and how they can be reached, for the line under Tell.
  const personId = person?.id ?? prefill.personId ?? null;
  useEffect(() => {
    if (!open || !personId) return;
    let cancelled = false;
    void apiBrowser()
      .POST('/v1/queries/person.get', { body: { workspaceId, personId } })
      .then(unwrap)
      .then((out) => {
        if (cancelled) return;
        if (!person) setPerson({ id: out.person.id, fullName: out.person.fullName });
        setAddress(addressLine(out.person.address));
        setPostalCode(out.person.address.postalCode);
        setContact({
          id: out.person.id,
          phone: !!out.person.phoneE164,
          email: !!out.person.email,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, personId, workspaceId]);

  // The chosen calendar's settings: its people, lengths, services and places.
  useEffect(() => {
    if (!open || !calendarId) return;
    let cancelled = false;
    calendarConfig(workspaceId, calendarId)
      .then((c) => {
        if (!cancelled) setConfig({ id: calendarId, config: c });
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, calendarId, workspaceId]);

  const current = config && config.id === calendarId ? config.config : null;
  const offered = useMemo(
    () =>
      current && current.services.mode !== 'none'
        ? current.services.items
            .map((i) => services.find((s) => s.id === i.serviceId))
            .filter((s): s is ServiceItem => !!s && !s.archivedAt)
        : [],
    [current, services],
  );
  const service = offered.find((s) => s.id === serviceId) ?? offered[0] ?? null;
  const terms = current ? resolveTerms(current, service ? serviceCatalog(service) : null) : null;
  const lengths = terms?.durations ?? [60];
  const team = current?.team.members.map((m) => m.userId) ?? [];
  const nameOf = (id: string) => people.find((p) => p.userId === id)?.fullName ?? 'Someone';
  const places = current?.locations.options ?? [];
  const place = places[locationIdx] ?? places[0] ?? null;
  const travel = current?.buffers.travelMinutes ?? 0;
  const mode = current?.team.assignment;
  /** Needs no staff: there's nobody to pick, and the equipment it reserves shows instead. */
  const staffless = mode === 'none';
  const many = mode === 'collective' || (current?.team.crewSize ?? 1) > 1;
  const uses = staffless
    ? (terms?.requiredResources ?? []).map((r) =>
        reservedText(r.quantity, resources.find((x) => x.id === r.resourceId)?.name ?? 'resource'),
      )
    : [];
  const reach = contact && person && contact.id === person.id ? contact : null;

  // Keep choices valid as the calendar or service changes.
  const length = lengths.includes(duration) ? duration : (lengths[0] ?? 60);
  const who = userId && team.includes(userId) ? userId : '';
  const autoLabel =
    mode === 'round_robin' || mode === 'weighted'
      ? 'Whoever’s next in turn'
      : mode === 'first_available'
        ? 'The first free person'
        : many
          ? 'Everyone it needs'
          : 'Let the calendar choose';
  const withChoice = who || (mode === 'fixed' && team.length ? team[0]! : '');
  // A fresh time offered after a full resource can fall between the quarter hours.
  const timeOptions = timeOptionsWith(time);

  const change =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setWarnings(null);
      setError(null);
      setFull(null);
    };

  async function book() {
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      const location: AppointmentLocationIn | undefined = place
        ? {
            kind: place.kind,
            address:
              place.kind === 'customer_address'
                ? address.trim() || null
                : place.kind === 'business'
                  ? place.address
                  : null,
            meetingUrl: place.kind === 'virtual' ? place.meetingUrl : null,
            postalCode: place.kind === 'customer_address' ? postalCode : null,
          }
        : undefined;
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/appointment.create', {
          body: {
            workspaceId,
            calendarId,
            startsAt: new Date(localInstant(date, minutesToClock(time), timeZone)).toISOString(),
            durationMinutes: length,
            serviceId: service?.id ?? null,
            ...(withChoice && !many && !staffless ? { userIds: [withChoice] } : {}),
            personId: person?.id ?? null,
            partySize: 1,
            ...(location ? { location } : {}),
            leadId: prefill.leadId ?? null,
            customRecordId: prefill.customRecordId ?? null,
            acknowledgeWarnings: !!warnings,
            clientId: clientId.current,
            notify: tell,
          },
        }),
      );
      const title = service?.name ?? calendars?.find((c) => c.id === calendarId)?.name ?? 'It';
      const names = namesText(out.userIds.map((u) => firstName(nameOf(u))));
      toast.success(
        `Booked ${title}${names ? ` with ${names}` : ''} for ${fmtAt(out.startsAt, timeZone)}.`,
      );
      clientId.current = crypto.randomUUID();
      setWarnings(null);
      onBooked(out);
    } catch (e) {
      if (e instanceof ApiError && e.rule === 'needs_confirmation') {
        setWarnings((e.details as { warnings?: AppointmentWarning[] }).warnings ?? []);
      } else if (e instanceof ApiError && e.rule === 'resource_full') {
        // Every one of the equipment is in use then: a hard stop with fresh times, never "Book anyway".
        setWarnings(null);
        setFull({ message: e.message, times: freshTimes(e.details) });
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const list = calendars ?? [];
  const noCalendars = calendars !== null && list.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="New appointment"
        className="max-h-[92vh] w-[min(540px,calc(100vw-24px))] overflow-y-auto"
      >
        {noCalendars ? (
          <p className="mt-3 text-[13px] text-text-2">
            There are no calendars yet. An owner or admin sets them up in Settings, then Calendars.
          </p>
        ) : (
          <div className="mt-3.5 flex flex-col gap-2.5" data-testid="appointment-dialog">
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
              <div className="min-w-0">
                <Label htmlFor="appt-customer">Customer</Label>
                <CustomerPicker
                  id="appt-customer"
                  workspaceId={workspaceId}
                  value={person}
                  locked={lockCustomer}
                  onChange={change((p: PickedCustomer | null) => {
                    setPerson(p);
                    setAddress('');
                    setPostalCode(null);
                  })}
                />
              </div>
              <Field label="Calendar" htmlFor="appt-calendar" className="min-w-0">
                <Select
                  id="appt-calendar"
                  value={calendarId}
                  onChange={(e) => change(setCalendarId)(e.target.value)}
                >
                  {list.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div
              className={`grid grid-cols-1 gap-2.5 sm:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]${offered.length || !staffless || uses.length ? '' : ' hidden'}`}
            >
              {offered.length ? (
                <Field label="Service" htmlFor="appt-service" className="min-w-0">
                  <Select
                    id="appt-service"
                    value={service?.id ?? ''}
                    onChange={(e) => change(setServiceId)(e.target.value)}
                  >
                    {offered.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
              {staffless ? (
                uses.length ? (
                  <div
                    className={offered.length ? 'min-w-0' : 'min-w-0 sm:col-span-2'}
                    data-testid="appointment-uses"
                  >
                    <Label>Uses</Label>
                    <span className="flex h-10 min-w-0 items-center truncate rounded-control border border-border bg-card-2 px-3 text-[14px] text-text-2">
                      {joinWords(uses)}
                    </span>
                  </div>
                ) : null
              ) : (
                <Field
                  label="With"
                  htmlFor="appt-with"
                  className={offered.length ? 'min-w-0' : 'min-w-0 sm:col-span-2'}
                >
                  <Select
                    id="appt-with"
                    value={withChoice}
                    disabled={!team.length}
                    onChange={(e) => change(setUserId)(e.target.value)}
                  >
                    {mode !== 'fixed' || !team.length ? (
                      <option value="">{autoLabel}</option>
                    ) : null}
                    {many
                      ? null
                      : team.map((u) => (
                          <option key={u} value={u}>
                            {nameOf(u)}
                          </option>
                        ))}
                  </Select>
                </Field>
              )}
            </div>
            <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2.5">
              <Field label="Date" htmlFor="appt-date" className="min-w-0">
                <Input
                  id="appt-date"
                  type="date"
                  value={date}
                  onChange={(e) => e.target.value && change(setDate)(e.target.value)}
                />
              </Field>
              <Field label="Start" htmlFor="appt-start" className="min-w-0">
                <Select
                  id="appt-start"
                  value={String(time)}
                  onChange={(e) => change(setTime)(Number(e.target.value))}
                >
                  {timeOptions.map(([m, label]) => (
                    <option key={m} value={m}>
                      {label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Length" htmlFor="appt-length" className="min-w-0">
                <Select
                  id="appt-length"
                  value={String(length)}
                  onChange={(e) => change(setDuration)(Number(e.target.value))}
                >
                  {lengths.map((m) => (
                    <option key={m} value={m}>
                      {fmtLength(m)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {places.length ? (
              <div className="min-w-0">
                <Label htmlFor="appt-place">Location</Label>
                <div className="flex gap-2">
                  {places.length > 1 ? (
                    <Select
                      id="appt-place"
                      className="w-[170px] flex-none"
                      value={String(locationIdx)}
                      onChange={(e) => change(setLocationIdx)(Number(e.target.value))}
                    >
                      {places.map((p, i) => (
                        <option key={i} value={i}>
                          {LOCATION_LABEL[p.kind]}
                        </option>
                      ))}
                    </Select>
                  ) : null}
                  {place?.kind === 'customer_address' ? (
                    <Input
                      id={places.length > 1 ? undefined : 'appt-place'}
                      value={address}
                      placeholder="Street, city, ZIP"
                      aria-label="Customer’s address"
                      onChange={(e) => change(setAddress)(e.target.value)}
                    />
                  ) : (
                    <span className="flex h-10 min-w-0 flex-1 items-center truncate rounded-control border border-border bg-card-2 px-3 text-[14px] text-text-2">
                      {place?.kind === 'business'
                        ? place.address || 'The business'
                        : place?.kind === 'virtual'
                          ? place.meetingUrl || 'Video call'
                          : 'Phone call'}
                    </span>
                  )}
                </div>
              </div>
            ) : null}
            <p className="text-[12.5px] text-text-3">
              {travel && place?.kind === 'customer_address'
                ? `${fmtLength(travel)} travel is kept before and after. `
                : ''}
              Times are {zoneLabel(timeZone)}.
            </p>
            {warnings?.length ? (
              <div className="flex flex-col gap-2" data-testid="appointment-warnings">
                {warnings.map((w, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2.5 rounded-menu bg-warning-soft px-3 py-2.5 text-[13px] leading-[1.45] text-warning-text"
                  >
                    <AlertTriangle className="mt-px h-4 w-4 flex-none" strokeWidth={1.75} />
                    <span>{w.message}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {full ? (
              <div className="flex flex-col gap-2" data-testid="appointment-full">
                <div
                  role="alert"
                  className="flex items-start gap-2.5 rounded-menu bg-danger-soft px-3 py-2.5 text-[13px] leading-[1.45] text-danger-text"
                >
                  <CircleAlert className="mt-px h-4 w-4 flex-none" strokeWidth={1.75} />
                  <span>{full.message}</span>
                </div>
                {full.times.length ? (
                  <FreshTimes
                    times={full.times}
                    date={date}
                    timeZone={timeZone}
                    testId="appointment-fresh-time"
                    onPick={(t) => {
                      change(setDate)(dateOf(t, timeZone));
                      setTime(minutesOf(t, timeZone));
                    }}
                  />
                ) : null}
              </div>
            ) : null}
            {error ? (
              <div
                role="alert"
                className="flex items-start gap-2.5 rounded-menu bg-danger-soft px-3 py-2.5 text-[13px] text-danger-text"
              >
                <CircleAlert className="mt-px h-4 w-4 flex-none" strokeWidth={1.75} />
                <span>{error}</span>
              </div>
            ) : null}
            {person ? (
              <TellField
                name={firstName(person.fullName)}
                notifications={current?.notifications ?? null}
                reach={reach ? { phone: reach.phone, email: reach.email, textingReady } : null}
                checked={tell}
                onChange={setTell}
                testId="appointment-tell"
              />
            ) : null}
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!current || noCalendars}
            onClick={() => void book()}
            data-testid="appointment-book"
          >
            {warnings ? 'Book anyway' : 'Book'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
