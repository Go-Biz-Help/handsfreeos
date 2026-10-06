'use client';
/**
 * A listing's showings (board 71, design/realestate/Showings.dc.html): every showing asked for on the listing's page,
 * read from ShowingTime's emails, or added by hand; where each stands; and what buyers said, with the themes the AI
 * drew from their words. Beside them, how showings work here: who says yes, the times open, the access instructions
 * and when they go out, and when feedback is asked for.
 *
 * A showing read from an email waits for a person to check it; the agent says yes or no for the seller only when the
 * seller doesn't answer in their portal. Feedback is shared with the seller by the agent, never on its own.
 */
import { localInstant } from '@hfos/core';
import {
  PRICE_FEELS,
  SHOWING_CONFIRMS,
  type PriceFeel,
} from '@hfos/core/addons/realestate/showings';
import { Copy } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { usePublicOrigin } from '@/lib/use-origin';
import { cn } from '@/lib/utils';
import { CardHead, dealHref, HeadLink } from './bits';
import { DealCrumb } from './buyer-bits';
import { LockboxesCard } from './lockboxes';
import type { LockboxList, ShowingList } from './types';
import { useAct } from './use-act';

type Showing = ShowingList['showings'][number];

const STATE_BADGE: Readonly<Record<Showing['state'], 'ok' | 'pending' | 'danger' | 'gray'>> = {
  requested: 'pending',
  confirmed: 'ok',
  declined: 'gray',
  cancelled: 'gray',
  done: 'gray',
};

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "“Loved the patio.” 4/5" */
function feedbackLine(s: Showing): string | null {
  const f = s.feedback;
  if (!f) return null;
  const said = f.liked ?? f.pause;
  return [said ? `“${said}”` : null, f.interest ? `${f.interest}/5` : null]
    .filter(Boolean)
    .join(' ');
}

export function ShowingsPage({
  workspaceId,
  dealId,
  dealName,
  timeZone,
  list,
  lockboxes,
  live,
  brandedOrigin,
}: {
  workspaceId: string;
  dealId: string;
  dealName: string;
  timeZone: string;
  list: ShowingList;
  /** Round seven: its lockboxes and who opened them. */
  lockboxes: LockboxList;
  live: boolean;
  brandedOrigin: string | null;
}) {
  useLiveRefresh(['custom_record']);
  const origin = usePublicOrigin(brandedOrigin);
  const { busy, act } = useAct();
  const [adding, setAdding] = useState(false);
  const [settings, setSettings] = useState(false);
  const [checking, setChecking] = useState<Showing | null>(null);
  const [feedback, setFeedback] = useState<Showing | null>(null);
  const seller = list.sellerFirstName ?? 'the seller';
  const s = list.settings;
  const decide = (sh: Showing, decision: 'confirm' | 'decline' | 'cancel') =>
    act(
      `${decision}:${sh.id}`,
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/realestate.showing.decide', {
            body: { workspaceId, showingId: sh.id, decision },
          }),
        ),
      decision === 'confirm'
        ? 'Confirmed. The agent hears now, with the access instructions before it.'
        : decision === 'decline'
          ? 'Declined. The agent hears now.'
          : 'Cancelled. The agent hears now.',
    );
  const share = (sh: Showing) =>
    act(
      `share:${sh.id}`,
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/realestate.showing.share_feedback', {
            body: { workspaceId, showingId: sh.id },
          }),
        ),
      `Shared with ${seller} in their portal.`,
    );
  return (
    <div data-testid="realestate-showings">
      <DealCrumb workspaceId={workspaceId} dealId={dealId} dealName={dealName} here="Showings" />
      <PageHeader
        title="Showings"
        description={`${list.street ?? dealName} · from our page and ShowingTime’s emails`}
        actions={
          <>
            {list.requestPath ? (
              <Button
                variant="secondary"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(`${origin}${list.requestPath}`)
                    .then(() => toast.success('Copied. Paste it wherever buyers’ agents look.'))
                }
                data-testid="showings-copy-link"
              >
                <Copy className="h-4 w-4" strokeWidth={1.75} /> Copy the request link
              </Button>
            ) : null}
            {live ? (
              <Button onClick={() => setAdding(true)} data-testid="showings-add">
                Add a showing
              </Button>
            ) : null}
          </>
        }
      />
      {!list.requestPath ? (
        <Callout tone="info" className="mb-4">
          Buyers’ agents ask for a showing on the listing’s public page. Put the page up from
          Marketing and its request link shows here.
        </Callout>
      ) : null}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-5">
        <div className="min-w-0 space-y-4">
          <Card className="overflow-x-auto p-0" data-testid="showings-table">
            {list.showings.length === 0 ? (
              <p className="px-5 py-8 text-center text-[13.5px] text-text-2">
                No showings yet. They come from the listing’s page and ShowingTime’s emails, or add
                one by hand.
              </p>
            ) : (
              <table className="w-full min-w-[600px] text-left text-[13.5px]">
                <thead className="border-b border-border text-xs font-semibold uppercase tracking-wide text-text-3">
                  <tr>
                    <th className="px-5 py-3 font-semibold">When</th>
                    <th className="px-3 py-3 font-semibold">Agent</th>
                    <th className="px-3 py-3 font-semibold">Where it stands</th>
                    <th className="px-5 py-3 font-semibold">Feedback</th>
                  </tr>
                </thead>
                <tbody>
                  {list.showings.map((sh) => (
                    <tr
                      key={sh.id}
                      className="border-b border-border align-top last:border-b-0"
                      data-testid={`showing-${sh.id}`}
                    >
                      <td className="px-5 py-3">
                        <div className="whitespace-nowrap font-medium">{sh.when}</div>
                        <div className="text-[12px] text-text-3">
                          {sh.sourceLabel}
                          {sh.source === 'showingtime' ? (
                            sh.checked ? (
                              ' · checked'
                            ) : live && sh.can.check ? (
                              <>
                                {' · '}
                                <button
                                  type="button"
                                  className="text-accent-text hover:underline"
                                  onClick={() => setChecking(sh)}
                                  data-testid="showing-check"
                                >
                                  check it
                                </button>
                              </>
                            ) : null
                          ) : null}
                          {sh.accessSentAt ? ' · access sent' : ''}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div>{sh.agentName}</div>
                        {sh.brokerage ? <div className="text-text-2">{sh.brokerage}</div> : null}
                        {sh.agentPhone || sh.agentEmail ? (
                          <div className="text-[12px] text-text-3">
                            {[sh.agentPhone, sh.agentEmail].filter(Boolean).join(' · ')}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-3 py-3">
                        <Badge variant={STATE_BADGE[sh.state]}>{sh.stateWords}</Badge>
                        {sh.decisionNote ? (
                          <div className="mt-1 text-[12px] text-text-3">{sh.decisionNote}</div>
                        ) : null}
                        {live && (sh.can.confirm || sh.can.decline || sh.can.cancel) ? (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {sh.can.confirm ? (
                              <Button
                                size="sm"
                                variant="secondary"
                                loading={busy === `confirm:${sh.id}`}
                                onClick={() => void decide(sh, 'confirm')}
                                data-testid="showing-confirm"
                              >
                                Confirm
                              </Button>
                            ) : null}
                            {sh.can.decline ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                loading={busy === `decline:${sh.id}`}
                                onClick={() => void decide(sh, 'decline')}
                              >
                                Decline
                              </Button>
                            ) : null}
                            {sh.can.cancel ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                loading={busy === `cancel:${sh.id}`}
                                onClick={() =>
                                  confirm(
                                    `Cancel the showing ${sh.when}? ${sh.agentName} hears now.`,
                                  ) && void decide(sh, 'cancel')
                                }
                              >
                                Cancel it
                              </Button>
                            ) : null}
                          </div>
                        ) : null}
                      </td>
                      <td className="max-w-[240px] px-5 py-3">
                        {feedbackLine(sh) ? (
                          <div>{feedbackLine(sh)}</div>
                        ) : sh.feedbackAskedAt ? (
                          <span className="text-text-2">Link sent</span>
                        ) : (
                          <span className="text-text-3">—</span>
                        )}
                        <div className="mt-1 flex flex-wrap gap-x-3 text-[12.5px]">
                          {live && sh.can.feedback ? (
                            <button
                              type="button"
                              className="text-accent-text hover:underline"
                              onClick={() => setFeedback(sh)}
                            >
                              {sh.feedback ? 'Change it' : 'Type it in'}
                            </button>
                          ) : null}
                          {live && sh.can.share ? (
                            <button
                              type="button"
                              className="text-accent-text hover:underline"
                              disabled={busy === `share:${sh.id}`}
                              onClick={() => void share(sh)}
                              data-testid="showing-share"
                            >
                              Share with {seller}
                            </button>
                          ) : sh.feedbackSharedAt ? (
                            <span className="text-text-3">Shared with {seller}</span>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          <LockboxesCard
            workspaceId={workspaceId}
            dealId={dealId}
            timeZone={timeZone}
            list={lockboxes}
            live={live}
          />
        </div>
        <div className="space-y-4">
          <Card className="p-4 md:p-5" data-testid="showings-said">
            <CardHead title="What buyers said" />
            <p className="text-[13px] text-text-2">{list.summary.words}</p>
            <dl className="mt-3 space-y-2 text-[13.5px]">
              {list.themes?.likedWords ? (
                <div>
                  <dt className="text-[12px] font-semibold uppercase tracking-wide text-text-3">
                    Liked
                  </dt>
                  <dd>{list.themes.likedWords}</dd>
                </div>
              ) : null}
              {list.themes?.dislikedWords ? (
                <div>
                  <dt className="text-[12px] font-semibold uppercase tracking-wide text-text-3">
                    Didn’t
                  </dt>
                  <dd>{list.themes.dislikedWords}</dd>
                </div>
              ) : null}
              {list.summary.averageInterest !== null ? (
                <div>
                  <dt className="text-[12px] font-semibold uppercase tracking-wide text-text-3">
                    Interest
                  </dt>
                  <dd>{list.summary.interestWords}</dd>
                </div>
              ) : null}
              {list.summary.answered ? (
                <div>
                  <dt className="text-[12px] font-semibold uppercase tracking-wide text-text-3">
                    Price
                  </dt>
                  <dd>
                    {(['low', 'right', 'high'] as const)
                      .filter((k) => list.summary.price[k])
                      .map((k) => `${PRICE_FEELS[k].toLowerCase()} (${list.summary.price[k]})`)
                      .join(', ') || 'Nobody said'}
                  </dd>
                </div>
              ) : null}
            </dl>
            <p className="mt-3 text-[12px] text-text-3">
              Themes the AI drew from their words, each with its quotes. Nothing goes to {seller}{' '}
              until you share it.
            </p>
          </Card>
          <Card className="p-4 md:p-5" data-testid="showings-how">
            <CardHead
              title="How showings work here"
              action={
                live ? (
                  <button
                    type="button"
                    className="text-[13px] text-accent-text hover:underline"
                    onClick={() => setSettings(true)}
                    data-testid="showings-settings"
                  >
                    Change
                  </button>
                ) : undefined
              }
            />
            <dl className="space-y-2 text-[13.5px]">
              <Line label="Requests">
                {s.open
                  ? `${s.days.map((d) => DAYS[d]).join(', ') || 'No days'} · ${s.from}–${s.to} · ${s.minutes} minutes`
                  : 'Not taken on the listing’s page'}
              </Line>
              <Line label="Confirming">
                {s.confirm === 'seller'
                  ? `${seller} says yes in their portal`
                  : SHOWING_CONFIRMS.auto}
              </Line>
              <Line label="Access">
                {s.access || lockboxes.lockboxes.some((l) => l.hasCode)
                  ? `Sent to the confirmed agent ${s.accessHours} ${s.accessHours === 1 ? 'hour' : 'hours'} before`
                  : 'No access instructions yet'}
              </Line>
              {lockboxes.lockboxes.some((l) => l.hasCode) ? (
                <Line label="Lockbox codes">
                  Only in that email, put in as it’s sent. Never on phones, in exports or in the
                  Inbox.
                </Line>
              ) : null}
              <Line label="Feedback">
                Asked for {s.feedbackHours} {s.feedbackHours === 1 ? 'hour' : 'hours'} after
              </Line>
            </dl>
          </Card>
        </div>
      </div>
      <SettingsDialog
        open={settings}
        onClose={() => setSettings(false)}
        workspaceId={workspaceId}
        dealId={dealId}
        settings={s}
        seller={seller}
      />
      <AddShowingDialog
        open={adding}
        onClose={() => setAdding(false)}
        workspaceId={workspaceId}
        dealId={dealId}
        timeZone={timeZone}
        minutes={s.minutes}
      />
      <CheckDialog
        showing={checking}
        onClose={() => setChecking(null)}
        workspaceId={workspaceId}
        timeZone={timeZone}
      />
      <FeedbackDialog
        showing={feedback}
        onClose={() => setFeedback(null)}
        workspaceId={workspaceId}
      />
    </div>
  );
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[12px] font-semibold uppercase tracking-wide text-text-3">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** A date and time typed in the business's time zone, as an instant. */
const instantOf = (local: string, timeZone: string) =>
  new Date(localInstant(local.slice(0, 10), local.slice(11, 16), timeZone)).toISOString();

/** How showings work here: who says yes, the open times, access instructions, feedback. */
function SettingsDialog({
  open,
  onClose,
  workspaceId,
  dealId,
  settings,
  seller,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  dealId: string;
  settings: ShowingList['settings'];
  seller: string;
}) {
  const [s, setS] = useState(settings);
  const { busy, errors, act } = useAct(onClose);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) return;
        setS(settings);
        onClose();
      }}
    >
      <DialogContent
        title="How showings work here"
        className="max-h-[92dvh] w-[min(560px,calc(100vw-32px))] overflow-y-auto"
      >
        <form
          className="mt-4 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'save',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/realestate.showing.settings', {
                    body: { workspaceId, dealId, ...s },
                  }),
                ),
              'Saved.',
            );
          }}
        >
          <div className="flex items-center justify-between gap-3 text-[13.5px]">
            <span>Take requests on the listing’s page</span>
            <Switch
              checked={s.open}
              onChange={(open) => setS({ ...s, open })}
              label="Take requests on the listing’s page"
              testId="showings-open"
            />
          </div>
          <Field label="Who says yes" htmlFor="sh-confirm">
            <Select
              id="sh-confirm"
              value={s.confirm}
              onChange={(e) => setS({ ...s, confirm: e.target.value as 'seller' | 'auto' })}
            >
              <option value="seller">{seller} says yes in their portal</option>
              <option value="auto">{SHOWING_CONFIRMS.auto}</option>
            </Select>
          </Field>
          <div>
            <div className="mb-1.5 text-[13px] font-medium">Days</div>
            <div className="flex flex-wrap gap-1.5">
              {DAYS.map((d, i) => {
                const on = s.days.includes(i);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setS({
                        ...s,
                        days: on ? s.days.filter((x) => x !== i) : [...s.days, i].sort(),
                      })
                    }
                    className={cn(
                      'h-8 rounded-full border px-3 text-[13px]',
                      on
                        ? 'border-accent-soft bg-accent-soft text-accent-text'
                        : 'border-border-strong text-text-2',
                    )}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="From" htmlFor="sh-from" error={errors.from}>
              <Input
                id="sh-from"
                type="time"
                value={s.from}
                onChange={(e) => setS({ ...s, from: e.target.value })}
              />
            </Field>
            <Field label="To" htmlFor="sh-to" error={errors.to}>
              <Input
                id="sh-to"
                type="time"
                value={s.to}
                onChange={(e) => setS({ ...s, to: e.target.value })}
              />
            </Field>
            <Field label="Each one" htmlFor="sh-minutes">
              <Select
                id="sh-minutes"
                value={String(s.minutes)}
                onChange={(e) => setS({ ...s, minutes: Number(e.target.value) })}
              >
                {[15, 30, 45, 60, 90].map((m) => (
                  <option key={m} value={m}>
                    {m} minutes
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field
            label="Access instructions"
            htmlFor="sh-access"
            hint="The lockbox code and how to get in. Sent only to a confirmed showing’s agent, before it."
            error={errors.access}
          >
            <Textarea
              id="sh-access"
              rows={3}
              value={s.access ?? ''}
              onChange={(e) => setS({ ...s, access: e.target.value || null })}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Send them" htmlFor="sh-access-hours">
              <Select
                id="sh-access-hours"
                value={String(s.accessHours)}
                onChange={(e) => setS({ ...s, accessHours: Number(e.target.value) })}
              >
                {[0, 1, 2, 4, 24].map((h) => (
                  <option key={h} value={h}>
                    {h === 0 ? 'When it’s confirmed' : `${h} ${h === 1 ? 'hour' : 'hours'} before`}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Ask for feedback" htmlFor="sh-feedback-hours">
              <Select
                id="sh-feedback-hours"
                value={String(s.feedbackHours)}
                onChange={(e) => setS({ ...s, feedbackHours: Number(e.target.value) })}
              >
                {[0, 1, 2, 4, 24].map((h) => (
                  <option key={h} value={h}>
                    {h === 0 ? 'Right after' : `${h} ${h === 1 ? 'hour' : 'hours'} after`}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy === 'save'} data-testid="showings-save">
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A showing set up some other way (a phone call), added by hand. */
function AddShowingDialog({
  open,
  onClose,
  workspaceId,
  dealId,
  timeZone,
  minutes,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  dealId: string;
  timeZone: string;
  minutes: number;
}) {
  const [at, setAt] = useState('');
  const [name, setName] = useState('');
  const [brokerage, setBrokerage] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const { busy, errors, act } = useAct(() => {
    setAt('');
    setName('');
    setBrokerage('');
    setEmail('');
    setPhone('');
    onClose();
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Add a showing" className="w-[min(520px,calc(100vw-32px))]">
        <form
          className="mt-4 grid gap-3.5 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'add',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/realestate.showing.add', {
                    body: {
                      workspaceId,
                      dealId,
                      startsAt: at ? instantOf(at, timeZone) : '',
                      minutes,
                      agentName: name,
                      brokerage: brokerage.trim() || undefined,
                      agentEmail: email.trim() || undefined,
                      agentPhone: phone.trim() || undefined,
                    },
                  }),
                ),
              'Added.',
            );
          }}
        >
          <Field label="When" htmlFor="sh-at" error={errors.startsAt} className="sm:col-span-2">
            <Input
              id="sh-at"
              type="datetime-local"
              value={at}
              onChange={(e) => setAt(e.target.value)}
            />
          </Field>
          <Field label="Buyer’s agent" htmlFor="sh-name" error={errors.agentName}>
            <Input id="sh-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Brokerage (optional)" htmlFor="sh-brokerage" error={errors.brokerage}>
            <Input
              id="sh-brokerage"
              value={brokerage}
              onChange={(e) => setBrokerage(e.target.value)}
            />
          </Field>
          <Field label="Email (optional)" htmlFor="sh-email" error={errors.agentEmail}>
            <Input
              id="sh-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Mobile (optional)" htmlFor="sh-phone" error={errors.agentPhone}>
            <Input id="sh-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy === 'add'}>
              Add it
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A showing read from ShowingTime's email, checked by a person: the time and agent as read, fixed if wrong. */
function CheckDialog({
  showing,
  onClose,
  workspaceId,
  timeZone,
}: {
  showing: Showing | null;
  onClose: () => void;
  workspaceId: string;
  timeZone: string;
}) {
  const [at, setAt] = useState('');
  const [name, setName] = useState('');
  const { busy, errors, act } = useAct(onClose);
  return (
    <Dialog open={showing !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Check it against ShowingTime’s email"
        description={
          showing
            ? `Read as ${showing.when} with ${showing.agentName}. Fix what was read wrong.`
            : ''
        }
        className="w-[min(480px,calc(100vw-32px))]"
      >
        <form
          className="mt-4 space-y-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!showing) return;
            void act(
              'check',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/realestate.showing.check', {
                    body: {
                      workspaceId,
                      showingId: showing.id,
                      ...(at ? { startsAt: instantOf(at, timeZone) } : {}),
                      ...(name.trim() ? { agentName: name.trim() } : {}),
                    },
                  }),
                ),
              'Checked.',
            );
          }}
        >
          <Field
            label="The right time (only if it’s wrong)"
            htmlFor="chk-at"
            error={errors.startsAt}
          >
            <Input
              id="chk-at"
              type="datetime-local"
              value={at}
              onChange={(e) => setAt(e.target.value)}
            />
          </Field>
          <Field
            label="The right agent (only if it’s wrong)"
            htmlFor="chk-name"
            error={errors.agentName}
          >
            <Input id="chk-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy === 'check'} data-testid="showing-check-save">
              It’s right
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Feedback the agent heard another way (a call), typed in. */
function FeedbackDialog({
  showing,
  onClose,
  workspaceId,
}: {
  showing: Showing | null;
  onClose: () => void;
  workspaceId: string;
}) {
  const [interest, setInterest] = useState<number | null>(null);
  const [liked, setLiked] = useState('');
  const [pause, setPause] = useState('');
  const [price, setPrice] = useState<PriceFeel | ''>('');
  const { busy, act } = useAct(onClose);
  return (
    <Dialog open={showing !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="What the buyers said"
        description={showing ? `${showing.when} · ${showing.agentName}` : ''}
        className="w-[min(520px,calc(100vw-32px))]"
      >
        <form
          className="mt-4 space-y-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!showing) return;
            void act(
              'save',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/realestate.showing.feedback', {
                    body: {
                      workspaceId,
                      showingId: showing.id,
                      interest,
                      liked: liked.trim() || null,
                      pause: pause.trim() || null,
                      price: price || null,
                    },
                  }),
                ),
              'Saved.',
            );
          }}
        >
          <div>
            <div className="mb-1.5 text-[13px] font-medium">Their interest</div>
            <div className="flex gap-1.5">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  aria-pressed={interest === n}
                  onClick={() => setInterest(n)}
                  className={cn(
                    'h-9 w-9 rounded-control border text-[14px]',
                    interest === n
                      ? 'border-accent bg-accent-soft font-semibold text-accent-text'
                      : 'border-border-strong',
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          <Field label="What they liked" htmlFor="fb-liked">
            <Textarea
              id="fb-liked"
              rows={2}
              value={liked}
              onChange={(e) => setLiked(e.target.value)}
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
          <Field label="The price" htmlFor="fb-price">
            <Select
              id="fb-price"
              value={price}
              onChange={(e) => setPrice(e.target.value as PriceFeel | '')}
            >
              <option value="">They didn’t say</option>
              {(Object.keys(PRICE_FEELS) as PriceFeel[]).map((k) => (
                <option key={k} value={k}>
                  {PRICE_FEELS[k]}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy === 'save'}>
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The listing's showings on its deal page: what waits, and what's coming. */
export function ShowingsCard({
  workspaceId,
  dealId,
  list,
}: {
  workspaceId: string;
  dealId: string;
  list: ShowingList;
}) {
  const waiting = list.showings.filter((s) => s.state === 'requested');
  const unchecked = list.showings.filter((s) => s.can.check);
  const coming = list.showings
    .filter((s) => s.state === 'confirmed' && new Date(s.startsAt).getTime() > Date.now())
    .slice(0, 3);
  return (
    <Card className="p-4 md:p-5" data-testid="listing-showings">
      <CardHead
        title="Showings"
        action={<HeadLink href={dealHref(workspaceId, dealId, 'showings')}>Open</HeadLink>}
      />
      {list.showings.length === 0 ? (
        <p className="text-[13.5px] text-text-2">
          None yet. Buyers’ agents ask on the listing’s page, and ShowingTime’s emails are read in.
        </p>
      ) : (
        <div className="space-y-2.5 text-[13.5px]">
          {waiting.length || unchecked.length ? (
            <div className="flex flex-wrap gap-1.5">
              {waiting.length ? (
                <Badge variant="pending">
                  {waiting.length} waiting on {list.sellerFirstName ?? 'the seller'}
                </Badge>
              ) : null}
              {unchecked.length ? (
                <Badge variant="pending">{unchecked.length} from ShowingTime to check</Badge>
              ) : null}
            </div>
          ) : null}
          {coming.length ? (
            <ul className="space-y-1.5">
              {coming.map((s) => (
                <li key={s.id} className="flex justify-between gap-3">
                  <span className="font-medium">{s.when}</span>
                  <span className="truncate text-text-2">
                    {s.agentName}
                    {s.brokerage ? ` · ${s.brokerage}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="text-[13px] text-text-2">{list.summary.words}</p>
        </div>
      )}
    </Card>
  );
}
