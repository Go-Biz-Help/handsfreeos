'use client';
/**
 * Settings → Texting: RCS (0103).
 *
 * **One setting for the whole business, nothing in the composer.** Once a sender is connected and the carriers
 * approve it, every text goes RCS first — the business's name and logo at the top, pictures, buttons to tap —
 * and a phone that can't show RCS gets the same message as an SMS or MMS by itself. So this card is the only
 * place RCS is set up; the inbox just says which way each text went.
 *
 * **Asked for and paid for here, made by HandsFreeOS (0104).** Twilio onboards RCS senders only in its console,
 * in the business's Twilio subaccount, which only HandsFreeOS can open. So a business tells us what its sender
 * should show, sees exactly what it costs (the carriers' and Aegis's fees passed on at cost, and ours), and pays
 * at Stripe; a support ticket opens, HandsFreeOS makes the sender and connects it here. The card lists the
 * senders it finds in the account, so connecting one is a click, by us or by them.
 */
import {
  formatDate,
  formatUtcDate,
  money,
  RCS_FEE_LINES,
  RCS_FIRST_YEAR_CENTS,
  RCS_YEARLY_CENTS,
  RcsBrand,
  rcsSenderIdInput,
} from '@hfos/core';
import {
  CircleAlert,
  Clock,
  CreditCard,
  Info,
  MessageSquareText,
  RefreshCw,
  Unplug,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { ChannelIcon } from '@/components/inbox/bits';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { PhoneNumberInfo, PhoneSetupStatus } from '@/lib/api/types';
import { findRcsSenders, type FoundRcsSender } from '@/lib/api/worker';
import { cn } from '@/lib/utils';
import { SetRow } from './set-row';

type Sender = NonNullable<PhoneSetupStatus['rcsSender']>;
type Request = NonNullable<PhoneSetupStatus['rcsRequest']>;

/** What the request form starts from: what the business already told the carriers for texting. */
export interface RcsPrefill {
  readonly website: string;
  readonly privacyUrl: string;
  readonly termsUrl: string;
  readonly phone: string;
  readonly email: string;
}

/** The badge beside the card's title: where RCS stands for the business, in a word or two. */
/** Paid for, and the year paid for not over: renewing, or stopped and running out its year. */
const paidUp = (r: Request): boolean =>
  r.status === 'paid' &&
  (!r.stoppedAt || (!!r.paidThrough && new Date(r.paidThrough).getTime() > Date.now()));

function badgeOf(s: Sender | null, r: Request | null): { label: string; variant: BadgeVariant } {
  if (!s || s.status === 'failed') {
    if (r && paidUp(r)) return { label: 'Being set up', variant: 'pending' };
    if (r?.status === 'pending' || r?.status === 'open')
      return { label: 'Waiting for payment', variant: 'gray' };
  }
  if (!s) return { label: 'Off', variant: 'gray' };
  switch (s.status) {
    case 'connecting':
      return { label: 'Connecting', variant: 'pending' };
    case 'in_review':
      return { label: 'In review', variant: 'pending' };
    case 'active':
      if (s.sending) return { label: 'On', variant: 'ok' };
      return s.enabled
        ? { label: 'Finishing setup', variant: 'pending' }
        : { label: 'Paused', variant: 'gray' };
    case 'offline':
      return { label: 'Offline', variant: 'danger' };
    case 'failed':
      return { label: 'Not connected', variant: 'danger' };
    case 'disconnecting':
      return { label: 'Disconnecting', variant: 'gray' };
    default:
      return { label: 'Off', variant: 'gray' };
  }
}

const FOUND_STATE: Record<FoundRcsSender['state'], string> = {
  online: 'Approved',
  in_review: 'In review',
  offline: 'Offline',
  failed: 'Not approved',
};

/** A business's name for a line: "Main line · (713) 555-0100", or the number alone. */
const lineName = (n: PhoneNumberInfo) => (n.label ? `${n.label} · ${n.display}` : n.display);

/** Where a customer's first RCS message starts its thread, when the business has more than one line. */
function LineSelect({
  id,
  numbers,
  value,
  onChange,
  disabled,
}: {
  id?: string;
  numbers: readonly PhoneNumberInfo[];
  value: string | null;
  onChange: (next: string | null) => void;
  disabled?: boolean;
}) {
  const fallback = numbers.find((n) => n.isDefault) ?? numbers[0];
  return (
    <Select
      id={id}
      selectSize="sm"
      aria-label="New RCS conversations start on"
      className="w-[240px] max-w-full"
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value || null)}
      data-testid="rcs-line"
    >
      <option value="">
        {fallback ? `The default number (${fallback.display})` : 'The default number'}
      </option>
      {numbers.map((n) => (
        <option key={n.id} value={n.id}>
          {lineName(n)}
        </option>
      ))}
    </Select>
  );
}

/**
 * Connect a sender: the ones found in the business's Twilio account to pick from, or its id typed in. The same
 * form tries again after a sender could not be connected, starting from the id that failed.
 */
function ConnectForm({
  workspaceId,
  lines,
  retryId,
  intro,
  onConnected,
}: {
  workspaceId: string;
  lines: readonly PhoneNumberInfo[];
  retryId: string | null;
  /** What to say above it: why there is something to connect, and who made it. */
  intro: ReactNode;
  onConnected: () => void;
}) {
  const inputId = useId();
  const lineId = useId();
  const [senderId, setSenderId] = useState(retryId ?? '');
  const [line, setLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [found, setFound] = useState<{
    accountSid: string | null;
    senders: FoundRcsSender[];
  } | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  // What is already in the business's Twilio account, looked up once when the form opens.
  useEffect(() => {
    let cancelled = false;
    findRcsSenders(workspaceId)
      .then((r) => {
        if (cancelled) return;
        setFound(r);
        // One sender and nothing typed: that is the one.
        if (r.senders.length === 1) setSenderId((v) => v || r.senders[0]!.senderId);
      })
      .catch((e) => {
        if (!cancelled) setLookupError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  async function connect(e: FormEvent) {
    e.preventDefault();
    const parsed = rcsSenderIdInput.safeParse(senderId);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter the sender’s id from Twilio.');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/rcs_sender.connect', {
          body: { workspaceId, senderId: parsed.data, ...(line ? { phoneNumberId: line } : {}) },
        }),
      );
      toast.success('Connecting your RCS sender…');
      onConnected();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const senders = found?.senders ?? [];
  return (
    <form onSubmit={(e) => void connect(e)} className="mt-4 flex flex-col gap-3.5" noValidate>
      {intro}
      {found?.accountSid ? (
        <p className="text-xs text-text-3">
          Twilio account{' '}
          <span className="font-mono" data-testid="rcs-account">
            {found.accountSid}
          </span>
        </p>
      ) : null}

      {senders.length ? (
        <div className="flex flex-col gap-1.5" data-testid="rcs-found">
          <span className="text-[13px] font-medium">In your Twilio account</span>
          {senders.map((s) => (
            <button
              key={s.sid}
              type="button"
              onClick={() => setSenderId(s.senderId)}
              aria-pressed={senderId === s.senderId}
              className={cn(
                'flex items-center justify-between gap-3 rounded-[10px] border px-3 py-2 text-left transition-colors',
                senderId === s.senderId
                  ? 'border-accent bg-accent-soft'
                  : 'border-border hover:border-border-strong',
              )}
              data-testid="rcs-found-sender"
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-[13px] font-medium">
                  {s.displayName ?? s.senderId}
                </span>
                <span className="truncate font-mono text-xs text-text-3">{s.senderId}</span>
              </span>
              <Badge
                variant={
                  s.state === 'online' ? 'ok' : s.state === 'in_review' ? 'pending' : 'danger'
                }
              >
                {FOUND_STATE[s.state]}
              </Badge>
            </button>
          ))}
        </div>
      ) : found ? (
        <p className="text-xs text-text-3" data-testid="rcs-found-none">
          No RCS senders in your Twilio account yet. Once it’s made, it shows up here.
        </p>
      ) : lookupError ? (
        <p className="text-xs text-text-3">
          Couldn’t look in your Twilio account ({lookupError}). You can still type the sender’s id.
        </p>
      ) : null}

      <Field
        label="Sender id"
        htmlFor={inputId}
        hint="From the sender’s page in Twilio, like lonestar_hvac_agent. With or without rcs: in front."
        error={error}
      >
        <Input
          id={inputId}
          value={senderId}
          onChange={(e) => setSenderId(e.target.value)}
          placeholder="lonestar_hvac_agent"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={!!error || undefined}
          data-testid="rcs-sender-id"
        />
      </Field>
      {lines.length > 1 ? (
        <Field
          label="New RCS conversations start on"
          htmlFor={lineId}
          hint="When a customer messages your RCS sender first, their conversation goes with this number."
        >
          <LineSelect id={lineId} numbers={lines} value={line} onChange={setLine} />
        </Field>
      ) : null}
      <div>
        <Button type="submit" loading={saving} data-testid="rcs-connect">
          Connect RCS sender
        </Button>
      </div>
    </form>
  );
}

/** What RCS costs, line by line: whose fee each is, and what is passed on at cost. Core's list, so it never drifts. */
function FeeTable() {
  return (
    <div className="overflow-hidden rounded-[10px] border border-border" data-testid="rcs-fees">
      <ul className="divide-y divide-border">
        {RCS_FEE_LINES.map((l) => (
          <li key={l.key} className="flex items-start justify-between gap-3 px-3 py-2.5">
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium">
                {l.name}
                {l.passedOn ? <Badge variant="gray">Passed on at cost</Badge> : null}
              </span>
              <span className="block text-xs text-text-3">{l.detail}</span>
            </span>
            <span className="whitespace-nowrap text-[13px] font-medium">
              {money(l.cents)}
              <span className="font-normal text-text-3">
                {l.when === 'yearly' ? ' a year' : ''}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-0.5 bg-card-2 px-3 py-2.5 text-[13px]">
        <div className="flex justify-between gap-3 font-semibold">
          <span>First year</span>
          <span data-testid="rcs-first-year">{money(RCS_FIRST_YEAR_CENTS)}</span>
        </div>
        <div className="flex justify-between gap-3 text-text-2">
          <span>Each year after</span>
          <span data-testid="rcs-yearly">{money(RCS_YEARLY_CENTS)}</span>
        </div>
      </div>
    </div>
  );
}

type BrandForm = {
  displayName: string;
  description: string;
  color: string;
  website: string;
  privacyUrl: string;
  termsUrl: string;
  phone: string;
  email: string;
  logoUrl: string;
  notes: string;
};

/** A link typed without its scheme still counts: "example.com" is "https://example.com". */
const withScheme = (v: string) => {
  const t = v.trim();
  return !t || /^https?:\/\//i.test(t) ? t : `https://${t}`;
};

/**
 * Ask for RCS: what the sender should show, what it costs, and Pay. Checked here with the same rules the command
 * uses (core's RcsBrand), so a mistake is pointed at before anybody reaches the payment page.
 */
function RequestForm({
  workspaceId,
  businessName,
  prefill,
  onSent,
}: {
  workspaceId: string;
  businessName: string;
  prefill: RcsPrefill;
  onSent: () => void;
}) {
  const id = useId();
  const [form, setForm] = useState<BrandForm>({
    displayName: businessName.slice(0, 40),
    description: '',
    color: '#1A73E8',
    website: prefill.website,
    privacyUrl: prefill.privacyUrl,
    termsUrl: prefill.termsUrl,
    phone: prefill.phone,
    email: prefill.email,
    logoUrl: '',
    notes: '',
  });
  const [errors, setErrors] = useState<Partial<Record<keyof BrandForm, string>>>({});
  const [saving, setSaving] = useState(false);
  const set = (k: keyof BrandForm) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function pay(e: FormEvent) {
    e.preventDefault();
    const parsed = RcsBrand.safeParse({
      ...form,
      website: withScheme(form.website),
      privacyUrl: withScheme(form.privacyUrl),
      termsUrl: withScheme(form.termsUrl),
      logoUrl: form.logoUrl.trim() ? withScheme(form.logoUrl) : null,
    });
    if (!parsed.success) {
      const next: Partial<Record<keyof BrandForm, string>> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof BrandForm | undefined;
        if (key && !next[key]) next[key] = issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/rcs_request.submit', {
          body: { workspaceId, brand: parsed.data },
        }),
      );
      if (out.checkoutUrl) window.location.assign(out.checkoutUrl);
      else onSent();
    } catch (err) {
      toast.error(errorMessage(err));
      setSaving(false);
    }
  }

  const field = (
    key: keyof BrandForm,
    label: string,
    hint: string,
    extra: { placeholder?: string; type?: string; autoComplete?: string } = {},
  ) => (
    <Field label={label} htmlFor={`${id}-${key}`} hint={hint} error={errors[key]}>
      <Input
        id={`${id}-${key}`}
        value={form[key]}
        onChange={set(key)}
        aria-invalid={!!errors[key] || undefined}
        data-testid={`rcs-brand-${key}`}
        {...extra}
      />
    </Field>
  );

  return (
    <form onSubmit={(e) => void pay(e)} className="mt-4 flex flex-col gap-3.5" noValidate>
      <p className="text-[13px] text-text-2">
        We make your RCS sender for you. Tell us what customers should see, pay for the first year,
        and we’ll take it from there. The carriers review every sender, which can take a few weeks,
        and your texts keep going as they do now until it’s approved.
      </p>
      <div className="grid gap-3.5 md:grid-cols-2">
        {field(
          'displayName',
          'Name customers see',
          'At the top of your texts. Up to 40 characters.',
        )}
        <Field
          label="Brand color"
          htmlFor={`${id}-color`}
          hint="Your buttons and header are drawn in it."
          error={errors.color}
        >
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="h-9 w-9 shrink-0 rounded-control border border-border"
              style={{ background: /^#[0-9a-f]{6}$/i.test(form.color) ? form.color : undefined }}
            />
            <Input
              id={`${id}-color`}
              value={form.color}
              onChange={set('color')}
              placeholder="#1A73E8"
              aria-invalid={!!errors.color || undefined}
              data-testid="rcs-brand-color"
            />
          </div>
        </Field>
      </div>
      {field(
        'description',
        'What your business does',
        'One sentence, shown on your profile. Up to 100 characters.',
        { placeholder: 'Heating and cooling repair in Houston.' },
      )}
      <div className="grid gap-3.5 md:grid-cols-2">
        {field('website', 'Website', 'The carriers check it.', { placeholder: 'example.com' })}
        {field('logoUrl', 'Logo (optional)', 'A link to it. If you don’t have one, we’ll ask.', {
          placeholder: 'example.com/logo.png',
        })}
        {field('privacyUrl', 'Privacy policy', 'A page the carriers can open.', {
          placeholder: 'example.com/privacy',
        })}
        {field('termsUrl', 'Terms of service', 'A page the carriers can open.', {
          placeholder: 'example.com/terms',
        })}
        {field('phone', 'Phone on your profile', 'Where customers can call you.', {
          autoComplete: 'tel',
        })}
        {field('email', 'Email on your profile', 'Where customers can write to you.', {
          type: 'email',
          autoComplete: 'email',
        })}
      </div>
      {field('notes', 'Anything else (optional)', 'For our team, not shown to customers.')}

      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">What it costs</span>
        <FeeTable />
        <p className="text-xs text-text-3">
          The carriers’ and Aegis’s fees are what they charge us, with nothing added. The yearly{' '}
          {money(RCS_YEARLY_CENTS)} is charged to the same card a year from now, and you can stop it
          renewing here any time.
        </p>
      </div>
      <div>
        <Button type="submit" loading={saving} data-testid="rcs-pay">
          <CreditCard className="h-3.5 w-3.5" strokeWidth={1.5} />
          Pay {money(RCS_FIRST_YEAR_CENTS)} and send
        </Button>
      </div>
    </form>
  );
}

/** Paid through when, what renews, and the way to stop it. */
function RenewalRow({ workspaceId, request }: { workspaceId: string; request: Request }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  // Paying a refused renewal with another card: to the page once it's made, or waiting for Stripe's word after.
  const [paying, setPaying] = useState(false);
  const [back, setBack] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('rcs') === 'renewed') setBack(true);
  }, []);
  const refused = !!request.renewalProblem;
  useEffect(() => {
    if (paying && request.renewalCheckoutUrl) window.location.assign(request.renewalCheckoutUrl);
  }, [paying, request.renewalCheckoutUrl]);
  useEffect(() => {
    if (!refused || !(paying || back)) return;
    const timer = setInterval(() => router.refresh(), 2500);
    return () => clearInterval(timer);
  }, [refused, paying, back, router]);
  const until = request.paidThrough ? formatUtcDate(new Date(request.paidThrough)) : '';
  async function payNow() {
    setPaying(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/rcs_request.pay_renewal', { body: { workspaceId } }),
      );
      if (out.checkoutUrl) window.location.assign(out.checkoutUrl);
      else router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
      setPaying(false);
    }
  }
  async function stop() {
    setBusy(true);
    try {
      unwrap(await apiBrowser().POST('/v1/commands/rcs_request.cancel', { body: { workspaceId } }));
      toast.success('RCS won’t renew');
      setConfirm(false);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  if (request.stoppedAt)
    return (
      <p className="mt-3 text-xs text-text-3" data-testid="rcs-renewal">
        Paid through {until}. It won’t renew.
      </p>
    );
  return (
    <div className="mt-3" data-testid="rcs-renewal">
      {refused ? (
        <Callout
          tone="warning"
          icon={CircleAlert}
          className="mb-2 px-3 py-2.5"
          data-testid="rcs-renewal-refused"
          action={
            back ? null : (
              <Button
                size="sm"
                variant="secondary"
                loading={paying}
                onClick={() => void payNow()}
                data-testid="rcs-renewal-pay"
              >
                <CreditCard className="h-3.5 w-3.5" strokeWidth={1.5} />
                Pay {money(request.yearlyCents)} with another card
              </Button>
            )
          }
        >
          {back
            ? 'Confirming your payment with Stripe…'
            : `We couldn’t take this year’s ${money(request.yearlyCents)}: ${request.renewalProblem} RCS stays on meanwhile. The card you pay with now is the one we charge next year.`}
        </Callout>
      ) : null}
      {confirm ? (
        <div className="flex flex-wrap items-center gap-2 rounded-[10px] bg-card-2 px-3 py-2.5">
          <span className="min-w-[200px] flex-1 text-[13px] text-text-2">
            Stop RCS renewing? It stays on until {until}, and nothing more is charged.
          </span>
          <Button variant="ghost" size="sm" onClick={() => setConfirm(false)}>
            Keep it
          </Button>
          <Button
            variant="danger"
            size="sm"
            loading={busy}
            onClick={() => void stop()}
            data-testid="rcs-stop-yes"
          >
            Stop renewing
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-xs text-text-3">
          <span className="flex-1">
            Paid through {until}.{' '}
            {request.renews ? `Renews for ${money(request.yearlyCents)} a year on that day.` : ''}
          </span>
          <Button variant="ghost" size="sm" onClick={() => setConfirm(true)} data-testid="rcs-stop">
            Stop renewing
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * A request waiting on its payment page: being made (a few seconds), or made and not paid yet. Coming back from
 * Stripe paid, the card waits here for Stripe's own word, which is the only one believed.
 */
function PayPanel({
  workspaceId,
  request,
  returning,
}: {
  workspaceId: string;
  request: Request;
  returning: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function startOver() {
    setBusy(true);
    try {
      unwrap(await apiBrowser().POST('/v1/commands/rcs_request.cancel', { body: { workspaceId } }));
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  }
  if (request.status === 'pending' || returning)
    return (
      <div
        className="mt-4 flex items-center gap-3 text-[13.5px] text-text-2"
        role="status"
        data-testid="rcs-pay-waiting"
      >
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        {returning ? 'Confirming your payment with Stripe…' : 'Making your payment page…'}
      </div>
    );
  return (
    <div className="mt-4 flex flex-col gap-3" data-testid="rcs-pay-open">
      <p className="text-[13px] text-text-2">
        Your payment page is ready: {money(request.firstYearCents)} for the first year, then{' '}
        {money(request.yearlyCents)} a year.
      </p>
      <div className="flex flex-wrap gap-2">
        {request.checkoutUrl ? (
          <Button
            onClick={() => window.location.assign(request.checkoutUrl!)}
            data-testid="rcs-pay-go"
          >
            <CreditCard className="h-3.5 w-3.5" strokeWidth={1.5} />
            Pay {money(request.firstYearCents)}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          loading={busy}
          onClick={() => void startOver()}
          data-testid="rcs-start-over"
        >
          Change the details
        </Button>
      </div>
    </div>
  );
}

/** What is going on with a connected sender right now, when there is something to say. */
function stateNote(
  s: Sender,
): { tone: 'info' | 'warning' | 'danger' | 'neutral'; text: string } | null {
  switch (s.status) {
    case 'connecting':
      return { tone: 'neutral', text: 'Checking the sender with Twilio. This takes a moment.' };
    case 'in_review':
      return {
        tone: 'info',
        text: 'The carriers are reviewing your sender. This can take a few weeks. Texts keep going as SMS and MMS until then, and we’ll email you when RCS is on.',
      };
    case 'offline':
      return {
        tone: 'warning',
        text: `Twilio says this sender is offline${s.providerStatus ? ` (${s.providerStatus})` : ''}. Texts go as SMS and MMS until it’s back. Check the sender in the Twilio console, then check again here.`,
      };
    case 'disconnecting':
      return {
        tone: 'neutral',
        text: 'Taking the sender off your texting. Texts go as SMS and MMS.',
      };
    case 'active':
      if (!s.enabled)
        return {
          tone: 'neutral',
          text: 'RCS is paused. Every text goes as SMS or MMS, and the sender stays connected.',
        };
      if (!s.sending)
        return {
          tone: 'neutral',
          text: 'Approved. Adding the sender to your texting, which takes a moment.',
        };
      return null;
    default:
      return null;
  }
}

/** Settings → Texting's RCS card: connect a sender, follow its review, pause it, or let it go. */
export function RcsCard({
  workspaceId,
  businessName,
  sender,
  request,
  prefill,
  numbers,
  canManage,
}: {
  workspaceId: string;
  businessName: string;
  sender: Sender | null;
  /** Asking HandsFreeOS for a sender and paying for it (0104). Null for people who can't manage channels. */
  request: Request | null;
  prefill: RcsPrefill;
  numbers: readonly PhoneNumberInfo[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<'refresh' | 'disconnect' | 'enabled' | 'line' | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [connectOwn, setConnectOwn] = useState(false);
  // Pressed Pay, or back from Stripe: go to the page once it's made, or wait for Stripe's word that it's paid.
  const [goPay, setGoPay] = useState(false);
  const [returning, setReturning] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('rcs') === 'paid') setReturning(true);
  }, []);
  const asking = request?.status === 'pending' || request?.status === 'open';
  const paidFor = request !== null && paidUp(request);
  const confirming = returning && request?.status === 'open';
  useEffect(() => {
    if (goPay && request?.status === 'open' && request.checkoutUrl)
      window.location.assign(request.checkoutUrl);
  }, [goPay, request]);
  // The page takes seconds to make, and Stripe's word takes seconds to arrive: look again every few.
  useEffect(() => {
    if (request?.status !== 'pending' && !confirming) return;
    const timer = setInterval(() => router.refresh(), 2500);
    return () => clearInterval(timer);
  }, [request?.status, confirming, router]);
  const badge = badgeOf(sender, request);
  const lines = numbers.filter((n) => n.status === 'active');
  const connected = sender && sender.status !== 'failed';
  const note = connected ? stateNote(sender) : null;
  const settled = connected && sender.status !== 'connecting' && sender.status !== 'disconnecting';
  // Connecting and letting go take seconds: look again every few, in case the live channel is down.
  const moving = sender?.status === 'connecting' || sender?.status === 'disconnecting';
  useEffect(() => {
    if (!moving) return;
    const timer = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(timer);
  }, [moving, router]);

  async function act(kind: 'refresh' | 'disconnect', success: string): Promise<void> {
    setBusy(kind);
    try {
      if (kind === 'refresh')
        unwrap(
          await apiBrowser().POST('/v1/commands/rcs_sender.refresh', { body: { workspaceId } }),
        );
      else
        unwrap(
          await apiBrowser().POST('/v1/commands/rcs_sender.disconnect', { body: { workspaceId } }),
        );
      toast.success(success);
      setConfirmOff(false);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function update(
    change: { enabled?: boolean; phoneNumberId?: string | null },
    success: string,
  ): Promise<void> {
    setBusy(change.enabled !== undefined ? 'enabled' : 'line');
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/rcs_sender.update', {
          body: { workspaceId, ...change },
        }),
      );
      toast.success(success);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="p-6" id="rcs" data-testid="rcs-card" data-status={sender?.status ?? 'none'}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight">RCS messaging</h2>
        <Badge variant={badge.variant} data-testid="rcs-badge">
          {badge.label}
        </Badge>
      </div>
      <p className="mt-1 text-[13px] text-text-2">
        Phones that support RCS get your texts with your name and logo, bigger pictures, and buttons
        to tap. Other phones still get a regular text. It all stays in the same conversations, and
        each message shows how it went.
      </p>

      {sender?.status === 'failed' ? (
        <Callout tone="danger" icon={CircleAlert} className="mt-4 px-3 py-2.5">
          <span data-testid="rcs-error">
            Couldn’t connect <span className="font-mono text-xs">{sender.senderId}</span>
            {sender.lastError ? `: ${sender.lastError}` : '.'}
          </span>
        </Callout>
      ) : null}

      {connected ? (
        <>
          <div className="mt-4 flex items-center gap-3.5">
            <ChannelIcon icon={MessageSquareText} size={44} />
            <div className="min-w-0">
              <div className="truncate text-[15px] font-medium" data-testid="rcs-name">
                {sender.displayName ?? businessName}
              </div>
              <div className="truncate text-xs text-text-3">
                <span className="font-mono">{sender.senderId}</span>
                {sender.connectedAt ? ` · approved ${formatDate(sender.connectedAt)}` : ''}
              </div>
            </div>
          </div>
          {note ? (
            <Callout
              tone={note.tone}
              icon={note.tone === 'warning' ? CircleAlert : note.tone === 'info' ? Clock : Info}
              className="mt-3.5 px-3 py-2.5"
              data-testid="rcs-note"
            >
              {note.text}
            </Callout>
          ) : null}
          {sender.status === 'offline' && sender.lastError ? (
            <p className="mt-2 text-xs text-text-3">{sender.lastError}</p>
          ) : null}
          {settled && canManage ? (
            <div className="mt-2">
              <SetRow
                first
                center
                setting="texting.rcs_send"
                title="Send as RCS when the phone supports it"
                description="Off sends every text as SMS or MMS. The sender stays connected."
              >
                <Switch
                  checked={sender.enabled}
                  label="Send as RCS"
                  disabled={busy !== null}
                  testId="rcs-enabled"
                  onChange={(on) =>
                    void update({ enabled: on }, on ? 'RCS is back on' : 'RCS paused')
                  }
                />
              </SetRow>
              {lines.length > 1 ? (
                <SetRow
                  setting="texting.rcs_line"
                  title="New RCS conversations start on"
                  description="When a customer messages your RCS sender first, their conversation goes with this number."
                >
                  <LineSelect
                    numbers={lines}
                    value={sender.phoneNumberId}
                    disabled={busy !== null}
                    onChange={(id) => void update({ phoneNumberId: id }, 'Saved')}
                  />
                </SetRow>
              ) : null}
            </div>
          ) : null}
          {settled && canManage ? (
            confirmOff ? (
              <div
                className="mt-3 flex flex-wrap items-center gap-2 rounded-[10px] bg-card-2 px-3 py-2.5"
                data-testid="rcs-disconnect-confirm"
              >
                <span className="min-w-[200px] flex-1 text-[13px] text-text-2">
                  Disconnect RCS? Texts go as SMS and MMS again. The sender stays in your Twilio
                  account.
                </span>
                <Button variant="ghost" size="sm" onClick={() => setConfirmOff(false)}>
                  Keep it
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  loading={busy === 'disconnect'}
                  onClick={() => void act('disconnect', 'RCS disconnected')}
                  data-testid="rcs-disconnect-yes"
                >
                  Disconnect
                </Button>
              </div>
            ) : (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  loading={busy === 'refresh'}
                  disabled={busy !== null}
                  onClick={() => void act('refresh', 'Checking with Twilio…')}
                  data-testid="rcs-refresh"
                >
                  {busy === 'refresh' ? null : (
                    <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.5} />
                  )}
                  Check now
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => setConfirmOff(true)}
                  data-testid="rcs-disconnect"
                >
                  <Unplug className="h-3.5 w-3.5" strokeWidth={1.5} />
                  Disconnect
                </Button>
              </div>
            )
          ) : null}
        </>
      ) : canManage && paidFor ? (
        <>
          <Callout
            tone="info"
            icon={Clock}
            className="mt-4 px-3 py-2.5"
            data-testid="rcs-being-made"
          >
            Paid, thank you. We’re making your RCS sender at Twilio and will connect it here
            {request.ticketNumber ? ` (support ticket #${request.ticketNumber})` : ''}. Then the
            carriers review it, which can take a few weeks. We’ll email you when RCS is on, and your
            texts keep going as they do now until then.
          </Callout>
          <ConnectForm
            workspaceId={workspaceId}
            lines={lines}
            retryId={sender?.senderId ?? null}
            intro={
              <p className="text-[13px] text-text-2">
                Your sender shows up here once it’s made. We’ll connect it for you, or you can pick
                it and connect it yourself.
              </p>
            }
            onConnected={() => router.refresh()}
          />
        </>
      ) : canManage && asking ? (
        <PayPanel workspaceId={workspaceId} request={request} returning={confirming} />
      ) : canManage ? (
        <>
          {request &&
          (request.status === 'expired' || request.status === 'failed') &&
          request.problem ? (
            <Callout tone="warning" icon={CircleAlert} className="mt-4 px-3 py-2.5">
              {request.problem}
            </Callout>
          ) : null}
          {connectOwn ? (
            <ConnectForm
              workspaceId={workspaceId}
              lines={lines}
              retryId={sender?.senderId ?? null}
              intro={
                <button
                  type="button"
                  onClick={() => setConnectOwn(false)}
                  className="self-start text-[13px] text-text-3 hover:text-text"
                >
                  ← Ask us to make one instead
                </button>
              }
              onConnected={() => router.refresh()}
            />
          ) : (
            <>
              <RequestForm
                workspaceId={workspaceId}
                businessName={businessName}
                prefill={prefill}
                onSent={() => {
                  setGoPay(true);
                  router.refresh();
                }}
              />
              <button
                type="button"
                onClick={() => setConnectOwn(true)}
                className="mt-3 self-start text-xs text-text-3 hover:text-text"
                data-testid="rcs-connect-own"
              >
                Already have an RCS sender at Twilio? Connect it
              </button>
            </>
          )}
        </>
      ) : null}

      {canManage && connected && request?.status === 'paid' ? (
        <RenewalRow workspaceId={workspaceId} request={request} />
      ) : null}
      {canManage && !connected && paidFor ? (
        <RenewalRow workspaceId={workspaceId} request={request} />
      ) : null}

      {!canManage ? (
        <p className="mt-3 text-xs text-text-3">Owners and admins can change this.</p>
      ) : null}
    </Card>
  );
}
