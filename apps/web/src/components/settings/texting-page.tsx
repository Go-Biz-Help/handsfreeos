'use client';
import {
  guidedSetupSavedWhen,
  money,
  ownSiteBoxText,
  PHONE_SETUP_WORDS,
  sendsOffers,
  type BusinessAddress,
} from '@hfos/core';
import {
  Check,
  CircleAlert,
  Clock,
  Copy,
  MessageCircle,
  MoreHorizontal,
  Phone,
  Search,
  Trash2,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { InboxVisibilityCard } from '@/components/settings/inbox-visibility-card';
import { NumbersCard, type Ringable } from '@/components/settings/numbers-card';
import { A2pWizard, CopyButton, type HostedSurfaces } from '@/components/settings/a2p-wizard';
import { HideChatSwitch, WebPersonButton } from '@/components/settings/web-person';
import type { LetterProfile } from '@/components/settings/port-letter';
import {
  BringNumberStep,
  ImportsCard,
  type NumberImportInfo,
  type TwilioConnections,
} from '@/components/settings/number-import';
import { PhoneAccountCard } from '@/components/settings/phone-account-card';
import { PhoneCard } from '@/components/settings/phone-card';
import { PortStep, type MigratedNumber, type PortInfo } from '@/components/settings/port-step';
import { ChannelIcon, Pill } from '@/components/inbox/bits';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FieldError, Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { RadioCard } from '@/components/ui/radio-card';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type {
  PhoneNumberInfo,
  PhoneSetupStatus,
  RegistrationInfo,
  RegistrationSubmitBody,
} from '@/lib/api/types';
import { searchNumbers, type AvailableNumber } from '@/lib/api/worker';
import { formatDate } from '@/lib/format';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { setupHref } from '@/lib/setup';
import { keepSetupReturn, setupReturnFor } from '@/lib/setup-return';
import { cn } from '@/lib/utils';
import { RcsCard, type RcsPrefill } from './rcs-card';
import { ReleaseNumberDialog } from './release-number-dialog';

type Status = PhoneSetupStatus;
const START = PHONE_SETUP_WORDS.startCard;
export type NumberType = 'local' | 'toll_free';

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
  businessWebsite = null,
  businessAddress = null,
  status,
  me,
  people,
  ports,
  portsFromMigration,
  imports,
  importsFromMigration,
  twilio,
  inboxPerPerson,
  surfaces,
  registrationDraft = null,
  guidedDraft = null,
  industry = null,
  bring = null,
  setup,
}: {
  workspaceId: string;
  businessName: string;
  /** The kind of business, which texting approval's example texts are worded for. */
  industry?: string | null;
  /** The website the business already gave (Settings → Workspace), which a first registration starts from. */
  businessWebsite?: string | null;
  /** The address setup asked for, which a first registration starts from too. */
  businessAddress?: BusinessAddress | null;
  status: Status;
  me: { fullName: string; email: string };
  /** Everyone who works the inbox, for choosing who a number rings (M17). */
  people: Ringable[];
  /** Numbers being brought from another carrier, newest first (M17). */
  ports: readonly PortInfo[];
  /** Numbers a migration found the business using that are not on their way here yet (M11). */
  portsFromMigration: readonly MigratedNumber[];
  /**
   * Numbers already in Twilio on their way here, from the business's own Twilio account or GoHighLevel
   * (20261010000900). Each carries its own setup status and, separately, its texting registration's.
   */
  imports: readonly NumberImportInfo[];
  /** The migration's numbers that are neither on their way by a port nor by a transfer. */
  importsFromMigration: readonly MigratedNumber[];
  /** The Twilio accounts this organization connected, and where their numbers may go. */
  twilio: TwilioConnections;
  /** Whether each person sees only their own threads (M17). Shown beside "who this number rings". */
  inboxPerPerson: boolean;
  /**
   * What is already public for this business: the booking site's slug, a live chat widget, a live form.
   * The registration wizard needs them to know what its hosted opt-in still has to create, and to write
   * addresses a carrier can open into the sentence it sends.
   */
  surfaces: HostedSurfaces;
  /** The registration's answers as they were left (`registration.get_draft`), for the wizard to pick up. */
  registrationDraft?: Record<string, unknown> | null;
  /** When the guided phone setup's answers were last saved, if it was started and left (`guided_setup.get_draft`). */
  guidedDraft?: { readonly savedAt: string } | null;
  /**
   * `?bring=`: the guided phone setup's first question said the number they have is staying with them, so the page
   * opens on moving it here: `carrier` on the port from a phone company, `choose` on where the number is today.
   */
  bring?: 'carrier' | 'choose' | null;
  /**
   * Shown inside setup (HANDSFREEOS_ONBOARDING_IMPLEMENTATION_PLAN.md §6, and the onboarding quick setup): the kind
   * of number its EIN question picked, and none of the account's own settings, which aren't a first-day question.
   * `returnTo` is where Stripe's texting fee page comes back to (the wizard's number step when left out), and with
   * `nearAddress` a local number is looked for near the business's address straight away.
   */
  setup?: { numberType: NumberType; returnTo?: string; nearAddress?: boolean };
}) {
  useLiveRefresh([
    'phone_number',
    'registration',
    'number_port',
    'number_import',
    'twilio_connection',
    'workspace',
    'rcs_sender',
  ]);
  const router = useRouter();
  // Back from paying a texting fee: Stripe's page returns everyone here, so whoever paid from setup's number step
  // goes back there, with the same word on how it went (lib/setup-return.ts).
  useEffect(() => {
    if (setup || !new URLSearchParams(window.location.search).has('fees')) return;
    const here = `${window.location.pathname}${window.location.search}`;
    const back = setupReturnFor(here);
    if (back !== here) router.replace(back);
  }, [setup, router]);
  // Buying and releasing take seconds: check again every few, in case the live channel is down.
  const busy = status.nextStep === 'provisioning' || status.nextStep === 'releasing';
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(timer);
  }, [busy, router]);
  const [fixing, setFixing] = useState(false);
  const [showSent, setShowSent] = useState(false);
  // In setup: where Stripe's texting fee page comes back to, through Settings.
  const setupReturn = setup ? (setup.returnTo ?? setupHref(workspaceId, 'number')) : null;
  const near =
    setup?.nearAddress && businessAddress
      ? { city: businessAddress.city, state: businessAddress.state }
      : null;
  // Just sent a registration with fees to pay: off to the payment page as soon as it is made.
  const [goPay, setGoPay] = useState(false);
  // Sent: the page shows what went, and any fees, at once. The live channel leaves this tab's own changes to it
  // (lib/api/own-requests.ts), and while fees are owed nothing else changes until they're paid.
  const sent = (fee: { id: string } | null) => {
    if (fee) setGoPay(true);
    router.refresh();
  };
  // A business that already has a number and wants another. There is no `nextStep` for this — the wizard is
  // about getting a first number working — so it is local state that drops back into the same buy screen.
  const [adding, setAdding] = useState(false);
  // Moving a number here rather than buying one: from the guided setup's first question (`?bring=`), or from
  // "Phone account and transfers".
  const [bringing, setBringing] = useState<'carrier' | 'choose' | null>(setup ? null : bring);
  // "Phone account and transfers": the business's phone account, and moving a number here.
  const [more, setMore] = useState(false);
  const guided = `/onboarding/${workspaceId}/phone`;
  // Texting approval's own guided page. Sign-up's number step keeps the questions on its own screen.
  const approvalPage = setup ? null : `/onboarding/${workspaceId}/texting`;
  const submission = latestSubmission(status.registrations);
  const porting: Porting = {
    fromMigration: portsFromMigration,
    profile: letterProfileOf(businessName, submission, me),
    imports,
    importsFromMigration,
    twilio,
  };
  // A number is on its way here, or a migration found one to bring: the screens for moving it are what to show.
  const moving =
    ports.some((p) => p.status !== 'cancelled' && p.status !== 'complete') ||
    portsFromMigration.length > 0 ||
    imports.some((i) => i.status === 'waiting');
  // Every number on its way here from Twilio or HighLevel, above whatever else the page shows: the request to
  // copy lives on it, and a business checking back comes here for exactly that.
  const importsCard = (
    <ImportsCard workspaceId={workspaceId} businessName={businessName} imports={imports} />
  );
  // Phone & texting on or off, and the business's Twilio Account SID. Behind "Phone account and transfers" (the
  // owner's pick 4a) until a number is being moved here, which starts with giving that SID to HighLevel or Twilio.
  const accountCard =
    !setup && (more || adding || !!bringing || moving) ? (
      <PhoneAccountCard workspaceId={workspaceId} />
    ) : null;
  const sentSheet = (
    <SubmissionSheet open={showSent} onOpenChange={setShowSent} submission={submission} />
  );
  // Under the phone account, behind the same link: a number the business already has, moved here.
  const moveCard = status.canManage ? (
    <Card className="max-w-[820px] p-5 md:p-6">
      <h2 className="text-lg font-semibold tracking-tight">Move a number here</h2>
      <p className="mt-1 text-[13px] text-text-2">
        Bring a number you already have from your phone company, Twilio or HighLevel. Customers keep
        using the number they know.
      </p>
      <Button
        variant="secondary"
        className="mt-3.5"
        onClick={() => {
          setBringing('choose');
          // Beside a number the business has, it is one more number; with none, it is the way to the first.
          if (status.numbers.length > 0) setAdding(true);
        }}
        data-testid="phone-more-bring"
      >
        Move a number
      </Button>
    </Card>
  ) : null;

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
        {accountCard}
        {importsCard}
        {numbersCard}
        <Card
          className="max-w-[820px] p-5 md:p-7"
          data-testid="texting-setup"
          data-step="add_number"
        >
          <button
            type="button"
            onClick={() => {
              setAdding(false);
              setBringing(null);
            }}
            className="text-[13px] text-text-3 hover:text-text"
            data-testid="numbers-add-cancel"
          >
            ← Back to your numbers
          </button>
          <div className="mt-3">
            <NumberStep
              workspaceId={workspaceId}
              failed={null}
              ports={ports}
              porting={porting}
              bring={bringing}
            />
          </div>
        </Card>
      </div>
    );

  // Numbers a migration found that nothing here has picked up yet. Mid-setup the port screen offers them
  // itself; once a business is set up the port screen is behind "Add a number", so it is said out loud here.
  const migratedCallout = portsFromMigration.length ? (
    <Callout
      tone="info"
      icon={Phone}
      className="max-w-[820px]"
      action={
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setAdding(true)}
          data-testid="migrated-bring"
        >
          Bring {portsFromMigration.length === 1 ? 'it' : 'them'} here
        </Button>
      }
      data-testid="migrated-numbers"
    >
      Your migration found customers texting and calling{' '}
      {portsFromMigration.length === 1
        ? portsFromMigration[0]!.display
        : `${portsFromMigration.length} numbers`}{' '}
      that {portsFromMigration.length === 1 ? 'is' : 'are'} not here yet. Move{' '}
      {portsFromMigration.length === 1 ? 'it' : 'them'} over and customers keep dialing what they
      always have.
    </Callout>
  ) : null;

  const step = status.nextStep;
  // In setup: the number is still being worked on there, one step at a time, until the carriers approve it.
  const working =
    status.number?.status === 'active' && (!setup || step === 'ready') ? status.number : null;
  // Calls only: the business said it doesn't text (the guided setup's second question), so nothing asks it to
  // register until it turns texting on.
  const wantsTexting = status.settings.texting !== 'not_now' || step !== 'submit_registration';

  // What the carriers need, are looking at, or turned down.
  const approval = (number: PhoneNumberInfo) =>
    step === 'submit_registration' && approvalPage ? (
      <ApprovalStart
        href={approvalPage}
        started={!!registrationDraft}
        canManage={status.canManage}
      />
    ) : step === 'submit_registration' || fixing ? (
      <A2pWizard
        workspaceId={workspaceId}
        businessName={businessName}
        businessWebsite={businessWebsite}
        businessAddress={businessAddress}
        industry={industry}
        number={number}
        me={me}
        initial={fixing ? submission : null}
        draft={registrationDraft}
        surfaces={surfaces}
        onBack={fixing ? () => setFixing(false) : undefined}
        feesPaidFor={status.textingFees?.paidFor ?? null}
        onSubmitted={(fee) => {
          setFixing(false);
          sent(fee);
        }}
      />
    ) : step === 'rejected' ? (
      <Rejected
        workspaceId={workspaceId}
        status={status}
        businessName={businessName}
        surfaces={surfaces}
        onFix={() => (approvalPage ? router.push(`${approvalPage}?fix=1`) : setFixing(true))}
        onViewSent={() => setShowSent(true)}
      />
    ) : (
      <Review
        workspaceId={workspaceId}
        status={status}
        businessName={businessName}
        surfaces={surfaces}
        onViewSent={() => setShowSent(true)}
      />
    );
  const current =
    step === 'buy_number' || step === 'provisioning' || step === 'releasing' || step === 'porting'
      ? 0
      : step === 'submit_registration' || fixing
        ? 1
        : 2;
  const feeDue = (hidden: boolean) =>
    status.textingFees?.due && !fixing && !hidden ? (
      <TextingFeeDue
        workspaceId={workspaceId}
        fee={status.textingFees.due}
        goPay={goPay}
        setupReturn={setupReturn}
        ours={status.textingFees.paidFor.ours}
      />
    ) : null;

  // The business has its number: one card that says what it does, and under it whatever texting still needs.
  if (working)
    return (
      <div className="flex flex-col gap-5">
        {importsCard}
        {migratedCallout}
        <PhoneCard
          workspaceId={workspaceId}
          businessName={businessName}
          status={status}
          number={working}
          contactPhone={String(
            (submission?.['contact'] as { phone?: string } | undefined)?.phone ?? '',
          )}
          onViewSent={() => setShowSent(true)}
          onAdd={numbersCard ? null : () => setAdding(true)}
          onMore={setup ? null : () => setMore((open) => !open)}
          setup={!!setup}
          feeDue={
            status.textingFees?.month ? (
              <TextingFeeDue
                workspaceId={workspaceId}
                fee={status.textingFees.month}
                goPay={false}
                ours={status.textingFees.paidFor.ours}
              />
            ) : null
          }
        />
        {step !== 'ready' && wantsTexting ? (
          <Card
            id="approval"
            className="max-w-[820px] scroll-mt-20 p-5 md:p-7"
            data-testid="texting-setup"
            data-step={step}
          >
            <Steps current={current} turnedDown={step === 'rejected' && !fixing} />
            {feeDue(false)}
            {approval(working)}
          </Card>
        ) : null}
        {step === 'ready' ? (
          <div className="max-w-[820px]">
            <RcsCard
              workspaceId={workspaceId}
              businessName={businessName}
              sender={status.rcsSender}
              request={status.rcsRequest}
              prefill={rcsPrefillOf(submission, working)}
              numbers={status.numbers}
              canManage={status.canManage}
            />
          </div>
        ) : null}
        {numbersCard}
        {visibilityCard}
        {more ? (
          <div className="flex flex-col gap-5" data-testid="phone-more">
            {accountCard}
            {moveCard}
          </div>
        ) : null}
        {sentSheet}
      </div>
    );

  /*
   * A local number's texting registration doesn't need the number here, so a business without a working one
   * (it is moving its own here, or hasn't got one yet) can send it now and text the day the number lands.
   * Not for a toll-free number on its way: its verification is for that number, and waits for it.
   */
  const arrivingPort = status.numbers.find((n) => n.status === 'porting');
  const arrivingImport = imports.find((i) => i.status === 'waiting');
  const arriving = arrivingPort ?? arrivingImport ?? null;
  const ahead =
    (step === 'buy_number' || step === 'porting') &&
    arriving?.numberType !== 'toll_free' &&
    (status.canManage || status.localRegistrationStep !== 'submit_registration')
      ? { arriving: arriving ? arriving.display : null }
      : null;
  const registerAhead = ahead ? (
    <RegisterAhead
      workspaceId={workspaceId}
      businessName={businessName}
      businessWebsite={businessWebsite}
      businessAddress={businessAddress}
      status={status}
      me={me}
      surfaces={surfaces}
      draft={registrationDraft}
      submission={submission}
      industry={industry}
      approvalPage={approvalPage}
      arriving={ahead.arriving}
      onViewSent={() => setShowSent(true)}
      goPay={goPay}
      setupReturn={setupReturn}
      onSent={sent}
    />
  ) : null;

  // No number yet, and none on its way: the guided setup gets it, one question at a time (the owner, 22 Nov 2026).
  // Sign-up's own number step keeps its screen until sign-up itself is redone.
  if (!setup && step === 'buy_number' && !bringing && !moving) {
    const failed = status.number?.status === 'failed' ? status.number : null;
    // A registration already sent ahead of the number is news; one not started is behind the link with the rest.
    const sentAhead = status.localRegistrationStep !== 'submit_registration';
    return (
      <div className="flex flex-col gap-5">
        {importsCard}
        <Card className="max-w-[820px] p-5 md:p-7" data-testid="phone-start">
          <div className="flex items-start gap-3.5">
            <ChannelIcon icon={Phone} size={44} />
            <div className="min-w-0">
              <h2 className="text-lg font-semibold tracking-tight">{START.title}</h2>
              <p className="mt-1 max-w-[560px] text-[13.5px] text-text-2">{START.hint}</p>
            </div>
          </div>
          {failed ? (
            <Callout tone="danger" icon={CircleAlert} className="mt-4">
              We couldn’t get {failed.display}
              {failed.lastError ? `: ${failed.lastError}` : '.'} Nothing was bought. Pick another
              number.
            </Callout>
          ) : null}
          {status.canManage ? (
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <ButtonLink href={guided} variant="primary" size="lg" data-testid="phone-start-go">
                {guidedDraft ? START.carryOn : START.start}
              </ButtonLink>
              {guidedDraft ? (
                <span className="text-[13px] text-text-2" data-testid="phone-start-saved">
                  {START.saved(guidedSetupSavedWhen(guidedDraft.savedAt, new Date()))}
                </span>
              ) : null}
            </div>
          ) : (
            <p className="mt-4 text-[13px] text-text-3">
              Ask an owner or admin of this business to get the number.
            </p>
          )}
          <div className="mt-5 border-t border-border pt-4 text-[13px]">
            <button
              type="button"
              onClick={() => setMore((open) => !open)}
              className="text-accent-text hover:underline"
              data-testid="phone-more-link"
            >
              {PHONE_SETUP_WORDS.card.account}
            </button>
          </div>
        </Card>
        {sentAhead ? registerAhead : null}
        {more ? (
          <div className="flex flex-col gap-5" data-testid="phone-more">
            {accountCard}
            {moveCard}
            {sentAhead ? null : registerAhead}
          </div>
        ) : null}
        {sentSheet}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {accountCard}
      {importsCard}
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
        {feeDue(!!ahead)}
        {step === 'buy_number' ? (
          <NumberStep
            workspaceId={workspaceId}
            failed={status.number?.status === 'failed' ? status.number : null}
            ports={ports}
            porting={porting}
            numberType={setup?.numberType}
            near={near}
            bring={bringing}
            // Outside sign-up a new number is the guided setup's to get.
            onNew={setup ? undefined : () => router.push(guided)}
          />
        ) : step === 'porting' ? (
          // Weeks with a carrier, not seconds with us, so it is its own screen rather than the spinner that
          // `provisioning` gets: there is a status, a moving day and a way out, and a business checking back
          // every few days needs all three.
          <PortStep
            workspaceId={workspaceId}
            ports={ports}
            fromMigration={porting.fromMigration}
            profile={porting.profile}
            onBack={() => setAdding(true)}
          />
        ) : step === 'provisioning' || step === 'releasing' ? (
          <div className="flex items-center gap-3 py-6 text-[13.5px] text-text-2" role="status">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            {step === 'provisioning'
              ? `Setting up ${status.number?.display ?? 'your number'}. This takes a few seconds.`
              : `Releasing ${status.number?.display ?? 'the number'}.`}
          </div>
        ) : (
          approval(status.number!)
        )}
        {sentSheet}
      </Card>
      {registerAhead}
    </div>
  );
}

/** What the port screen needs besides the ports themselves, and the Twilio transfer screens beside it. */
interface Porting {
  readonly fromMigration: readonly MigratedNumber[];
  readonly profile: LetterProfile;
  readonly imports: readonly NumberImportInfo[];
  readonly importsFromMigration: readonly MigratedNumber[];
  readonly twilio: TwilioConnections;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Twilio's letter of authorisation, filled in from the carrier registration: the one place a business has already
 * written its legal name, its address and who to talk to down for a carrier. The person signed in stands in for
 * the name until there is a registration. The phone bill may say something else, and the form says to check.
 */
function letterProfileOf(
  businessName: string,
  submission: Record<string, unknown> | null,
  me: { fullName: string; email: string },
): LetterProfile {
  const s = submission ?? {};
  const address = (s['address'] ?? {}) as Record<string, unknown>;
  const contact = (s['contact'] ?? {}) as Record<string, unknown>;
  const [meFirst = '', ...meRest] = me.fullName.trim().split(/\s+/);
  const first = text(contact['firstName']);
  const last = text(contact['lastName']);
  return {
    businessName: text(s['legalName']) || businessName,
    firstName: first || (last ? '' : meFirst),
    lastName: last || (first ? '' : meRest.join(' ')),
    street: text(address['line1']),
    city: text(address['city']),
    state: text(address['state']),
    zip: text(address['postalCode']),
  };
}

/**
 * What the RCS request form starts from: what the business already told the carriers for texting, which the
 * RCS review checks the same things against. The business number stands in for a contact phone.
 */
function rcsPrefillOf(
  submission: Record<string, unknown> | null,
  number: PhoneNumberInfo,
): RcsPrefill {
  const s = submission ?? {};
  const contact = (s['contact'] ?? {}) as Record<string, unknown>;
  return {
    website: text(s['website']),
    privacyUrl: text(s['privacyPageUrl']) || text(s['policyUrl']),
    termsUrl: text(s['termsPageUrl']) || text(s['termsUrl']),
    phone: number.display,
    email: text(contact['email']),
  };
}

function latestSubmission(regs: RegistrationInfo[]): Record<string, unknown> | null {
  const withData = regs
    .filter((r) => r.submission && Object.keys(r.submission).length > 0)
    .sort((a, b) => (b.submittedAt ?? '').localeCompare(a.submittedAt ?? ''));
  return withData[0]?.submission ?? null;
}

/**
 * Settings' way in to texting approval: what it is in two lines, and Start, which opens its guided page
 * (`/onboarding/<business>/texting`). With answers already saved, it says so and carries on from them.
 */
function ApprovalStart({
  href,
  started,
  canManage,
}: {
  href: string;
  started: boolean;
  canManage: boolean;
}) {
  return (
    <div data-testid="approval-start">
      <h2 className="text-lg font-semibold tracking-tight">Get approved to text</h2>
      <p className="mt-1 max-w-[62ch] text-[13.5px] leading-normal text-text-2">
        The phone carriers check every business before it can text. You answer 8 questions, we check
        your website the way their reviewer does, and then the carriers take 1 to 3 weeks. Calls
        work the whole time.
      </p>
      {canManage ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <ButtonLink href={href} variant="primary" data-testid="approval-start-go">
            {started ? 'Carry on where you left off' : 'Start'}
          </ButtonLink>
          {started ? (
            <span className="text-[13px] text-text-3">Your answers so far are saved.</span>
          ) : null}
        </div>
      ) : (
        <p className="mt-3 text-xs text-text-3">Owners and admins can send it.</p>
      )}
    </div>
  );
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
  porting,
  numberType = 'toll_free',
  near = null,
  bring = null,
  onNew,
}: {
  workspaceId: string;
  failed: PhoneNumberInfo | null;
  ports: readonly PortInfo[];
  porting: Porting;
  /** Open on moving a number here: `carrier` on the port screen, `choose` on where the number is today. */
  bring?: 'carrier' | 'choose' | null;
  /** Where "A new number instead" goes, when buying one isn't this screen's job (the guided setup's). */
  onNew?: () => void;
  /** The kind to search first. Toll-free unless the setup wizard's EIN question said local. */
  numberType?: NumberType;
  /** In setup: the business's city, where local numbers are looked for first, straight away. */
  near?: { city: string; state: string } | null;
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
    bring ||
      ports.some((p) => p.status !== 'cancelled' && p.status !== 'complete') ||
      porting.fromMigration.length > 0 ||
      porting.imports.some((i) => i.status === 'waiting')
      ? 'bring'
      : 'new',
  );
  const [type, setType] = useState<NumberType>(numberType);
  const [area, setArea] = useState('');
  const [prefix, setPrefix] = useState('');
  const [city, setCity] = useState(near?.city ?? '');
  const [region, setRegion] = useState(near?.state ?? '');
  const [digits, setDigits] = useState('');
  // '' is the city itself; anything else is a radius around it, in miles.
  const [miles, setMiles] = useState(near ? '25' : '');
  const [more, setMore] = useState(!!near);
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

  // In setup, local numbers near the business show straight away. Once, on the way in.
  const looked = useRef(false);
  useEffect(() => {
    if (looked.current || !near || type !== 'local' || source !== 'new') return;
    looked.current = true;
    void search();
  }, []);

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

  /*
   * Where the number is today decides how it moves (20261010000900): already in Twilio — the business's own
   * account, or GoHighLevel's LC Phone — it is transferred account to account in days; anywhere else it is a
   * carrier port. A port already under way goes straight back to the port screen.
   */
  const carrierPort = (onBack: () => void) => (
    <PortStep
      workspaceId={workspaceId}
      ports={ports}
      fromMigration={porting.fromMigration}
      profile={porting.profile}
      onBack={onBack}
      backLabel="← Somewhere else"
    />
  );
  if (source === 'bring')
    return (
      <BringNumberStep
        workspaceId={workspaceId}
        imports={porting.imports}
        fromMigration={porting.importsFromMigration}
        twilio={porting.twilio}
        carrierPort={carrierPort}
        initial={
          bring === 'carrier' ||
          ports.some((p) => p.status !== 'cancelled' && p.status !== 'complete')
            ? 'carrier'
            : null
        }
        onBack={onNew ?? (() => setSource('new'))}
      />
    );

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

const pathOf = (v: unknown): 'hosted' | 'own_site' | 'in_person' | null =>
  v === 'hosted' || v === 'own_site' || v === 'in_person' ? v : null;

/**
 * While the carriers look: "Email your web person" for what the website needs, and, for a business whose customers
 * agree on a form, the switch that hides its chat until texting is approved (2026-11-12).
 */
function WebsiteHelp({
  workspaceId,
  status,
  surfaces,
}: {
  workspaceId: string;
  status: Status;
  surfaces: HostedSurfaces;
}) {
  const sent = latestSubmission(status.registrations);
  const path = pathOf(sent?.['optInPath']);
  const others = Array.isArray(sent?.['otherWays'])
    ? (sent['otherWays'] as { path?: unknown }[])
    : [];
  const chatAgrees = path === 'hosted' || others.some((w) => w?.path === 'hosted');
  return (
    <div
      className="mt-5 space-y-3 rounded-card border border-border p-4"
      data-testid="website-help"
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-medium">Your website</p>
          <p className="mt-0.5 text-[12.5px] text-text-3">
            The reviewer opens it. Someone else looks after it? Send them what it needs, each change
            in its own file.
          </p>
        </div>
        <WebPersonButton
          workspaceId={workspaceId}
          website={text(sent?.['website']) || null}
          forms={surfaces.liveForms ?? []}
          chats={surfaces.chats ?? []}
          path={path}
        />
      </div>
      {chatAgrees ? null : (
        <HideChatSwitch
          workspaceId={workspaceId}
          chats={surfaces.chats ?? []}
          className="border-t border-border pt-3"
        />
      )}
    </div>
  );
}

function Review({
  workspaceId,
  status,
  businessName,
  surfaces,
  onViewSent,
  ahead,
}: {
  workspaceId: string;
  status: Status;
  businessName: string;
  surfaces: HostedSurfaces;
  onViewSent: () => void;
  /**
   * Sent ahead of the number: the business is moving its own here, or has none yet. Always 10DLC, and the
   * first row says where the number is rather than that it was bought.
   */
  ahead?: { display: string | null };
}) {
  const n = ahead ? null : status.number!;
  const local = !n || n.numberType === 'local';
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
  // Its fees not paid yet (0105): nothing has gone to the carriers, so nothing is in review either.
  const unpaid = !!status.textingFees?.due && local;
  const brandState = unpaid ? 'next' : stateOf(brand);
  const brandApproved = brand
    .map((r) => r?.approvedAt)
    .filter(Boolean)
    .sort()
    .pop();
  return (
    <div data-testid="review-step">
      <h2 className="text-lg font-semibold tracking-tight">
        {unpaid
          ? `${businessName}’s registration goes to the carriers once it’s paid`
          : `The carriers are reviewing ${businessName}`}
      </h2>
      <p className="mb-5 mt-1 text-[13px] text-text-2">
        {local
          ? 'Local numbers go through a brand and campaign registration that usually takes 1 to 3 weeks.'
          : 'Toll-free verification usually takes a few days.'}{' '}
        {ahead
          ? 'We check every 15 minutes and email you when they approve it. Your number can text as soon as it’s here.'
          : 'We check every 15 minutes and email you when texting is on. Calls already work.'}
      </p>
      <div
        className="overflow-hidden rounded-card border border-border"
        data-testid="review-checklist"
      >
        {n ? (
          <ReviewRow title="Number bought" sub={`${n.display} · calls ring now`} state="done" />
        ) : (
          <ReviewRow
            title={ahead?.display ? 'Number on its way' : 'Number'}
            sub={
              ahead?.display
                ? `${ahead.display} · texts can go out the day it’s here`
                : 'Get one or bring yours whenever you’re ready'
            }
            state="next"
          />
        )}
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
      <WebsiteHelp workspaceId={workspaceId} status={status} surfaces={surfaces} />
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={onViewSent}>
          View what we sent
        </Button>
        {n ? (
          <Button variant="secondary" disabled title="Texting isn’t approved yet">
            Text me a test
          </Button>
        ) : null}
        <span className="flex-1" />
        {submitted ? (
          <span className="text-xs text-text-3">Submitted {formatDate(submitted)}</span>
        ) : null}
      </div>
    </div>
  );
}

type Fee = NonNullable<NonNullable<Status['textingFees']>['due']>;

/**
 * A texting fee waiting on the business (0105): a registration's fees, which hold it back from the carriers, or a
 * month of the campaign the card didn't pay. The page is being made, is waiting to be paid, or the card said no
 * and the business pays with another. Back from Stripe, it waits for Stripe's own word, the only one believed.
 */
function TextingFeeDue({
  workspaceId,
  fee,
  goPay,
  setupReturn = null,
  ours = false,
}: {
  workspaceId: string;
  fee: Fee;
  /** Just sent: go to the page as soon as it is made. */
  goPay: boolean;
  /** In setup's number step: Stripe's page comes back to Settings, which sends them on to this. */
  setupReturn?: string | null;
  /** HandsFreeOS's own business, never charged: a fee it has anyway is let through, with no page. */
  ours?: boolean;
}) {
  const router = useRouter();
  const [paying, setPaying] = useState(false);
  const [back, setBack] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('fees') === 'paid') setBack(true);
  }, []);
  const toPage = useCallback(
    (url: string) => {
      if (setupReturn) keepSetupReturn(workspaceId, 'number', setupReturn);
      window.location.assign(url);
    },
    [setupReturn, workspaceId],
  );
  const go = !ours && (goPay || paying);
  useEffect(() => {
    if (go && fee.status === 'open' && fee.checkoutUrl) toPage(fee.checkoutUrl);
  }, [go, fee.status, fee.checkoutUrl, toPage]);
  const waiting =
    fee.status === 'pending' ||
    (back && fee.status === 'open') ||
    (paying && (ours || fee.status !== 'open'));
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => router.refresh(), 2500);
    return () => clearInterval(timer);
  }, [waiting, router]);
  // A page that never comes (Stripe said no to making it): stop waiting, and show what the fee now says.
  useEffect(() => {
    if (!paying) return;
    const timer = setTimeout(() => setPaying(false), 30_000);
    return () => clearTimeout(timer);
  }, [paying]);

  async function payAgain() {
    setPaying(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/texting_fee.pay', {
          body: { workspaceId, textingFeeId: fee.id },
        }),
      );
      if (out.checkoutUrl && !ours) toPage(out.checkoutUrl);
      else router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
      setPaying(false);
    }
  }

  const amount = money(fee.amountCents);
  const month = fee.purpose === 'month';
  const what = month
    ? `this month’s ${amount} for your texting campaign`
    : `the ${amount} the carriers charge for your registration (${fee.lines.map((l) => `${l.name} ${money(l.cents)}`).join(', ')})`;
  return (
    <Callout
      tone={fee.status === 'failed' || fee.problem ? 'warning' : 'info'}
      icon={fee.status === 'failed' || fee.problem ? CircleAlert : Clock}
      className="mb-[18px] mt-1"
      data-testid="texting-fee-due"
      data-status={fee.status}
      action={
        waiting ? null : ours ? (
          <Button size="sm" onClick={() => void payAgain()} data-testid="texting-fee-ours">
            Send it without paying
          </Button>
        ) : fee.status === 'open' && fee.checkoutUrl ? (
          <Button size="sm" onClick={() => toPage(fee.checkoutUrl!)} data-testid="texting-fee-pay">
            Pay {amount}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            loading={paying}
            onClick={() => void payAgain()}
            data-testid="texting-fee-pay-again"
          >
            Pay {amount} with another card
          </Button>
        )
      }
    >
      {waiting ? (
        <span className="flex items-center gap-2" role="status">
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          {ours
            ? 'Sending it to the carriers…'
            : back && fee.status === 'open'
              ? 'Confirming your payment with Stripe…'
              : 'Making your payment page…'}
        </span>
      ) : ours ? (
        `HandsFreeOS’s own business isn’t charged for texting, so you don’t pay ${what}. Send it to the carriers without paying.`
      ) : fee.problem ? (
        `We couldn’t take ${what}: ${fee.problem} ${month ? 'Your texts keep going out.' : 'Nothing goes to the carriers until it’s paid.'}`
      ) : (
        `Pay ${what} to send it to the carriers. They’re passed on at cost, and nothing goes to the carriers until they’re paid.`
      )}
    </Callout>
  );
}

/**
 * The 10DLC registration sent ahead of the number: below the number screens while a business moves its own
 * number here, or before it has one. The carriers take 1 to 3 weeks either way, so the weeks a port or a
 * transfer takes needn't be added to them. It follows the registration through review the same way the main
 * screen does once there is a number, and hands over to it when the number lands.
 */
function RegisterAhead({
  workspaceId,
  businessName,
  businessWebsite,
  businessAddress,
  status,
  me,
  surfaces,
  draft,
  submission,
  industry,
  approvalPage,
  arriving,
  onViewSent,
  goPay,
  setupReturn,
  onSent,
}: {
  workspaceId: string;
  businessName: string;
  businessWebsite: string | null;
  businessAddress: BusinessAddress | null;
  industry: string | null;
  /** Texting approval's guided page, where the questions are asked; null in sign-up, which asks them here. */
  approvalPage: string | null;
  status: Status;
  me: { fullName: string; email: string };
  surfaces: HostedSurfaces;
  draft: Record<string, unknown> | null;
  submission: Record<string, unknown> | null;
  /** The number on its way here, when there is one. */
  arriving: string | null;
  onViewSent: () => void;
  goPay: boolean;
  /** In setup's number step: where Stripe's texting fee page comes back to. */
  setupReturn: string | null;
  /** Sent, with the fees to pay when there are any. */
  onSent: (fee: { id: string } | null) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [fixing, setFixing] = useState(false);
  const step = status.localRegistrationStep;
  const close = () => {
    setOpen(false);
    setFixing(false);
  };

  let body: ReactNode;
  if (open || fixing)
    body = (
      <A2pWizard
        workspaceId={workspaceId}
        businessName={businessName}
        businessWebsite={businessWebsite}
        businessAddress={businessAddress}
        industry={industry}
        number={arriving ? { numberType: 'local', display: arriving } : null}
        me={me}
        initial={fixing ? submission : null}
        draft={draft}
        surfaces={surfaces}
        feesPaidFor={status.textingFees?.paidFor ?? null}
        onBack={close}
        onSubmitted={(fee) => {
          close();
          onSent(fee);
        }}
      />
    );
  else if (step === 'awaiting_approval')
    body = (
      <Review
        workspaceId={workspaceId}
        status={status}
        businessName={businessName}
        surfaces={surfaces}
        onViewSent={onViewSent}
        ahead={{ display: arriving }}
      />
    );
  else if (step === 'rejected')
    body = (
      <Rejected
        workspaceId={workspaceId}
        status={status}
        businessName={businessName}
        surfaces={surfaces}
        onFix={() => (approvalPage ? router.push(`${approvalPage}?fix=1`) : setFixing(true))}
        onViewSent={onViewSent}
        ahead
      />
    );
  else if (step === 'ready')
    body = (
      <Callout tone="info" icon={Check} data-testid="register-ahead-approved">
        Texting is approved.{' '}
        {arriving
          ? `${arriving} can text customers as soon as it’s here.`
          : 'Any local number you get or bring here can text customers as soon as it’s working.'}
      </Callout>
    );
  else
    body = (
      <>
        <h2 className="text-lg font-semibold tracking-tight">Register for texting now</h2>
        <p className="mt-1 text-[13px] text-text-2">
          {arriving
            ? `The carriers take 1 to 3 weeks to approve a local number for texting, and that doesn’t have to wait for ${arriving}. Send your business details now and it can text the day it’s here.`
            : 'Keeping a local number you already have, or getting one soon? The carriers take 1 to 3 weeks to approve a local number for texting, and that doesn’t need the number here yet. Send your business details now and it can text the day it arrives.'}
        </p>
        {arriving ? null : (
          <p className="mt-1.5 text-xs text-text-3">
            Toll-free numbers are verified once you have them, which usually takes a few days.
          </p>
        )}
        {status.canManage ? (
          <div className="mt-4">
            <Button
              onClick={() => (approvalPage ? router.push(approvalPage) : setOpen(true))}
              data-testid="register-ahead-start"
            >
              {draft ? 'Pick up the registration' : 'Start the registration'}
            </Button>
          </div>
        ) : (
          <p className="mt-3 text-xs text-text-3">Owners and admins can send it.</p>
        )}
      </>
    );
  return (
    <Card className="max-w-[820px] p-5 md:p-7" data-testid="register-ahead" data-step={step}>
      {status.textingFees?.due && !open && !fixing ? (
        <TextingFeeDue
          workspaceId={workspaceId}
          fee={status.textingFees.due}
          goPay={goPay}
          setupReturn={setupReturn}
          ours={status.textingFees.paidFor.ours}
        />
      ) : null}
      {body}
    </Card>
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
  surfaces,
  onFix,
  onViewSent,
  ahead = false,
}: {
  workspaceId: string;
  status: Status;
  businessName: string;
  surfaces: HostedSurfaces;
  onFix: () => void;
  onViewSent: () => void;
  /** Sent ahead of the number, so it is 10DLC and there are no calls yet to keep working. */
  ahead?: boolean;
}) {
  const local = ahead || status.number?.numberType === 'local';
  const meanwhile = ahead ? '' : ', and calls keep working';
  const bad = status.registrations.find((r) => r.status === 'rejected' || r.status === 'failed');
  const reason = bad?.rejectionReason ?? null;
  const optIn = !!reason && /opt|consent|agree|permission/i.test(reason);
  // The words for a box on their own website: core's, the same ones our forms, booking page and chat show and the
  // ones quoted to the carriers. A line of its own here once said less ("Message rates may apply", no frequency, no
  // HELP), and a business pasted it into a form beside our box (2026-11-11).
  const useCase = latestSubmission(status.registrations)?.['useCase'];
  const ownBox = ownSiteBoxText(
    businessName,
    sendsOffers(typeof useCase === 'string' ? useCase : null),
  );
  const callout = (
    <Callout tone="danger" icon={CircleAlert} className="mb-[18px]">
      <div className="flex flex-col gap-1">
        <strong>The carriers turned down the texting registration.</strong>
        <span>{reason ? `Their reason: “${reason}”` : 'They didn’t give a reason.'}</span>
      </div>
    </Callout>
  );
  // A local number's business profile or brand turned down by the carriers: support corrects it with them.
  if (local && bad?.status === 'rejected' && PROFILE_STEPS.has(bad.kind))
    return (
      <div data-testid="rejected-step">
        {callout}
        <SupportFix
          workspaceId={workspaceId}
          status={status}
          businessName={businessName}
          onViewSent={onViewSent}
          ahead={ahead}
        />
      </div>
    );
  return (
    <div data-testid="rejected-step">
      {callout}
      <h2 className="text-lg font-semibold tracking-tight">What to fix</h2>
      <p className="mb-4 mt-1 text-[13px] text-text-2">
        {optIn
          ? `Your HandsFreeOS forms, booking page and chat already show the right words. On a form on your own website, put the words below beside a tick box, then send the details again. Nothing else changes${meanwhile}.`
          : `Change what the carriers asked about, then send the details again. Nothing else changes${meanwhile}.`}
      </p>
      {optIn ? (
        <div className="mb-[18px] rounded-[10px] bg-card-2 p-3" data-testid="own-site-box-words">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-text-3">For a form on your own website</div>
            <CopyButton text={ownBox} />
          </div>
          <p className="mt-1 whitespace-pre-line text-[13px]">{ownBox}</p>
          <p className="mt-1.5 text-xs text-text-3">
            The box has to start empty and must not be required to send the form. Don’t add it to
            your HandsFreeOS forms: they already have it.
          </p>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button onClick={onFix} data-testid="fix-registration">
          Fix and send again
        </Button>
        <WebPersonButton
          workspaceId={workspaceId}
          website={text(latestSubmission(status.registrations)?.['website']) || null}
          forms={surfaces.liveForms ?? []}
          chats={surfaces.chats ?? []}
          path={pathOf(latestSubmission(status.registrations)?.['optInPath'])}
        />
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
  ahead = false,
}: {
  workspaceId: string;
  status: Status;
  businessName: string;
  onViewSent: () => void;
  ahead?: boolean;
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
        and share their reason. Once support tells you it’s fixed, send it again.
        {ahead ? null : ' Calls keep working.'}
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
                <dd className="min-w-0 whitespace-pre-line break-words font-medium">{v || '—'}</dd>
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
