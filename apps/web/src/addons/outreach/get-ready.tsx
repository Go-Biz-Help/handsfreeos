'use client';
/**
 * Get ready for your best results (docs/outreach.md, decision 63; packages/core/src/addons/outreach/readiness.ts): the
 * card on Today while the person isn't ready, and the setup's step. Each item says what's left and opens where it's
 * done: the main offer in Settings, a playbook's niche on the Playbooks tab, and the person's own three in a sheet here:
 * their profile, read by their computer and checked by the AI (decision 64), with bios to put in and each item to tick
 * once it's right; their messages, samples the AI writes for their playbook in their voice, to OK (decisions 65 to 67);
 * and their goal with the math worked as they change it.
 *
 * The profile is the network's own (`readiness.platform`): LinkedIn's has its own list in its words, headlines up to
 * 220 characters to put in, and its whole About, each asked and ticked on LinkedIn; Instagram's its bio to put in and a
 * name to use (decision 80). What the AI wrote can be changed before it goes in, nothing still in [brackets] goes in,
 * and **Put them all in** puts the picked headline and the About in with one press, the person's OK for both.
 */
import { bioEditShown } from '@hfos/core/addons/outreach/asks';
import { WEEKDAY_WORDS } from '@hfos/core/addons/outreach/automation';
import {
  numbersLines,
  numbersMath,
  numbersVerdict,
  profileWordsOn,
  READY_WORDS as R,
  tickCounts,
  CALLS_GOAL,
  type ReadyItem,
  type ReadyState,
} from '@hfos/core/addons/outreach/readiness';
import type { MessageSamples } from '@hfos/core/addons/outreach/conversation';
import {
  ABOUT_MOST,
  ASK_RECOMMENDATIONS_URL,
  checkCounts,
  hasPlaceholder,
  RECOMMENDATIONS_WORDS as RW,
  type AnyProfileItem,
} from '@hfos/core/addons/outreach/profile-check';
import { Check, CheckCircle2, Circle, Clock, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ButtonLink, Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Stepper } from '@/components/ui/stepper';
import { copyText } from '@/components/ui/copy-field';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { workerPost } from '@/lib/api/worker';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { outreachHref } from './address';
import { AskButton, AskLine } from './asks';
import type { Asks, Readiness } from './types';

/** Monday first, as the working week reads. */
const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;

const STATE_ICON: Record<ReadyState, { icon: typeof Circle; className: string }> = {
  done: { icon: CheckCircle2, className: 'text-success' },
  todo: { icon: Circle, className: 'text-text-3' },
  look_again: { icon: RefreshCw, className: 'text-warning' },
  waiting: { icon: Clock, className: 'text-warning' },
};

/** The five items, each with what's left and where it's done. Used on Today's card and in the setup's step. */
export function ReadyItems({
  workspaceId,
  readiness,
  asks,
  onChange,
}: {
  workspaceId: string;
  readiness: Readiness;
  /** Reading the profile and putting a bio in, asked of the person's computer: null where they can't be asked. */
  asks: Asks | null;
  /** The person's own two changed: what the server says now. */
  onChange?: (next: Readiness) => void;
}) {
  const [open, setOpen] = useState<'profile' | 'messages' | 'numbers' | null>(null);
  const go = (item: ReadyItem, left: string | null): ReactNode => {
    const label = R.items[item].go;
    // OK'd, with the playbook's short video still to link: its step in the playbook (decision 69).
    if (item === 'messages' && left === R.left.messagesVideo)
      return (
        <ButtonLink
          size="sm"
          variant="secondary"
          href={outreachHref(workspaceId, { view: 'playbooks' })}
          data-testid="ready-add-video"
        >
          {R.items.messages.goVideo}
        </ButtonLink>
      );
    if (item === 'offer')
      return (
        <ButtonLink
          size="sm"
          variant="secondary"
          href={`/app/w/${workspaceId}/settings/main-offer`}
        >
          {label}
        </ButtonLink>
      );
    if (item === 'playbook')
      return (
        <ButtonLink
          size="sm"
          variant="secondary"
          href={outreachHref(workspaceId, { view: 'playbooks' })}
        >
          {label}
        </ButtonLink>
      );
    return (
      <Button
        size="sm"
        variant="secondary"
        onClick={() => setOpen(item)}
        data-testid={`ready-open-${item}`}
      >
        {label}
      </Button>
    );
  };
  return (
    <>
      <ul className="divide-y divide-border">
        {readiness.items.map((i) => {
          const { icon: Icon, className } = STATE_ICON[i.state];
          return (
            <li
              key={i.item}
              className="grid grid-cols-[20px_minmax(0,1fr)] gap-3 py-4 sm:grid-cols-[20px_minmax(0,1fr)_auto] sm:items-start"
              data-testid={`ready-${i.item}`}
              data-state={i.state}
            >
              <Icon
                className={cn('mt-0.5 h-5 w-5', className)}
                strokeWidth={1.75}
                aria-label={R.states[i.state]}
                role="img"
              />
              <div className="min-w-0">
                <p className="font-semibold">{R.items[i.item].label}</p>
                {i.state === 'done' ? null : (
                  <p className="text-[13px] text-text-2">{R.items[i.item].why}</p>
                )}
                {i.left ? <p className="mt-1 text-[13px]">{i.left}</p> : null}
                {(i.item === 'profile' || i.item === 'messages') &&
                i.state === 'look_again' &&
                readiness.changed.length ? (
                  <p className="text-[13px] text-text-2">{R.changed(readiness.changed)}</p>
                ) : null}
              </div>
              <div className="col-start-2 sm:col-start-3">
                {i.state === 'done' ? (
                  <span className="inline-flex h-[22px] items-center rounded-full bg-success-soft px-2 text-[12px] font-medium text-success-text">
                    {R.states.done}
                  </span>
                ) : i.state === 'waiting' ? (
                  <span className="inline-flex h-[22px] items-center rounded-full bg-warning-soft px-2 text-[12px] font-medium text-warning-text">
                    {R.states.waiting}
                  </span>
                ) : (
                  go(i.item, i.left)
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <ProfileSheet
        workspaceId={workspaceId}
        readiness={readiness}
        asks={asks}
        open={open === 'profile'}
        onClose={() => setOpen(null)}
        onChange={onChange}
      />
      <MessagesSheet
        workspaceId={workspaceId}
        readiness={readiness}
        open={open === 'messages'}
        onClose={() => setOpen(null)}
        onChange={onChange}
      />
      <NumbersSheet
        workspaceId={workspaceId}
        readiness={readiness}
        open={open === 'numbers'}
        onClose={() => setOpen(null)}
        onChange={onChange}
      />
    </>
  );
}

/** Today's card while the person isn't ready: in place of the day's list. */
export function GetReadyCard({
  workspaceId,
  readiness: start,
  asks,
}: {
  workspaceId: string;
  readiness: Readiness;
  asks: Asks | null;
}) {
  const router = useRouter();
  // The profile read and checked, or a bio put in, on the person's computer: it shows here.
  useLiveRefresh(['outreach_setup', 'outreach_ask'], 800);
  const [readiness, setReadiness] = useState(start);
  useEffect(() => setReadiness(start), [start]);
  const done = readiness.items.filter((i) => i.state === 'done').length;
  const of = readiness.items.length;
  const waitingOnBusiness = readiness.items.some((i) => i.state === 'waiting');
  return (
    <Card className="p-0" data-testid="get-ready">
      <div className="grid gap-3 p-5 pb-1">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
              {R.card}
            </p>
            <h2 className="mt-1 text-lg font-semibold tracking-tight">{R.title}</h2>
            <p className="mt-1 text-[13px] text-text-2">
              {R.cardHint(of - done)}
              {waitingOnBusiness ? ` ${R.waitingBusiness}` : ''}
            </p>
          </div>
          <span className="text-[13px] tabular-nums text-text-2">{R.progress(done, of)}</span>
        </div>
        <div
          className="h-1.5 overflow-hidden rounded-full bg-card-2"
          role="progressbar"
          aria-label={R.progress(done, of)}
          aria-valuemin={0}
          aria-valuemax={of}
          aria-valuenow={done}
        >
          <div
            className="h-full rounded-full bg-accent"
            style={{ width: `${(done / of) * 100}%` }}
          />
        </div>
      </div>
      <div className="px-5 pb-1">
        <ReadyItems
          workspaceId={workspaceId}
          readiness={readiness}
          asks={asks}
          onChange={(next) => {
            setReadiness(next);
            // Ready now: Today's list comes back.
            if (next.ready) router.refresh();
          }}
        />
      </div>
    </Card>
  );
}

export function ProfileSheet({
  workspaceId,
  readiness,
  asks,
  open,
  onClose,
  onChange,
}: {
  workspaceId: string;
  readiness: Readiness;
  asks: Asks | null;
  open: boolean;
  onClose: () => void;
  onChange?: (next: Readiness) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  // The network's own profile: its list, its words, and its asks.
  const platform = readiness.platform ?? 'facebook';
  const P = profileWordsOn(platform);
  const live = readiness.offer?.version ?? null;
  const on = (item: AnyProfileItem) => tickCounts(readiness.profile[item], live);
  // The AI's check, when it's of the live version: what's right, and what to change.
  const check = checkCounts(readiness.profileCheck, live) ? readiness.profileCheck : null;
  const right = (item: AnyProfileItem) => on(item) || check?.items[item]?.ok === true;
  const edit = bioEditShown(asks, platform, readiness.profileCheck?.at ?? null);
  // The headline picked for Put them all in, and the About as the person changed it (decision 80).
  const [picked, setPicked] = useState(0);
  const [about, setAbout] = useState(check?.aboutDraft ?? '');
  useEffect(() => setAbout(check?.aboutDraft ?? ''), [check?.aboutDraft]);
  const bio = check?.bios[picked] ?? check?.bios[0] ?? null;
  const aboutWhy = !about.trim()
    ? null
    : about.trim().length > ABOUT_MOST
      ? P.tooLong(about.trim().length, ABOUT_MOST)
      : hasPlaceholder(about)
        ? P.fillIn
        : null;
  const ticked = P.items.filter((i) => right(i.item)).length;
  const again = readiness.items.find((i) => i.item === 'profile')?.state === 'look_again';
  const tick = async (item: AnyProfileItem) => {
    setBusy(item);
    try {
      const next = unwrap(
        await apiBrowser().POST('/v1/commands/outreach.readiness.profile', {
          body: { workspaceId, platform, item, done: !on(item) },
        }),
      );
      onChange?.(next);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent title={P.title} description={P.hint}>
        <div className="grid gap-4" data-testid="ready-profile-sheet">
          {again ? (
            <p
              role="status"
              className="rounded-menu bg-warning-soft p-3 text-[13px] text-warning-text"
            >
              <span className="font-semibold">{R.left.profileAgain}</span>
              {readiness.changed.length ? ` ${R.changed(readiness.changed)}` : null}
            </p>
          ) : null}
          {readiness.offer ? (
            <div className="grid gap-1.5">
              <div className="flex justify-between text-[13px] text-text-2">
                <span>{P.offer}</span>
                <span className="tabular-nums">{P.ticked(ticked, P.items.length)}</span>
              </div>
              <p className="text-[13px] font-medium">“{readiness.offer.line}”</p>
            </div>
          ) : null}
          <div className="grid gap-2 rounded-menu bg-card-2 p-3" data-testid="ready-profile-read">
            <p className="text-[13px] text-text-2">
              {check
                ? P.readAt(
                    new Date(check.at).toLocaleString([], {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    }),
                  )
                : P.notRead}
            </p>
            {asks ? (
              <AskButton
                workspaceId={workspaceId}
                asks={asks}
                ask={{ kind: 'profile_read' }}
                platform={platform}
                label={check ? P.readAgain : P.read}
                variant={check ? 'secondary' : 'primary'}
                testId="ready-profile-read-ask"
              />
            ) : null}
          </div>
          <ul className="divide-y divide-border">
            {P.items.map((words) => {
              const { item } = words;
              const checked = on(item);
              const ai = check?.items[item] ?? null;
              return (
                <li key={item} className="grid grid-cols-[24px_minmax(0,1fr)] gap-3 py-3.5">
                  {ai?.ok && !checked ? (
                    // Right by the AI's check: nothing to tick.
                    <CheckCircle2
                      className="mt-0.5 h-5 w-5 text-success"
                      strokeWidth={1.75}
                      role="img"
                      aria-label={P.ok}
                      data-testid={`ready-profile-${item}-ok`}
                    />
                  ) : (
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      aria-label={words.label}
                      disabled={busy !== null}
                      onClick={() => void tick(item)}
                      data-testid={`ready-profile-${item}`}
                      className={cn(
                        'mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-[6px] border-[1.5px] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring disabled:cursor-wait',
                        checked
                          ? 'border-accent bg-accent text-white'
                          : 'border-border-strong bg-card',
                      )}
                    >
                      {checked ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : null}
                    </button>
                  )}
                  <div className="min-w-0" data-testid={`ready-profile-ai-${item}`}>
                    <p className="font-semibold">{words.label}</p>
                    {ai ? (
                      <p
                        className={cn(
                          'text-[13px]',
                          ai.ok ? 'text-success-text' : 'text-warning-text',
                        )}
                      >
                        <span className="font-medium">{ai.ok ? P.ok : P.fix}:</span>{' '}
                        {ai.ok ? ai.why : (ai.fix ?? ai.why)}
                      </p>
                    ) : (
                      <p className="text-[13px] text-text-2">{words.tip}</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {check?.bios.length ? (
            <div className="grid gap-2" data-testid="ready-bios">
              <div>
                <p className="font-semibold">{P.bios}</p>
                <p className="text-[13px] text-text-2">{P.biosHint}</p>
              </div>
              {check.bios.map((option, i) => (
                <div
                  key={option}
                  className={cn(
                    'grid gap-2 rounded-menu border p-3',
                    check.aboutDraft && i === picked ? 'border-accent' : 'border-border',
                  )}
                >
                  {check.aboutDraft ? (
                    // The one Put them all in puts in beside the About.
                    <button
                      type="button"
                      role="radio"
                      aria-checked={i === picked}
                      onClick={() => setPicked(i)}
                      className="text-left text-[14px]"
                      data-testid={`ready-bio-pick-${i}`}
                    >
                      “{option}”
                    </button>
                  ) : (
                    <p className="text-[14px]">“{option}”</p>
                  )}
                  {hasPlaceholder(option) ? (
                    <p className="text-[12.5px] text-warning-text">{P.fillIn}</p>
                  ) : asks ? (
                    <AskButton
                      workspaceId={workspaceId}
                      asks={asks}
                      ask={{ kind: 'profile_edit', bio: option }}
                      platform={platform}
                      label={P.useBio}
                      showLine={false}
                      testId={`ready-bio-use-${i}`}
                    />
                  ) : null}
                </div>
              ))}
              {/* How the last one put in went, once: an ask doesn't say which it was. */}
              {edit && asks ? <AskLine workspaceId={workspaceId} asks={asks} ask={edit} /> : null}
            </div>
          ) : null}
          {check?.coverLine ? (
            <div className="grid gap-1">
              <p className="font-semibold">{P.coverLine}</p>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-[14px]">“{check.coverLine}”</p>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void copyText(check.coverLine!, P.coverCopied)}
                  data-testid="ready-cover-copy"
                >
                  Copy
                </Button>
              </div>
              <p className="text-[12.5px] text-text-3">{P.coverHint}</p>
            </div>
          ) : null}
          {platform === 'alignable' && check ? (
            <div className="grid gap-1.5" data-testid="ready-recommendations">
              <div>
                <p className="font-semibold">{RW.title}</p>
                <p className="text-[13px] text-text-2" data-testid="ready-recommendations-count">
                  {RW.count(check.recommendations ?? null)}
                </p>
              </div>
              {check.recommendNote ? (
                <div className="grid gap-1">
                  <p className="text-[13px] font-medium">{RW.note}</p>
                  <p className="whitespace-pre-wrap text-[14px]" data-testid="ready-recommend-note">
                    {check.recommendNote}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void copyText(check.recommendNote!, RW.copied)}
                      data-testid="ready-recommend-copy"
                    >
                      Copy
                    </Button>
                    <a
                      href={ASK_RECOMMENDATIONS_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[13px] font-medium text-accent-text hover:underline"
                    >
                      {RW.open}
                    </a>
                  </div>
                  <p className="text-[12.5px] text-text-3">{RW.noteHint}</p>
                </div>
              ) : null}
            </div>
          ) : null}
          {check?.aboutDraft && P.about ? (
            <div className="grid gap-1.5" data-testid="ready-about">
              <div>
                <p className="font-semibold">{P.about}</p>
                <p className="text-[13px] text-text-2">{P.aboutHint}</p>
              </div>
              <textarea
                value={about}
                onChange={(e) => setAbout(e.target.value)}
                rows={8}
                aria-label={P.about}
                className="w-full rounded-menu border border-border bg-card p-3 text-[14px] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
                data-testid="ready-about-text"
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p
                  className={cn('text-[12.5px]', aboutWhy ? 'text-warning-text' : 'text-text-3')}
                  data-testid="ready-about-why"
                >
                  {aboutWhy ?? P.length(about.trim().length, ABOUT_MOST)}
                </p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void copyText(about, P.aboutCopied ?? 'Copied.')}
                    data-testid="ready-about-copy"
                  >
                    Copy
                  </Button>
                  {asks ? (
                    <AskButton
                      workspaceId={workspaceId}
                      asks={asks}
                      ask={{ kind: 'profile_edit', about: about.trim() }}
                      platform={platform}
                      label={P.useBio}
                      showLine={false}
                      disabled={aboutWhy !== null || !about.trim()}
                      testId="ready-about-use"
                    />
                  ) : null}
                </div>
              </div>
              {asks && bio && !hasPlaceholder(bio) ? (
                // Both in one press: the headline picked above, and this About (decision 80).
                <div className="grid gap-1 rounded-menu bg-card-2 p-3" data-testid="ready-all">
                  <p className="text-[13px] text-text-2">{P.useAllHint}</p>
                  <div>
                    <AskButton
                      workspaceId={workspaceId}
                      asks={asks}
                      ask={{ kind: 'profile_edit', bio, about: about.trim() }}
                      platform={platform}
                      label={P.useAll}
                      variant="primary"
                      showLine={false}
                      disabled={aboutWhy !== null || !about.trim()}
                      testId="ready-all-use"
                    />
                  </div>
                </div>
              ) : null}
              {/* With no bios (Alignable's), how the last one put in went shows here: its code's box among it. */}
              {!check.bios.length && edit && asks ? (
                <AskLine workspaceId={workspaceId} asks={asks} ask={edit} />
              ) : null}
            </div>
          ) : null}
          {check?.nameDraft ? (
            <div className="grid gap-1" data-testid="ready-name">
              <p className="font-semibold">{P.name}</p>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-[14px]">“{check.nameDraft}”</p>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void copyText(check.nameDraft!, P.nameCopied)}
                  data-testid="ready-name-copy"
                >
                  Copy
                </Button>
              </div>
              <p className="text-[12.5px] text-text-3">{P.nameHint}</p>
            </div>
          ) : null}
          {check?.feature.length ? (
            <div className="grid gap-1">
              <p className="font-semibold">{P.feature}</p>
              <ul className="list-disc pl-5 text-[13.5px]">
                {check.feature.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="flex justify-end">
            <Button onClick={onClose} data-testid="ready-profile-done">
              {P.done}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Your messages: samples the AI writes for the person's playbook, in their voice, to someone made up (the worker's
 * `outreach.messages.samples`). The first messages, the video, the link, the follow-ups in turn and a check-in, each as
 * it would read in Messenger; They read right OKs them against the main offer live now.
 */
function MessagesSheet({
  workspaceId,
  readiness,
  open,
  onClose,
  onChange,
}: {
  workspaceId: string;
  readiness: Readiness;
  open: boolean;
  onClose: () => void;
  onChange?: (next: Readiness) => void;
}) {
  const M = R.messages;
  const [samples, setSamples] = useState<MessageSamples | null>(readiness.messages.samples);
  useEffect(() => setSamples(readiness.messages.samples), [readiness.messages.samples]);
  const [busy, setBusy] = useState<'write' | 'ok' | null>(null);
  const live = readiness.offer?.version ?? null;
  const again = readiness.items.find((i) => i.item === 'messages')?.state === 'look_again';
  // Written for an earlier version: shown, but written again before they're OK'd.
  const older = samples !== null && live !== null && samples.version !== live;
  const write = async () => {
    setBusy('write');
    try {
      setSamples(
        await workerPost<MessageSamples>('/v1/addons/outreach/actions/outreach.messages.samples', {
          workspaceId,
          input: {},
        }),
      );
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const ok = async () => {
    setBusy('ok');
    try {
      const next = unwrap(
        await apiBrowser().POST('/v1/commands/outreach.readiness.messages', {
          body: { workspaceId },
        }),
      );
      toast.success(M.okd);
      onChange?.(next);
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const bubble = (text: string, key?: string) => (
    <p
      key={key}
      className="max-w-[88%] whitespace-pre-wrap rounded-[14px] bg-accent-soft px-3 py-2 text-[13.5px]"
      data-testid="ready-message-sample"
    >
      {text}
    </p>
  );
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent title={M.title} description={M.hint}>
        <div className="grid gap-4" data-testid="ready-messages-sheet">
          {samples ? (
            <p className="text-[12.5px] text-text-3">
              {M.about(samples.playbookName, samples.version)}
            </p>
          ) : null}
          {again ? (
            <p
              role="status"
              className="rounded-menu bg-warning-soft p-3 text-[13px] text-warning-text"
            >
              <span className="font-semibold">{R.left.messagesAgain}</span>
              {readiness.changed.length ? ` ${R.changed(readiness.changed)}` : null}
            </p>
          ) : older ? (
            <p
              role="status"
              className="rounded-menu bg-warning-soft p-3 text-[13px] text-warning-text"
            >
              {M.older}
            </p>
          ) : null}
          {busy === 'write' ? (
            <p className="flex items-center gap-2 text-[13px] text-text-2" role="status">
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />
              {M.writing}
            </p>
          ) : null}
          {samples ? (
            <div className="divide-y divide-border" data-testid="ready-messages-samples">
              <section className="grid gap-2 pb-4">
                <h3 className="font-semibold">{M.first}</h3>
                {samples.first.map((t) => bubble(t, t))}
              </section>
              <section className="grid gap-2 py-4">
                <h3 className="font-semibold">{M.video}</h3>
                {samples.video ? (
                  bubble(samples.video)
                ) : (
                  <p className="rounded-menu bg-card-2 p-3 text-[13px] text-text-2">{M.noVideo}</p>
                )}
              </section>
              {samples.link ? (
                <section className="grid gap-2 py-4">
                  <h3 className="font-semibold">{M.link}</h3>
                  {bubble(samples.link)}
                </section>
              ) : null}
              {samples.followUps.length ? (
                <section className="grid gap-2 py-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="font-semibold">{M.followUps(samples.followUps.length)}</h3>
                    <Link
                      href={outreachHref(workspaceId, { view: 'playbooks' })}
                      className="text-[13px] font-medium text-accent-text hover:underline"
                    >
                      {M.changeHowMany}
                    </Link>
                  </div>
                  {samples.followUps.map((t, i) => (
                    <div key={t} className="grid gap-1">
                      <span className="text-[11.5px] tabular-nums text-text-3">
                        {M.later(samples.followUpGaps[i] ?? 1)}
                      </span>
                      {bubble(t)}
                    </div>
                  ))}
                </section>
              ) : null}
              {samples.checkIn ? (
                <section className="grid gap-2 pt-4">
                  <h3 className="font-semibold">{M.checkIn}</h3>
                  {bubble(samples.checkIn)}
                </section>
              ) : null}
            </div>
          ) : busy !== 'write' ? (
            <p className="rounded-menu bg-card-2 p-3 text-[13px] text-text-2">{M.none}</p>
          ) : null}
          <div className="flex flex-wrap justify-between gap-2 border-t border-border pt-4">
            <Button
              variant={samples ? 'secondary' : 'primary'}
              onClick={() => void write()}
              loading={busy === 'write'}
              disabled={busy !== null || live === null}
              data-testid="ready-messages-write"
            >
              <Sparkles className="h-3.5 w-3.5" strokeWidth={1.5} />
              {samples ? M.again : M.write}
            </Button>
            {samples && !older ? (
              <Button
                onClick={() => void ok()}
                loading={busy === 'ok'}
                disabled={busy !== null}
                data-testid="ready-messages-ok"
              >
                {M.ok}
              </Button>
            ) : null}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function NumbersSheet({
  workspaceId,
  readiness,
  open,
  onClose,
  onChange,
}: {
  workspaceId: string;
  readiness: Readiness;
  open: boolean;
  onClose: () => void;
  onChange?: (next: Readiness) => void;
}) {
  const [goal, setGoal] = useState(readiness.numbers.goal ?? 8);
  const [days, setDays] = useState<number[]>(readiness.numbers.days);
  const [busy, setBusy] = useState(false);
  const m = numbersMath({ goal, daysAWeek: days.length, canSend: readiness.numbers.canSend });
  const toggle = (d: number) =>
    setDays((now) =>
      now.includes(d) ? (now.length > 1 ? now.filter((x) => x !== d) : now) : [...now, d],
    );
  const save = async () => {
    setBusy(true);
    try {
      const next = unwrap(
        await apiBrowser().POST('/v1/commands/outreach.readiness.numbers', {
          body: { workspaceId, goal, days },
        }),
      );
      toast.success(R.numbers.saved);
      onChange?.(next);
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent title={R.numbers.title} description={R.numbers.hint}>
        <div className="grid gap-6" data-testid="ready-numbers-sheet">
          <div className="grid gap-2">
            <span className="text-[13px] font-medium" id="ready-goal">
              {R.numbers.goal}
            </span>
            <Stepper
              value={goal}
              onChange={setGoal}
              min={CALLS_GOAL.min}
              max={CALLS_GOAL.max}
              label={R.numbers.goal}
              testId="ready-goal"
            />
          </div>
          <div className="grid gap-2">
            <span className="text-[13px] font-medium" id="ready-days">
              {R.numbers.days}
            </span>
            <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby="ready-days">
              {WEEK.map((d) => {
                const picked = days.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={picked}
                    onClick={() => toggle(d)}
                    data-testid={`ready-day-${d}`}
                    className={cn(
                      'h-9 min-w-[52px] rounded-full border px-2.5 text-[13px] font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
                      picked
                        ? 'border-accent bg-accent-soft text-accent-text'
                        : 'border-border-strong bg-card text-text-2 hover:bg-card-2',
                    )}
                  >
                    {WEEKDAY_WORDS[d]}
                  </button>
                );
              })}
            </div>
            {days.includes(0) ? (
              <p className="text-[12.5px] text-warning-text">{R.numbers.sunday}</p>
            ) : null}
          </div>
          <div className="grid gap-3" data-testid="ready-math">
            <span className="text-[13px] font-medium">{R.numbers.takes}</span>
            <div className="flex flex-wrap gap-6">
              <div>
                <p className="text-[28px] font-semibold tabular-nums tracking-tight">
                  {m.messagesADay.low} to {m.messagesADay.high}
                </p>
                <p className="text-[13px] text-text-2">{R.numbers.messagesADay}</p>
              </div>
              <div>
                <p className="text-[28px] font-semibold tabular-nums tracking-tight">
                  {Math.round(m.yesesADay * 10) / 10}
                </p>
                <p className="text-[13px] text-text-2">{R.numbers.yesesADay}</p>
              </div>
            </div>
            <ol className="grid list-decimal gap-1.5 rounded-menu bg-card-2 py-3 pl-8 pr-4 text-[13px] tabular-nums">
              {numbersLines(goal, m).map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ol>
            <p
              role="status"
              data-testid="ready-verdict"
              data-fits={m.fits}
              className={cn(
                'rounded-menu p-3 text-[13px]',
                m.fits === 'yes'
                  ? 'bg-success-soft text-success-text'
                  : 'bg-warning-soft text-warning-text',
              )}
            >
              {numbersVerdict(m)}
            </p>
            <p className="text-[12px] text-text-3">
              {R.numbers.rates} {R.numbers.notMessages}
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => void save()} loading={busy} data-testid="ready-numbers-save">
              {R.numbers.save}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
