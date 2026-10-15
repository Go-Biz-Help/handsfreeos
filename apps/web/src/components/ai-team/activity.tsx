'use client';
import type { TeammateAiUsage } from '@hfos/core';
import {
  AlertCircle,
  BookOpen,
  CalendarCheck,
  CheckCircle2,
  Gauge,
  Globe,
  Hand,
  Hourglass,
  Info,
  Loader2,
  Mail,
  MessageSquare,
  MinusCircle,
  PhoneCall,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useMemo, useState, useTransition, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Segmented } from '@/components/ui/segmented';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { teammateActions } from '@/lib/ai-team/actions';
import { feedbackActions, feedbackOn, myFeedback, useReplyFeedback } from '@/lib/ai-team/feedback';
import {
  CHANNEL_NAMES,
  checksOf,
  clockWithSeconds,
  joinWords,
  knowledgeOf,
  percentOfLimit,
  plural,
  runResult,
  toolCallState,
  toolName,
  triggerWords,
  wroteWords,
  type Tone,
} from '@/lib/ai-team/describe';
import type {
  ActivityPeriod,
  TeammateActivity,
  TeammateChannelKey,
  TeammateRun,
} from '@/lib/ai-team/types';
import { errorMessage } from '@/lib/api/client';
import { dateOf, fmtMonthDay, fmtTime, todayIn } from '@/lib/calendar/time';
import { cn } from '@/lib/utils';
import { CheckChips, KnowledgeChips } from './chips';
import { LogRow } from './log';
import { ReplyFeedback } from './reply-feedback';

type Filter = 'all' | 'handed_off' | 'drafted';

/** Who the run was for: someone not in Contacts is a website chat's visitor, or a customer by text or email. */
const whoOf = (r: Pick<TeammateRun, 'person' | 'channel'>): string =>
  r.person?.fullName ?? (r.channel === 'chat' ? 'Unknown visitor' : 'Unknown customer');

const PERIOD_WORDS: Readonly<Record<ActivityPeriod, string>> = {
  today: 'today',
  '7d': 'in the last 7 days',
  '30d': 'in the last 30 days',
};
const CHANNEL_ICONS: Readonly<Record<TeammateChannelKey, LucideIcon>> = {
  sms: MessageSquare,
  email: Mail,
  chat: Globe,
};
const RESULT_STYLE: Readonly<Record<Tone, string>> = {
  ok: 'text-success-text',
  warn: 'text-warning-text',
  danger: 'text-danger-text',
  gray: 'text-text-2',
  accent: 'text-accent-text',
};
const TOOL_ICONS: Readonly<Record<string, LucideIcon>> = {
  search_knowledge: BookOpen,
  find_times: CalendarCheck,
  my_appointments: CalendarCheck,
  read_call_transcript: PhoneCall,
  book: CalendarCheck,
  reschedule: CalendarCheck,
  cancel: CalendarCheck,
  hand_off: Hand,
};

function resultIcon(run: TeammateRun): LucideIcon {
  if (run.status === 'running') return Loader2;
  if (run.status === 'failed') return AlertCircle;
  if (run.outcome === 'drafted') return Hourglass;
  if (run.outcome === 'handed_off') return Hand;
  if (run.outcome === 'replied') return CheckCircle2;
  return MinusCircle;
}

const people = (runs: readonly TeammateRun[]) =>
  joinWords(
    [...new Set(runs.map((r) => r.person?.fullName).filter((n): n is string => !!n))].slice(0, 2),
  );

const summaryOf = (r: TeammateRun) =>
  r.summary ?? (r.replyText ? `Replied: ${r.replyText}` : triggerWords(r.triggeredBy));

function Result({ run }: { run: TeammateRun }) {
  const r = runResult(run);
  const Icon = resultIcon(run);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-[5px] whitespace-nowrap text-[12.5px]',
        RESULT_STYLE[r.tone],
      )}
    >
      <Icon
        className={cn('h-3.5 w-3.5', run.status === 'running' && 'animate-spin')}
        strokeWidth={1.75}
      />
      {r.label}
    </span>
  );
}

function Channel({ channel }: { channel: TeammateChannelKey | null }) {
  if (!channel) return <span className="text-xs text-text-3">—</span>;
  const Icon = CHANNEL_ICONS[channel];
  return (
    <span className="inline-flex items-center gap-[5px] text-xs text-text-2">
      <Icon className="h-3.5 w-3.5" strokeWidth={1.5} />
      {CHANNEL_NAMES[channel]}
    </span>
  );
}

function Tile({
  label,
  value,
  sub,
  warn,
  testId,
}: {
  label: string;
  value: number;
  sub: string;
  warn?: boolean;
  testId: string;
}) {
  return (
    <Card
      className={cn('flex min-w-0 flex-col gap-0.5 px-4 py-3.5', warn && 'border-warning')}
      data-testid={testId}
    >
      <span className="text-xs text-text-3">{label}</span>
      <span
        className={cn(
          'text-[26px] font-semibold leading-[1.15] tracking-[-0.01em]',
          warn && 'text-warning-text',
        )}
      >
        {value}
      </span>
      <span className="truncate text-xs text-text-3">{sub}</span>
    </Card>
  );
}

/**
 * The Activity tab: today's counts and AI use, the runs of the chosen period (newest first) with who each
 * was for, what the teammate did and how it came out, and a sheet per run with the message that started
 * it, each tool call, the knowledge it used and the checks. The period is in the address, so the server
 * picks the runs and a live refresh keeps it.
 */
export function TeammateActivityView({
  workspaceId,
  name,
  timeZone,
  period,
  usage,
  initial,
}: {
  workspaceId: string;
  name: string;
  timeZone: string;
  period: ActivityPeriod;
  /** Today's AI use against the daily limit (from the teammate's catalogs). */
  usage: TeammateAiUsage;
  initial: TeammateActivity;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [switching, startSwitch] = useTransition();
  const [data, setData] = useState(initial);
  const [seen, setSeen] = useState(initial);
  // A fresh page load (a live refresh, or another period) replaces what's shown.
  if (seen !== initial) {
    setSeen(initial);
    setData(initial);
  }
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<TeammateRun | null>(null);
  const [loading, setLoading] = useState(false);

  const today = todayIn(timeZone);
  const real = data.runs.filter((r) => !r.isTest);
  const todays = real.filter((r) => dateOf(r.startedAt, timeZone) === today);
  const handoffs = real.filter((r) => r.outcome === 'handed_off');
  const drafts = real.filter((r) => r.outcome === 'drafted');
  const shown = filter === 'handed_off' ? handoffs : filter === 'drafted' ? drafts : real;
  const c = data.counters;
  const conversations = new Set(todays.map((r) => r.conversationId ?? r.id)).size;

  function choosePeriod(next: ActivityPeriod) {
    if (next === period) return;
    startSwitch(() =>
      router.replace(next === 'today' ? pathname : `${pathname}?period=${next}`, {
        scroll: false,
      }),
    );
  }

  async function more() {
    if (!data.nextCursor) return;
    setLoading(true);
    try {
      const next = await teammateActions(workspaceId).activity({
        cursor: data.nextCursor,
        since: period,
      });
      setData({ ...data, runs: [...data.runs, ...next.runs], nextCursor: next.nextCursor });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  const when = (iso: string) =>
    dateOf(iso, timeZone) === today ? fmtTime(iso, timeZone) : fmtMonthDay(dateOf(iso, timeZone));
  const emptyTitle =
    filter === 'handed_off'
      ? `No hand-offs ${PERIOD_WORDS[period]}`
      : filter === 'drafted'
        ? `No drafts ${PERIOD_WORDS[period]}`
        : period === 'today'
          ? 'No runs yet today'
          : `No runs ${PERIOD_WORDS[period]}`;
  const emptyBody =
    filter !== 'all'
      ? 'Try Everything, or a longer period.'
      : period === '7d'
        ? 'Try 30 days.'
        : `When ${name} answers someone, each reply shows here with what it looked up and the checks it passed.`;

  return (
    <div data-testid="teammate-activity">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Tile
          label="Conversations handled"
          value={conversations}
          sub="Today"
          testId="activity-conversations"
        />
        <Tile
          label="Replies sent"
          value={c.repliedToday}
          sub={c.draftedToday ? `${c.draftedToday} more held as drafts` : 'Today'}
          testId="activity-replies"
        />
        <Tile label="Booked" value={c.bookedToday} sub="Today" testId="activity-booked" />
        <Tile
          label="Handed to a person"
          value={c.handedOffToday}
          sub={people(todays.filter((r) => r.outcome === 'handed_off')) || 'Today'}
          testId="activity-handoffs"
        />
        <Tile
          label="Drafts waiting"
          value={c.pendingDrafts}
          sub={c.pendingDrafts ? 'In the inbox and on Approvals' : 'Nothing waiting'}
          warn={c.pendingDrafts > 0}
          testId="activity-drafts"
        />
      </div>

      <div className="mb-3 mt-4 flex flex-wrap items-center gap-2.5">
        <Segmented
          value={period}
          ariaLabel="Period"
          onChange={choosePeriod}
          options={[
            { value: 'today', label: 'Today', testId: 'activity-period-today' },
            { value: '7d', label: '7 days', testId: 'activity-period-7d' },
            { value: '30d', label: '30 days', testId: 'activity-period-30d' },
          ]}
        />
        <span className="flex flex-wrap gap-1.5">
          {(
            [
              ['all', 'Everything', null],
              ['handed_off', 'Hand-offs', handoffs.length],
              ['drafted', 'Drafts', drafts.length],
            ] as const
          ).map(([key, label, n]) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
              data-testid={`activity-filter-${key}`}
              className={cn(
                'inline-flex h-7 items-center rounded-full border px-3 text-[13px] font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
                filter === key
                  ? 'border-transparent bg-accent-soft text-accent-text'
                  : 'border-border-strong bg-card text-text-2 hover:text-text',
              )}
            >
              {n === null ? label : `${label} · ${n}`}
            </button>
          ))}
        </span>
        <span
          className="inline-flex min-w-0 items-center gap-1.5 text-xs text-text-3 sm:ml-auto"
          data-testid="activity-ai-usage"
          title={`${usage.usedTokens.toLocaleString('en-US')} of ${usage.dailyTokens.toLocaleString('en-US')} tokens`}
        >
          <Gauge className="h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
          <span>
            AI used today: {percentOfLimit(usage.usedTokens, usage.dailyTokens)} of the daily limit
            · {name} {percentOfLimit(usage.teammateTokens, usage.dailyTokens)}
          </span>
        </span>
      </div>

      <Card
        className={cn('overflow-hidden transition-opacity', switching && 'opacity-60')}
        aria-busy={switching}
        data-testid="teammate-runs"
      >
        <div className="hidden grid-cols-[84px_minmax(0,1.05fr)_108px_minmax(0,1.6fr)_168px] items-center gap-3 bg-card-2 px-4 py-[9px] text-xs font-medium text-text-3 md:grid">
          <span>When</span>
          <span>Customer</span>
          <span>Channel</span>
          <span>What {name} did</span>
          <span>Result</span>
        </div>
        {shown.map((r) => {
          const who = whoOf(r);
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => setOpen(r)}
              data-testid={`run-${r.id}`}
              className="block w-full border-t border-border px-4 py-2.5 text-left text-[13px] first:border-t-0 hover:bg-card-2 focus-visible:bg-card-2 focus-visible:outline-none md:first:border-t"
            >
              <span className="hidden grid-cols-[84px_minmax(0,1.05fr)_108px_minmax(0,1.6fr)_168px] items-center gap-3 md:grid">
                <span className="text-text-3">{when(r.startedAt)}</span>
                <span className="flex min-w-0 items-center gap-2">
                  <Avatar name={who} seed={r.person?.id ?? r.id} size="sm" />
                  <span className="truncate font-semibold">{who}</span>
                </span>
                <Channel channel={r.channel} />
                <span className="truncate">{summaryOf(r)}</span>
                <Result run={r} />
              </span>
              <span className="flex flex-col gap-1 md:hidden">
                <span className="flex items-center gap-2">
                  <Avatar name={who} seed={r.person?.id ?? r.id} size="sm" />
                  <span className="min-w-0 flex-1 truncate font-semibold">{who}</span>
                  <Result run={r} />
                </span>
                <span className="line-clamp-2 text-text-2">{summaryOf(r)}</span>
                <span className="flex items-center gap-2 text-xs text-text-3">
                  {when(r.startedAt)}
                  <Channel channel={r.channel} />
                </span>
              </span>
            </button>
          );
        })}
        {!shown.length ? (
          <EmptyState title={emptyTitle} className="py-9">
            {emptyBody}
          </EmptyState>
        ) : null}
      </Card>
      {data.nextCursor ? (
        <div className="mt-3 flex justify-center">
          <Button variant="secondary" size="sm" loading={loading} onClick={() => void more()}>
            Load more
          </Button>
        </div>
      ) : null}
      <p className="mt-3 flex items-start gap-2 text-xs text-text-3">
        <Info className="mt-px h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
        Every run is kept with the tools, knowledge and checks it used. Test console chats aren’t
        counted.
      </p>

      <RunSheet
        run={open}
        onClose={() => setOpen(null)}
        workspaceId={workspaceId}
        name={name}
        timeZone={timeZone}
      />
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-border py-3">
      <h3 className="mb-1 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** Thumbs on the reply a run wrote, and what came of them. */
function RunFeedback({
  workspaceId,
  runId,
  reply,
}: {
  workspaceId: string;
  runId: string;
  reply: string;
}) {
  const actions = useMemo(() => feedbackActions(workspaceId), [workspaceId]);
  const feedback = useReplyFeedback(workspaceId, { runIds: [runId] });
  return (
    <ReplyFeedback
      className="mt-2"
      workspaceId={workspaceId}
      actions={actions}
      reply={reply}
      runId={runId}
      mine={myFeedback(feedback, { runId })}
      all={feedbackOn(feedback, { runId })}
      canSaveRules={feedback.canSaveRules}
      slow={feedback.slow}
      onChange={feedback.put}
    />
  );
}

/** One run: what started it, each tool call, the knowledge, the safety check, and how it came out. */
function RunSheet({
  run,
  onClose,
  workspaceId,
  name,
  timeZone,
}: {
  run: TeammateRun | null;
  onClose: () => void;
  workspaceId: string;
  name: string;
  timeZone: string;
}) {
  const knowledge = run ? knowledgeOf(run.knowledge) : [];
  const checks = run ? checksOf(run.checks) : [];
  const took =
    run?.endedAt != null
      ? `${((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000).toFixed(1)} s`
      : null;
  const tokens = run ? run.inputTokens + run.outputTokens : 0;
  return (
    <Sheet open={!!run} onOpenChange={(o) => !o && onClose()}>
      {run ? (
        <SheetContent
          title={`Run · ${whoOf(run)}`}
          description={[
            run.channel ? CHANNEL_NAMES[run.channel] : null,
            `started ${fmtTime(run.startedAt, timeZone)}`,
            took ? `took ${took}` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
          className="sm:w-[540px]"
        >
          <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="run-sheet">
            <Badge
              variant={
                runResult(run).tone === 'ok'
                  ? 'ok'
                  : runResult(run).tone === 'danger'
                    ? 'danger'
                    : runResult(run).tone === 'warn'
                      ? 'pending'
                      : 'gray'
              }
            >
              {runResult(run).label}
            </Badge>
          </div>
          <Section title="What started it">
            {run.firstMessage ? (
              <>
                <p
                  className="whitespace-pre-wrap rounded-control bg-card-2 px-2.5 py-[7px] text-[12.5px] leading-[1.45] [overflow-wrap:anywhere]"
                  data-testid="run-first-message"
                >
                  {run.firstMessage.excerpt}
                </p>
                <span className="mt-[5px] block text-xs text-text-3">
                  {wroteWords(
                    run.person?.fullName ?? null,
                    run.channel,
                    run.firstMessage.at,
                    timeZone,
                  )}
                  .
                  {run.messageCount > 1
                    ? ` ${name} answered ${run.messageCount} messages together.`
                    : ''}
                </span>
              </>
            ) : (
              <p className="text-[13px]">{triggerWords(run.triggeredBy)}</p>
            )}
          </Section>
          <Section title="Tools">
            {run.toolCalls.length ? (
              run.toolCalls.map((tc, i) => {
                const state = toolCallState(tc.status, run.outcome);
                return (
                  <LogRow
                    key={`${tc.tool}-${i}`}
                    first={i === 0}
                    line={{
                      id: `${tc.tool}-${i}`,
                      time: clockWithSeconds(tc.at, timeZone),
                      tone: state.tone,
                      icon: TOOL_ICONS[tc.tool] ?? Wrench,
                      title: toolName(tc.tool),
                      detail: [state.word, tc.summary].filter(Boolean).join(' · ') || null,
                    }}
                  />
                );
              })
            ) : (
              <p className="text-[13px] text-text-2">No look-ups needed.</p>
            )}
          </Section>
          <Section title="Knowledge used">
            {knowledge.length ? (
              <KnowledgeChips items={knowledge} />
            ) : (
              <p className="text-[13px] text-text-2">None needed.</p>
            )}
          </Section>
          <Section title="Safety check">
            {checks.length ? (
              <CheckChips checks={checks} />
            ) : (
              <p className="text-[13px] text-text-2">
                {run.replyText ? 'No checks recorded.' : 'No reply, so nothing to check.'}
              </p>
            )}
          </Section>
          <Section title="Result">
            {run.summary ? <p className="text-[13px]">{run.summary}</p> : null}
            {run.replyText ? (
              <p className="mt-[5px] whitespace-pre-wrap rounded-control bg-card-2 px-2.5 py-[7px] text-[12.5px] leading-[1.45] [overflow-wrap:anywhere]">
                {run.replyText}
              </p>
            ) : null}
            {run.replyText && !run.isTest ? (
              <RunFeedback workspaceId={workspaceId} runId={run.id} reply={run.replyText} />
            ) : null}
            {run.error ? <p className="mt-1.5 text-[13px] text-danger-text">{run.error}</p> : null}
            {!run.summary && !run.replyText && !run.error ? (
              <p className="text-[13px] text-text-2">{runResult(run).label}.</p>
            ) : null}
          </Section>
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <span className="flex-1 text-xs text-text-3">
              {[
                run.model,
                tokens ? `${tokens.toLocaleString('en-US')} tokens` : null,
                plural(run.toolSteps, 'look-up', 'look-ups'),
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
            {run.conversationId ? (
              <ButtonLink
                size="sm"
                href={`/app/w/${workspaceId}/inbox/${run.conversationId}`}
                data-testid="run-open-conversation"
              >
                Open the conversation
              </ButtonLink>
            ) : null}
          </div>
          <p className="sr-only">{name}’s run.</p>
        </SheetContent>
      ) : null}
    </Sheet>
  );
}
