'use client';
/**
 * Social Outreach → Settings' **Comment research** (docs/outreach.md, decisions 166 and 172), for HandsFreeOS staff
 * only (`platform.ai.manage`): no business sees it. One Start begins a research on every network (the browser of
 * whoever starts it reads about 2,000 real comments a network over 3 days); each network's row shows it reading, Stop
 * has what it has summed up, and its findings and guide are read there, then put in every business's comments on that
 * network or taken out again. The words and the counts' lines are core's.
 */
import {
  brochureLines,
  COMMENT_RESEARCH_WORDS as W,
  researchNetworkName,
  researchProgress,
  researchTopicName,
  statLines,
  type CommentResearchNetwork,
  type CommentResearchOutput,
  type ResearchPlatform,
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

const running = (n: CommentResearchNetwork) =>
  n.research?.state === 'reading' || n.research?.state === 'summing';

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
  const networks = got?.networks ?? [];
  // While one reads or is summed up, the card keeps up on its own.
  const summing = networks.some((n) => n.research?.state === 'summing');
  const reading = networks.some((n) => n.research?.state === 'reading');
  useEffect(() => {
    if (!summing && !reading) return;
    const timer = setInterval(() => void load(), summing ? 15_000 : 60_000);
    return () => clearInterval(timer);
  }, [summing, reading, load]);
  const { busy, act } = useAct();
  if (!got) return null;

  const start = (platform?: ResearchPlatform) =>
    act(platform ? `start-${platform}` : 'start', async () =>
      setGot(
        unwrap(
          await apiBrowser().POST('/v1/commands/outreach.comment_research.start', {
            body: { workspaceId, ...(platform ? { platform } : {}) },
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

  const idle = networks.filter((n) => !running(n));
  const never = networks.every((n) => !n.research);

  return (
    <Part
      card
      title={W.title}
      badge={W.staffBadge}
      about={W.about}
      testId="outreach-comment-research"
    >
      <p className="text-[12.5px] text-text-3">{W.staffOnly}</p>
      {idle.length ? (
        <div>
          <Button
            size="sm"
            variant={never ? 'primary' : 'secondary'}
            disabled={busy !== null}
            onClick={() => void start()}
            data-testid="outreach-comment-research-start"
          >
            {never || idle.length === networks.length ? W.start : W.startRest}
          </Button>
        </div>
      ) : null}
      <div className="divide-y divide-border rounded-[10px] border border-border">
        {networks.map((n) => (
          <NetworkRow
            key={n.platform}
            network={n}
            busy={busy !== null}
            onStart={() => void start(n.platform)}
            onStop={(id) => void stop(id)}
            onUse={(id, on) => void use(id, on)}
          />
        ))}
      </div>
    </Part>
  );
}

/** One network's research: where it stands, what it found, its guide, and its own buttons. */
function NetworkRow({
  network,
  busy,
  onStart,
  onStop,
  onUse,
}: {
  network: CommentResearchNetwork;
  busy: boolean;
  onStart: () => void;
  onStop: (id: string) => void;
  onUse: (id: string, on: boolean) => void;
}) {
  const name = researchNetworkName(network.platform);
  const run = network.research;
  const inUse = network.inUse;
  const findings = run?.findings ?? null;
  const testId = `outreach-comment-research-${network.platform}`;
  return (
    <div className="space-y-2 px-3.5 py-3" data-testid={testId}>
      <h4 className="text-[14px] font-semibold">{name}</h4>
      {inUse ? (
        <p
          className="rounded-menu bg-accent-soft px-3.5 py-2.5 text-[13px] text-accent-text"
          data-testid={`${testId}-in-use`}
        >
          {inUse.thisOne ? W.inUse(name) : W.inUseOther(name)}{' '}
          {W.inUseFrom(inUse.comments, relativeTime(inUse.usedAt))}
        </p>
      ) : null}
      {!run ? <p className="text-[13px] text-text-2">{W.notStarted}</p> : null}
      {run?.state === 'stopped' ? <p className="text-[13px] text-text-2">{W.stopped}</p> : null}
      {run?.state === 'reading' ? (
        <div className="space-y-1" data-testid={`${testId}-reading`}>
          <p className="text-[13.5px] font-medium">{researchProgress(run, new Date())}</p>
          <p className="text-[12.5px] text-text-3">
            {run.mine ? W.needsExtension(network.platform) : W.notMine}
          </p>
        </div>
      ) : null}
      {run?.state === 'summing' ? (
        <p className="text-[13.5px]" data-testid={`${testId}-summing`}>
          {W.summing}
        </p>
      ) : null}
      {run?.state === 'done' && findings ? (
        <details className="group" data-testid={`${testId}-findings`}>
          <summary className="cursor-pointer text-[13.5px] font-semibold">
            {W.findingsTitle(findings.comments, findings.copied)}
          </summary>
          <div className="mt-2 space-y-3">
            <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-text-2">
              {[...statLines(findings), ...findings.patterns, ...brochureLines(findings)].map(
                (line) => (
                  <li key={line}>{line}</li>
                ),
              )}
            </ul>
            {findings.kinds.length ? (
              <div>
                <h5 className="text-[13.5px] font-semibold">{W.kindsTitle}</h5>
                <ul className="mt-1 space-y-1 text-[13px] text-text-2">
                  {findings.kinds.map((kind) => (
                    <li key={kind.topic}>
                      <span className="font-medium text-text">
                        {researchTopicName(kind.topic)}:
                      </span>{' '}
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
                <h5 className="text-[13.5px] font-semibold">{W.guideTitle}</h5>
                <pre
                  className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-[10px] border border-border bg-card-2 px-3.5 py-2.5 text-[12.5px] text-text-2"
                  data-testid={`${testId}-guide`}
                >
                  {run.guide}
                </pre>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {run?.state === 'reading' ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => onStop(run.id)}
            data-testid={`${testId}-stop`}
          >
            {W.stop}
          </Button>
        ) : null}
        {run?.state === 'done' && run.guide && !inUse?.thisOne ? (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => onUse(run.id, true)}
            data-testid={`${testId}-use`}
          >
            {W.use}
          </Button>
        ) : null}
        {run && inUse ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => onUse(run.id, false)}
            data-testid={`${testId}-unuse`}
          >
            {W.unuse}
          </Button>
        ) : null}
        {run?.state === 'done' || run?.state === 'stopped' ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={onStart}
            data-testid={`${testId}-start`}
          >
            {W.startAgain}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
