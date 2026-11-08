'use client';
/**
 * The Playbook (docs/socialcontent.md, part 3): what works for the creators studied, written by the AI from its
 * notes on their standouts, in sections of things to do, each with why it works and the standouts it came from. It's
 * written on its own once a few standouts are noted, and again as more are; **Write it again** writes it now.
 */
import { SOCIALCONTENT_WORDS as W, daysAgo } from '@hfos/core/addons/socialcontent/words';
import { RefreshCw } from 'lucide-react';
import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { workerPost } from '@/lib/api/worker';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { StandoutLinks } from './standout-links';
import type { Playbook, StandoutRef } from './types';
import { useAct } from './use-act';

export function PlaybookPage({
  workspaceId,
  playbook,
  examples,
}: {
  workspaceId: string;
  playbook: Playbook;
  examples: readonly StandoutRef[];
}) {
  useLiveRefresh(['socialcontent_playbook', 'socialcontent_post']);
  const { busy, act } = useAct();
  const byId = new Map(examples.map((e) => [e.id, e]));
  const write = () =>
    act(
      'write',
      () =>
        workerPost<{ sections: number }>(
          '/v1/addons/socialcontent/actions/socialcontent.playbook.write',
          { workspaceId, input: {} },
        ),
      W.playbook.done,
    );
  const since = playbook.noted - playbook.standouts;

  return (
    <div data-testid="socialcontent-playbook" className="space-y-5">
      <PageHeader
        title={W.playbook.title}
        description={W.playbook.intro}
        actions={
          playbook.noted > 0 ? (
            <Button
              variant="secondary"
              loading={busy === 'write'}
              onClick={() => void write()}
              data-testid="socialcontent-playbook-write"
            >
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
              {busy === 'write' ? W.playbook.writing : W.playbook.write}
            </Button>
          ) : null
        }
      />
      {playbook.writtenAt === null || !playbook.sections.length ? (
        <Card>
          <EmptyState title={W.playbook.title} className="py-10">
            {W.playbook.none}
          </EmptyState>
        </Card>
      ) : (
        <>
          <Card className="p-4 md:p-5">
            {playbook.summary ? (
              <p className="text-[14.5px] leading-[1.55] text-text">{playbook.summary}</p>
            ) : null}
            <p className="mt-2 text-[12.5px] text-text-3" data-testid="socialcontent-playbook-when">
              {W.playbook.written(daysAgo(playbook.writtenAt) ?? '', playbook.standouts)}
              {since > 0 ? ` ${W.playbook.newSince(since)}` : ''}
            </p>
          </Card>
          {playbook.sections.map((s) => (
            <Card key={s.title} className="p-4 md:p-5">
              <h2 className="text-[15px] font-semibold">{s.title}</h2>
              <ol className="mt-2 space-y-3">
                {s.items.map((i, n) => (
                  <li key={`${n}:${i.do}`} className="flex gap-3">
                    <span className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full bg-accent-soft text-[11.5px] font-semibold text-accent-text">
                      {n + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-medium text-text">{i.do}</div>
                      {i.why ? <div className="mt-0.5 text-[13px] text-text-2">{i.why}</div> : null}
                      <StandoutLinks label={W.playbook.examples} ids={i.examples} examples={byId} />
                    </div>
                  </li>
                ))}
              </ol>
            </Card>
          ))}
        </>
      )}
    </div>
  );
}
