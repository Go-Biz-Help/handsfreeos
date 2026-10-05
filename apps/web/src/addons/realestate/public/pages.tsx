'use client';
/**
 * Real Estate's signed-out pages (boards 44 and 45, design/realestate/PublicListing and OpenHouseSignIn), under the
 * business's site: a listing's page (`/a/<site>/realestate/<slug>`) and an open house's sign-in
 * (`…/<slug>/open-house/<id>`). They show only what the agent published, and only the business's name: no app, no
 * agent's phone. A question on the listing's page, or a sign-in at the open house, makes the visitor a customer with
 * a lead for the agent; someone working with another agent is only recorded. Each form carries the honeypot and the
 * bot check, and the yes to texts says who will text and how to stop, in core's words.
 *
 * Round five (boards 72, 73): a buyer's agent asks for a showing at one of the seller's open times
 * (`…/<slug>/showing`), and says how it went from the link they're sent after (`…/showing-feedback/<token>`).
 */
import {
  consentPolicyPath,
  consentTermsPath,
  fmtTime,
  fmtWhen,
  money,
  smsConsentWords,
} from '@hfos/core';
import { CalendarX, CheckCircle2, Clock, Home as HomeIcon } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { PublicFrame, PublicState } from '@/components/booking/public-shell';
import { Turnstile } from '@/components/booking/turnstile';
import { Honeypot } from '@/components/money/public-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Textarea } from '@/components/ui/textarea';
import type { AddonPublicPageProps } from '@/addons/registry';
import { ApiError } from '@/lib/api/errors';
import { TURNSTILE_SITE_KEY } from '@/lib/api/public-booking';
import { publicAddonCommand } from '@/lib/api/public-addon';
import type {
  PublicListing,
  PublicOpenHouse,
  PublicPhoto,
  PublicShowingFeedbackForm,
  PublicShowingTimes,
} from './types';

const STATUS_WORDS = { under_contract: 'Under contract', sold: 'Sold' } as const;

export default function RealestatePublicPages(props: AddonPublicPageProps) {
  if (props.page === ':slug') return <ListingPage {...props} />;
  if (props.page === ':slug/open-house/:openHouseId') return <OpenHousePage {...props} />;
  if (props.page === ':slug/showing') return <ShowingRequestPage {...props} />;
  if (props.page === ':slug/showing-feedback/:token') return <ShowingFeedbackPage {...props} />;
  return null;
}

function Frame({ props, children }: { props: AddonPublicPageProps; children: ReactNode }) {
  return (
    <PublicFrame
      business={{ name: props.business.name, phone: null, phoneDisplay: null }}
      byline="Page by HandsFreeOS"
    >
      <div className="mx-auto w-full max-w-[720px] px-4 py-5 md:px-6 md:py-8">{children}</div>
    </PublicFrame>
  );
}

function Photo({
  photo,
  alt,
  className,
}: {
  photo: PublicPhoto | undefined;
  alt: string;
  className: string;
}) {
  return photo?.url ? (
    // A link the worker signed for an hour: no loader in between.
    <img src={photo.url} alt={alt} className={`w-full rounded-card object-cover ${className}`} />
  ) : (
    <div
      className={`flex w-full items-center justify-center rounded-card bg-card-2 text-text-3 ${className}`}
    >
      <HomeIcon className="h-8 w-8" strokeWidth={1.25} />
    </div>
  );
}

/** The visitor's yes to texts, in core's words, with the business's policy and terms linked. */
function useConsent(props: AddonPublicPageProps) {
  return smsConsentWords(
    props.business.name,
    'form',
    consentPolicyPath(props.site),
    consentTermsPath(props.site),
  );
}

function ConsentBox({
  props,
  checked,
  onChange,
}: {
  props: AddonPublicPageProps;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  const words = useConsent(props);
  return (
    <div>
      <Checkbox
        className="text-[13px] font-medium"
        label={words.title}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        data-testid="public-sms-consent"
      />
      <p className="ml-[26px] mt-1 text-xs text-text-3">
        {words.detail}{' '}
        {words.policyUrl ? (
          <a className="underline" href={words.policyUrl} target="_blank" rel="noreferrer">
            Privacy policy
          </a>
        ) : null}
        {words.termsUrl ? (
          <>
            {' · '}
            <a className="underline" href={words.termsUrl} target="_blank" rel="noreferrer">
              Terms
            </a>
          </>
        ) : null}
      </p>
    </div>
  );
}

/** The honeypot, the bot check and the send state every form here shares. */
function useSend(props: AddonPublicPageProps) {
  const [website, setWebsite] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [reset, setReset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const siteKey = props.botCheck ? (props.botCheck.siteKey ?? TURNSTILE_SITE_KEY) : null;
  const send = async (command: string, input: Record<string, unknown>): Promise<boolean> => {
    setBusy(true);
    setFailed(null);
    setFieldErrors({});
    try {
      await publicAddonCommand(props.site, command, {
        input,
        website,
        ...(token ? { turnstileToken: token } : {}),
      });
      return true;
    } catch (e) {
      const details =
        e instanceof ApiError ? (e.details as { path?: string; message?: string }[]) : null;
      if (Array.isArray(details))
        setFieldErrors(
          Object.fromEntries(
            details.filter((d) => d.path && d.message).map((d) => [d.path!, d.message!]),
          ),
        );
      setFailed(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
      setReset((n) => n + 1);
      setToken(null);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const guard = (
    <>
      <Honeypot id="website" value={website} onChange={setWebsite} />
      {siteKey ? (
        <Turnstile siteKey={siteKey} onToken={setToken} resetKey={reset} />
      ) : props.botCheck ? (
        <p className="text-[13px] text-danger-text">
          This page isn’t fully set up, so it can’t be sent just now. Call or email the business
          instead.
        </p>
      ) : null}
      {failed ? (
        <p role="alert" className="text-[13px] text-danger-text">
          {failed}
        </p>
      ) : null}
    </>
  );
  return { busy, send, guard, fieldErrors, ready: !props.botCheck || !!token };
}

// ---------- a listing's page (board 44) ----------

function ListingPage(props: AddonPublicPageProps) {
  const l = props.result as PublicListing;
  const tz = props.business.timeZone;
  const [shown, setShown] = useState(0);
  const photo = l.photos[shown];
  return (
    <Frame props={props}>
      <div data-testid="public-listing">
        <Photo
          photo={photo}
          alt={photo?.caption ?? `The front of ${l.street}`}
          className="h-[240px] md:h-[380px]"
        />
        {l.photos.length > 1 ? (
          <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
            {l.photos.map((p, i) => (
              <button
                key={p.publicFileId}
                type="button"
                aria-label={`Photo ${i + 1} of ${l.photos.length}${p.caption ? `: ${p.caption}` : ''}`}
                aria-pressed={i === shown}
                onClick={() => setShown(i)}
                className={`h-16 w-24 flex-none overflow-hidden rounded-control border-2 ${i === shown ? 'border-accent' : 'border-transparent'}`}
              >
                <Photo photo={p} alt="" className="h-full rounded-none" />
              </button>
            ))}
          </div>
        ) : null}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {l.priceCents !== null ? (
            <span className="text-[28px] font-bold tabular-nums" data-testid="public-price">
              {money(l.priceCents)}
            </span>
          ) : null}
          {l.status !== 'for_sale' ? (
            <Badge variant={l.status === 'sold' ? 'gray' : 'pending'}>
              {STATUS_WORDS[l.status]}
            </Badge>
          ) : null}
        </div>
        <h1 className="text-[19px] font-semibold">{l.street}</h1>
        {l.cityLine ? <div className="text-[14px] text-text-2">{l.cityLine}</div> : null}
        {l.facts.length ? (
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[14px] sm:grid-cols-3">
            {l.facts.map((f) => (
              <div key={f.label}>
                <dt className="text-[12.5px] text-text-3">{f.label}</dt>
                <dd className="font-medium">{f.words}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {l.openHouses.map((o) => (
          <div
            key={o.id}
            className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-card bg-card-2 px-4 py-3 text-[14px]"
          >
            <span className="font-semibold">Open house · {fmtWhen(o.startsAt, o.endsAt, tz)}</span>
            {o.signInOpen ? (
              <Link
                href={`/a/${props.site}/realestate/${l.slug}/open-house/${o.id}`}
                className="text-accent-text hover:underline"
              >
                Sign in
              </Link>
            ) : null}
          </div>
        ))}
        {l.description ? (
          <p className="mt-4 whitespace-pre-wrap text-[15px] leading-relaxed">{l.description}</p>
        ) : null}
        {l.status !== 'sold' ? <AskForm props={props} listing={l} /> : null}
        <p className="mt-5 text-[12.5px] text-text-3">
          Listed by {l.agentName ? `${l.agentName}, ` : ''}
          {props.business.name} · MLS #{l.mlsNumber} · Equal Housing Opportunity
        </p>
      </div>
    </Frame>
  );
}

function AskForm({ props, listing: l }: { props: AddonPublicPageProps; listing: PublicListing }) {
  const [name, setName] = useState('');
  const [reach, setReach] = useState('');
  const [question, setQuestion] = useState('');
  const [consent, setConsent] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const { busy, send, guard, fieldErrors, ready } = useSend(props);
  if (sent)
    return (
      <Card className="mt-5 flex items-start gap-3 p-4" data-testid="public-asked">
        <CheckCircle2 className="h-5 w-5 flex-none text-success-text" strokeWidth={1.75} />
        <p className="text-[14px]">
          Thanks, {sent}. {l.agentName ? l.agentName.split(' ')[0] : 'The agent'} will get back to
          you.
        </p>
      </Card>
    );
  const [first, ...rest] = name.trim().split(/\s+/);
  const isEmail = reach.includes('@');
  return (
    <Card className="mt-5 p-4" data-testid="public-ask">
      <h2 className="mb-3 text-[16px] font-semibold">Ask about this home</h2>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send('realestate.public.ask', {
            slug: l.slug,
            firstName: first ?? '',
            lastName: rest.join(' '),
            ...(isEmail ? { email: reach.trim() } : { phone: reach.trim() }),
            question,
            smsConsent: !isEmail && consent,
          }).then((ok) => ok && setSent(first ?? ''));
        }}
      >
        <Field label="Your name" htmlFor="ask-name" error={fieldErrors.firstName}>
          <Input
            id="ask-name"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="ask-name"
          />
        </Field>
        <Field
          label="Email or phone"
          htmlFor="ask-reach"
          error={fieldErrors.email ?? fieldErrors.phone}
        >
          <Input
            id="ask-reach"
            autoComplete="email"
            value={reach}
            onChange={(e) => setReach(e.target.value)}
            data-testid="ask-reach"
          />
        </Field>
        <Field label="Your question" htmlFor="ask-question" error={fieldErrors.question}>
          <Textarea
            id="ask-question"
            rows={3}
            maxLength={1000}
            placeholder="Is the garage wired for a car charger?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            data-testid="ask-question"
          />
        </Field>
        {reach.trim() && !isEmail ? (
          <ConsentBox props={props} checked={consent} onChange={setConsent} />
        ) : null}
        {guard}
        <Button
          type="submit"
          loading={busy}
          disabled={!ready || !name.trim() || !reach.trim() || question.trim().length < 2}
          data-testid="ask-send"
        >
          Send
        </Button>
      </form>
    </Card>
  );
}

// ---------- an open house's sign-in (board 45) ----------

function OpenHousePage(props: AddonPublicPageProps) {
  const o = props.result as PublicOpenHouse;
  const tz = props.business.timeZone;
  const now = Date.now();
  return (
    <Frame props={props}>
      <div data-testid="public-open-house">
        <Photo
          photo={o.photo ?? undefined}
          alt={`The front of ${o.street}`}
          className="h-[180px] md:h-[260px]"
        />
        <h1 className="mt-4 text-[22px] font-semibold">Welcome to {o.street}</h1>
        <p className="text-[14px] text-text-2">
          Open house · {fmtWhen(o.startsAt, o.endsAt, tz)}
          {o.hostName ? ` · with ${o.hostName}` : ''}
        </p>
        {o.cancelled ? (
          <PublicState
            icon={<CalendarX className="h-5 w-5" strokeWidth={1.75} />}
            title="This open house was cancelled"
            testId="open-house-cancelled"
          >
            Ask {props.business.name} if you’d like to see the home another time.
          </PublicState>
        ) : !o.open ? (
          <PublicState
            icon={<Clock className="h-5 w-5" strokeWidth={1.75} />}
            title={
              now < new Date(o.opensAt).getTime()
                ? `Sign-in opens at ${fmtTime(o.opensAt, tz)}`
                : 'Sign-in has closed'
            }
            testId="open-house-closed"
          >
            {now < new Date(o.opensAt).getTime()
              ? 'Come back then, or when you arrive.'
              : `Ask ${props.business.name} if you’d like to see the home.`}
          </PublicState>
        ) : (
          <SignInForm props={props} />
        )}
        <p className="mt-5 text-[12.5px] text-text-3">
          {props.business.name} · Equal Housing Opportunity
        </p>
      </div>
    </Frame>
  );
}

function SignInForm({ props }: { props: AddonPublicPageProps }) {
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [withAgent, setWithAgent] = useState<'yes' | 'no'>('no');
  const [agentName, setAgentName] = useState('');
  const [consent, setConsent] = useState(false);
  const [done, setDone] = useState(false);
  const { busy, send, guard, fieldErrors, ready } = useSend(props);
  if (done)
    return (
      <PublicState
        tone="success"
        icon={<CheckCircle2 className="h-5 w-5" strokeWidth={1.75} />}
        title={`Thanks, ${first.trim()}!`}
        testId="open-house-signed-in"
      >
        You’re signed in. Enjoy the home.
      </PublicState>
    );
  return (
    <form
      className="mt-4 flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void send('realestate.public.open_house.sign_in', {
          slug: props.params['slug'],
          openHouseId: props.params['openHouseId'],
          firstName: first,
          lastName: last,
          ...(email.trim() ? { email: email.trim() } : {}),
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          withAgent: withAgent === 'yes',
          ...(withAgent === 'yes' && agentName.trim() ? { agentName: agentName.trim() } : {}),
          smsConsent: withAgent !== 'yes' && !!phone.trim() && consent,
        }).then((ok) => ok && setDone(true));
      }}
      data-testid="open-house-form"
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="First name" htmlFor="oh-first" error={fieldErrors.firstName}>
          <Input
            id="oh-first"
            autoComplete="given-name"
            value={first}
            onChange={(e) => setFirst(e.target.value)}
            data-testid="oh-first"
          />
        </Field>
        <Field label="Last name" htmlFor="oh-last">
          <Input
            id="oh-last"
            autoComplete="family-name"
            value={last}
            onChange={(e) => setLast(e.target.value)}
          />
        </Field>
      </div>
      <Field label="Email" htmlFor="oh-email" error={fieldErrors.email}>
        <Input
          id="oh-email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          data-testid="oh-email"
        />
      </Field>
      <Field label="Phone" htmlFor="oh-phone" error={fieldErrors.phone}>
        <Input
          id="oh-phone"
          type="tel"
          autoComplete="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          data-testid="oh-phone"
        />
      </Field>
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">Are you working with an agent?</span>
        <Segmented<'yes' | 'no'>
          value={withAgent}
          onChange={setWithAgent}
          ariaLabel="Are you working with an agent?"
          options={[
            { value: 'yes', label: 'Yes', testId: 'oh-agent-yes' },
            { value: 'no', label: 'No', testId: 'oh-agent-no' },
          ]}
        />
      </div>
      {withAgent === 'yes' ? (
        <Field label="Their name and brokerage (optional)" htmlFor="oh-agent">
          <Input id="oh-agent" value={agentName} onChange={(e) => setAgentName(e.target.value)} />
        </Field>
      ) : phone.trim() ? (
        <ConsentBox props={props} checked={consent} onChange={setConsent} />
      ) : null}
      {guard}
      <Button
        type="submit"
        loading={busy}
        disabled={!ready || !first.trim() || (!email.trim() && !phone.trim())}
        data-testid="oh-sign-in"
      >
        Sign in
      </Button>
    </form>
  );
}

// ---------- asking for a showing (board 72) ----------

/** "Fri, Oct 9" in the listing's time zone. */
const dayOf = (iso: string, tz: string) =>
  new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: tz,
  }).format(new Date(iso));

function ShowingRequestPage(props: AddonPublicPageProps) {
  const t = props.result as PublicShowingTimes;
  const tz = t.timeZone || props.business.timeZone;
  const [picked, setPicked] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [brokerage, setBrokerage] = useState('');
  const [license, setLicense] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [done, setDone] = useState<'requested' | 'confirmed' | null>(null);
  const { busy, send, guard, fieldErrors, ready } = useSend(props);
  const days = new Map<string, string[]>();
  for (const at of t.times) days.set(dayOf(at, tz), [...(days.get(dayOf(at, tz)) ?? []), at]);
  const [day, setDay] = useState<string>(() => [...days.keys()][0] ?? '');
  return (
    <Frame props={props}>
      <div data-testid="public-showing">
        <h1 className="text-[22px] font-semibold">Request a showing</h1>
        <p className="text-[14px] text-text-2">
          {t.street} · for buyers’ agents.{' '}
          {t.confirm === 'seller'
            ? 'The seller says yes, then you get the access instructions.'
            : 'It’s confirmed straight away, and the access instructions come before it.'}
        </p>
        {done ? (
          <PublicState
            tone="success"
            icon={<CheckCircle2 className="h-5 w-5" strokeWidth={1.75} />}
            title={done === 'confirmed' ? 'It’s confirmed' : 'Asked'}
            testId="showing-requested"
          >
            {picked ? `${dayOf(picked, tz)} at ${fmtTime(picked, tz)}. ` : ''}
            {done === 'confirmed'
              ? 'The access instructions come by email before it.'
              : 'You’ll hear by email once the seller answers, with the access instructions.'}
          </PublicState>
        ) : !t.open ? (
          <PublicState
            icon={<CalendarX className="h-5 w-5" strokeWidth={1.75} />}
            title="Showings aren’t taken here just now"
            testId="showing-closed"
          >
            {t.closedWords ?? `Ask ${props.business.name} for a time.`}
          </PublicState>
        ) : (
          <form
            className="mt-4 flex flex-col gap-3.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!picked) return;
              void send('realestate.public.request_showing', {
                slug: props.params['slug'],
                startsAt: picked,
                agentName: name,
                brokerage,
                license,
                email,
                ...(phone.trim() ? { phone: phone.trim() } : {}),
              }).then((ok) => ok && setDone(t.confirm === 'auto' ? 'confirmed' : 'requested'));
            }}
            data-testid="showing-form"
          >
            <div>
              <div className="mb-1.5 text-[13px] font-medium">When</div>
              {t.times.length === 0 ? (
                <p className="text-[13.5px] text-text-2">
                  No open times in the next two weeks. Ask {props.business.name} for one.
                </p>
              ) : (
                <>
                  <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="tablist">
                    {[...days.keys()].map((d) => (
                      <button
                        key={d}
                        type="button"
                        role="tab"
                        aria-selected={day === d}
                        onClick={() => setDay(d)}
                        className={`h-9 flex-none rounded-full border px-3 text-[13px] ${
                          day === d
                            ? 'border-accent-soft bg-accent-soft font-medium text-accent-text'
                            : 'border-border-strong bg-card text-text-2'
                        }`}
                        data-testid="showing-day"
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-1.5 sm:grid-cols-5">
                    {(days.get(day) ?? []).map((at) => (
                      <button
                        key={at}
                        type="button"
                        aria-pressed={picked === at}
                        onClick={() => setPicked(at)}
                        className={`h-9 rounded-control border px-2 text-[13.5px] ${
                          picked === at
                            ? 'border-accent bg-accent text-on-solid'
                            : 'border-border-strong bg-card hover:bg-card-2'
                        }`}
                        data-testid="showing-time"
                      >
                        {fmtTime(at, tz)}
                      </button>
                    ))}
                  </div>
                </>
              )}
              {fieldErrors.startsAt ? (
                <p className="mt-1 text-[12.5px] text-danger-text">{fieldErrors.startsAt}</p>
              ) : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Your name" htmlFor="sh-name" error={fieldErrors.agentName}>
                <Input
                  id="sh-name"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  data-testid="showing-name"
                />
              </Field>
              <Field label="Brokerage" htmlFor="sh-brokerage" error={fieldErrors.brokerage}>
                <Input
                  id="sh-brokerage"
                  autoComplete="organization"
                  value={brokerage}
                  onChange={(e) => setBrokerage(e.target.value)}
                  data-testid="showing-brokerage"
                />
              </Field>
              <Field label="License number" htmlFor="sh-license" error={fieldErrors.license}>
                <Input
                  id="sh-license"
                  value={license}
                  onChange={(e) => setLicense(e.target.value)}
                  data-testid="showing-license"
                />
              </Field>
              <Field label="Email" htmlFor="sh-email" error={fieldErrors.email}>
                <Input
                  id="sh-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  data-testid="showing-email"
                />
              </Field>
              <Field label="Mobile (optional)" htmlFor="sh-phone" error={fieldErrors.phone}>
                <Input
                  id="sh-phone"
                  type="tel"
                  autoComplete="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </Field>
            </div>
            <p className="text-[12.5px] text-text-3">
              Times are the seller’s open ones. Your details go only to the listing’s agent and the
              seller.
            </p>
            {guard}
            <Button
              type="submit"
              loading={busy}
              disabled={!ready || !picked}
              data-testid="showing-ask"
            >
              {picked ? `Ask for ${dayOf(picked, tz)} at ${fmtTime(picked, tz)}` : 'Pick a time'}
            </Button>
          </form>
        )}
        <p className="mt-5 text-[12.5px] text-text-3">
          {props.business.name} · Equal Housing Opportunity
        </p>
      </div>
    </Frame>
  );
}

// ---------- how the showing went (board 73) ----------

function ShowingFeedbackPage(props: AddonPublicPageProps) {
  const f = props.result as PublicShowingFeedbackForm;
  const tz = props.business.timeZone;
  const [interest, setInterest] = useState<number | null>(null);
  const [liked, setLiked] = useState('');
  const [pause, setPause] = useState('');
  const [price, setPrice] = useState<'low' | 'right' | 'high' | null>(null);
  const [done, setDone] = useState(f.answered);
  const { busy, send, guard, fieldErrors, ready } = useSend(props);
  return (
    <Frame props={props}>
      <div data-testid="public-showing-feedback">
        <h1 className="text-[22px] font-semibold">How did {f.street} show?</h1>
        <p className="text-[14px] text-text-2">
          Your showing {dayOf(f.startsAt, tz)} at {fmtTime(f.startsAt, tz)}. Two minutes; it goes to
          the listing’s agent.
        </p>
        {done ? (
          <PublicState
            tone="success"
            icon={<CheckCircle2 className="h-5 w-5" strokeWidth={1.75} />}
            title="Thank you"
            testId="showing-feedback-sent"
          >
            It’s with the listing’s agent.
          </PublicState>
        ) : (
          <form
            className="mt-4 flex flex-col gap-3.5"
            onSubmit={(e) => {
              e.preventDefault();
              void send('realestate.public.showing_feedback', {
                slug: props.params['slug'],
                token: props.params['token'],
                ...(interest ? { interest } : {}),
                ...(liked.trim() ? { liked: liked.trim() } : {}),
                ...(pause.trim() ? { pause: pause.trim() } : {}),
                ...(price ? { price } : {}),
              }).then((ok) => ok && setDone(true));
            }}
            data-testid="showing-feedback-form"
          >
            <div>
              <div className="mb-1.5 text-[13px] font-medium">Your buyers’ interest</div>
              <div className="flex gap-1.5">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={interest === n}
                    onClick={() => setInterest(n)}
                    className={`h-10 w-10 rounded-control border text-[15px] ${
                      interest === n
                        ? 'border-accent bg-accent font-semibold text-on-solid'
                        : 'border-border-strong bg-card'
                    }`}
                    data-testid={`feedback-interest-${n}`}
                  >
                    {n}
                  </button>
                ))}
              </div>
              {fieldErrors.interest ? (
                <p className="mt-1 text-[12.5px] text-danger-text">{fieldErrors.interest}</p>
              ) : null}
            </div>
            <Field label="What they liked" htmlFor="fb-liked">
              <Textarea
                id="fb-liked"
                rows={2}
                value={liked}
                onChange={(e) => setLiked(e.target.value)}
                data-testid="feedback-liked"
              />
            </Field>
            <Field label="What gave them pause" htmlFor="fb-pause">
              <Textarea
                id="fb-pause"
                rows={2}
                value={pause}
                onChange={(e) => setPause(e.target.value)}
              />
            </Field>
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">The price</span>
              <Segmented<'low' | 'right' | 'high'>
                value={price ?? ('' as 'low')}
                onChange={setPrice}
                ariaLabel="The price"
                options={[
                  { value: 'low', label: 'Low' },
                  { value: 'right', label: 'About right' },
                  { value: 'high', label: 'High' },
                ]}
              />
            </div>
            {guard}
            <Button
              type="submit"
              loading={busy}
              disabled={!ready || !interest}
              data-testid="feedback-send"
            >
              Send
            </Button>
          </form>
        )}
      </div>
    </Frame>
  );
}
