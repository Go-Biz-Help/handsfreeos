/**
 * Coached calls (`?view=calls`): the list, newest first, with the rep for people who review, and one call's write-up
 * (`&call=`): the score and what it's made of, the summary and notes, what the rep promised, the follow-up to copy,
 * the objections, tips for next time and what was said.
 */
import { SALESCOACH_WORDS as W } from '@hfos/core/addons/salescoach/words';
import { ChevronLeft } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { CopyField } from '@/components/ui/copy-field';
import { EmptyState } from '@/components/ui/empty-state';
import { cn, relativeTime } from '@/lib/utils';
import { salescoachHref } from './home';
import type { CoachedCall, CoachedCallSummary } from './types';

function StateBadge({ c }: { c: Pick<CoachedCallSummary, 'state' | 'score'> }) {
  if (c.state === 'done' && c.score !== null)
    return (
      <Badge variant={c.score >= 70 ? 'ok' : c.score >= 45 ? 'pending' : 'danger'}>
        {W.calls.score} {c.score}
      </Badge>
    );
  if (c.state === 'live') return <Badge variant="accent">{W.calls.live}</Badge>;
  if (c.state === 'writing') return <Badge>{W.calls.writing}</Badge>;
  if (c.state === 'stopped') return <Badge>{W.calls.stopped}</Badge>;
  return <Badge>{W.calls.failed}</Badge>;
}

export function CallsList({
  workspaceId,
  calls,
  reviews,
}: {
  workspaceId: string;
  calls: readonly CoachedCallSummary[];
  reviews: boolean;
}) {
  if (calls.length === 0)
    return (
      <EmptyState title={W.tabs.calls} dashed>
        {W.calls.none}
      </EmptyState>
    );
  return (
    <Card className="divide-y divide-border" data-testid="coached-calls">
      {calls.map((c) => (
        <Link
          key={c.id}
          href={salescoachHref(workspaceId, 'calls', c.id)}
          className="flex items-center gap-3 px-4 py-3 hover:bg-card-2"
        >
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-medium">
              {c.person?.name ?? W.calls.noCustomer}
            </div>
            <div className="truncate text-[12.5px] text-text-3">
              {[
                W.calls.channels[c.channel ?? 'call'],
                reviews ? c.rep?.name : null,
                c.playbookName,
                relativeTime(c.startedAt),
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </div>
          <StateBadge c={c} />
        </Link>
      ))}
    </Card>
  );
}

function Section({
  title,
  about,
  children,
}: {
  title: string;
  about?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-[14px] font-semibold">{title}</h2>
      {about ? <p className="-mt-1 text-[12.5px] text-text-3">{about}</p> : null}
      {children}
    </section>
  );
}

export function CallDetail({ workspaceId, call }: { workspaceId: string; call: CoachedCall }) {
  const r = call.result;
  return (
    <div className="space-y-4" data-testid="coached-call">
      <Link
        href={salescoachHref(workspaceId, 'calls')}
        className="inline-flex items-center gap-1 text-[13px] text-text-2 hover:text-text"
      >
        <ChevronLeft className="h-4 w-4" strokeWidth={1.75} aria-hidden />
        {W.tabs.calls}
      </Link>
      <Card className="flex flex-wrap items-center gap-3 p-4 md:p-5">
        <div className="min-w-0 flex-1">
          <div className="text-[16px] font-semibold">
            {call.person ? (
              <Link
                href={`/app/w/${workspaceId}/customers/people/${call.person.id}`}
                className="hover:underline"
              >
                {call.person.name}
              </Link>
            ) : (
              W.calls.noCustomer
            )}
          </div>
          <div className="text-[13px] text-text-3">
            {[
              W.calls.channels[call.channel ?? 'call'],
              call.rep?.name,
              call.playbookName,
              relativeTime(call.startedAt),
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
        {r ? (
          <div className="text-right" data-testid="coached-call-score">
            <div className="text-[28px] font-semibold tabular-nums leading-none">
              {r.score.total}
            </div>
            <div className="text-[12px] text-text-3">{W.calls.score}</div>
          </div>
        ) : (
          <StateBadge c={{ state: call.state, score: null }} />
        )}
      </Card>
      {call.failure ? <p className="text-[13.5px] text-text-2">{call.failure}</p> : null}
      {r ? (
        <Card className="space-y-5 p-4 md:p-5">
          <ul className="flex flex-wrap gap-2 text-[12.5px]">
            {r.score.steps ? (
              <Badge>{W.calls.steps(r.score.steps.covered, r.score.steps.of)}</Badge>
            ) : null}
            <Badge>
              {W.calls.objectionCount(r.score.objections.answered, r.score.objections.of)}
            </Badge>
            <Badge>{W.calls.talk(r.score.talkShare)}</Badge>
          </ul>
          <Section title={W.calls.summary}>
            <p className="text-[14px] leading-relaxed">{r.summary}</p>
          </Section>
          {r.notes.length ? (
            <Section title={W.calls.notes}>
              <ul className="list-disc space-y-1 pl-5 text-[14px]">
                {r.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </Section>
          ) : null}
          {r.promises.length ? (
            <Section title={W.calls.promises} about={W.calls.promisesAbout}>
              <ul className="space-y-1 text-[14px]">
                {r.promises.map((p) => (
                  <li key={p.what}>
                    {p.what}
                    {p.due ? <span className="text-text-3"> · {p.due}</span> : null}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
          {r.followUp ? (
            <Section title={W.calls.followUp} about={W.calls.followUpAbout}>
              <p className="whitespace-pre-wrap rounded-control bg-card-2 p-3 text-[14px]">
                {r.followUp}
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <CopyField value={r.followUp} label={W.calls.followUp} copied="Copied." />
                {call.conversationId ? (
                  <Link
                    href={`/app/w/${workspaceId}/inbox/${call.conversationId}`}
                    className="text-[13px] font-medium text-accent-text hover:underline"
                  >
                    {W.calls.openConversation}
                  </Link>
                ) : null}
              </div>
            </Section>
          ) : null}
          {r.objections.length ? (
            <Section title={W.calls.objections}>
              <ul className="space-y-1.5 text-[14px]">
                {r.objections.map((o) => (
                  <li key={o.said} className="flex items-start gap-2">
                    <Badge variant={o.answered ? 'ok' : 'danger'}>
                      {o.answered ? W.calls.answered : W.calls.notAnswered}
                    </Badge>
                    <span>{o.said}</span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
          {r.tips.length ? (
            <Section title={W.calls.tips}>
              <ul className="list-disc space-y-1 pl-5 text-[14px]">
                {r.tips.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </Section>
          ) : null}
        </Card>
      ) : null}
      {call.lines.length ? (
        <Card className="p-4 md:p-5">
          <Section title={W.calls.said}>
            <ol className="space-y-1.5 text-[13.5px]">
              {call.lines.map((l, i) => (
                <li key={i} className="flex gap-2">
                  <span
                    className={cn(
                      'w-[72px] flex-none text-[12px] font-medium',
                      l.speaker === 'team' ? 'text-accent-text' : 'text-text-2',
                    )}
                  >
                    {l.speaker === 'team' ? W.calls.you : W.calls.customer}
                  </span>
                  <span>{l.text}</span>
                </li>
              ))}
            </ol>
          </Section>
        </Card>
      ) : null}
    </div>
  );
}
