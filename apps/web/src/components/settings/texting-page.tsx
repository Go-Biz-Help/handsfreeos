'use client';
import { formatClock, formatPhone, normalizePhone } from '@hfos/core';
import {
  Check,
  CircleAlert,
  CircleCheck,
  Clock,
  Copy,
  Globe,
  Info,
  MessageCircle,
  MoreHorizontal,
  Phone,
  Plus,
  Search,
  Send,
  Trash2,
  Volume2,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { InboxVisibilityCard } from '@/components/settings/inbox-visibility-card';
import { NumbersCard, type Ringable } from '@/components/settings/numbers-card';
import { PortStep, type PortInfo } from '@/components/settings/port-step';
import { ChannelIcon, Pill } from '@/components/inbox/bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, FieldError, Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { RadioCard } from '@/components/ui/radio-card';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, ApiError, errorMessage, unwrap } from '@/lib/api/client';
import type {
  PhoneNumberInfo,
  PhoneSetupStatus,
  RegistrationInfo,
  RegistrationSubmitBody,
} from '@/lib/api/types';
import { searchNumbers, type AvailableNumber } from '@/lib/api/worker';
import { formatDate } from '@/lib/format';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { ReleaseNumberDialog } from './release-number-dialog';
import { SetRow } from './set-row';
import { TestTextDialog } from './test-text-dialog';

type Status = PhoneSetupStatus;
type NumberType = 'local' | 'toll_free';

const BUSINESS_TYPES = [
  ['llc', 'Limited liability company (LLC)'],
  ['corporation', 'Corporation'],
  ['sole_proprietor', 'Sole proprietor'],
  ['partnership', 'Partnership'],
  ['non_profit', 'Nonprofit'],
] as const;
const USE_CASES = [
  ['customer_care', 'Appointments, estimates and customer care'],
  ['mixed', 'Customer care and occasional promotions'],
  ['marketing', 'Marketing and promotions'],
] as const;
const VOLUMES = [
  ['under_1000', 'Under 1,000'],
  ['1000_10000', '1,000 to 10,000'],
  ['10000_100000', '10,000 to 100,000'],
  ['over_100000', 'Over 100,000'],
] as const;
const label = (list: readonly (readonly [string, string])[], value: unknown) =>
  list.find(([v]) => v === value)?.[1] ?? String(value ?? '');

/** Settings → Texting & calls: the setup wizard until the carriers approve, then the configured page. */
export function TextingPage({
  workspaceId,
  businessName,
  status,
  me,
  team,
  people,
  ports,
  inboxPerPerson,
}: {
  workspaceId: string;
  businessName: string;
  status: Status;
  me: { fullName: string; email: string };
  /** First names of the people whose browsers ring for calls. */
  team: string[];
  /** The same people with their ids, for choosing who a number rings (M17). */
  people: Ringable[];
  /** Numbers being brought from another carrier, newest first (M17). */
  ports: readonly PortInfo[];
  /** Whether each person sees only their own threads (M17). Shown beside "who this number rings". */
  inboxPerPerson: boolean;
}) {
  useLiveRefresh(['phone_number', 'registration', 'number_port', 'workspace']);
  const router = useRouter();
  // Buying and releasing take seconds: check again every few, in case the live channel is down.
  const busy = status.nextStep === 'provisioning' || status.nextStep === 'releasing';
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(timer);
  }, [busy, router]);
  const [fixing, setFixing] = useState(false);
  const [showSent, setShowSent] = useState(false);
  // A business that already has a number and wants another. There is no `nextStep` for this — the wizard is
  // about getting a first number working — so it is local state that drops back into the same buy screen.
  const [adding, setAdding] = useState(false);
  const submission = latestSubmission(status.registrations);
  const sentSheet = (
    <SubmissionSheet open={showSent} onOpenChange={setShowSent} submission={submission} />
  );

  /**
   * The list of numbers, shown only once there is a reason for it: a second number, or a first that is
   * finished and so could be joined by one. Mid-setup a business sees the wizard and nothing else, which is
   * the screen that was there before and the one that suits what it is doing.
   */
  const numbersCard =
    status.numbers.length > 1 || (status.numbers.length === 1 && status.nextStep === 'ready') ? (
      <NumbersCard
        workspaceId={workspaceId}
        numbers={status.numbers}
        people={people}
        canManage={status.canManage}
        onAdd={() => setAdding(true)}
      />
    ) : null;

  // Beside the numbers on purpose: "who this number rings" and "who sees which conversations" are the same
  // question asked twice, and a business deciding one is deciding the other. Held back until there is a
  // working number, like the list above it — mid-setup it would be a question about nothing.
  const visibilityCard = numbersCard ? (
    <InboxVisibilityCard workspaceId={workspaceId} perPerson={inboxPerPerson} />
  ) : null;

  if (adding)
    return (
      <div className="flex flex-col gap-5">
        {numbersCard}
        <Card
          className="max-w-[820px] p-5 md:p-7"
          data-testid="texting-setup"
          data-step="add_number"
        >
          <button
            type="button"
            onClick={() => setAdding(false)}
            className="text-[13px] text-text-3 hover:text-text"
            data-testid="numbers-add-cancel"
          >
            ← Back to your numbers
          </button>
          <div className="mt-3">
            <NumberStep workspaceId={workspaceId} failed={null} ports={ports} />
          </div>
        </Card>
      </div>
    );

  if (status.nextStep === 'ready' && status.number)
    return (
      <div className="flex flex-col gap-5">
        {numbersCard}
        {visibilityCard}
        <Configured
          workspaceId={workspaceId}
          businessName={businessName}
          status={status}
          number={status.number}
          team={team}
          onViewSent={() => setShowSent(true)}
          contactPhone={String(
            (submission?.['contact'] as { phone?: string } | undefined)?.phone ?? '',
          )}
        />
        {sentSheet}
      </div>
    );

  const step = status.nextStep;
  const current =
    step === 'buy_number' || step === 'provisioning' || step === 'releasing' || step === 'porting'
      ? 0
      : step === 'submit_registration' || fixing
        ? 1
        : 2;
  return (
    <Card className="max-w-[820px] p-5 md:p-7" data-testid="texting-setup" data-step={step}>
      {status.number && releasable(status.number.status) ? (
        <div
          className="mb-1 flex items-center justify-between gap-3 border-b border-border pb-3"
          data-testid="setup-number-bar"
        >
          <div className="min-w-0">
            <div className="text-[13px] font-medium">{status.number.display}</div>
            <div className="text-xs text-text-3">
              Yours from now on, whatever happens with the registration.
            </div>
          </div>
          <NumberActions workspaceId={workspaceId} number={status.number} />
        </div>
      ) : null}
      <Steps current={current} turnedDown={step === 'rejected' && !fixing} />
      {step === 'buy_number' ? (
        <NumberStep
          workspaceId={workspaceId}
          failed={status.number?.status === 'failed' ? status.number : null}
          ports={ports}
        />
      ) : step === 'porting' ? (
        // Weeks with a carrier, not seconds with us, so it is its own screen rather than the spinner that
        // `provisioning` gets: there is a status, a moving day and a way out, and a business checking back
        // every few days needs all three.
        <PortStep workspaceId={workspaceId} ports={ports} onBack={() => setAdding(true)} />
      ) : step === 'provisioning' || step === 'releasing' ? (
        <div className="flex items-center gap-3 py-6 text-[13.5px] text-text-2" role="status">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          {step === 'provisioning'
            ? `Setting up ${status.number?.display ?? 'your number'}. This takes a few seconds.`
            : `Releasing ${status.number?.display ?? 'the number'}.`}
        </div>
      ) : step === 'submit_registration' || fixing ? (
        <BusinessStep
          workspaceId={workspaceId}
          businessName={businessName}
          number={status.number!}
          me={me}
          initial={fixing ? submission : null}
          onBack={fixing ? () => setFixing(false) : undefined}
          onSubmitted={() => setFixing(false)}
        />
      ) : step === 'rejected' ? (
        <Rejected
          workspaceId={workspaceId}
          status={status}
          businessName={businessName}
          onFix={() => setFixing(true)}
          onViewSent={() => setShowSent(true)}
        />
      ) : (
        <Review status={status} businessName={businessName} onViewSent={() => setShowSent(true)} />
      )}
      {sentSheet}
    </Card>
  );
}

function latestSubmission(regs: RegistrationInfo[]): Record<string, unknown> | null {
  const withData = regs
    .filter((r) => r.submission && Object.keys(r.submission).length > 0)
    .sort((a, b) => (b.submittedAt ?? '').localeCompare(a.submittedAt ?? ''));
  return withData[0]?.submission ?? null;
}

function Steps({ current, turnedDown }: { current: number; turnedDown: boolean }) {
  const labels = ['Number', 'Business details', 'Carrier review'];
  return (
    <ol className="mb-[22px] flex flex-wrap items-center gap-1.5" aria-label="Setup steps">
      {labels.map((l, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={l} className="flex items-center gap-1.5">
            {i > 0 ? <span aria-hidden className="h-px w-8 bg-border" /> : null}
            <span
              aria-current={active ? 'step' : undefined}
              className={cn(
                'flex items-center gap-2 text-[13px] font-medium',
                done ? 'text-success-text' : active ? 'text-accent-text' : 'text-text-3',
                active && turnedDown && 'text-danger-text',
              )}
            >
              <span
                className={cn(
                  'inline-flex h-6 w-6 items-center justify-center rounded-full border-[1.5px] text-xs',
                  done
                    ? 'border-success bg-success text-white'
                    : active
                      ? turnedDown
                        ? 'border-danger bg-danger text-white'
                        : 'border-accent bg-accent text-white'
                      : 'border-border-strong',
                )}
              >
                {done ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : i + 1}
              </span>
              {l}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function NumberStep({
  workspaceId,
  failed,
  ports,
}: {
  workspaceId: string;
  failed: PhoneNumberInfo | null;
  ports: readonly PortInfo[];
}) {
  const router = useRouter();
  /**
   * New or their own (M17). The first question, before the kind of number, because it changes everything
   * after it and because a business that has had one number for eleven years is not shopping for a new one —
   * and until now this screen only offered shopping.
   *
   * A request already under way lands on it: a business that came back to check does not have to find the
   * choice again.
   */
  const [source, setSource] = useState<'new' | 'bring'>(
    ports.some((p) => p.status !== 'cancelled' && p.status !== 'complete') ? 'bring' : 'new',
  );
  const [type, setType] = useState<NumberType>('toll_free');
  const [area, setArea] = useState('');
  const [prefix, setPrefix] = useState('');
  const [city, setCity] = useState('');
  const [region, setRegion] = useState('');
  const [digits, setDigits] = useState('');
  // '' is the city itself; anything else is a radius around it, in miles.
  const [miles, setMiles] = useState('');
  const [more, setMore] = useState(false);
  const [results, setResults] = useState<AvailableNumber[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [buying, setBuying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pickedNumber = results?.find((r) => r.e164 === picked) ?? null;

  function choose(next: NumberType) {
    setType(next);
    setResults(null);
    setPicked(null);
    setError(null);
  }

  /** Whether the search asked for more than an area code, which is what usually empties the results. */
  const narrowed = Boolean(digits || (type === 'local' && city));

  /** `broaden` drops the city and the digits and looks again: the empty result's way out. */
  async function search({ broaden = false }: { broaden?: boolean } = {}) {
    if (!broaden && type === 'local' && city && !region) {
      setError('Add the state too, like AL. There is a Huntsville in three of them.');
      return;
    }
    if (broaden) {
      setCity('');
      setRegion('');
      setDigits('');
      setMiles('');
    }
    setSearching(true);
    setError(null);
    try {
      const code = type === 'local' ? area : prefix;
      const out = await searchNumbers({
        workspaceId,
        numberType: type,
        ...(code ? { areaCode: code } : {}),
        ...(!broaden && digits ? { contains: digits } : {}),
        ...(!broaden && type === 'local' && city && region ? { city, state: region } : {}),
        ...(!broaden && type === 'local' && city && region && miles
          ? { withinMiles: Number(miles) }
          : {}),
      });
      setResults(out.numbers);
      setPicked(out.numbers[0]?.e164 ?? null);
      if (out.numbers.length === 0)
        setError(
          !broaden && miles && city
            ? `We could not find ${city} to measure from — the carrier has nothing free in the city itself, and a distance is counted out from there. Searching the city alone, or the area code, still works.`
            : !broaden && narrowed
              ? 'Nothing free matches all of that right now. Carriers only sell what they have on hand, so asking for less usually finds one.'
              : 'No numbers are free there right now. Try another area code.',
        );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSearching(false);
    }
  }

  async function buy() {
    if (!pickedNumber) return;
    setBuying(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/phone_number.buy', {
          body: { workspaceId, e164: pickedNumber.e164, numberType: type },
        }),
      );
      toast.success(`${pickedNumber.display} bought. Calls ring now.`);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBuying(false);
    }
  }

  if (source === 'bring')
    return <PortStep workspaceId={workspaceId} ports={ports} onBack={() => setSource('new')} />;

  return (
    <div data-testid="number-step">
      <h2 className="text-lg font-semibold tracking-tight">Get a business number</h2>
      <p className="mb-[18px] mt-1 text-[13px] text-text-2">
        Customers text and call this number. Calls work as soon as you buy it; texting starts once
        the carriers approve you.
      </p>
      {/* Not a radio group beside the toll-free/local pair below: that one is a property of the number being
          bought, this one decides whether a number is being bought at all. */}
      <button
        type="button"
        onClick={() => setSource('bring')}
        className="mb-[18px] block text-[13px] text-accent-text hover:underline"
        data-testid="bring-your-number"
      >
        I already have a number I want to keep →
      </button>
      {failed ? (
        <Callout tone="danger" icon={CircleAlert} className="mb-4">
          We couldn’t buy {failed.display}
          {failed.lastError ? `: ${failed.lastError}` : '.'} Pick another number.
        </Callout>
      ) : null}
      <div
        role="radiogroup"
        aria-label="Kind of number"
        className="mb-[18px] grid grid-cols-1 gap-3 sm:grid-cols-2"
      >
        <RadioCard
          selected={type === 'toll_free'}
          onSelect={() => choose('toll_free')}
          testId="type-toll-free"
          title={
            <span className="flex items-center gap-2">
              Toll-free <Badge variant="ok">Faster approval</Badge>
            </span>
          }
          description="An (833), (844) or (855) number. Texting approval usually takes a few days."
        />
        <RadioCard
          selected={type === 'local'}
          onSelect={() => choose('local')}
          testId="type-local"
          title="Local"
          description="Your own area code, like (713). The carrier registration usually takes 1 to 3 weeks."
        />
      </div>
      <form
        className="mb-3 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        {type === 'local' ? (
          <div>
            <Label htmlFor="area-code">Area code</Label>
            <Input
              id="area-code"
              inputMode="numeric"
              maxLength={3}
              value={area}
              onChange={(e) => setArea(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="713"
              className="h-9 w-40"
            />
          </div>
        ) : (
          <div>
            <Label htmlFor="toll-free-prefix">Starts with</Label>
            <Select
              id="toll-free-prefix"
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              className="h-9 w-40"
            >
              <option value="">Any</option>
              <option value="833">833</option>
              <option value="844">844</option>
              <option value="855">855</option>
            </Select>
          </div>
        )}
        <Button type="submit" variant="secondary" loading={searching} data-testid="show-numbers">
          {searching ? null : <Search className="h-3.5 w-3.5" strokeWidth={1.5} />}
          Show numbers
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="h-9"
          onClick={() => setMore((v) => !v)}
          data-testid="more-filters"
        >
          {more ? 'Fewer choices' : 'More choices'}
        </Button>
        {more ? (
          <div className="flex w-full flex-wrap items-end gap-2">
            {type === 'local' ? (
              <>
                <div>
                  <Label htmlFor="number-city">City</Label>
                  <Input
                    id="number-city"
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    placeholder="Huntsville"
                    className="h-9 w-44"
                  />
                </div>
                <div>
                  <Label htmlFor="number-state">State</Label>
                  <Input
                    id="number-state"
                    maxLength={2}
                    value={region}
                    onChange={(e) =>
                      setRegion(e.target.value.replace(/[^A-Za-z]/g, '').toUpperCase())
                    }
                    placeholder="AL"
                    className="h-9 w-20"
                  />
                </div>
                <div>
                  <Label htmlFor="number-miles">How far out</Label>
                  <Select
                    id="number-miles"
                    value={miles}
                    onChange={(e) => setMiles(e.target.value)}
                    className="h-9 w-44"
                  >
                    <option value="">That city only</option>
                    <option value="15">Within 15 miles</option>
                    <option value="25">Within 25 miles</option>
                    <option value="50">Within 50 miles</option>
                  </Select>
                </div>
              </>
            ) : null}
            <div>
              <Label htmlFor="number-contains">Digits in the number</Label>
              <Input
                id="number-contains"
                inputMode="numeric"
                maxLength={10}
                value={digits}
                onChange={(e) => setDigits(e.target.value.replace(/[^0-9*]/g, ''))}
                placeholder="454"
                className="h-9 w-44"
              />
            </div>
            <p className="w-full text-[13px] text-text-3">
              A city on its own means that city exactly, which in most places is a handful of
              exchanges; a distance takes in the towns around it that customers think of as the same
              place. Digits can sit anywhere in the number — use * for any single digit to pin them
              down, like 256***454* for 454 in the middle. Asking for more leaves fewer to choose
              from.
            </p>
          </div>
        ) : null}
      </form>
      {error ? <FieldError>{error}</FieldError> : null}
      {results && results.length === 0 && narrowed ? (
        <Button
          variant="secondary"
          className="mt-2"
          loading={searching}
          onClick={() => void search({ broaden: true })}
          data-testid="broaden-search"
        >
          Look again without the city or digits
        </Button>
      ) : null}
      {results && results.length > 0 ? (
        <div
          role="radiogroup"
          aria-label="Available numbers"
          className="overflow-hidden rounded-card border border-border"
          data-testid="number-results"
        >
          {results.map((r) => (
            <button
              key={r.e164}
              type="button"
              role="radio"
              aria-checked={picked === r.e164}
              onClick={() => setPicked(r.e164)}
              className={cn(
                'flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left last:border-b-0',
                picked === r.e164 ? 'bg-accent-soft' : 'hover:bg-card-2',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'h-4 w-4 flex-none rounded-full border-[1.5px]',
                  picked === r.e164
                    ? 'border-accent bg-accent shadow-[inset_0_0_0_3px_var(--card)]'
                    : 'border-border-strong',
                )}
              />
              <span className="flex-1 font-mono text-[15px] font-medium">{r.display}</span>
              <span className="text-xs text-text-3">
                {type === 'toll_free'
                  ? 'Toll-free'
                  : [r.locality, r.region].filter(Boolean).join(', ') || 'Local'}
              </span>
              <Pill className="hidden sm:inline-flex">Calls · Texts · Photos</Pill>
            </button>
          ))}
        </div>
      ) : null}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-text-2">
          Calls ring right away. You can add forwarding phones next.
        </p>
        <Button
          disabled={!pickedNumber}
          loading={buying}
          onClick={() => void buy()}
          data-testid="buy-number"
        >
          {pickedNumber ? `Buy ${pickedNumber.display}` : 'Buy a number'}
        </Button>
      </div>
    </div>
  );
}

interface BizForm {
  legalName: string;
  businessType: string;
  ein: string;
  website: string;
  line1: string;
  city: string;
  state: string;
  postalCode: string;
  contactFirst: string;
  contactLast: string;
  contactPhone: string;
  contactEmail: string;
  optIn: string;
  sample1: string;
  sample2: string;
  useCase: string;
  volume: string;
}

/** Server paths of the business profile, mapped to the form's fields. */
const ERROR_FIELD: Record<string, keyof BizForm> = {
  'business.legalName': 'legalName',
  'business.businessType': 'businessType',
  'business.ein': 'ein',
  'business.website': 'website',
  'business.address.line1': 'line1',
  'business.address.city': 'city',
  'business.address.state': 'state',
  'business.address.postalCode': 'postalCode',
  'business.contact.firstName': 'contactFirst',
  'business.contact.lastName': 'contactLast',
  'business.contact.phone': 'contactPhone',
  'business.contact.email': 'contactEmail',
  'business.optInDescription': 'optIn',
  'business.messageSamples': 'sample2',
  'business.messageSamples.0': 'sample1',
  'business.messageSamples.1': 'sample2',
  'business.useCase': 'useCase',
  'business.monthlyVolume': 'volume',
};

function formFrom(
  initial: Record<string, unknown> | null,
  businessName: string,
  me: { fullName: string; email: string },
): BizForm {
  const b = (initial ?? {}) as {
    legalName?: string;
    businessType?: string;
    ein?: string | null;
    website?: string;
    address?: { line1?: string; city?: string; state?: string; postalCode?: string };
    contact?: { firstName?: string; lastName?: string; email?: string; phone?: string };
    optInDescription?: string;
    messageSamples?: string[];
    useCase?: string;
    monthlyVolume?: string;
  };
  const [meFirst = '', ...meRest] = me.fullName.trim().split(/\s+/);
  return {
    legalName: b.legalName ?? businessName,
    businessType: b.businessType ?? 'llc',
    ein: b.ein ?? '',
    website: b.website ?? '',
    line1: b.address?.line1 ?? '',
    city: b.address?.city ?? '',
    state: b.address?.state ?? '',
    postalCode: b.address?.postalCode ?? '',
    contactFirst: b.contact?.firstName ?? meFirst,
    contactLast: b.contact?.lastName ?? meRest.join(' '),
    contactPhone: b.contact?.phone ?? '',
    contactEmail: b.contact?.email ?? me.email,
    optIn: b.optInDescription ?? '',
    sample1: b.messageSamples?.[0] ?? '',
    sample2: b.messageSamples?.[1] ?? '',
    useCase: b.useCase ?? 'customer_care',
    volume: b.monthlyVolume ?? 'under_1000',
  };
}

function BusinessStep({
  workspaceId,
  businessName,
  number,
  me,
  initial,
  onBack,
  onSubmitted,
}: {
  workspaceId: string;
  businessName: string;
  number: PhoneNumberInfo;
  me: { fullName: string; email: string };
  initial: Record<string, unknown> | null;
  onBack?: () => void;
  onSubmitted: () => void;
}) {
  const router = useRouter();
  const [form, setForm] = useState<BizForm>(() => formFrom(initial, businessName, me));
  const [errors, setErrors] = useState<Partial<Record<keyof BizForm, string>>>({});
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const local = number.numberType === 'local';
  const set = (k: keyof BizForm) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const soleProp = form.businessType === 'sole_proprietor';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    const website = /^https?:\/\//i.test(form.website.trim())
      ? form.website.trim()
      : form.website.trim()
        ? `https://${form.website.trim()}`
        : '';
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/registration.submit', {
          body: {
            workspaceId,
            kind: local ? 'a2p_10dlc' : 'toll_free_verification',
            business: {
              legalName: form.legalName,
              businessType: form.businessType as 'llc',
              ein: soleProp ? null : form.ein || null,
              website,
              address: {
                line1: form.line1,
                city: form.city,
                state: form.state,
                postalCode: form.postalCode,
                country: 'US',
              },
              contact: {
                firstName: form.contactFirst,
                lastName: form.contactLast,
                email: form.contactEmail,
                phone: form.contactPhone,
              },
              useCase: form.useCase as 'customer_care',
              messageSamples: [form.sample1, form.sample2].map((s) => s.trim()).filter(Boolean),
              optInDescription: form.optIn,
              monthlyVolume: form.volume as 'under_1000',
            },
          },
        }),
      );
      toast.success('Sent to the carriers');
      onSubmitted();
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'validation' && Array.isArray(err.details)) {
        const next: Partial<Record<keyof BizForm, string>> = {};
        for (const d of err.details as { path?: string; message?: string }[]) {
          const key = ERROR_FIELD[d.path ?? ''];
          if (key && !next[key]) next[key] = d.message ?? 'Check this.';
        }
        setErrors(next);
        toast.error(Object.keys(next).length ? 'A few details need a look.' : err.message);
      } else toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const text = (
    k: keyof BizForm,
    lbl: string,
    props: Partial<Parameters<typeof Input>[0]> = {},
    span = false,
  ) => (
    <Field
      label={lbl}
      htmlFor={`biz-${k}`}
      error={errors[k]}
      className={cn('mb-3.5', span && 'sm:col-span-2')}
    >
      <Input
        id={`biz-${k}`}
        value={form[k]}
        onChange={(e) => set(k)(e.target.value)}
        invalid={!!errors[k]}
        {...props}
      />
    </Field>
  );

  return (
    <form onSubmit={(e) => void submit(e)} data-testid="business-step" noValidate>
      {onBack ? null : (
        <Callout tone="info" icon={CircleCheck} className="mb-[18px]">
          <strong>{number.display} is yours.</strong> Calls ring now. To turn on texting, the
          carriers need to know who is texting and why.
        </Callout>
      )}
      <h2 className="text-lg font-semibold tracking-tight">Business details for the carriers</h2>
      <p className="mb-4 mt-1 text-[13px] text-text-2">
        We send these to the carriers for you. Use the legal details on your tax paperwork.
      </p>
      <div className="grid grid-cols-1 gap-x-3.5 sm:grid-cols-2">
        {text('legalName', 'Legal business name')}
        <Field
          label="Business type"
          htmlFor="biz-businessType"
          error={errors.businessType}
          className="mb-3.5"
        >
          <Select
            id="biz-businessType"
            value={form.businessType}
            onChange={(e) => set('businessType')(e.target.value)}
          >
            {BUSINESS_TYPES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        {soleProp ? (
          <p className="mb-3.5 self-end text-[12.5px] text-text-3 sm:pb-3">
            Sole proprietors don’t need an EIN
            {local ? ', but local numbers need one: pick toll-free instead' : ''}.
          </p>
        ) : (
          text('ein', 'EIN (tax ID)', {
            className: 'font-mono text-sm',
            placeholder: '12-3456789',
            inputMode: 'numeric',
          })
        )}
        {text('website', 'Website', { placeholder: 'https://', inputMode: 'url' })}
        <div className="mb-3.5 sm:col-span-2">
          <Label htmlFor="biz-line1">Business address</Label>
          <div className="grid grid-cols-6 gap-2">
            <Input
              id="biz-line1"
              className="col-span-6"
              placeholder="Street"
              value={form.line1}
              onChange={(e) => set('line1')(e.target.value)}
              invalid={!!errors.line1}
            />
            <Input
              aria-label="City"
              className="col-span-3"
              placeholder="City"
              value={form.city}
              onChange={(e) => set('city')(e.target.value)}
              invalid={!!errors.city}
            />
            <Input
              aria-label="State"
              className="col-span-1"
              placeholder="TX"
              maxLength={2}
              value={form.state}
              onChange={(e) => set('state')(e.target.value.toUpperCase())}
              invalid={!!errors.state}
            />
            <Input
              aria-label="ZIP code"
              className="col-span-2"
              placeholder="ZIP"
              inputMode="numeric"
              value={form.postalCode}
              onChange={(e) => set('postalCode')(e.target.value)}
              invalid={!!errors.postalCode}
            />
          </div>
          <FieldError>
            {errors.line1 ?? errors.city ?? errors.state ?? errors.postalCode}
          </FieldError>
        </div>
        <div className="mb-3.5">
          <Label htmlFor="biz-contactFirst">Contact person</Label>
          <div className="grid grid-cols-2 gap-2">
            <Input
              id="biz-contactFirst"
              placeholder="First name"
              value={form.contactFirst}
              onChange={(e) => set('contactFirst')(e.target.value)}
              invalid={!!errors.contactFirst}
            />
            <Input
              aria-label="Last name"
              placeholder="Last name"
              value={form.contactLast}
              onChange={(e) => set('contactLast')(e.target.value)}
              invalid={!!errors.contactLast}
            />
          </div>
          <FieldError>{errors.contactFirst ?? errors.contactLast}</FieldError>
        </div>
        <div className="mb-3.5">
          <Label htmlFor="biz-contactPhone">Contact phone and email</Label>
          <div className="grid grid-cols-2 gap-2">
            <Input
              id="biz-contactPhone"
              placeholder="(713) 555-0123"
              inputMode="tel"
              value={form.contactPhone}
              onChange={(e) => set('contactPhone')(e.target.value)}
              invalid={!!errors.contactPhone}
            />
            <Input
              aria-label="Contact email"
              placeholder="you@business.com"
              inputMode="email"
              value={form.contactEmail}
              onChange={(e) => set('contactEmail')(e.target.value)}
              invalid={!!errors.contactEmail}
            />
          </div>
          <FieldError>{errors.contactPhone ?? errors.contactEmail}</FieldError>
        </div>
      </div>
      <Field
        label="How customers agree to get texts"
        htmlFor="biz-optIn"
        error={errors.optIn}
        className="mb-3.5"
      >
        <Textarea
          id="biz-optIn"
          className="min-h-32"
          value={form.optIn}
          onChange={(e) => set('optIn')(e.target.value)}
          invalid={!!errors.optIn}
          placeholder="Customers give us their cell number when they call or text, fill in our website form, book online or sign an estimate, and agree to get texts from us. We only send automated texts to people who contacted us or booked with us: replies to new inquiries, a text back after a missed call, appointment confirmations and reminders, follow-ups on estimates and review requests. Every text says how to opt out, and replying STOP stops them."
        />
      </Field>
      <div className="mb-3.5">
        <Label htmlFor="biz-sample1">{local ? 'Two example texts' : 'Example texts'}</Label>
        <div className="flex flex-col gap-2">
          <Input
            id="biz-sample1"
            value={form.sample1}
            onChange={(e) => set('sample1')(e.target.value)}
            invalid={!!errors.sample1}
            placeholder={`Hi Mike, this is ${businessName}. Sorry we missed your call! How can we help? Reply STOP to opt out.`}
          />
          <Input
            aria-label="Second example text"
            value={form.sample2}
            onChange={(e) => set('sample2')(e.target.value)}
            invalid={!!errors.sample2}
            placeholder={`Hi Mike, it’s ${businessName}. Just checking in on your AC estimate. Any questions? Reply STOP to opt out.`}
          />
        </div>
        <FieldError>{errors.sample1 ?? errors.sample2}</FieldError>
      </div>
      <div className="flex flex-col gap-x-3.5 sm:flex-row">
        <Field label="What you text about" htmlFor="biz-useCase" className="mb-3.5 flex-1">
          <Select
            id="biz-useCase"
            value={form.useCase}
            onChange={(e) => set('useCase')(e.target.value)}
          >
            {USE_CASES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Texts a month" htmlFor="biz-volume" className="mb-3.5 sm:w-[220px]">
          <Select
            id="biz-volume"
            value={form.volume}
            onChange={(e) => set('volume')(e.target.value)}
          >
            {VOLUMES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Checkbox
        className="mb-[18px] mt-1 text-[13px]"
        label="These details are accurate, and we only text customers who agreed to it."
        checked={agreed}
        onChange={(e) => setAgreed(e.target.checked)}
        data-testid="business-agree"
      />
      <div className="flex items-center justify-between gap-3">
        {onBack ? (
          <Button variant="ghost" onClick={onBack}>
            Back
          </Button>
        ) : (
          <span />
        )}
        <Button type="submit" disabled={!agreed} loading={busy} data-testid="submit-registration">
          Submit for approval
        </Button>
      </div>
    </form>
  );
}

type RowState = 'done' | 'review' | 'next' | 'turned_down';

function ReviewRow({ title, sub, state }: { title: string; sub: string; state: RowState }) {
  const tile =
    state === 'done' ? (
      <ChannelIcon icon={Check} tone="success" />
    ) : state === 'next' ? (
      <ChannelIcon icon={MessageCircle} />
    ) : (
      <ChannelIcon icon={Clock} tone="warning" />
    );
  const badge =
    state === 'done' ? (
      <Badge variant="ok">Done</Badge>
    ) : state === 'review' ? (
      <Badge variant="pending">In review</Badge>
    ) : state === 'turned_down' ? (
      <Badge variant="danger">Turned down</Badge>
    ) : (
      <Badge variant="gray">Next</Badge>
    );
  return (
    <div className="flex items-center gap-3 border-b border-border px-4 py-3.5 last:border-b-0">
      {tile}
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{title}</div>
        <div className="text-xs text-text-3">{sub}</div>
      </div>
      {badge}
    </div>
  );
}

const stateOf = (regs: (RegistrationInfo | undefined)[]): RowState => {
  const present = regs.filter((r): r is RegistrationInfo => !!r);
  if (present.length === 0) return 'next';
  if (present.some((r) => r.status === 'rejected' || r.status === 'failed')) return 'turned_down';
  if (present.length === regs.length && present.every((r) => r.status === 'approved'))
    return 'done';
  return 'review';
};

function latestOf(
  regs: RegistrationInfo[],
  kind: RegistrationInfo['kind'],
): RegistrationInfo | undefined {
  return regs
    .filter((r) => r.kind === kind)
    .sort((a, b) => (b.submittedAt ?? '').localeCompare(a.submittedAt ?? ''))[0];
}

function Review({
  status,
  businessName,
  onViewSent,
}: {
  status: Status;
  businessName: string;
  onViewSent: () => void;
}) {
  const n = status.number!;
  const local = n.numberType === 'local';
  const regs = status.registrations;
  const submitted = regs
    .map((r) => r.submittedAt)
    .filter((d): d is string => !!d)
    .sort()[0];
  const brand = [
    latestOf(regs, 'a2p_customer_profile'),
    latestOf(regs, 'a2p_trust_product'),
    latestOf(regs, 'a2p_brand'),
  ];
  const brandState = stateOf(brand);
  const brandApproved = brand
    .map((r) => r?.approvedAt)
    .filter(Boolean)
    .sort()
    .pop();
  return (
    <div data-testid="review-step">
      <h2 className="text-lg font-semibold tracking-tight">
        The carriers are reviewing {businessName}
      </h2>
      <p className="mb-5 mt-1 text-[13px] text-text-2">
        {local
          ? 'Local numbers go through a brand and campaign registration that usually takes 1 to 3 weeks.'
          : 'Toll-free verification usually takes a few days.'}{' '}
        We check every 15 minutes and email you when texting is on. Calls already work.
      </p>
      <div
        className="overflow-hidden rounded-card border border-border"
        data-testid="review-checklist"
      >
        <ReviewRow title="Number bought" sub={`${n.display} · calls ring now`} state="done" />
        {local ? (
          <>
            <ReviewRow
              title="Business profile and brand"
              sub={
                brandState === 'done' && brandApproved
                  ? `Approved ${formatDate(brandApproved)}`
                  : 'Usually a few days'
              }
              state={brandState}
            />
            <ReviewRow
              title="Texting campaign"
              sub="Usually 1 to 3 weeks"
              state={brandState === 'done' ? stateOf([latestOf(regs, 'a2p_campaign')]) : 'next'}
            />
          </>
        ) : (
          <ReviewRow
            title="Toll-free verification"
            sub="Usually a few days"
            state={stateOf([latestOf(regs, 'toll_free_verification')])}
          />
        )}
        <ReviewRow title="Texting turns on" sub="We email you the moment it does" state="next" />
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={onViewSent}>
          View what we sent
        </Button>
        <Button variant="secondary" disabled title="Texting isn’t approved yet">
          Text me a test
        </Button>
        <span className="flex-1" />
        {submitted ? (
          <span className="text-xs text-text-3">Submitted {formatDate(submitted)}</span>
        ) : null}
      </div>
    </div>
  );
}

/** Steps the carriers check against the business profile HandsFreeOS keeps for the business with them. */
const PROFILE_STEPS = new Set<RegistrationInfo['kind']>([
  'a2p_customer_profile',
  'a2p_trust_product',
  'a2p_brand',
]);

function Rejected({
  workspaceId,
  status,
  businessName,
  onFix,
  onViewSent,
}: {
  workspaceId: string;
  status: Status;
  businessName: string;
  onFix: () => void;
  onViewSent: () => void;
}) {
  const bad = status.registrations.find((r) => r.status === 'rejected' || r.status === 'failed');
  const reason = bad?.rejectionReason ?? null;
  const optIn = !!reason && /opt|consent|agree|permission/i.test(reason);
  const callout = (
    <Callout tone="danger" icon={CircleAlert} className="mb-[18px]">
      <div className="flex flex-col gap-1">
        <strong>The carriers turned down the texting registration.</strong>
        <span>{reason ? `Their reason: “${reason}”` : 'They didn’t give a reason.'}</span>
      </div>
    </Callout>
  );
  // A local number's business profile or brand turned down by the carriers: support corrects it with them.
  if (
    status.number?.numberType === 'local' &&
    bad?.status === 'rejected' &&
    PROFILE_STEPS.has(bad.kind)
  )
    return (
      <div data-testid="rejected-step">
        {callout}
        <SupportFix
          workspaceId={workspaceId}
          status={status}
          businessName={businessName}
          onViewSent={onViewSent}
        />
      </div>
    );
  return (
    <div data-testid="rejected-step">
      {callout}
      <h2 className="text-lg font-semibold tracking-tight">What to fix</h2>
      <p className="mb-4 mt-1 text-[13px] text-text-2">
        {optIn
          ? 'Add a line to your booking and contact forms, then send the details again. Nothing else changes, and calls keep working.'
          : 'Change what the carriers asked about, then send the details again. Nothing else changes, and calls keep working.'}
      </p>
      {optIn ? (
        <div className="mb-[18px] rounded-[10px] bg-card-2 p-3">
          <div className="text-xs text-text-3">A line you can copy onto your website form</div>
          <p className="mt-1 text-[13px]">
            “By giving us your cell number you agree to receive texts from {businessName} about your
            service, including automated texts about your inquiry, appointments, estimates and
            reviews. Message rates may apply. Reply STOP to opt out.”
          </p>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button onClick={onFix} data-testid="fix-registration">
          Fix and send again
        </Button>
        <Button variant="ghost" onClick={onViewSent}>
          View what we sent
        </Button>
      </div>
    </div>
  );
}

/**
 * The carriers turned down a local number's business profile or brand. They check those against the profile
 * HandsFreeOS keeps for the business with them, which support corrects in Twilio; then the same details go again.
 */
function SupportFix({
  workspaceId,
  status,
  businessName,
  onViewSent,
}: {
  workspaceId: string;
  status: Status;
  businessName: string;
  onViewSent: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function sendAgain() {
    const sent = latestSubmission(status.registrations);
    if (!sent) return;
    setBusy(true);
    try {
      const business = Object.fromEntries(
        Object.entries(sent).filter(([k]) => k !== 'forNumber'),
      ) as RegistrationSubmitBody['business'];
      unwrap(
        await apiBrowser().POST('/v1/commands/registration.submit', {
          body: { workspaceId, kind: 'a2p_10dlc', business },
        }),
      );
      toast.success('Sent to the carriers');
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <h2 className="text-lg font-semibold tracking-tight">What happens next</h2>
      <p className="mb-4 mt-1 text-[13px] text-text-2">
        The carriers check {businessName}’s brand against the business profile HandsFreeOS keeps for
        you with them, and that profile can’t be changed from this page. Contact HandsFreeOS support
        and share their reason. Once support tells you it’s fixed, send it again. Calls keep
        working.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button loading={busy} onClick={() => void sendAgain()} data-testid="resend-registration">
          Send again
        </Button>
        <Button variant="ghost" onClick={onViewSent}>
          View what we sent
        </Button>
      </div>
    </>
  );
}

function SubmissionSheet({
  open,
  onOpenChange,
  submission,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  submission: Record<string, unknown> | null;
}) {
  const b = (submission ?? {}) as {
    legalName?: string;
    businessType?: string;
    ein?: string | null;
    website?: string;
    address?: { line1?: string; city?: string; state?: string; postalCode?: string };
    contact?: { firstName?: string; lastName?: string; email?: string; phone?: string };
    optInDescription?: string;
    messageSamples?: string[];
    useCase?: string;
    monthlyVolume?: string;
  };
  const rows: [string, ReactNode][] = [
    ['Legal name', b.legalName],
    ['Business type', label(BUSINESS_TYPES, b.businessType)],
    ['EIN', b.ein || '—'],
    ['Website', b.website],
    [
      'Address',
      [b.address?.line1, b.address?.city, b.address?.state, b.address?.postalCode]
        .filter(Boolean)
        .join(', '),
    ],
    [
      'Contact',
      [
        `${b.contact?.firstName ?? ''} ${b.contact?.lastName ?? ''}`.trim(),
        b.contact?.phone,
        b.contact?.email,
      ]
        .filter(Boolean)
        .join(' · '),
    ],
    ['Texts about', label(USE_CASES, b.useCase)],
    ['Texts a month', label(VOLUMES, b.monthlyVolume)],
    ['How customers agree', b.optInDescription],
    [
      'Example texts',
      <ul key="samples" className="flex flex-col gap-1.5">
        {(b.messageSamples ?? []).map((s) => (
          <li key={s} className="rounded-control bg-card-2 px-2.5 py-2">
            {s}
          </li>
        ))}
      </ul>,
    ],
  ];
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title="What we sent the carriers"
        description="Read-only while the carriers review it. To change something after a decision, send the details again."
      >
        {submission ? (
          <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-3 text-[13px]">
            {rows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-text-2">{k}</dt>
                <dd className="min-w-0 break-words font-medium">{v || '—'}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-[13px] text-text-2">Nothing sent yet.</p>
        )}
      </SheetContent>
    </Sheet>
  );
}

/** Every hour, so a business with early or late shifts can set its own window. */
const HOURS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);
const START_TIMES = HOURS;
const END_TIMES = HOURS;
const REMINDERS = [
  [10, '10 minutes'],
  [5, '5 minutes'],
  [15, '15 minutes'],
  [30, '30 minutes'],
  [60, '1 hour'],
  [0, 'Never'],
] as const;

/** A number can be given back from the moment it is bought — never only once the carrier has approved it. */
function releasable(status: PhoneNumberInfo['status']): boolean {
  return status === 'active' || status === 'provisioning';
}

/**
 * Copy the number, or give it back. Its own component because it belongs to the number rather than to any one step:
 * a business part-way through carrier registration, or one whose registration was turned down, still needs a way out,
 * and before this the menu existed only on the finished screen (step 1, finding: "can't release a number").
 */
function NumberActions({
  workspaceId,
  number: n,
}: {
  workspaceId: string;
  number: PhoneNumberInfo;
}) {
  const router = useRouter();
  const [release, setRelease] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(n.display);
      toast.success(`Copied ${n.display}`);
    } catch {
      toast.error('Your browser didn’t allow copying.');
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Number actions" title="More">
            <MoreHorizontal className="h-[18px] w-[18px]" strokeWidth={1.5} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="min-w-[220px]">
          <DropdownMenuItem onSelect={() => void copy()}>
            <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />
            Copy number
          </DropdownMenuItem>
          {releasable(n.status) ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem danger onSelect={() => setRelease(true)} data-testid="release-menu">
                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                Release this number
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <ReleaseNumberDialog
        workspaceId={workspaceId}
        phoneNumberId={n.id}
        display={n.display}
        e164={n.e164}
        open={release}
        onOpenChange={setRelease}
        onReleased={() => router.refresh()}
      />
    </>
  );
}

function Configured({
  workspaceId,
  businessName,
  status,
  number: n,
  team,
  onViewSent,
  contactPhone,
}: {
  workspaceId: string;
  businessName: string;
  status: Status;
  number: PhoneNumberInfo;
  team: string[];
  onViewSent: () => void;
  contactPhone: string;
}) {
  const router = useRouter();
  const calls = useRouting(workspaceId, n);
  const [test, setTest] = useState(false);
  const [quiet, setQuiet] = useState(status.settings.quietHours);
  const [reminder, setReminder] = useState(status.settings.unansweredReminderMinutes);
  const city = status.timezone.split('/').pop()?.replace(/_/g, ' ') ?? status.timezone;
  const local = n.numberType === 'local';
  const regs = status.registrations;
  const approved = (kind: RegistrationInfo['kind']) => latestOf(regs, kind)?.approvedAt;
  const useCase = String(latestSubmission(regs)?.['useCase'] ?? '');

  async function save(
    change: { quietHours?: typeof quiet; unansweredReminderMinutes?: number },
    success: string,
  ) {
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/phone.update_settings', {
          body: { workspaceId, ...change },
        }),
      );
      toast.success(success);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
      setQuiet(status.settings.quietHours);
      setReminder(status.settings.unansweredReminderMinutes);
    }
  }
  const setQuietHours = (next: typeof quiet, success: string) => {
    setQuiet(next);
    void save({ quietHours: next }, success);
  };

  const regRows: [string, string | null | undefined][] = local
    ? [
        ['Business profile', approved('a2p_customer_profile')],
        ['Messaging profile', approved('a2p_trust_product')],
        ['Brand', approved('a2p_brand')],
        [`Texting campaign · ${label(USE_CASES, useCase).toLowerCase()}`, approved('a2p_campaign')],
      ]
    : [['Toll-free verification', approved('toll_free_verification')]];

  return (
    <div
      className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2"
      data-testid="texting-configured"
    >
      <div className="flex flex-col gap-5">
        <Card className="p-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">Business number</h2>
              <p className="mt-1 text-[13px] text-text-2">
                Customers text and call {businessName} here.
              </p>
            </div>
            <NumberActions workspaceId={workspaceId} number={n} />
          </div>
          <div className="mt-4 flex items-center gap-3.5">
            <ChannelIcon icon={Phone} size={44} />
            <div>
              <div
                className="font-mono text-xl font-medium tracking-[-0.01em]"
                data-testid="business-number"
              >
                {n.display}
              </div>
              <div className="text-xs text-text-3">
                {local ? 'Local' : 'Toll-free'}
                {n.purchasedAt ? ` · bought ${formatDate(n.purchasedAt)}` : ''}
              </div>
            </div>
          </div>
          <div className="mt-3.5 flex flex-wrap gap-1.5">
            <Badge variant="ok">
              <Phone className="h-3.5 w-3.5" strokeWidth={1.75} />
              Calls ready
            </Badge>
            <Badge variant="ok">
              <MessageCircle className="h-3.5 w-3.5" strokeWidth={1.75} />
              Texting approved
            </Badge>
            <Badge variant="gray">Photos and picture texts</Badge>
          </div>
          <div className="mt-[18px] flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setTest(true)}
              data-testid="text-me-a-test"
            >
              <Send className="h-3.5 w-3.5" strokeWidth={1.5} />
              Text me a test
            </Button>
          </div>
        </Card>

        <Card className="p-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold tracking-tight">Carrier registration</h2>
            <Badge variant="ok">Approved</Badge>
          </div>
          <p className="mt-1 text-[13px] text-text-2">
            Carriers only deliver business texts from registered senders.
          </p>
          <div className="mt-3.5">
            {regRows.map(([title, date], i) => (
              <SetRow
                key={title}
                first={i === 0}
                center
                title={
                  <span className="flex items-center gap-2.5 font-normal">
                    <ChannelIcon icon={Check} tone="success" size={24} />
                    {title}
                  </span>
                }
              >
                <span className="text-xs text-text-3">
                  {date ? `Approved ${formatDate(date)}` : 'Approved'}
                </span>
              </SetRow>
            ))}
          </div>
          <Button variant="ghost" size="sm" className="-ml-2.5 mt-1.5" onClick={onViewSent}>
            View what we sent
          </Button>
        </Card>

        <Card className="p-6">
          <h2 className="text-lg font-semibold tracking-tight">Texting rules</h2>
          <div className="mt-2">
            <SetRow
              first
              title="Quiet hours"
              description="Automatic texts wait until morning. People on the team get a “send anyway?” check first."
              body={
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Select
                    selectSize="sm"
                    className="w-[110px]"
                    aria-label="Quiet hours start"
                    disabled={!quiet.enabled}
                    value={quiet.start}
                    onChange={(e) =>
                      setQuietHours({ ...quiet, start: e.target.value }, 'Quiet hours saved')
                    }
                  >
                    {START_TIMES.map((t) => (
                      <option key={t} value={t}>
                        {formatClock(t)}
                      </option>
                    ))}
                  </Select>
                  <span className="text-[13px] text-text-3">to</span>
                  <Select
                    selectSize="sm"
                    className="w-[110px]"
                    aria-label="Quiet hours end"
                    disabled={!quiet.enabled}
                    value={quiet.end}
                    onChange={(e) =>
                      setQuietHours({ ...quiet, end: e.target.value }, 'Quiet hours saved')
                    }
                  >
                    {END_TIMES.map((t) => (
                      <option key={t} value={t}>
                        {formatClock(t)}
                      </option>
                    ))}
                  </Select>
                  <span className="text-xs text-text-3">{city} time</span>
                </div>
              }
            >
              <Switch
                checked={quiet.enabled}
                label="Quiet hours"
                testId="quiet-hours-switch"
                onChange={(on) =>
                  setQuietHours(
                    { ...quiet, enabled: on },
                    on ? 'Quiet hours on' : 'Quiet hours off',
                  )
                }
              />
            </SetRow>
            <SetRow
              title="Remind the team when a customer waits"
              description="One email to whoever the conversation is assigned to, or to every owner and admin when nobody is."
            >
              <Select
                selectSize="sm"
                className="w-[130px]"
                aria-label="Remind after"
                value={String(reminder)}
                onChange={(e) => {
                  const minutes = Number(e.target.value);
                  setReminder(minutes);
                  void save(
                    { unansweredReminderMinutes: minutes },
                    minutes === 0
                      ? 'Reminders off'
                      : `Reminders after ${label(
                          REMINDERS.map(([m, l]) => [String(m), l] as const),
                          String(minutes),
                        )}`,
                  );
                }}
              >
                {REMINDERS.map(([m, l]) => (
                  <option key={m} value={m}>
                    {l}
                  </option>
                ))}
              </Select>
            </SetRow>
            <SetRow
              center
              title="STOP, START and HELP"
              description="Handled automatically. Opted-out customers can’t be texted until they text START."
            >
              <Badge variant="gray">Always on</Badge>
            </SetRow>
          </div>
        </Card>
      </div>

      <div className="flex flex-col gap-5">
        <CallsCard routing={calls.routing} save={calls.save} update={calls.update} team={team} />
        <CallerIdCard
          workspaceId={workspaceId}
          phoneNumberId={n.id}
          display={n.display}
          initial={n.routing.forwardedCallerId}
        />
        <VoicemailCard
          routing={calls.routing}
          save={calls.save}
          update={calls.update}
          businessName={businessName}
        />
      </div>

      <TestTextDialog
        workspaceId={workspaceId}
        businessName={businessName}
        defaultPhone={contactPhone}
        open={test}
        onOpenChange={setTest}
      />
    </div>
  );
}

type Routing = PhoneNumberInfo['routing'];
type RoutingChange = (routing: Routing) => Routing;
type RoutingSave = (change: RoutingChange, opts?: { optimistic?: boolean }) => Promise<void>;
type RoutingUpdate = (change: RoutingChange, success: string) => void;
type Issue = { path?: string; message?: string };

/** The design's choices, the default first (the core allows 10 to 25). */
const RING_SECONDS: readonly number[] = [20, 15, 25];
const MAX_PHONES = 3;
/** The core schema's limit for the voicemail greeting. */
const GREETING_MAX = 500;

const defaultGreeting = (businessName: string) =>
  `You’ve reached ${businessName}. Leave your name, number and what you need, and we’ll call you back today.`;

/** "Dale", "Dale and Priya", "Dale, Priya and Marco". */
function listNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The command's field problems when it refused the input, else null. */
function validationIssues(err: unknown): Issue[] | null {
  return err instanceof ApiError && err.code === 'validation' && Array.isArray(err.details)
    ? (err.details as Issue[])
    : null;
}

/**
 * Who rings and for how long, as the page shows it: what the server last accepted plus the flips still on
 * their way. Saves go one at a time, and each applies its change to what the server last accepted, so quick
 * flips never overwrite each other. Every save sends the whole routing, as the command expects.
 */
function useRouting(workspaceId: string, number: PhoneNumberInfo) {
  const router = useRouter();
  const [routing, setRouting] = useState<Routing>(number.routing);
  const saved = useRef<Routing>(number.routing);
  const pending = useRef<RoutingChange[]>([]);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const show = () => setRouting(pending.current.reduce((r, change) => change(r), saved.current));

  /** Resolves once saved and rejects with the command's error. Optimistic changes show before it answers. */
  const save: RoutingSave = (change, { optimistic = true } = {}) => {
    if (optimistic) {
      pending.current = [...pending.current, change];
      show();
    }
    const job = queue.current.then(async () => {
      const next = change(saved.current);
      // What forwarded phones show is its own choice (CallerIdCard): left out, the number keeps it.
      const { forwardedCallerId: _own, ...routing } = next;
      try {
        unwrap(
          await apiBrowser().POST('/v1/commands/phone_number.set_routing', {
            body: { workspaceId, phoneNumberId: number.id, routing },
          }),
        );
        saved.current = next;
        router.refresh();
      } finally {
        pending.current = pending.current.filter((c) => c !== change);
        show();
      }
    });
    queue.current = job.catch(() => undefined);
    return job;
  };

  /** Saves at once, then a short confirmation (or the error). */
  const update: RoutingUpdate = (change, success) => {
    void save(change).then(
      () => {
        toast.success(success);
      },
      (e: unknown) => {
        toast.error(errorMessage(e));
      },
    );
  };

  return { routing, save, update };
}

function CallsCard({
  routing,
  save,
  update,
  team,
}: {
  routing: Routing;
  save: RoutingSave;
  update: RoutingUpdate;
  team: string[];
}) {
  const uid = useId();
  const addPhoneId = `${uid}-add-phone`;
  const errorId = `${uid}-add-error`;
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [phone, setPhone] = useState('');
  const [errors, setErrors] = useState<{ label?: string; phone?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const refocus = useRef(false);
  const phones = routing.forwarding;
  const ringOptions = RING_SECONDS.includes(routing.ringSeconds)
    ? RING_SECONDS
    : [...RING_SECONDS, routing.ringSeconds];

  // Once the add form closes, the keyboard goes back to "Add a phone" instead of the top of the page.
  useEffect(() => {
    if (adding || !refocus.current) return;
    refocus.current = false;
    document.getElementById(addPhoneId)?.focus();
  }, [adding, addPhoneId]);

  function close() {
    refocus.current = true;
    setAdding(false);
    setLabel('');
    setPhone('');
    setErrors({});
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    const name = label.trim();
    const typed = phone.trim();
    if (!name || !typed) {
      setErrors({
        label: name ? undefined : 'Name this phone.',
        phone: typed ? undefined : 'Enter a phone number.',
      });
      return;
    }
    setErrors({});
    setBusy(true);
    // The core schema normalizes the same way; a number it can't read goes as typed so it says why.
    const e164 = normalizePhone(typed) ?? typed;
    let index = -1;
    try {
      await save(
        (r) => {
          index = r.forwarding.length;
          return { ...r, forwarding: [...r.forwarding, { e164, label: name, enabled: true }] };
        },
        { optimistic: false },
      );
      toast.success(`${name} rings on the next call`);
      close();
    } catch (err) {
      const issues = validationIssues(err);
      if (!issues) {
        toast.error(errorMessage(err));
        return;
      }
      const next: typeof errors = {};
      for (const issue of issues) {
        const key =
          issue.path === `routing.forwarding.${index}.e164`
            ? 'phone'
            : issue.path === `routing.forwarding.${index}.label`
              ? 'label'
              : 'form';
        next[key] ??= issue.message ?? 'Check this.';
      }
      setErrors(next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-6">
      <h2 className="text-lg font-semibold tracking-tight">When a customer calls</h2>
      <p className="mt-1 text-[13px] text-text-2">
        Everything below rings at the same time. The first to answer takes the call.
      </p>
      <div className="mt-3.5 flex items-center gap-3 pb-3 pt-1">
        <ChannelIcon icon={Globe} />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">Team browsers</div>
          <div className="text-xs text-text-3">
            {team.length > 0
              ? `Anyone with HandsFreeOS open: ${listNames(team)}`
              : 'Anyone with HandsFreeOS open'}
          </div>
        </div>
        <Badge variant="gray">Always</Badge>
      </div>
      {phones.map((p) => {
        const nameId = `${uid}-phone-${p.e164}`;
        return (
          <div
            key={p.e164}
            role="group"
            aria-labelledby={nameId}
            className="flex items-center gap-3 border-t border-border py-3"
          >
            <ChannelIcon icon={Phone} />
            <div className="min-w-0 flex-1">
              <div id={nameId} className="truncate text-[13px] font-medium">
                {p.label}
              </div>
              <div className="font-mono text-xs text-text-3">{formatPhone(p.e164)}</div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              title="Remove"
              aria-label={`Remove ${p.label}`}
              onClick={() =>
                update(
                  (r) => ({ ...r, forwarding: r.forwarding.filter((f) => f.e164 !== p.e164) }),
                  `${p.label} removed`,
                )
              }
            >
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
            </Button>
            <Switch
              checked={p.enabled}
              label="Ring this phone"
              onChange={(on) =>
                update(
                  (r) => ({
                    ...r,
                    forwarding: r.forwarding.map((f) =>
                      f.e164 === p.e164 ? { ...f, enabled: on } : f,
                    ),
                  }),
                  on ? `${p.label} rings now` : `${p.label} won’t ring`,
                )
              }
            />
          </div>
        );
      })}
      {adding ? (
        <form
          noValidate
          onSubmit={(e) => void add(e)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
          }}
          className="border-t border-border py-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Input
              inputSize="sm"
              autoFocus
              aria-label="Phone name"
              placeholder="Name, like Priya’s cell"
              maxLength={40}
              className="min-w-[140px] flex-1"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              invalid={!!errors.label}
              aria-describedby={errors.label ? errorId : undefined}
            />
            <Input
              inputSize="sm"
              aria-label="Phone number"
              placeholder="(713) 555-0123"
              inputMode="tel"
              maxLength={40}
              className="w-[150px] flex-none font-mono text-[13px]"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              invalid={!!errors.phone}
              aria-describedby={errors.phone ? errorId : undefined}
            />
            <div className="flex gap-2">
              <Button type="submit" size="sm" loading={busy}>
                Add
              </Button>
              <Button variant="ghost" size="sm" onClick={close}>
                Cancel
              </Button>
            </div>
          </div>
          <FieldError id={errorId}>{errors.label ?? errors.phone ?? errors.form}</FieldError>
        </form>
      ) : null}
      <div className="mt-2.5 flex items-center justify-between gap-3">
        <Button
          id={addPhoneId}
          variant="ghost"
          size="sm"
          className="-ml-2.5"
          disabled={phones.length >= MAX_PHONES || adding}
          onClick={() => setAdding(true)}
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
          Add a phone
        </Button>
        <span className="text-xs text-text-3">{`${phones.length} of ${MAX_PHONES} phones`}</span>
      </div>
      <SetRow center title="Ring for" className="mt-2">
        <Select
          selectSize="sm"
          className="w-[130px]"
          aria-label="Ring for"
          value={String(routing.ringSeconds)}
          onChange={(e) => {
            const seconds = Number(e.target.value);
            update((r) => ({ ...r, ringSeconds: seconds }), `Rings for ${seconds} seconds`);
          }}
        >
          {ringOptions.map((s) => (
            <option key={s} value={s}>
              {`${s} seconds`}
            </option>
          ))}
        </Select>
      </SetRow>
      <Callout tone="info" icon={Info} className="mt-1.5">
        <span className="text-[13px]">
          Forwarded phones hear “Press 1 to take this call,” so a cell’s own voicemail can never
          grab the call first.
        </span>
      </Callout>
    </Card>
  );
}

/**
 * What a forwarded phone shows when a customer calls the business number (M10): the customer's number, or the
 * business's. iOS 26's call screening sends callers a phone doesn't know to voicemail, so a person who turned it on
 * saves the business number as a contact and picks the business number here; the whisper still names the caller.
 */
function CallerIdCard({
  workspaceId,
  phoneNumberId,
  display,
  initial,
}: {
  workspaceId: string;
  phoneNumberId: string;
  display: string;
  initial: 'customer' | 'business';
}) {
  const router = useRouter();
  const [choice, setChoice] = useState(initial);
  const [busy, setBusy] = useState(false);

  async function choose(next: 'customer' | 'business') {
    if (next === choice || busy) return;
    const was = choice;
    setChoice(next);
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/phone_number.set_caller_id', {
          body: { workspaceId, phoneNumberId, forwardedCallerId: next },
        }),
      );
      toast.success(
        next === 'business'
          ? `Forwarded phones show ${display}`
          : 'Forwarded phones show the customer’s number',
      );
      router.refresh();
    } catch (e) {
      setChoice(was);
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-6" data-testid="caller-id">
      <h2 className="text-lg font-semibold tracking-tight">What forwarded phones show</h2>
      <p className="mt-1 text-[13px] text-text-2">
        When a customer calls and a phone above rings, its screen shows one of these. Either way,
        the phone hears who is calling before pressing 1.
      </p>
      <div
        role="radiogroup"
        aria-label="What forwarded phones show"
        className="mt-3.5 flex flex-col gap-2.5"
      >
        <RadioCard
          selected={choice === 'customer'}
          onSelect={() => void choose('customer')}
          title="The customer’s number"
          description="You see who is calling before you pick up."
          testId="caller-id-customer"
        />
        <RadioCard
          selected={choice === 'business'}
          onSelect={() => void choose('business')}
          title={`The business number, ${display}`}
          description="Every call rings through on a phone that screens or silences unknown callers, once the business number is saved as a contact on it."
          testId="caller-id-business"
        />
      </div>
      <Callout tone="neutral" icon={Info} className="mt-3">
        <span className="text-[13px]">
          iPhones that screen unknown callers send calls from numbers they don’t know to voicemail,
          including forwarded customers. Save {display} as a contact on each forwarded phone and
          pick the business number here.
        </span>
      </Callout>
    </Card>
  );
}

function VoicemailCard({
  routing,
  save,
  update,
  businessName,
}: {
  routing: Routing;
  save: RoutingSave;
  update: RoutingUpdate;
  businessName: string;
}) {
  const [greeting, setGreeting] = useState(
    () => routing.voicemailGreeting || defaultGreeting(businessName),
  );
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  // A greeting still reading aloud stops when the page goes.
  useEffect(
    () => () => {
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    },
    [],
  );

  function play() {
    if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
      toast.error('Your browser can’t play the greeting');
      return;
    }
    const speech = new SpeechSynthesisUtterance(greeting.trim() || defaultGreeting(businessName));
    speech.lang = 'en-US';
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(speech);
  }

  async function saveGreeting() {
    setSaving(true);
    setError(undefined);
    const text = greeting.trim();
    try {
      await save((r) => ({ ...r, voicemailGreeting: text || null }), { optimistic: false });
      toast.success('Greeting saved');
    } catch (err) {
      const issue = validationIssues(err)?.find((i) => i.path === 'routing.voicemailGreeting');
      if (issue?.message) setError(issue.message);
      else toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Voicemail</h2>
          <p className="mt-1 text-[13px] text-text-2">
            When nobody answers, callers can leave a message.
          </p>
        </div>
        <Switch
          checked={routing.voicemailEnabled}
          label="Voicemail"
          onChange={(on) =>
            update((r) => ({ ...r, voicemailEnabled: on }), on ? 'Voicemail on' : 'Voicemail off')
          }
        />
      </div>
      {routing.voicemailEnabled ? (
        <>
          <Field
            label="Greeting"
            htmlFor="voicemail-greeting"
            className="mb-3.5 mt-4"
            error={error}
            hint="Read aloud by a natural-sounding voice. Messages and their transcripts land in the inbox."
          >
            <Textarea
              id="voicemail-greeting"
              className="min-h-[76px]"
              maxLength={GREETING_MAX}
              value={greeting}
              onChange={(e) => setGreeting(e.target.value)}
              invalid={!!error}
              aria-describedby={error ? 'voicemail-greeting-error' : undefined}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={play}>
              <Volume2 className="h-3.5 w-3.5" strokeWidth={1.5} />
              Play greeting
            </Button>
            <Button size="sm" loading={saving} onClick={() => void saveGreeting()}>
              Save
            </Button>
          </div>
        </>
      ) : null}
    </Card>
  );
}
