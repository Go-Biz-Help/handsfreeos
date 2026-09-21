'use client';
/**
 * The booking page's steps, phone first (design/m5/Booking.dc.html and BookingScreens.dc.html): the ZIP
 * first when the calendar routes by ZIP, then the service and length, the person when customers pick, a day
 * and time, the customer's details, and "You’re booked". A sessions calendar lists its sessions with seats
 * left, and "Join the waitlist" when one is full. The Book button sends one clientId per booking, so a
 * doubled tap never books twice.
 */
import { addDays, daysBetween, localDateOf, smsConsentWords, startOfLocalDay } from '@hfos/core';
import {
  CalendarSearch,
  Check,
  ChevronLeft,
  CircleX,
  Clock,
  Globe,
  MapPin,
  Minus,
  Plus,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { FieldError, Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/api/errors';
import {
  bookOnline,
  getOpenTimes,
  isHeld,
  joinWaitlist,
  TURNSTILE_SITE_KEY,
  type Booked,
  type FullSession,
  type Held,
  type IntakeQuestion,
  type LocationKind,
  type PublicCalendarPage,
  type PublicSlot,
  type RecordedPay,
} from '@/lib/api/public-booking';
import { cn } from '@/lib/utils';
import { BookedPanel } from './booked-panel';
import { DepositStep, TimeWentPanel } from './deposit-pay';
import {
  dateShort,
  dayShort,
  lengthLabel,
  localDate,
  money,
  seatsLabel,
  timeOf,
  timeRange,
} from './format';
import { BookingOff, CallButton, callPhrase, PublicState } from './public-shell';
import { TimePicker } from './time-picker';
import { Turnstile } from './turnstile';

type Answer = string | number | boolean | string[] | null;
type Step =
  | 'choose'
  | 'time'
  | 'sessions'
  | 'details'
  | 'pay'
  | 'waitlist'
  | 'booked'
  | 'waitlisted'
  | 'gone';
type SessionRow =
  | { readonly kind: 'open'; readonly slot: PublicSlot }
  | { readonly kind: 'full'; readonly full: FullSession };

interface WaitlistTarget {
  readonly sessionId?: string;
  readonly wantedFrom?: string;
  readonly wantedTo?: string;
  /** "Sat, Sep 26 · 10:00 AM–12:00 PM", or "the next 60 days". */
  readonly label: string;
}

const DAY = 86_400_000;
const FIELD_OF: Record<string, string> = {
  name: 'name',
  phone: 'phone',
  email: 'email',
  address: 'address',
  notes: 'notes',
};

// ---- Small pieces ----

function StepHead({
  label,
  title,
  sub,
  onBack,
  className,
}: {
  label?: string;
  title: string;
  sub?: ReactNode;
  onBack?: () => void;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-0.5', className)}>
      <div className="flex min-h-6 items-center justify-between">
        {label ? (
          <span className="text-xs font-semibold uppercase tracking-[0.04em] text-text-3">
            {label}
          </span>
        ) : (
          <span />
        )}
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="inline-flex min-h-6 items-center gap-0.5 text-xs font-medium text-accent-text hover:underline"
          >
            <ChevronLeft size={14} aria-hidden />
            Back
          </button>
        ) : null}
      </div>
      <h1 className="text-lg font-semibold tracking-[-0.005em]">{title}</h1>
      {sub ? <p className="text-[13px] text-text-2">{sub}</p> : null}
    </div>
  );
}

/** The bottom bar on phones (sticky), a plain row on computers. */
function ActionBar({ children, phoneOnly }: { children: ReactNode; phoneOnly?: boolean }) {
  return (
    <div
      className={cn(
        'sticky bottom-0 z-10 -mx-4 mt-auto flex flex-col gap-2 border-t border-border bg-card px-4 py-2.5',
        phoneOnly ? 'md:hidden' : 'md:static md:mx-0 md:mt-2 md:border-0 md:bg-transparent md:p-0',
      )}
    >
      {children}
    </div>
  );
}

function Choice({
  selected,
  onSelect,
  title,
  description,
  aside,
  testId,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  description?: string | null;
  aside?: string | null;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      data-testid={testId}
      className={cn(
        'flex min-h-[60px] w-full items-center gap-3 rounded-[10px] border px-3.5 py-3 text-left transition-colors',
        selected
          ? 'border-accent bg-accent-soft shadow-[0_0_0_1px_var(--accent)]'
          : 'border-border-strong bg-card hover:bg-card-2',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'flex h-4 w-4 flex-none items-center justify-center rounded-full border-[1.5px]',
          selected ? 'border-accent' : 'border-border-strong',
        )}
      >
        {selected ? <span className="h-2 w-2 rounded-full bg-accent" /> : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="text-[15px] font-medium">{title}</span>
        {description ? <span className="text-xs text-text-2">{description}</span> : null}
      </span>
      {aside ? <span className="whitespace-nowrap text-[13px] font-medium">{aside}</span> : null}
    </button>
  );
}

function ChoiceGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-col gap-2">
      <span className="text-[13px] font-medium">{label}</span>
      {children}
    </div>
  );
}

function PartyStepper({
  value,
  max,
  onChange,
}: {
  value: number;
  max: number;
  onChange: (n: number) => void;
}) {
  const button =
    'inline-flex h-[30px] w-[30px] items-center justify-center text-text-2 hover:bg-card-2 disabled:opacity-40';
  return (
    <div className="flex items-center justify-between">
      <span className="text-[13px] font-medium" id="party-label">
        How many people?
      </span>
      <span
        role="group"
        aria-labelledby="party-label"
        className="inline-flex h-8 items-center overflow-hidden rounded-control border border-border-strong bg-card"
      >
        <button
          type="button"
          aria-label="Fewer"
          className={button}
          disabled={value <= 1}
          onClick={() => onChange(value - 1)}
        >
          <Minus size={15} />
        </button>
        <span
          className="min-w-[26px] text-center text-[13.5px] font-semibold tabular-nums"
          data-testid="party-size"
        >
          {value}
        </span>
        <button
          type="button"
          aria-label="More"
          className={button}
          disabled={value >= max}
          onClick={() => onChange(value + 1)}
        >
          <Plus size={15} />
        </button>
      </span>
    </div>
  );
}

function TimesIn({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-1.5 text-xs text-text-3">
      <Globe size={14} aria-hidden />
      Times in {label}
    </p>
  );
}

/** "Text me about this appointment": starts unticked; STOP always wins on the worker's side. */
function SmsConsent({
  checked,
  onChange,
  business,
  phone,
  emailToo,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  business: string;
  phone: string;
  emailToo: boolean;
}) {
  const words = smsConsentWords(business, 'booking');
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="flex min-h-11 items-start gap-2.5 py-1 text-left"
      >
        <span
          aria-hidden
          className={cn(
            'mt-0.5 inline-flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[5px] border',
            checked ? 'border-accent bg-accent text-white' : 'border-border-strong bg-card',
          )}
        >
          {checked ? <Check size={13} strokeWidth={2.4} /> : null}
        </span>
        {/* The words are core's (messaging/consent.ts), shared with the public form, because a carrier
            reads both and two screens that say different things is what an audit finds. */}
        <span className="flex flex-col gap-0.5">
          <span className="text-[13px] font-medium">{words.title}</span>
          <span className="text-xs text-text-3">{words.detail}</span>
        </span>
      </button>
      <span className="text-xs text-text-3">
        {checked
          ? phone.trim()
            ? `You’ll get texts at ${phone.trim()}.`
            : 'Add your mobile number to get texts.'
          : emailToo
            ? 'Leave it unticked and we’ll email you instead.'
            : 'Leave it unticked and we won’t text you.'}
      </span>
    </div>
  );
}

/** People never see it, so it stays empty; bots fill it in and are turned away. */
function Honeypot({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div aria-hidden className="absolute -left-[10000px] top-auto h-px w-px overflow-hidden">
      <label>
        Website
        <input
          name="website"
          tabIndex={-1}
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
    </div>
  );
}

function IntakeField({
  q,
  value,
  onChange,
  error,
}: {
  q: IntakeQuestion;
  value: Answer | undefined;
  onChange: (v: Answer) => void;
  error?: string;
}) {
  const id = `intake-${q.id}`;
  const label = (
    <Label htmlFor={id}>
      {q.label} {q.required ? null : <span className="font-normal text-text-3">Optional</span>}
    </Label>
  );
  if (q.kind === 'checkbox')
    return (
      <div>
        <label className="flex items-center gap-2.5 text-sm">
          <input
            id={id}
            type="checkbox"
            className="h-[18px] w-[18px] accent-accent"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          {q.label}
        </label>
        <FieldError>{error}</FieldError>
      </div>
    );
  if (q.kind === 'multi_select') {
    const list = Array.isArray(value) ? value : [];
    return (
      <fieldset>
        <legend className="mb-1.5 text-[13px] font-medium">
          {q.label} {q.required ? null : <span className="font-normal text-text-3">Optional</span>}
        </legend>
        <div className="flex flex-col gap-1.5">
          {q.options.map((o) => (
            <label key={o} className="flex items-center gap-2.5 text-sm">
              <input
                type="checkbox"
                className="h-[18px] w-[18px] accent-accent"
                checked={list.includes(o)}
                onChange={(e) =>
                  onChange(e.target.checked ? [...list, o] : list.filter((x) => x !== o))
                }
              />
              {o}
            </label>
          ))}
        </div>
        <FieldError>{error}</FieldError>
      </fieldset>
    );
  }
  return (
    <div>
      {label}
      {q.kind === 'long_text' ? (
        <Textarea
          id={id}
          className="min-h-16"
          value={typeof value === 'string' ? value : ''}
          invalid={!!error}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : q.kind === 'select' ? (
        <Select
          id={id}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">Choose one</option>
          {q.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          id={id}
          type={q.kind === 'number' ? 'number' : q.kind === 'date' ? 'date' : 'text'}
          value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
          invalid={!!error}
          onChange={(e) =>
            onChange(
              q.kind === 'number'
                ? e.target.value === ''
                  ? null
                  : Number(e.target.value)
                : e.target.value,
            )
          }
        />
      )}
      <FieldError>{error}</FieldError>
    </div>
  );
}

// ---- The flow ----

export function BookingFlow({
  page,
  site,
  calendarSlug,
}: {
  page: PublicCalendarPage;
  site: string;
  calendarSlug: string;
}) {
  const info = page.booking!;
  const tz = page.timezone;
  const business = page.business;
  const sessionsMode = info.mode === 'sessions';

  // What, where and who.
  const [serviceId, setServiceId] = useState<string | null>(info.services[0]?.id ?? null);
  const service = info.services.find((s) => s.id === serviceId) ?? null;
  const lengths = service ? service.durations : info.durations;
  const [duration, setDuration] = useState<number>(lengths[0] ?? 60);
  const [zip, setZip] = useState('');
  const [personId, setPersonId] = useState('');
  const [locationKind, setLocationKind] = useState<LocationKind | null>(
    info.locations[0]?.kind ?? null,
  );
  const [party, setParty] = useState(1);
  const maxParty = info.capacity.maxPartySize;
  const zipRouting = info.zipRouting;
  const zipComplete = /^\d{5}$/.test(zip);
  const zipCovered = !zipRouting || (zipComplete && zipRouting.postalCodes.includes(zip));
  const chooseLocation = info.customerChoosesLocation && info.locations.length > 1;
  const hasChoices =
    !sessionsMode &&
    (!!zipRouting ||
      info.services.length > 1 ||
      lengths.length > 1 ||
      info.people.length > 1 ||
      chooseLocation ||
      maxParty > 1);
  // A calendar that asks for money adds a step: the time is held while they pay for it.
  const takesPayment = !!info.payment;
  const flow: Step[] = [
    ...(sessionsMode
      ? (['sessions', 'details'] as Step[])
      : hasChoices
        ? (['choose', 'time', 'details'] as Step[])
        : (['time', 'details'] as Step[])),
    ...(takesPayment ? (['pay'] as Step[]) : []),
  ];
  const [step, setStep] = useState<Step>(flow[0]!);
  const index = flow.indexOf(step);
  const stepLabel = index >= 0 ? `Step ${index + 1} of ${flow.length}` : undefined;
  const back = index > 0 ? () => setStep(flow[index - 1]!) : undefined;
  const what = service?.name ?? page.calendar.name;
  const needsAddress = locationKind === 'customer_address';
  const locationLabel = info.locations.find((l) => l.kind === locationKind)?.label ?? null;

  // When: business-local dates, within the calendar's window.
  const today = localDateOf(Date.now(), tz);
  const minDate =
    info.window.dateFrom && info.window.dateFrom > today ? info.window.dateFrom : today;
  const horizon = addDays(today, info.window.maxDaysAhead);
  const maxDate = info.window.dateTo && info.window.dateTo < horizon ? info.window.dateTo : horizon;
  const [slot, setSlot] = useState<PublicSlot | null>(null);
  const [noTimes, setNoTimes] = useState(false);
  const loadKey = JSON.stringify([serviceId, duration, party, zip, personId, locationKind]);
  const load = useCallback(
    (from: string, to: string) =>
      getOpenTimes(site, calendarSlug, {
        from,
        to,
        serviceId,
        durationMinutes: sessionsMode ? undefined : duration,
        partySize: party,
        postalCode: zipRouting ? zip : null,
        chosenUserId: personId || null,
        locationKind,
      }),
    [
      site,
      calendarSlug,
      serviceId,
      sessionsMode,
      duration,
      party,
      zipRouting,
      zip,
      personId,
      locationKind,
    ],
  );

  // Sessions: this month's, then more on request.
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [rowsUntil, setRowsUntil] = useState<string | null>(null);
  const [rowsLoading, setRowsLoading] = useState(false);
  const loadSessions = useCallback(
    async (from: string, reset: boolean) => {
      const days = Math.min(30, daysBetween(from, maxDate) + 1);
      if (days <= 0) return;
      setRowsLoading(true);
      try {
        const out = await load(
          new Date(Math.max(Date.now(), startOfLocalDay(from, tz))).toISOString(),
          new Date(startOfLocalDay(addDays(from, days), tz)).toISOString(),
        );
        const next: SessionRow[] = [
          ...out.slots.map((s) => ({ kind: 'open' as const, slot: s })),
          ...(out.full ?? []).map((f) => ({ kind: 'full' as const, full: f })),
        ];
        const start = (r: SessionRow) => (r.kind === 'open' ? r.slot.startsAt : r.full.startsAt);
        setRows((prev) =>
          [...(reset ? [] : prev), ...next].sort((a, b) => start(a).localeCompare(start(b))),
        );
        setRowsUntil(addDays(from, days));
        setError(null);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'We couldn’t load the times. Try again.');
      } finally {
        setRowsLoading(false);
      }
    },
    [load, maxDate, tz],
  );
  useEffect(() => {
    if (sessionsMode) void loadSessions(minDate, true);
  }, [sessionsMode, loadSessions, minDate]);

  // Details.
  const [form, setForm] = useState({
    name: '',
    phone: '',
    email: '',
    address: '',
    notes: '',
    smsConsent: false,
  });
  const set = (k: keyof typeof form) => (v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));
  const [intake, setIntake] = useState<Record<string, Answer>>({});
  const [website, setWebsite] = useState('');
  const botSiteKey = info.botCheck ? (info.botCheck.siteKey ?? TURNSTILE_SITE_KEY) : null;
  const [botToken, setBotToken] = useState<string | null>(null);
  const [botReset, setBotReset] = useState(0);
  const clientId = useRef<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  /** The time went while they typed: fresh times, and the server's words when a resource is full. */
  const [taken, setTaken] = useState<{
    at: string;
    slots: PublicSlot[];
    message: string | null;
  } | null>(null);
  const [off, setOff] = useState(false);
  const [booked, setBooked] = useState<Booked | null>(null);
  /** The time this calendar is holding while they pay for it, and what is due. */
  const [held, setHeld] = useState<Held | null>(null);
  /** The time went while they were paying: nothing was charged, and here are other times. */
  const [lost, setLost] = useState<{ answer: RecordedPay; times: readonly PublicSlot[] } | null>(
    null,
  );
  const [waitFor, setWaitFor] = useState<WaitlistTarget | null>(null);
  const [waitlisted, setWaitlisted] = useState<{ position: number; again: boolean } | null>(null);

  const go = (s: Step) => {
    setError(null);
    setStep(s);
    window.scrollTo({ top: 0 });
  };

  function failed(e: unknown) {
    if (botSiteKey) {
      setBotToken(null);
      setBotReset((n) => n + 1);
    }
    if (!(e instanceof ApiError)) {
      setError('Something went wrong. Please try again.');
      return;
    }
    // Someone was faster, or every bed or room it needs is in use then (resource_full): fresh times.
    if ((e.rule === 'slot_taken' || e.rule === 'resource_full') && slot) {
      const fresh = (
        (e.details as { slots?: Omit<PublicSlot, 'people'>[] } | undefined)?.slots ?? []
      ).map((s) => ({ ...s, people: [] }));
      setTaken({
        at: slot.startsAt,
        slots: fresh,
        message: e.rule === 'resource_full' ? e.message : null,
      });
      setSlot(null);
      return;
    }
    if (e.rule === 'calendar_not_bookable') {
      setOff(true);
      return;
    }
    if (e.code === 'validation' && Array.isArray(e.details) && e.details.length) {
      const errs: Record<string, string> = {};
      const other: string[] = [];
      for (const d of e.details as { path: string; message: string }[]) {
        const key = d.path.startsWith('intake.') ? d.path : FIELD_OF[d.path];
        if (key) errs[key] ??= d.message;
        else other.push(d.message);
      }
      setFieldErrors(errs);
      setError(other[0] ?? (Object.keys(errs).length ? null : e.message));
      return;
    }
    setError(e.message);
  }

  async function submitBooking() {
    if (submitting || !slot) return;
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    clientId.current ??= crypto.randomUUID();
    try {
      const res = await bookOnline(site, calendarSlug, {
        clientId: clientId.current,
        startsAt: slot.startsAt,
        sessionId: slot.sessionId,
        serviceId,
        durationMinutes: sessionsMode ? undefined : duration,
        partySize: party,
        locationKind,
        address: needsAddress ? form.address.trim() || null : null,
        postalCode: zipRouting ? zip : null,
        chosenUserId: personId || null,
        name: form.name,
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        smsConsent: form.smsConsent,
        intake,
        notes: form.notes.trim() || null,
        website,
        turnstileToken: botToken ?? undefined,
      });
      // A calendar that asks for money holds the time instead of confirming it: the pay step comes next.
      if (isHeld(res)) {
        setHeld(res);
        go('pay');
      } else {
        setBooked(res);
        go('booked');
      }
    } catch (e) {
      failed(e);
    } finally {
      setSubmitting(false);
    }
  }

  async function submitWaitlist() {
    if (submitting || !waitFor) return;
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      const res = await joinWaitlist(site, calendarSlug, {
        sessionId: waitFor.sessionId ?? null,
        wantedFrom: waitFor.wantedFrom,
        wantedTo: waitFor.wantedTo,
        partySize: party,
        name: form.name,
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        smsConsent: form.smsConsent,
        website,
        turnstileToken: botToken ?? undefined,
      });
      setWaitlisted({ position: res.position, again: res.alreadyWaiting });
      go('waitlisted');
    } catch (e) {
      failed(e);
    } finally {
      setSubmitting(false);
    }
  }

  function restart() {
    clientId.current = null;
    setBooked(null);
    setHeld(null);
    setLost(null);
    setWaitlisted(null);
    setWaitFor(null);
    setSlot(null);
    setTaken(null);
    setNoTimes(false);
    setIntake({});
    setForm((f) => ({ ...f, address: '', notes: '' }));
    if (sessionsMode) void loadSessions(minDate, true);
    go(flow[0]!);
  }

  const startWaitlist = (target: WaitlistTarget) => {
    setWaitFor(target);
    go('waitlist');
  };

  if (off) return <BookingOff business={business} />;

  // ---------- booked ----------
  if (step === 'booked' && booked)
    return (
      <BookedPanel
        booked={booked}
        tz={tz}
        business={business}
        deposit={held?.deposit ?? null}
        onRestart={restart}
      />
    );

  // ---------- the time went while they were paying ----------
  if (step === 'gone' && lost)
    return (
      <TimeWentPanel
        answer={lost.answer}
        tz={tz}
        times={lost.times}
        onPick={(s) => {
          restart();
          setSlot(s);
        }}
        onRestart={restart}
      />
    );

  // ---------- on the waitlist ----------
  if (step === 'waitlisted' && waitlisted && waitFor) {
    return (
      <PublicState
        tone="success"
        icon={<Check size={20} />}
        title="You’re on the waitlist"
        testId="waitlisted"
        action={
          <Button variant="secondary" size="sm" onClick={restart}>
            Back to the times
          </Button>
        }
      >
        {waitlisted.again ? 'You were already on it. ' : ''}You’re number {waitlisted.position} in
        line for {waitFor.label}. We’ll text or email you if a spot opens.
      </PublicState>
    );
  }

  // ---------- nothing open ----------
  if (step === 'time' && noTimes) {
    const days = Math.max(1, daysBetween(today, maxDate));
    const until = Math.min(startOfLocalDay(addDays(maxDate, 1), tz), Date.now() + 89 * DAY);
    return (
      <PublicState
        tone="accent"
        icon={<CalendarSearch size={20} />}
        title={`No open times in the next ${days} days`}
        testId="no-times"
        action={
          <div className="flex flex-col items-center gap-2">
            {info.waitlist.enabled ? (
              <Button
                size="sm"
                onClick={() =>
                  startWaitlist({
                    wantedFrom: new Date().toISOString(),
                    wantedTo: new Date(until).toISOString(),
                    label: `a time in the next ${days} days`,
                  })
                }
              >
                Join the waitlist
              </Button>
            ) : (
              <CallButton business={business} />
            )}
            {back ? (
              <button
                type="button"
                className="text-[13px] font-medium text-accent-text hover:underline"
                onClick={() => {
                  setNoTimes(false);
                  back();
                }}
              >
                Try something else
              </button>
            ) : null}
          </div>
        }
      >
        {info.waitlist.enabled
          ? 'Join the waitlist and we’ll text you when a time opens.'
          : `Please ${callPhrase(business)} and we’ll find a time.`}
      </PublicState>
    );
  }

  const errorLine = error ? (
    <p role="alert" className="text-[13px] text-danger-text" data-testid="booking-error">
      {error}
    </p>
  ) : null;

  const contactFields = (
    <>
      <div className="grid grid-cols-2 gap-2.5">
        <div className="min-w-0">
          <Label htmlFor="bk-name">Name</Label>
          <Input
            id="bk-name"
            autoComplete="name"
            value={form.name}
            invalid={!!fieldErrors.name}
            onChange={(e) => set('name')(e.target.value)}
          />
          <FieldError>{fieldErrors.name}</FieldError>
        </div>
        <div className="min-w-0">
          <Label htmlFor="bk-phone">Mobile</Label>
          <Input
            id="bk-phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={form.phone}
            invalid={!!fieldErrors.phone}
            onChange={(e) => set('phone')(e.target.value)}
          />
          <FieldError>{fieldErrors.phone}</FieldError>
        </div>
      </div>
      <div>
        <Label htmlFor="bk-email">Email</Label>
        <Input
          id="bk-email"
          type="email"
          autoComplete="email"
          value={form.email}
          invalid={!!fieldErrors.email}
          onChange={(e) => set('email')(e.target.value)}
        />
        <FieldError>{fieldErrors.email}</FieldError>
      </div>
    </>
  );

  const consentAndChecks = (
    <>
      <SmsConsent
        checked={form.smsConsent}
        onChange={(v) => set('smsConsent')(v)}
        business={business.name}
        phone={form.phone}
        emailToo={!!form.email.trim() || !form.phone.trim()}
      />
      <Honeypot value={website} onChange={setWebsite} />
      {botSiteKey ? (
        <Turnstile siteKey={botSiteKey} onToken={setBotToken} resetKey={botReset} />
      ) : info.botCheck ? (
        <p className="text-[13px] text-danger-text">
          Online booking isn’t fully set up. Please {callPhrase(business)}.
        </p>
      ) : null}
    </>
  );

  let content: ReactNode;
  if (step === 'choose') {
    content = (
      <>
        <StepHead label={stepLabel} title={page.calendar.name} sub={page.calendar.description} />
        {zipRouting ? (
          <div>
            <div className="flex items-center gap-2.5">
              <Label htmlFor="bk-zip" className="mb-0 flex-1">
                Your ZIP code
              </Label>
              <Input
                id="bk-zip"
                inputMode="numeric"
                autoComplete="postal-code"
                maxLength={5}
                className="h-[38px] w-[120px]"
                value={zip}
                invalid={zipComplete && !zipCovered}
                onChange={(e) => setZip(e.target.value.replace(/\D/g, '').slice(0, 5))}
              />
            </div>
            {zipComplete ? (
              zipCovered ? (
                <p className="mt-1.5 flex items-center gap-1.5 text-xs text-success-text">
                  <Check size={14} aria-hidden />
                  We come to {zip}.
                </p>
              ) : (
                <div className="mt-1.5 flex flex-col gap-1" role="alert" data-testid="outside-area">
                  <p className="flex items-start gap-2 text-[13px] text-danger-text">
                    <CircleX size={15} className="mt-0.5 flex-none" aria-hidden />
                    We don’t come to {zip} yet.
                  </p>
                  <p className="text-[13px] text-text-2">
                    {business.phoneDisplay
                      ? `Call ${business.phoneDisplay} and we’ll see what we can do.`
                      : `Contact ${business.name} and we’ll see what we can do.`}
                  </p>
                </div>
              )
            ) : null}
          </div>
        ) : null}
        {info.services.length > 1 ? (
          <ChoiceGroup label="What do you need?">
            {info.services.map((s) => (
              <Choice
                key={s.id}
                selected={s.id === serviceId}
                onSelect={() => {
                  setServiceId(s.id);
                  setDuration(s.durations[0] ?? 60);
                  setSlot(null);
                }}
                title={s.name}
                description={s.description}
                aside={s.priceCents !== null ? money(s.priceCents) : null}
                testId="service"
              />
            ))}
          </ChoiceGroup>
        ) : null}
        {lengths.length > 1 ? (
          <div role="radiogroup" aria-label="How long do you need?">
            <span className="mb-1.5 block text-[13px] font-medium">How long do you need?</span>
            <div className="flex gap-0.5 rounded-control bg-card-2 p-[3px]">
              {lengths.map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={m === duration}
                  onClick={() => {
                    setDuration(m);
                    setSlot(null);
                  }}
                  className={cn(
                    'h-10 flex-1 rounded-[6px] text-[13px] font-medium md:h-9',
                    m === duration ? 'bg-card text-text shadow-1' : 'text-text-2 hover:text-text',
                  )}
                >
                  {lengthLabel(m)}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {info.people.length > 1 ? (
          <ChoiceGroup label="Who would you like?">
            <Choice
              selected={personId === ''}
              onSelect={() => setPersonId('')}
              title="Anyone available"
              description="We’ll send whoever is free."
            />
            {info.people.map((p) => (
              <Choice
                key={p.id}
                selected={personId === p.id}
                onSelect={() => setPersonId(p.id)}
                title={p.name}
              />
            ))}
          </ChoiceGroup>
        ) : null}
        {chooseLocation ? (
          <ChoiceGroup label="Where?">
            {info.locations.map((l) => (
              <Choice
                key={l.kind}
                selected={locationKind === l.kind}
                onSelect={() => setLocationKind(l.kind)}
                title={l.label}
                description={l.address}
              />
            ))}
          </ChoiceGroup>
        ) : null}
        {maxParty > 1 ? <PartyStepper value={party} max={maxParty} onChange={setParty} /> : null}
        <ActionBar>
          <Button
            size="lg"
            className="w-full"
            disabled={!zipCovered || (info.services.length > 0 && !service)}
            onClick={() => go('time')}
          >
            Continue
          </Button>
        </ActionBar>
      </>
    );
  } else if (step === 'time') {
    const sub = `${what} · ${lengthLabel(duration)}${zipRouting && zip ? ` · ZIP ${zip}` : ''}`;
    content = (
      <>
        <div className="md:grid md:grid-cols-[200px_minmax(0,1fr)] md:gap-7">
          <div className="flex flex-col gap-2.5">
            <StepHead
              label={stepLabel}
              title="Pick a time"
              sub={sub}
              onBack={back}
              className="md:hidden"
            />
            <div className="hidden flex-col gap-2.5 md:flex">
              <span className="text-xs font-semibold uppercase tracking-[0.04em] text-text-3">
                {stepLabel}
              </span>
              <h1 className="text-lg font-semibold">{what}</h1>
              <span className="flex items-center gap-2 text-[13px] text-text-2">
                <Clock size={15} aria-hidden />
                {lengthLabel(duration)}
                {party > 1 ? ` · ${party} people` : ''}
              </span>
              {locationLabel ? (
                <span className="flex items-center gap-2 text-[13px] text-text-2">
                  <MapPin size={15} aria-hidden />
                  {locationLabel}
                  {zipRouting && zip ? `, ZIP ${zip}` : ''}
                </span>
              ) : null}
              {back ? (
                <button
                  type="button"
                  onClick={back}
                  className="w-fit text-[13px] font-medium text-accent-text hover:underline"
                >
                  Change service
                </button>
              ) : null}
            </div>
          </div>
          <TimePicker
            timezone={tz}
            timezoneLabel={page.timezoneLabel}
            minDate={minDate}
            maxDate={maxDate}
            load={load}
            loadKey={loadKey}
            selected={slot}
            onSelect={(s) => {
              setSlot(s);
              setTaken(null);
            }}
            onEmpty={() => setNoTimes(true)}
            footer={
              <Button className="w-full" disabled={!slot} onClick={() => go('details')}>
                {slot ? `Continue with ${timeOf(slot.startsAt, tz)}` : 'Continue'}
              </Button>
            }
          />
        </div>
        <ActionBar phoneOnly>
          {slot ? (
            <div className="flex items-center justify-between text-[13px]">
              <span className="font-medium">
                {dayShort(slot.startsAt, tz)} · {timeOf(slot.startsAt, tz)}
              </span>
              <span className="text-text-3">{lengthLabel(duration)}</span>
            </div>
          ) : null}
          <Button size="lg" className="w-full" disabled={!slot} onClick={() => go('details')}>
            Continue
          </Button>
        </ActionBar>
      </>
    );
  } else if (step === 'sessions') {
    content = (
      <>
        <StepHead title={page.calendar.name} sub={page.calendar.description} />
        {maxParty > 1 ? <PartyStepper value={party} max={maxParty} onChange={setParty} /> : null}
        {rows.length ? (
          <div className="divide-y divide-border overflow-hidden rounded-card border border-border bg-card shadow-1">
            {rows.map((r) => {
              const s = r.kind === 'open' ? r.slot : r.full;
              const label = `${dayShort(s.startsAt, tz)} · ${timeRange(s.startsAt, s.endsAt, tz)}`;
              return (
                <div
                  key={
                    r.kind === 'open'
                      ? `o:${r.slot.startsAt}:${r.slot.sessionId}`
                      : `f:${r.full.sessionId}`
                  }
                  className="flex items-center gap-2.5 px-3.5 py-2"
                  data-testid="session"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-[13px] font-medium">{label}</span>
                    {r.kind === 'open' ? (
                      <span className="text-xs font-medium text-success-text">
                        {r.slot.seatsLeft !== null
                          ? `${seatsLabel(r.slot.seatsLeft)} left`
                          : 'Open'}
                      </span>
                    ) : (
                      <span className="text-xs font-medium text-warning-text">
                        Full
                        {r.full.waiting
                          ? ` · ${r.full.waiting} ${r.full.waiting === 1 ? 'person' : 'people'} waiting`
                          : ''}
                      </span>
                    )}
                  </span>
                  {r.kind === 'open' ? (
                    <Button
                      size="sm"
                      onClick={() => {
                        setSlot(r.slot);
                        setTaken(null);
                        go('details');
                      }}
                    >
                      Book {seatsLabel(party)}
                    </Button>
                  ) : info.waitlist.enabled ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => startWaitlist({ sessionId: r.full.sessionId, label })}
                    >
                      Join the waitlist
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : rowsLoading ? (
          <p aria-live="polite" className="text-[13px] text-text-3">
            Finding open times…
          </p>
        ) : (
          <PublicState
            tone="accent"
            icon={<CalendarSearch size={20} />}
            title="No sessions coming up"
            testId="no-times"
            action={<CallButton business={business} />}
          >
            New dates are added often. Check back soon, or {callPhrase(business)}.
          </PublicState>
        )}
        {rows.length && rowsUntil && rowsUntil <= maxDate ? (
          <Button
            variant="ghost"
            size="sm"
            className="self-center"
            loading={rowsLoading}
            onClick={() => void loadSessions(rowsUntil, false)}
          >
            Show later dates
          </Button>
        ) : null}
        {errorLine}
        <TimesIn label={page.timezoneLabel} />
      </>
    );
  } else if (step === 'pay' && held) {
    content = (
      <DepositStep
        hold={held}
        tz={tz}
        stepLabel="Last step"
        onBack={() => go('details')}
        onPaid={(answer) => {
          setHeld(answer.hold);
          if (answer.hold.booked) {
            setBooked(answer.hold.booked);
            go('booked');
          }
        }}
        onLost={(answer) => {
          setLost({ answer, times: answer.times ?? [] });
          go('gone');
        }}
      />
    );
  } else if (step === 'waitlist' && waitFor) {
    content = (
      <form
        noValidate
        className="flex flex-1 flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          void submitWaitlist();
        }}
      >
        <StepHead
          title="Join the waitlist"
          sub={waitFor.label}
          onBack={() => go(sessionsMode ? 'sessions' : 'time')}
        />
        <p className="text-[13px] text-text-2">
          We’ll text or email you if a spot opens up. You’re not booked until you claim it.
        </p>
        {contactFields}
        {consentAndChecks}
        {errorLine}
        <ActionBar>
          <Button
            type="submit"
            size="lg"
            className="w-full"
            loading={submitting}
            disabled={botSiteKey !== null && !botToken}
          >
            Join the waitlist
          </Button>
        </ActionBar>
      </form>
    );
  } else {
    // Details.
    content = (
      <form
        noValidate
        className="flex flex-1 flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          void submitBooking();
        }}
      >
        <StepHead
          label={stepLabel}
          title="Your details"
          sub={
            slot
              ? `${what} · ${dayShort(slot.startsAt, tz)} at ${timeOf(slot.startsAt, tz)}${party > 1 ? ` · ${seatsLabel(party)}` : ''}`
              : 'Pick one of the open times below.'
          }
          onBack={back}
        />
        {info.payment ? (
          <p className="text-[13px] text-text-2" data-testid="payment-ahead">
            {info.payment.mode === 'full'
              ? `${money(info.payment.amountCents)} is due to book. `
              : `A ${money(info.payment.amountCents)} deposit is due to book. `}
            Your card is held, not charged, until the time is confirmed.
          </p>
        ) : null}
        {taken ? (
          <div className="flex flex-col gap-2.5" data-testid="slot-taken">
            <div
              role="alert"
              className="flex items-start gap-2.5 rounded-[10px] bg-danger-soft px-3 py-2.5 text-[13.5px] text-danger-text"
            >
              <CircleX size={17} className="mt-0.5 flex-none" aria-hidden />
              <span className="flex flex-col gap-0.5">
                <strong className="font-semibold">
                  {taken.message ?? `Sorry, ${timeOf(taken.at, tz)} was just taken`}
                </strong>
                <span>
                  {taken.slots.length
                    ? new Set(taken.slots.map((s) => localDate(s.startsAt, tz))).size === 1
                      ? `Here are the open times left on ${dateShort(localDate(taken.slots[0]!.startsAt, tz))}.`
                      : 'Here are the nearest open times.'
                    : 'Go back and pick another time.'}
                </span>
              </span>
            </div>
            {taken.slots.length ? (
              <div className="grid grid-cols-3 gap-1.5">
                {taken.slots.map((s) => {
                  const sameDay = localDate(s.startsAt, tz) === localDate(taken.at, tz);
                  return (
                    <button
                      key={`${s.startsAt}:${s.sessionId ?? ''}`}
                      type="button"
                      data-testid="fresh-slot"
                      onClick={() => {
                        setSlot(s);
                        setTaken(null);
                      }}
                      className="inline-flex h-[34px] items-center justify-center whitespace-nowrap rounded-control border border-border-strong bg-card px-1.5 text-[13.5px] font-medium hover:border-accent"
                    >
                      {sameDay
                        ? timeOf(s.startsAt, tz)
                        : `${dayShort(s.startsAt, tz).split(',')[0]} ${timeOf(s.startsAt, tz)}`}
                    </button>
                  );
                })}
              </div>
            ) : null}
            <TimesIn label={page.timezoneLabel} />
          </div>
        ) : null}
        {contactFields}
        {needsAddress ? (
          <div>
            <Label htmlFor="bk-address">Street address</Label>
            <Input
              id="bk-address"
              autoComplete="street-address"
              value={form.address}
              invalid={!!fieldErrors.address}
              onChange={(e) => set('address')(e.target.value)}
            />
            {fieldErrors.address ? (
              <FieldError>{fieldErrors.address}</FieldError>
            ) : zipRouting && zip ? (
              <p className="mt-1.5 text-[12.5px] text-text-3">ZIP {zip}</p>
            ) : null}
          </div>
        ) : null}
        <div>
          <Label htmlFor="bk-notes">
            Anything we should know? <span className="font-normal text-text-3">Optional</span>
          </Label>
          <Textarea
            id="bk-notes"
            className="min-h-16"
            value={form.notes}
            onChange={(e) => set('notes')(e.target.value)}
          />
        </div>
        {info.intake.map((q) => (
          <IntakeField
            key={q.id}
            q={q}
            value={intake[q.id]}
            error={fieldErrors[`intake.${q.id}`]}
            onChange={(v) => setIntake((a) => ({ ...a, [q.id]: v }))}
          />
        ))}
        {info.policies.text ? (
          <p className="whitespace-pre-line text-xs text-text-3">{info.policies.text}</p>
        ) : null}
        {consentAndChecks}
        {errorLine}
        <ActionBar>
          <Button
            type="submit"
            size="lg"
            className="w-full"
            loading={submitting}
            disabled={!slot || (botSiteKey !== null && !botToken)}
          >
            {takesPayment ? 'Continue to payment' : `Book ${what}`}
          </Button>
        </ActionBar>
      </form>
    );
  }

  return (
    <div
      className={cn(
        'relative mx-auto flex w-full flex-1 flex-col gap-4 px-4 pt-4 md:pb-8 md:pt-8',
        step === 'time' ? 'max-w-[860px]' : 'max-w-[560px]',
      )}
      data-testid={`step-${step}`}
    >
      {content}
    </div>
  );
}
