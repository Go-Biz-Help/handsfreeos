'use client';
/**
 * Social Outreach → Settings' **Comment research** (docs/outreach.md, decision 166), for HandsFreeOS staff only
 * (`platform.ai.manage`): no business sees it. Start a research (the browser of whoever starts it reads about 2,000
 * real comments over 3 days), watch it read, stop it and have what it has summed up, read what it found, and put its
 * guide in every business's Instagram comments or take it out again. The words and the counts' lines are core's.
 */
import {
  brochureLines,
  COMMENT_RESEARCH_WORDS as W,
  researchProgress,
  researchTopicName,
  statLines,
  type CommentResearchOutput,
} from '@hfos/core/addons/outreach/comment-research';
import { useCallback, useEffect, useState } from 'react';
import { useStaffCan } from '@/components/shell/workspace-shell';
import { Button } from '@/components/ui/button';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { relativeTime } from '@/lib/utils';
import { Part } from './settings-view';
import { useAct } from './use-act';

/** The card, for HandsFreeOS staff who may change what the AI is told; nothing for anyone else. */
export function CommentResearchPart({ workspaceId }: { workspaceId: string }) {
  return useStaffCan('platform.ai.manage') ? <ResearchCard workspaceId={workspaceId} /> : null;
}

function ResearchCard({ workspaceId }: { workspaceId: string }) {
  const [got, setGot] = useState<CommentResearchOutput | null>(null);
  const load = useCallback(async () => {
    try {
      setGot(
        unwrap(
          await apiBrowser().POST('/v1/queries/outreach.comment_research.get', {
            body: { workspaceId },
          }),
        ),
      );
    } catch {
      setGot(null);
    }
  }, [workspaceId]);
  useEffect(() => {
    void load();
  }, [load]);
  // While it reads or is summed up, the card keeps up on its own.
  const state = got?.research?.state ?? null;
  useEffect(() => {
    if (state !== 'reading' && state !== 'summing') return;
    const timer = setInterval(() => void load(), state === 'summing' ? 15_000 : 60_000);
    return () => clearInterval(timer);
  }, [state, load]);
  const { busy, act } = useAct();
  if (!got) return null;
  const run = got.research;
  const findings = run?.findings ?? null;

  const start = () =>
    act('start', async () =>
      setGot(
        unwrap(
          await apiBrowser().POST('/v1/commands/outreach.comment_research.start', {
            body: { workspaceId },
          }),
        ),
      ),
    );
  const stop = (id: string) =>
    act('stop', async () =>
      setGot(
        unwrap(
          await apiBrowser().POST('/v1/commands/outreach.comment_research.stop', {
            body: { workspaceId, id },
          }),
        ),
      ),
    );
  const use = (id: string, on: boolean) =>
    act('use', async () =>
      setGot(
        unwrap(
          await apiBrowser().POST('/v1/commands/outreach.comment_research.use', {
            body: { workspaceId, id, use: on },
          }),
        ),
      ),
    );

  return (
    <Part
      card
      title={W.title}
      badge={W.staffBadge}
      about={W.about}
      testId="outreach-comment-research"
    >
      <p className="text-[12.5px] text-text-3">{W.staffOnly}</p>
      {got.inUse ? (
        <p
          className="rounded-menu bg-accent-soft px-3.5 py-2.5 text-[13px] text-accent-text"
          data-testid="outreach-comment-research-in-use"
        >
          {got.inUse.thisOne ? W.inUse : W.inUseOther}{' '}
          {W.inUseFrom(got.inUse.comments, relativeTime(got.inUse.usedAt))}
        </p>
      ) : null}
      {!run || run.state === 'stopped' ? (
        <>
          {run ? <p className="text-[13px] text-text-2">{W.stopped}</p> : null}
          <p className="text-[12.5px] text-text-3">{W.needsExtension}</p>
        </>
      ) : null}
      {run?.state === 'reading' ? (
        <div className="space-y-1.5" data-testid="outreach-comment-research-reading">
          <p className="text-[13.5px] font-medium">{researchProgress(run, new Date())}</p>
          <p className="text-[12.5px] text-text-3">{run.mine ? W.needsExtension : W.notMine}</p>
        </div>
      ) : null}
      {run?.state === 'summing' ? (
        <p className="text-[13.5px]" data-testid="outreach-comment-research-summing">
          {W.summing}
        </p>
      ) : null}
      {run?.state === 'done' && findings ? (
        <div className="space-y-3" data-testid="outreach-comment-research-findings">
          <div>
            <h4 className="text-[13.5px] font-semibold">
              {W.findingsTitle(findings.comments, findings.copied)}
            </h4>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[13px] text-text-2">
              {[...statLines(findings), ...findings.patterns, ...brochureLines(findings)].map(
                (line) => (
                  <li key={line}>{line}</li>
                ),
              )}
            </ul>
          </div>
          {findings.kinds.length ? (
            <div>
              <h4 className="text-[13.5px] font-semibold">{W.kindsTitle}</h4>
              <ul className="mt-1 space-y-1 text-[13px] text-text-2">
                {findings.kinds.map((kind) => (
                  <li key={kind.topic}>
                    <span className="font-medium text-text">{researchTopicName(kind.topic)}:</span>{' '}
                    {kind.how}
                    {kind.examples.length ? (
                      <span className="text-text-3">
                        {' '}
                        {kind.examples.map((e) => `“${e}”`).join(', ')}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {run.guide ? (
            <div>
              <h4 className="text-[13.5px] font-semibold">{W.guideTitle}</h4>
              <pre
                className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-[10px] border border-border bg-card-2 px-3.5 py-2.5 text-[12.5px] text-text-2"
                data-testid="outreach-comment-research-guide"
              >
                {run.guide}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {run?.state === 'reading' ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy !== null}
            onClick={() => void stop(run.id)}
            data-testid="outreach-comment-research-stop"
          >
            {W.stop}
          </Button>
        ) : null}
        {run?.state === 'done' && run.guide && !got.inUse?.thisOne ? (
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() => void use(run.id, true)}
            data-testid="outreach-comment-research-use"
          >
            {W.use}
          </Button>
        ) : null}
        {run && got.inUse ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy !== null}
            onClick={() => void use(run.id, false)}
            data-testid="outreach-comment-research-unuse"
          >
            {W.unuse}
          </Button>
        ) : null}
        {!run || run.state === 'done' || run.state === 'stopped' ? (
          <Button
            size="sm"
            variant={run ? 'secondary' : 'primary'}
            disabled={busy !== null}
            onClick={() => void start()}
            data-testid="outreach-comment-research-start"
          >
            {run ? W.startAgain : W.start}
          </Button>
        ) : null}
      </div>
    </Part>
  );
}
