'use client';
import {
  CAMPAIGN_CALL_OPENING_MAX,
  CAMPAIGN_DRAFT_MAX,
  CAMPAIGN_EMAIL_BODY_MAX,
  CAMPAIGN_EMAIL_SUBJECT_MAX,
  CAMPAIGN_PER_HOUR_MAX,
} from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { CampaignGet, CampaignRecipient } from '@/lib/api/types';
import {
  CAMPAIGN_STATUS_BADGE,
  callWords,
  PAUSED_REASON_WORDS,
  people,
  skipWords,
  statusWords,
} from './words';

const REFRESH_MS = 5000;

const timeOf = (iso: string) =>
  new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));

/**
 * One campaign. While the AI writes, it shows how far it has got; then every text, each one editable, and
 * "Approve all and send"; once sending, how many went, when the next one goes, the pace, and pause or stop.
 * An email campaign shows its one email instead (subject and words, editable, with the footer every email
 * gets), and the people it goes to. A call campaign shows how every call opens (editable), and who it calls and
 * how each call went.
 */
export function CampaignView({
  workspaceId,
  data,
  canManage,
}: {
  workspaceId: string;
  data: CampaignGet;
  canManage: boolean;
}) {
  const router = useRouter();
  const { campaign: c, recipients } = data;
  const [busy, setBusy] = useState<string | null>(null);
  const live = c.status === 'drafting' || c.status === 'sending';
  const email = c.channel === 'email';
  const calls = c.channel === 'call';
  const noun = email ? 'email' : calls ? 'call' : 'text';

  // Keeps up with the worker while it writes or sends.
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(t);
  }, [live, router]);

  async function act(
    what: 'approve' | 'pause' | 'resume' | 'cancel',
    confirmText?: string,
  ): Promise<void> {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(what);
    try {
      unwrap(
        await apiBrowser().POST(`/v1/commands/campaign.${what}`, {
          body: { workspaceId, campaignId: c.id },
        }),
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const going = recipients.filter((r) =>
    ['ready', 'approved', 'sent', 'failed'].includes(r.status),
  );
  const left = recipients.filter((r) => r.status === 'skipped' || r.status === 'removed');
  const stoppable = ['drafting', 'review', 'sending', 'paused'].includes(c.status);

  return (
    <div className="flex flex-col gap-5" data-testid="campaign-view" data-status={c.status}>
      <Card className="flex flex-col gap-3 p-[18px]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Badge
              variant={CAMPAIGN_STATUS_BADGE[c.status] ?? 'gray'}
              data-testid="campaign-status"
            >
              {statusWords(c.status, c.channel)}
            </Badge>
            <span className="text-[13px] text-text-2">
              {c.status === 'drafting'
                ? email || calls
                  ? `To ${people(c.counts.total - c.counts.skipped)}`
                  : `${c.counts.total - c.counts.drafting - c.counts.skipped} of ${c.counts.total - c.counts.skipped} written`
                : c.status === 'review'
                  ? `${people(c.counts.ready)} to ${noun}`
                  : `${c.counts.sent} of ${c.counts.sent + c.counts.approved + c.counts.failed} ${calls ? 'called' : 'sent'}`}
            </span>
          </div>
          {canManage ? (
            <div className="flex flex-wrap gap-2">
              {c.status === 'review' ? (
                <Button
                  onClick={() =>
                    act(
                      'approve',
                      email
                        ? `Send this email to ${people(c.counts.ready)}, ${c.perHour} an hour while you’re open?`
                        : calls && c.keepAdding
                          ? `Have your AI teammate call ${people(c.counts.ready)} now and anyone who joins later, ${c.perHour} an hour while you’re open? Each call says it’s an AI and that it’s recorded.`
                          : calls
                            ? `Have your AI teammate call ${people(c.counts.ready)}, ${c.perHour} an hour while you’re open? Each call says it’s an AI and that it’s recorded.`
                            : `Send ${people(c.counts.ready)} these texts, ${c.perHour} an hour while you’re open?`,
                    )
                  }
                  loading={busy === 'approve'}
                  disabled={c.counts.ready === 0 && !c.keepAdding}
                  data-testid="campaign-approve"
                >
                  {calls ? 'Approve all and start calling' : 'Approve all and send'}
                </Button>
              ) : null}
              {c.status === 'sending' ? (
                <Button
                  variant="secondary"
                  onClick={() => act('pause')}
                  loading={busy === 'pause'}
                  data-testid="campaign-pause"
                >
                  Pause
                </Button>
              ) : null}
              {c.status === 'paused' ? (
                <Button
                  onClick={() => act('resume')}
                  loading={busy === 'resume'}
                  data-testid="campaign-resume"
                >
                  Resume
                </Button>
              ) : null}
              {stoppable ? (
                <Button
                  variant="ghost"
                  onClick={() =>
                    act(
                      'cancel',
                      calls
                        ? 'Stop this campaign? Calls not made yet won’t be.'
                        : `Stop this campaign? ${email ? 'Emails' : 'Texts'} not sent yet won’t go.`,
                    )
                  }
                  loading={busy === 'cancel'}
                  data-testid="campaign-cancel"
                >
                  Stop
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
        {c.status === 'paused' && c.pausedReason ? (
          <p
            className="rounded-control bg-warning-soft px-3 py-2 text-[13px] text-warning-text"
            data-testid="campaign-paused-reason"
          >
            {PAUSED_REASON_WORDS[c.pausedReason] ??
              'Paused: something stopped it sending. Resume to try again.'}
          </p>
        ) : null}
        <p className="text-[13.5px]">{c.goal}</p>
        {c.offer ? (
          <p className="text-[12.5px] text-text-2" data-testid="campaign-offer-name">
            About the offer {c.offer.name}
          </p>
        ) : null}
        <PaceLine workspaceId={workspaceId} data={data} canManage={canManage} />
        {calls ? (
          <KeepAddingLine workspaceId={workspaceId} data={data} canManage={canManage} />
        ) : null}
      </Card>

      {email && c.email ? (
        <EmailCard
          workspaceId={workspaceId}
          campaignId={c.id}
          email={c.email}
          editable={canManage && c.status === 'review'}
        />
      ) : email && c.status === 'drafting' ? (
        <p className="text-[13px] text-text-2">
          The AI is writing the email. This page updates on its own.
        </p>
      ) : null}

      {calls && c.call ? (
        <CallCard
          workspaceId={workspaceId}
          campaignId={c.id}
          call={c.call}
          editable={canManage && c.status === 'review'}
        />
      ) : calls && c.status === 'drafting' ? (
        <p className="text-[13px] text-text-2">
          The AI is writing how the calls open. This page updates on its own.
        </p>
      ) : null}

      {(email || calls) && going.length ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
            {calls ? 'Who it calls' : 'Who gets it'}
          </h2>
          <Card className="divide-y divide-border">
            {going.map((r) => (
              <RecipientRow
                key={r.id}
                workspaceId={workspaceId}
                r={r}
                editable={canManage && c.status === 'review' && r.status === 'ready'}
                mode={calls ? 'call' : 'email'}
              />
            ))}
          </Card>
        </section>
      ) : null}

      {email || calls ? null : going.length ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
            {c.status === 'review' ? 'Read each text' : 'Texts'}
          </h2>
          <Card className="divide-y divide-border">
            {going.map((r) => (
              <RecipientRow
                key={r.id}
                workspaceId={workspaceId}
                r={r}
                editable={canManage && c.status === 'review' && r.status === 'ready'}
              />
            ))}
          </Card>
        </section>
      ) : c.status === 'drafting' ? (
        <p className="text-[13px] text-text-2">
          The AI is writing each text. This page updates on its own.
        </p>
      ) : null}

      {left.length ? (
        <details className="flex flex-col gap-2" data-testid="campaign-left-out">
          <summary className="cursor-pointer text-[13px] text-text-2">
            {people(left.length)} left out
          </summary>
          <Card className="mt-2 divide-y divide-border">
            {left.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 px-[18px] py-2.5">
                <span className="text-[13px]">{r.name}</span>
                <span className="text-[12.5px] text-text-2">
                  {r.status === 'removed' ? 'Taken out' : skipWords(r.skipReason)}
                </span>
              </div>
            ))}
          </Card>
        </details>
      ) : null}
    </div>
  );
}

function PaceLine({
  workspaceId,
  data,
  canManage,
}: {
  workspaceId: string;
  data: CampaignGet;
  canManage: boolean;
}) {
  const router = useRouter();
  const c = data.campaign;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(c.perHour));
  const [busy, setBusy] = useState(false);
  const changeable = canManage && ['review', 'sending', 'paused'].includes(c.status);
  const noun = c.channel === 'email' ? 'emails' : c.channel === 'call' ? 'calls' : 'texts';
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);

  async function save() {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > CAMPAIGN_PER_HOUR_MAX) {
      toast.error(`Between 1 and ${CAMPAIGN_PER_HOUR_MAX} an hour.`);
      return;
    }
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/campaign.set_pace', {
          body: { workspaceId, campaignId: c.id, perHour: n },
        }),
      );
      setEditing(false);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-text-2">
      {editing ? (
        <>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={CAMPAIGN_PER_HOUR_MAX}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="h-8 w-20"
            aria-label={`${Noun} an hour`}
            data-testid="campaign-pace-input"
          />
          <span>{noun} an hour</span>
          <Button size="sm" onClick={save} loading={busy} data-testid="campaign-pace-save">
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </>
      ) : (
        <>
          <span data-testid="campaign-pace">
            {c.perHour} {noun} an hour, while you’re open and never in quiet hours.
          </span>
          {changeable ? (
            <button
              type="button"
              className="font-medium text-accent-text hover:underline"
              onClick={() => {
                setValue(String(c.perHour));
                setEditing(true);
              }}
              data-testid="campaign-pace-edit"
            >
              Change
            </button>
          ) : null}
        </>
      )}
      {c.status === 'sending' && data.nextSendAt ? (
        <span className="basis-full">
          {c.keepAdding && c.counts.approved === 0
            ? `Looks for new people again: ${timeOf(data.nextSendAt)}`
            : `Next ${noun.slice(0, -1)}: ${timeOf(data.nextSendAt)}`}
        </span>
      ) : null}
    </div>
  );
}

/** A call campaign that keeps adding people, or doesn't: anyone who comes to fit joins, until it's stopped. */
function KeepAddingLine({
  workspaceId,
  data,
  canManage,
}: {
  workspaceId: string;
  data: CampaignGet;
  canManage: boolean;
}) {
  const router = useRouter();
  const c = data.campaign;
  const [busy, setBusy] = useState(false);
  const open = !['done', 'cancelled'].includes(c.status);
  if (!open && !c.keepAdding) return null;

  async function set(on: boolean) {
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/campaign.set_keep_adding', {
          body: { workspaceId, campaignId: c.id, on },
        }),
      );
      toast.success(
        on ? 'It keeps adding people who come to fit.' : 'It calls only the people it has now.',
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-[13px] font-medium">Keep adding people</span>
        <span className="text-[12.5px] text-text-2" data-testid="campaign-keep-adding-words">
          {c.keepAdding
            ? 'Anyone who later gets one of its tags or reaches one of its stages, and agrees to calls in writing, joins and is called at its pace, until you stop it.'
            : 'It calls only the people it has, then finishes.'}
        </span>
      </div>
      {canManage && open ? (
        <Switch
          checked={c.keepAdding}
          label="Keep adding people"
          busy={busy}
          onChange={(on) => void set(on)}
          testId="campaign-keep-adding-switch"
        />
      ) : null}
    </div>
  );
}

function RecipientRow({
  workspaceId,
  r,
  editable,
  mode = 'text',
}: {
  workspaceId: string;
  r: CampaignRecipient;
  editable: boolean;
  /** An email or call campaign's row: who and where, no words of their own (a call's shows how it went). */
  mode?: 'text' | 'email' | 'call';
}) {
  const email = mode === 'email';
  const call = mode === 'call' ? callWords(r.call) : null;
  const router = useRouter();
  const [text, setText] = useState(r.draft ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(r.draft ?? ''), [r.draft]);

  async function save() {
    const next = text.trim();
    if (!next || next === (r.draft ?? '')) return;
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/campaign.update_draft', {
          body: { workspaceId, recipientId: r.id, draft: next },
        }),
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/campaign.remove_recipient', {
          body: { workspaceId, recipientId: r.id },
        }),
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5 px-[18px] py-3" data-testid={`recipient-${r.id}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13.5px] font-medium">
          {r.name}
          {email ? (
            r.email ? (
              <span className="ml-2 font-normal text-text-3">{r.email}</span>
            ) : null
          ) : r.phone ? (
            <span className="ml-2 font-normal text-text-3">{r.phone}</span>
          ) : null}
        </span>
        <span className="flex items-center gap-2 text-[12.5px] text-text-2">
          {r.edited ? <span>Edited</span> : null}
          {call ? (
            <Badge variant={call.tone} data-testid={`recipient-call-${r.id}`}>
              {call.text}
            </Badge>
          ) : r.status === 'sent' && r.sentAt ? (
            <Badge variant="ok">Sent {timeOf(r.sentAt)}</Badge>
          ) : null}
          {r.status === 'failed' && !call ? (
            <Badge variant="danger">{mode === 'call' ? 'Not called' : 'Didn’t send'}</Badge>
          ) : null}
          {r.status === 'approved' ? <span>Waiting its turn</span> : null}
          {editable ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={remove}
              disabled={busy}
              data-testid={`recipient-remove-${r.id}`}
            >
              Remove
            </Button>
          ) : null}
        </span>
      </div>
      {mode === 'call' && r.call?.summary ? (
        <p className="text-[13px] text-text-2">{r.call.summary}</p>
      ) : null}
      {mode !== 'text' ? null : editable ? (
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={save}
          maxLength={CAMPAIGN_DRAFT_MAX}
          disabled={busy}
          className="min-h-[64px] text-[13.5px]"
          aria-label={`Text to ${r.name}`}
          data-testid={`recipient-draft-${r.id}`}
        />
      ) : (
        <p className="whitespace-pre-wrap text-[13px] text-text-2">{r.draft}</p>
      )}
    </div>
  );
}

/** An email campaign's one email: subject and words (saved when a box is left), and the footer it always gets. */
function EmailCard({
  workspaceId,
  campaignId,
  email,
  editable,
}: {
  workspaceId: string;
  campaignId: string;
  email: NonNullable<CampaignGet['campaign']['email']>;
  editable: boolean;
}) {
  const router = useRouter();
  const [subject, setSubject] = useState(email.subject ?? '');
  const [body, setBody] = useState(email.body ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => setSubject(email.subject ?? ''), [email.subject]);
  useEffect(() => setBody(email.body ?? ''), [email.body]);

  async function save() {
    const s = subject.trim();
    const b = body.trim();
    if (!s || !b || (s === (email.subject ?? '') && b === (email.body ?? ''))) return;
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/campaign.update_email', {
          body: { workspaceId, campaignId, subject: s, body: b },
        }),
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-2" data-testid="campaign-email">
      <div className="flex items-center justify-between">
        <h2 className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
          {editable ? 'Read the email' : 'The email'}
        </h2>
        {email.edited ? <span className="text-[12.5px] text-text-2">Edited</span> : null}
      </div>
      <Card className="flex flex-col gap-3 p-[18px]">
        {editable ? (
          <>
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              onBlur={save}
              maxLength={CAMPAIGN_EMAIL_SUBJECT_MAX}
              disabled={busy}
              aria-label="Subject"
              data-testid="campaign-email-subject"
            />
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onBlur={save}
              maxLength={CAMPAIGN_EMAIL_BODY_MAX}
              disabled={busy}
              className="min-h-[200px] text-[13.5px]"
              aria-label="Email"
              data-testid="campaign-email-body"
            />
            <span className="text-[12px] text-text-3">
              {'{first_name}'} becomes each person’s first name (“there” when you don’t have it).
            </span>
          </>
        ) : (
          <>
            <p className="text-[13.5px] font-medium">{email.subject}</p>
            <p className="whitespace-pre-wrap text-[13px] text-text-2">{email.body}</p>
          </>
        )}
        <div
          className="whitespace-pre-wrap border-t border-border pt-3 text-[12px] text-text-3"
          data-testid="campaign-email-footer"
        >
          {`Every email ends with: why they get it, an unsubscribe link, and your address.\n${
            email.postalAddress ?? 'No address yet: add it in Settings → Payments.'
          }`}
        </div>
      </Card>
    </section>
  );
}

/** A call campaign's opening line (saved when the box is left), and how every call goes around it. */
function CallCard({
  workspaceId,
  campaignId,
  call,
  editable,
}: {
  workspaceId: string;
  campaignId: string;
  call: NonNullable<CampaignGet['campaign']['call']>;
  editable: boolean;
}) {
  const router = useRouter();
  const [opening, setOpening] = useState(call.opening ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => setOpening(call.opening ?? ''), [call.opening]);

  async function save() {
    const o = opening.trim();
    if (!o || o === (call.opening ?? '')) return;
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/campaign.update_call', {
          body: { workspaceId, campaignId, opening: o },
        }),
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-2" data-testid="campaign-call">
      <div className="flex items-center justify-between">
        <h2 className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
          How every call opens
        </h2>
        {call.edited ? <span className="text-[12.5px] text-text-2">Edited</span> : null}
      </div>
      <Card className="flex flex-col gap-3 p-[18px]">
        <p className="text-[12.5px] text-text-2">
          “Hi Ana, this is your AI teammate, an AI assistant for your business. This call is
          recorded. I’m calling …”
        </p>
        {editable ? (
          <Input
            value={opening}
            onChange={(e) => setOpening(e.target.value)}
            onBlur={save}
            maxLength={CAMPAIGN_CALL_OPENING_MAX}
            disabled={busy}
            aria-label="I’m calling …"
            data-testid="campaign-call-opening"
          />
        ) : (
          <p className="text-[13.5px] font-medium">{call.opening}</p>
        )}
        <p className="text-[12px] text-text-3">
          Then it asks if now is a good time, and talks from what the campaign is for. Anyone who
          asks not to be called again isn’t. A voicemail box gets what you chose in Settings →
          Automations.
        </p>
      </Card>
    </section>
  );
}
