'use client';
/**
 * Settings → Texting & calls once the business has its number (the owner, 22 Nov 2026, pick 4a): one card that says
 * what the number does in plain lines, with Change on every row. Each Change opens the same editor the guided setup
 * asked that question with (components/phone-setup/editors.tsx), so a setting is set and changed in the same words,
 * and saves that one part (phone_setup.save). The cards this replaces (When a customer calls, What forwarded phones
 * show, Call recording, Voicemail, Texting rules) held the same settings as switches and boxes.
 */
import {
  formatPhone,
  money,
  PHONE_SETUP_WORDS,
  phoneMissedNow,
  phoneMissedSummary,
  phoneQuietSummary,
  phoneRingSummary,
  phoneSetupAnswersFromNow,
  phoneSetupPartBody,
  phoneSetupProblems,
  phoneSetupStart,
  type PhoneSetupAnswers,
  type PhoneSetupContext,
  type PhoneSetupPart,
} from '@hfos/core';
import { Info, MessageCircle, Phone, Plus, Send } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { ChannelIcon } from '@/components/inbox/bits';
import { MissedEditor, QuietEditor, RingEditor } from '@/components/phone-setup/editors';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { FieldError, Label } from '@/components/ui/field';
import { Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { PhoneNumberInfo, PhoneSetupStatus } from '@/lib/api/types';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ReleaseNumberDialog } from './release-number-dialog';
import { SETTING_TARGET, settingAttrs } from './setting-anchor';
import { TestTextDialog } from './test-text-dialog';

const W = PHONE_SETUP_WORDS.card;
const LINES = PHONE_SETUP_WORDS.lines;

type Editing = PhoneSetupPart | 'recording' | 'waits' | null;

export function PhoneCard({
  workspaceId,
  businessName,
  status,
  number: n,
  contactPhone,
  onViewSent,
  onAdd,
  onMore,
  feeDue,
  setup = false,
}: {
  workspaceId: string;
  businessName: string;
  status: PhoneSetupStatus;
  number: PhoneNumberInfo;
  /** The phone the registration gave, which a test text offers first. */
  contactPhone: string;
  onViewSent: () => void;
  /** "Add a number" beside the number, when the list of numbers under the card doesn't offer it already. */
  onAdd: (() => void) | null;
  /** Opens "Phone account and transfers". */
  onMore: (() => void) | null;
  /** This month's carrier fee, when one is owed. */
  feeDue?: ReactNode;
  /** Inside sign-up: none of the links out. */
  setup?: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<Editing>(null);
  const [test, setTest] = useState(false);
  const [release, setRelease] = useState(false);
  const [turningOn, setTurningOn] = useState(false);

  const local = n.numberType === 'local';
  const step = n.status === 'active' ? status.nextStep : 'porting';
  const ready = step === 'ready';
  const wantsTexting = status.settings.texting !== 'not_now' || step !== 'submit_registration';
  const ctx: PhoneSetupContext = {
    mode: 'again',
    businessName,
    teammate: status.teammate
      ? {
          name: status.teammate.name,
          on: status.teammate.on,
          canManage: status.teammate.canManage,
        }
      : null,
    textingSettled: step !== 'submit_registration',
    businessE164: n.e164,
  };
  const now: PhoneSetupAnswers = {
    ...phoneSetupStart(ctx),
    ...phoneSetupAnswersFromNow({
      routing: n.routing,
      settings: status.settings,
      teammate: status.teammate,
    }),
  };

  const ring = phoneRingSummary(
    n.routing.forwarding.map((f) => ({
      label: f.label,
      number: formatPhone(f.e164),
      enabled: f.enabled,
    })),
    n.routing.forwardedCallerId,
  );
  const missedNow = phoneMissedNow({
    routing: n.routing,
    settings: status.settings,
    teammate: status.teammate,
  });
  const missed = phoneMissedSummary(
    { then: missedNow.then, mode: missedNow.mode, ringSeconds: n.routing.ringSeconds },
    status.teammate,
  );
  const quiet = phoneQuietSummary(status.settings.quietHours);
  const approvedAt = status.registrations
    .map((r) => r.approvedAt)
    .filter((d): d is string => !!d)
    .sort()
    .pop();

  async function turnOnTexting() {
    setTurningOn(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/phone.update_settings', {
          body: { workspaceId, texting: 'on' },
        }),
      );
      router.refresh();
      // The approval's questions are the next card down.
      setTimeout(
        () => document.getElementById('approval')?.scrollIntoView({ behavior: 'smooth' }),
        400,
      );
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setTurningOn(false);
    }
  }

  const change = (what: Exclude<Editing, null>, label: string) =>
    status.canManage ? (
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setEditing(what)}
        aria-label={`Change ${label.toLowerCase()}`}
        data-testid={`change-${what}`}
      >
        Change
      </Button>
    ) : null;

  const texting =
    step === 'porting' ? null : !wantsTexting ? (
      <Badge variant="gray">{W.callsOnly}</Badge>
    ) : ready ? (
      <Badge variant="ok" data-testid="texting-approved">
        <MessageCircle className="h-3.5 w-3.5" strokeWidth={1.75} />
        {W.textingApproved}
      </Badge>
    ) : (
      <Badge variant={step === 'rejected' ? 'danger' : 'pending'}>
        <MessageCircle className="h-3.5 w-3.5" strokeWidth={1.75} />
        {step === 'awaiting_approval'
          ? W.textingWaiting
          : step === 'rejected'
            ? W.textingTurnedDown
            : W.textingNeeds}
      </Badge>
    );

  return (
    <Card className="max-w-[820px] p-5 md:p-7" data-testid="phone-card" data-step={step}>
      <div
        className={cn('flex flex-wrap items-start justify-between gap-4', SETTING_TARGET)}
        {...settingAttrs('texting.number')}
      >
        <div className="flex min-w-0 items-center gap-3.5">
          <ChannelIcon icon={Phone} size={44} />
          <div className="min-w-0">
            <div className="text-xs font-medium uppercase tracking-[0.04em] text-text-3">
              {W.title}
            </div>
            <div
              className="font-mono text-[22px] font-medium leading-tight tracking-[-0.01em]"
              data-testid="business-number"
            >
              {n.display}
            </div>
            <div className="text-xs text-text-3">
              {local ? 'Local' : 'Toll-free'}
              {n.purchasedAt ? ` · yours since ${formatDate(n.purchasedAt)}` : ''}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {status.messagingReady ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setTest(true)}
              data-testid="text-me-a-test"
            >
              <Send className="h-3.5 w-3.5" strokeWidth={1.5} />
              {W.testText}
            </Button>
          ) : null}
          {onAdd && status.canManage ? (
            <Button variant="secondary" size="sm" onClick={onAdd} data-testid="phone-card-add">
              <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
              {W.addNumber}
            </Button>
          ) : null}
        </div>
      </div>
      <div className="mt-3.5 flex flex-wrap gap-1.5">
        {step === 'porting' ? (
          <Badge variant="pending">{W.onItsWay}</Badge>
        ) : (
          <Badge variant="ok">
            <Phone className="h-3.5 w-3.5" strokeWidth={1.75} />
            {W.callsWorking}
          </Badge>
        )}
        {texting}
        {status.rcsSender?.sending ? (
          <Badge variant="accent" data-testid="rcs-on-badge">
            RCS
          </Badge>
        ) : null}
      </div>

      <Group title={W.calls}>
        <Row
          {...settingAttrs('texting.calls')}
          label={LINES.ring}
          value={ring.value}
          sub={<span {...settingAttrs('texting.caller_id')}>{ring.sub}</span>}
          action={change('ring', LINES.ring)}
          testId="row-ring"
        />
        <Row
          {...settingAttrs('texting.voicemail')}
          label={LINES.missed}
          value={<span {...settingAttrs('texting.ring_for')}>{missed.value}</span>}
          sub={missed.sub}
          action={change('missed', LINES.missed)}
          testId="row-missed"
        />
        <Row
          {...settingAttrs('texting.recording')}
          label={W.recording}
          value={n.routing.announceRecording ? W.recordingOn : W.recordingOff}
          sub={W.recordingSub}
          action={change('recording', W.recording)}
          testId="row-recording"
        />
      </Group>

      {step === 'porting' ? null : (
        <Group title={W.texting}>
          <Row
            {...settingAttrs('texting.registration')}
            label={W.approval}
            value={
              !wantsTexting
                ? W.approvalOff
                : ready
                  ? `${W.approved}${approvedAt ? ` ${formatDate(approvedAt)}` : ''}`
                  : step === 'awaiting_approval'
                    ? W.approvalWaiting
                    : step === 'rejected'
                      ? W.approvalTurnedDown
                      : W.approvalNeeds
            }
            sub={
              <>
                {!wantsTexting
                  ? W.approvalOffSub
                  : ready
                    ? status.textingFees?.monthlyCents
                      ? W.monthly(money(status.textingFees.monthlyCents))
                      : W.approvedSub
                    : step === 'awaiting_approval'
                      ? W.approvalWaitingSub(local)
                      : step === 'rejected'
                        ? W.approvalTurnedDownSub
                        : W.approvalNeedsSub}
                {ready && feeDue ? <div className="mt-2">{feeDue}</div> : null}
              </>
            }
            action={
              !wantsTexting ? (
                status.canManage ? (
                  <Button
                    size="sm"
                    loading={turningOn}
                    onClick={() => void turnOnTexting()}
                    data-testid="turn-on-texting"
                  >
                    {W.turnOn}
                  </Button>
                ) : null
              ) : ready || step === 'awaiting_approval' ? (
                <Button variant="ghost" size="sm" onClick={onViewSent} data-testid="see-what-sent">
                  {W.seeSent}
                </Button>
              ) : (
                <Button
                  variant={step === 'rejected' ? 'secondary' : 'primary'}
                  size="sm"
                  onClick={() =>
                    // Approval is a guided page of its own; what the carriers turned down is read on this one first.
                    step === 'submit_registration' && !setup
                      ? router.push(`/onboarding/${workspaceId}/texting`)
                      : document.getElementById('approval')?.scrollIntoView({ behavior: 'smooth' })
                  }
                  data-testid="start-approval"
                >
                  {step === 'rejected' ? 'See what to fix' : W.startApproval}
                </Button>
              )
            }
            testId="row-approval"
          />
          {wantsTexting ? (
            <>
              {/* Its id stays quiet-hours: Automations' "Edit quiet hours" links here. */}
              <Row
                {...settingAttrs('texting.quiet_hours')}
                label={LINES.quiet}
                value={quiet.value}
                sub={quiet.sub}
                action={change('quiet', LINES.quiet)}
                testId="row-quiet"
              />
              <Row
                {...settingAttrs('texting.remind_waiting')}
                label={W.waits}
                value={W.waitsValue(status.settings.unansweredReminderMinutes)}
                sub={W.waitsHint}
                action={change('waits', W.waits)}
                testId="row-waits"
              />
              <Row
                {...settingAttrs('texting.stop_help')}
                label={W.stop}
                value={W.stopValue}
                sub={W.stopSub}
                action={null}
                testId="row-stop"
              />
            </>
          ) : null}
        </Group>
      )}

      {setup ? null : (
        <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 border-t border-border pt-4 text-[13px]">
          {status.canManage ? (
            <Link
              href={`/onboarding/${workspaceId}/phone`}
              className="text-accent-text hover:underline"
              data-testid="run-setup-again"
            >
              {PHONE_SETUP_WORDS.again}
            </Link>
          ) : null}
          {onMore ? (
            <button
              type="button"
              onClick={onMore}
              className="text-accent-text hover:underline"
              data-testid="phone-more-link"
            >
              {W.account}
            </button>
          ) : null}
          {status.canManage && n.status === 'active' ? (
            <button
              type="button"
              onClick={() => setRelease(true)}
              className="text-text-3 hover:text-danger-text hover:underline"
              data-testid="give-up-number"
            >
              {W.giveUp(n.display)}
            </button>
          ) : null}
        </div>
      )}

      {editing === 'ring' || editing === 'missed' || editing === 'quiet' ? (
        <PartDialog
          part={editing}
          workspaceId={workspaceId}
          phoneNumberId={n.id}
          start={now}
          ctx={ctx}
          timezone={status.timezone}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {editing === 'recording' ? (
        <RecordingDialog
          workspaceId={workspaceId}
          phoneNumberId={n.id}
          initial={n.routing.announceRecording}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {editing === 'waits' ? (
        <WaitsDialog
          workspaceId={workspaceId}
          initial={status.settings.unansweredReminderMinutes}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <TestTextDialog
        workspaceId={workspaceId}
        businessName={businessName}
        defaultPhone={contactPhone}
        open={test}
        onOpenChange={setTest}
      />
      <ReleaseNumberDialog
        workspaceId={workspaceId}
        phoneNumberId={n.id}
        display={n.display}
        e164={n.e164}
        open={release}
        onOpenChange={setRelease}
        onReleased={() => router.refresh()}
      />
    </Card>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="text-xs font-semibold uppercase tracking-[0.04em] text-text-3">{title}</h2>
      <div className="mt-1.5 overflow-hidden rounded-menu border border-border">{children}</div>
    </section>
  );
}

/** One thing the number does: its name, what it is set to, a line on what that means, and Change. */
function Row({
  label,
  value,
  sub,
  action,
  testId,
  ...mark
}: {
  label: string;
  value: ReactNode;
  sub: ReactNode;
  action: ReactNode;
  testId: string;
  id?: string;
  'data-setting'?: string;
}) {
  return (
    <div
      {...mark}
      className={cn(
        // On a phone a wide button (Start texting approval) drops under the words rather than squeezing them.
        'flex flex-wrap items-start justify-between gap-x-4 gap-y-2.5 border-b border-border px-4 py-3.5 last:border-b-0',
        SETTING_TARGET,
      )}
      data-testid={testId}
    >
      <div className="flex min-w-[200px] flex-1 flex-col gap-0.5">
        <div className="text-xs font-medium text-text-3">{label}</div>
        <div className="font-semibold">{value}</div>
        <div className="max-w-[520px] text-[13px] leading-snug text-text-2">{sub}</div>
      </div>
      {action ? <div className="flex-none">{action}</div> : null}
    </div>
  );
}

/** A Change dialog's frame: the editor, what went wrong under it, then Cancel and Save changes. */
function ChangeDialog({
  title,
  hint,
  error,
  busy,
  onSave,
  onClose,
  children,
}: {
  title: string;
  hint: string;
  error: string | null;
  busy: boolean;
  onSave: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        title={title}
        description={hint}
        className="max-h-[calc(100dvh-32px)] w-[min(640px,calc(100vw-32px))] overflow-y-auto"
      >
        <div className="mt-4" data-testid="change-dialog">
          {children}
        </div>
        {error ? <FieldError>{error}</FieldError> : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} data-testid="change-cancel">
            {W.cancel}
          </Button>
          <Button loading={busy} onClick={onSave} data-testid="change-save">
            {W.save}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const PART_WORDS = {
  ring: PHONE_SETUP_WORDS.ring,
  missed: PHONE_SETUP_WORDS.missed,
  quiet: PHONE_SETUP_WORDS.quiet,
} as const;

/** What rings, what happens when nobody picks up, or quiet hours: the guided setup's own question, saved alone. */
function PartDialog({
  part,
  workspaceId,
  phoneNumberId,
  start,
  ctx,
  timezone,
  onClose,
}: {
  part: PhoneSetupPart;
  workspaceId: string;
  phoneNumberId: string;
  start: PhoneSetupAnswers;
  ctx: PhoneSetupContext;
  timezone: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [answers, setAnswers] = useState(start);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<PhoneSetupAnswers>) => {
    setAnswers((a) => ({ ...a, ...patch }));
    setProblems({});
    setError(null);
  };

  async function save() {
    const found = phoneSetupProblems(part, answers, ctx);
    const body = phoneSetupPartBody(part, answers, ctx);
    if (found.length || !body) {
      setProblems(Object.fromEntries(found.map((p) => [p.path, p.message])));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/phone_setup.save', {
          body: { workspaceId, phoneNumberId, ...body },
        }),
      );
      toast.success(W.saved);
      router.refresh();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const editor = { answers, set, problems, ctx };
  return (
    <ChangeDialog
      title={PART_WORDS[part].title}
      hint={PART_WORDS[part].hint}
      error={error}
      busy={busy}
      onSave={() => void save()}
      onClose={onClose}
    >
      {part === 'ring' ? (
        <RingEditor {...editor} switches />
      ) : part === 'missed' ? (
        <MissedEditor {...editor} />
      ) : (
        <QuietEditor {...editor} timezone={timezone} />
      )}
    </ChangeDialog>
  );
}

/**
 * Every answered call is recorded and written out. The business chooses whether callers hear so: some states need
 * everyone on a call to agree to a recording.
 */
function RecordingDialog({
  workspaceId,
  phoneNumberId,
  initial,
  onClose,
}: {
  workspaceId: string;
  phoneNumberId: string;
  initial: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [on, setOn] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (on === initial) return onClose();
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/phone_number.set_recording_notice', {
          body: { workspaceId, phoneNumberId, announceRecording: on },
        }),
      );
      toast.success(W.saved);
      router.refresh();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ChangeDialog
      title={W.recording}
      hint={W.recordingHint}
      error={error}
      busy={busy}
      onSave={() => void save()}
      onClose={onClose}
    >
      <div className="flex items-center justify-between gap-4 rounded-menu border border-border p-3.5">
        <span className="font-semibold">{W.recordingSwitch}</span>
        <Switch checked={on} label={W.recordingSwitch} onChange={setOn} testId="recording-switch" />
      </div>
      {on ? null : (
        <Callout tone="warning" icon={Info} className="mt-3">
          <span className="text-[13px]">{W.recordingWarning}</span>
        </Callout>
      )}
    </ChangeDialog>
  );
}

/** How long a customer waits for a text back before the team gets an email about it. */
function WaitsDialog({
  workspaceId,
  initial,
  onClose,
}: {
  workspaceId: string;
  initial: number;
  onClose: () => void;
}) {
  const router = useRouter();
  const [minutes, setMinutes] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A time set somewhere else (the Assistant can pick any) stays in the list.
  const choices: readonly (readonly [number, string])[] = W.waitsChoices.some(
    ([m]) => m === initial,
  )
    ? W.waitsChoices
    : [...W.waitsChoices, [initial, `${initial} minutes`] as const];

  async function save() {
    if (minutes === initial) return onClose();
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/phone.update_settings', {
          body: { workspaceId, unansweredReminderMinutes: minutes },
        }),
      );
      toast.success(W.saved);
      router.refresh();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ChangeDialog
      title={W.waitsTitle}
      hint={W.waitsHint}
      error={error}
      busy={busy}
      onSave={() => void save()}
      onClose={onClose}
    >
      <Label htmlFor="waits-after">{W.waitsAfter}</Label>
      <Select
        id="waits-after"
        className="w-[180px]"
        value={String(minutes)}
        onChange={(e) => setMinutes(Number(e.target.value))}
        data-testid="waits-after"
      >
        {choices.map(([m, l]) => (
          <option key={m} value={m}>
            {l}
          </option>
        ))}
      </Select>
    </ChangeDialog>
  );
}
