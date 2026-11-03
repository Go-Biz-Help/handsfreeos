'use client';
/**
 * A webinar's link anyone can use (`/live/<key>`, HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md, the owner's 5c): the
 * business's look, the webinar's title and time, and a door form (name, mobile, email and the texting boxes the
 * booking page shows). Sending it saves a seat (the worker's http/webinar-door.ts).
 *
 * - **A new customer** gets their own Join link back: while it's open (an hour before to the end) the page goes
 *   straight into the call; before that it says they're registered, with the link to keep.
 * - **Anyone already on file** is sent their own Join link instead, to the phone or email the business has.
 * - **Full, over, cancelled, or asking for payment**: the page says so, and a paid one points to the booking page.
 */
import { WEBINAR_WORDS, consentPolicyPath, consentTermsPath } from '@hfos/core';
import { CalendarCheck, CalendarOff, Mail, Video } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button, buttonClassName } from '@/components/ui/button';
import { FieldError, Label } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/api/errors';
import {
  registerWebinar,
  TURNSTILE_SITE_KEY,
  type WebinarDoor,
  type WebinarDoorAnswer,
} from '@/lib/api/public-booking';
import { Honeypot, OffersConsent, SmsConsent } from './booking-flow';
import { PublicFrame, PublicState } from './public-shell';
import { Turnstile } from './turnstile';

const FIELDS = new Set(['name', 'phone', 'email']);

export function WebinarDoorPage({ doorKey, door }: { doorKey: string; door: WebinarDoor }) {
  return (
    <PublicFrame business={door.business} byline="Webinars by HandsFreeOS">
      <Door doorKey={doorKey} door={door} />
    </PublicFrame>
  );
}

function Door({ doorKey, door }: { doorKey: string; door: WebinarDoor }) {
  const [answer, setAnswer] = useState<WebinarDoorAnswer | null>(null);
  const when = `${door.when} (${door.zone})`;

  if (door.state === 'cancelled')
    return (
      <PublicState icon={<CalendarOff size={20} />} title={door.title} testId="live-cancelled">
        {WEBINAR_WORDS.doorCancelled}
      </PublicState>
    );
  if (door.state === 'over')
    return (
      <PublicState icon={<CalendarOff size={20} />} title={door.title} testId="live-over">
        {WEBINAR_WORDS.doorOver}
      </PublicState>
    );
  if (!door.ready)
    return (
      <PublicState icon={<CalendarOff size={20} />} title={door.title} testId="live-off">
        {WEBINAR_WORDS.doorOff}
      </PublicState>
    );
  if (door.paid)
    return (
      <PublicState
        icon={<CalendarCheck size={20} />}
        title={door.title}
        testId="live-paid"
        action={
          door.bookingPath ? (
            <a className={buttonClassName({})} href={door.bookingPath}>
              {WEBINAR_WORDS.doorSave}
            </a>
          ) : undefined
        }
      >
        {door.bookingPath
          ? `${when}. This webinar asks for payment to save a seat, on the booking page.`
          : `${when}. This webinar asks for payment to save a seat. Get in touch with ${door.business.name} to join.`}
      </PublicState>
    );
  if (door.state === 'full')
    return (
      <PublicState
        tone="warning"
        icon={<CalendarOff size={20} />}
        title={door.title}
        testId="live-full"
      >
        {`${WEBINAR_WORDS.doorFull} Get in touch with ${door.business.name} about the next one.`}
      </PublicState>
    );
  if (answer?.status === 'sent')
    return (
      <PublicState tone="accent" icon={<Mail size={20} />} title={door.title} testId="live-sent">
        {WEBINAR_WORDS.doorSent}
      </PublicState>
    );
  if (answer?.status === 'registered' && answer.joinUrl)
    return (
      <PublicState
        tone="accent"
        icon={<CalendarCheck size={20} />}
        title="You’re registered"
        testId="live-registered"
        action={
          <a
            className={buttonClassName({ variant: answer.open ? 'primary' : 'secondary' })}
            href={answer.joinUrl}
            data-testid="live-join-link"
          >
            {answer.open ? WEBINAR_WORDS.doorJoin : 'Your own Join link'}
          </a>
        }
      >
        {WEBINAR_WORDS.doorRegistered(when)}
      </PublicState>
    );
  return <DoorForm doorKey={doorKey} door={door} when={when} onAnswer={setAnswer} />;
}

function DoorForm({
  doorKey,
  door,
  when,
  onAnswer,
}: {
  doorKey: string;
  door: WebinarDoor;
  when: string;
  onAnswer: (a: WebinarDoorAnswer) => void;
}) {
  const business = door.business;
  const [form, setForm] = useState({
    name: '',
    phone: '',
    email: '',
    smsConsent: false,
    offersConsent: false,
    callConsent: false,
  });
  const [website, setWebsite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const botSiteKey = door.botCheck ? (door.botCheck.siteKey ?? TURNSTILE_SITE_KEY) : null;
  const [botToken, setBotToken] = useState<string | null>(null);
  const [botReset, setBotReset] = useState(0);
  const set =
    <K extends keyof typeof form>(k: K) =>
    (v: (typeof form)[K]) =>
      setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const a = await registerWebinar(doorKey, {
        name: form.name,
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        smsConsent: form.smsConsent,
        offersConsent: business.offersConsent ? form.offersConsent : false,
        callConsent: business.callConsent ? form.callConsent : false,
        website,
        ...(botToken ? { turnstileToken: botToken } : {}),
      });
      // Open now, and theirs: straight into the call.
      if (a.status === 'registered' && a.open && a.joinUrl) window.location.assign(a.joinUrl);
      onAnswer(a);
    } catch (err) {
      setBotToken(null);
      setBotReset((n) => n + 1);
      if (!(err instanceof ApiError)) {
        setError('We couldn’t save your seat. Check your connection and try again.');
      } else if (err.code === 'validation' && Array.isArray(err.details) && err.details.length) {
        const errs: Record<string, string> = {};
        const other: string[] = [];
        for (const d of err.details as { path: string; message: string }[])
          if (FIELDS.has(d.path)) errs[d.path] ??= d.message;
          else other.push(d.message);
        setFieldErrors(errs);
        setError(other[0] ?? (Object.keys(errs).length ? null : err.message));
      } else setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const open = door.state === 'open';
  return (
    <main className="mx-auto flex w-full max-w-[480px] flex-1 flex-col gap-5 px-4 py-8">
      <div className="flex flex-col items-center gap-1.5 text-center">
        <span
          aria-hidden
          className="mb-1 inline-flex h-[42px] w-[42px] items-center justify-center rounded-full bg-accent-soft text-accent-text"
        >
          <Video size={20} />
        </span>
        <p className="text-[12px] font-medium uppercase tracking-wide text-text-3">
          {WEBINAR_WORDS.name}
        </p>
        <h1 className="text-lg font-semibold" data-testid="live-title">
          {door.title}
        </h1>
        <p className="text-[13.5px] text-text-2" data-testid="live-when">
          {when}
        </p>
        {open ? (
          <p className="text-[13px] font-medium text-accent-text">It’s open now. Join below.</p>
        ) : null}
      </div>
      <form className="relative flex flex-col gap-3" onSubmit={(e) => void submit(e)} noValidate>
        <div>
          <Label htmlFor="live-name">Your name</Label>
          <Input
            id="live-name"
            autoComplete="name"
            value={form.name}
            invalid={!!fieldErrors.name}
            onChange={(e) => set('name')(e.target.value)}
            data-testid="live-name"
          />
          <FieldError>{fieldErrors.name}</FieldError>
        </div>
        <div>
          <Label htmlFor="live-phone">Mobile</Label>
          <Input
            id="live-phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={form.phone}
            invalid={!!fieldErrors.phone}
            onChange={(e) => set('phone')(e.target.value)}
            data-testid="live-phone"
          />
          <FieldError>{fieldErrors.phone}</FieldError>
        </div>
        <div>
          <Label htmlFor="live-email">Email</Label>
          <Input
            id="live-email"
            type="email"
            autoComplete="email"
            value={form.email}
            invalid={!!fieldErrors.email}
            onChange={(e) => set('email')(e.target.value)}
            data-testid="live-email"
          />
          <FieldError>{fieldErrors.email}</FieldError>
        </div>
        <SmsConsent
          checked={form.smsConsent}
          onChange={(v) => set('smsConsent')(v)}
          business={business.name}
          phone={form.phone}
          emailToo={!!form.email.trim() || !form.phone.trim()}
          policyPath={door.site ? consentPolicyPath(door.site) : null}
          termsPath={door.site ? consentTermsPath(door.site) : null}
        />
        {business.offersConsent ? (
          <OffersConsent
            checked={form.offersConsent}
            onChange={(v) => set('offersConsent')(v)}
            words={business.offersConsent}
          />
        ) : null}
        {business.callConsent ? (
          <OffersConsent
            checked={form.callConsent}
            onChange={(v) => set('callConsent')(v)}
            words={business.callConsent}
            testId="booking-call-consent"
          />
        ) : null}
        <Honeypot value={website} onChange={setWebsite} />
        {botSiteKey ? (
          <Turnstile siteKey={botSiteKey} onToken={setBotToken} resetKey={botReset} />
        ) : null}
        {error ? (
          <p className="text-[13px] text-danger-text" role="alert" data-testid="live-error">
            {error}
          </p>
        ) : null}
        <Button
          type="submit"
          size="lg"
          loading={busy}
          disabled={!form.name.trim() || (!!botSiteKey && !botToken)}
          data-testid="live-submit"
        >
          {busy ? WEBINAR_WORDS.doorSaving : open ? WEBINAR_WORDS.doorJoin : WEBINAR_WORDS.doorSave}
        </Button>
        {door.aiNotes ? (
          <p className="text-center text-[12px] text-text-3">
            AI takes notes during this webinar for {business.name}.
          </p>
        ) : null}
      </form>
    </main>
  );
}
