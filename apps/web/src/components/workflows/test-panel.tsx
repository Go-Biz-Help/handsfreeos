'use client';
import {
  allSteps,
  findStep,
  type Step,
  type WorkflowDefinition,
  type WorkflowNames,
} from '@hfos/core';
import { AlertCircle, AlertTriangle, CheckCircle2, CircleStop, Loader2, Play } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CustomerPicker } from '@/components/calendar/customer-picker';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import {
  clockSeconds,
  failedStep,
  isLive,
  knowledgeUsed,
  messageOf,
  stepKeyParts,
  stepNote,
} from '@/lib/workflows/run-words';
import { aiKeyOf, stepLines } from '@/lib/workflows/steps';
import type { WorkflowTest } from '@/lib/workflows/use-test';
import { cn } from '@/lib/utils';
import { useEditor } from './editor-context';

interface Assumption {
  readonly key: string;
  readonly label: string;
  readonly kind: 'wait' | 'pick';
  /** For picks: '' lets the run decide. */
  readonly options: readonly { value: string; label: string }[];
}

const WAIT_EVENT: Record<string, string> = {
  'message.received': 'a reply',
  'appointment.booked': 'a booking',
};

function waitWords(step: Step): string {
  if (step.type !== 'wait' || step.until.kind !== 'event') return 'it';
  return [...new Set(step.until.events.map((e) => WAIT_EVENT[e] ?? 'the event'))].join(' or ');
}

/** What a test can take as given, built from the steps: waits for a reply, each branch, each AI sort. */
function assumptionsOf(def: WorkflowDefinition, names: WorkflowNames): Assumption[] {
  const out: Assumption[] = [];
  const locs = allSteps(def);
  const waits = locs.filter((l) => l.step.type === 'wait' && l.step.until.kind === 'event');
  if (waits.length) {
    const what = waitWords(waits[0]!.step);
    out.push({
      key: 'wait.timed_out',
      label: waits.length > 1 ? 'When it waits for the customer' : `When it waits for ${what}`,
      kind: 'wait',
      options: [
        { value: 'timeout', label: 'It times out' },
        { value: 'came', label: `${what[0]!.toUpperCase()}${what.slice(1)} comes` },
      ],
    });
  }
  for (const { step } of locs) {
    if (step.type === 'branch')
      out.push({
        key: `branch.${step.id}`,
        label: `Path at “${stepLines(step, names, def).title}”`,
        kind: 'pick',
        options: [
          {
            value: '',
            label: step.mode === 'ai' ? 'Let the AI pick' : 'Let the conditions decide',
          },
          ...step.branches.map((b) => ({ value: b.id, label: b.name })),
        ],
      });
    if (step.type === 'ai' && step.task === 'classify')
      out.push({
        key: `ai.${aiKeyOf(step)}`,
        label: 'The AI sorts it as',
        kind: 'pick',
        options: [
          { value: '', label: 'Let the AI decide' },
          ...step.categories.map((c) => ({ value: c, label: c })),
        ],
      });
  }
  return out;
}

/**
 * The Test tab: Simulate or Send to me, the test contact (shared with the message previews), what to take as
 * given, Run test, then the live step log and how it came out. The same log marks the step list.
 */
export function TestPanel({
  test,
  def,
  names,
  timeZone,
  revision,
  unsaved,
  errors,
  canManage,
  simulateOnly = false,
}: {
  test: WorkflowTest;
  def: WorkflowDefinition;
  names: WorkflowNames;
  timeZone: string;
  /** The draft's saved revision. */
  revision: number;
  unsaved: boolean;
  /** Checks that block testing and publishing. */
  errors: number;
  canManage: boolean;
  /** Agency templates: Simulate only, walked in the browser (lib/agency/simulate.ts); no run to open. */
  simulateOnly?: boolean;
}) {
  const { sample, setSample, workspaceId } = useEditor();
  const [picking, setPicking] = useState(false);
  const assumptions = assumptionsOf(def, names);
  const running = !!test.result && isLive(test.result.run.status);
  const waiting = test.startingSince !== null;

  async function pick(id: string) {
    try {
      const p = unwrap(
        await apiBrowser().POST('/v1/queries/person.get', { body: { workspaceId, personId: id } }),
      ).person;
      setSample({
        id: p.id,
        firstName: p.firstName,
        lastName: p.lastName,
        fullName: p.fullName,
        email: p.email,
        phone: p.phone,
        city: p.address?.city ?? null,
      });
      setPicking(false);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <div data-testid="workflow-test">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[15px] font-semibold">Test this draft</h3>
        <span className="text-xs text-text-3">Revision {revision}</span>
      </div>
      <p className="mb-3 text-xs text-text-3">
        Tests never reach your customers or count in the stats.
      </p>
      {simulateOnly ? null : (
        <Segmented
          ariaLabel="Test mode"
          fill
          value={test.mode}
          onChange={test.setMode}
          options={[
            { value: 'simulate', label: 'Simulate', testId: 'test-mode-simulate' },
            { value: 'send_to_me', label: 'Send to me', testId: 'test-mode-send' },
          ]}
        />
      )}
      <p
        className={cn('text-xs text-text-2', !simulateOnly && 'mt-2')}
        data-testid="test-mode-note"
      >
        {simulateOnly
          ? 'Simulate walks the steps here with sample details: nothing is sent, waits are skipped, and paths and AI steps follow what you take as given.'
          : test.mode === 'simulate'
            ? 'Sends nothing and skips the waits. AI steps run for real.'
            : 'Sends only to you, with 5-second waits. Texts come to your email, because your profile has no mobile number.'}
      </p>

      <div className="mt-3.5">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-[13px] font-medium">Test contact</span>
          {canManage && !simulateOnly ? (
            <button
              type="button"
              onClick={() => setPicking((v) => !v)}
              className="text-xs font-medium text-accent-text hover:underline"
              data-testid="test-contact-change"
            >
              {picking ? 'Done' : 'Change'}
            </button>
          ) : null}
        </div>
        {picking ? (
          <CustomerPicker
            workspaceId={workspaceId}
            value={null}
            onChange={(c) => {
              if (c) void pick(c.id);
            }}
          />
        ) : (
          <div
            className="flex items-center gap-2 rounded-control border border-border bg-card-2 px-2.5 py-1.5"
            data-testid="test-contact"
          >
            {sample ? <Avatar name={sample.fullName} seed={sample.id} size="sm" /> : null}
            <span className="min-w-0 flex-1 truncate text-[13px]">
              {sample ? sample.fullName : 'Sample details (no customers yet)'}
            </span>
          </div>
        )}
        <p className="mt-1 text-xs text-text-3">
          {test.mode === 'simulate'
            ? 'Their details fill in the messages. They aren’t contacted.'
            : 'Their details fill in the messages, but everything goes to you.'}
        </p>
      </div>

      {assumptions.length ? (
        <div className="mt-3.5" data-testid="test-assume">
          <div className="mb-1.5 text-[13px] font-medium">Take as given</div>
          <div className="flex flex-col gap-2.5">
            {assumptions.map((a) =>
              a.kind === 'wait' ? (
                <div key={a.key}>
                  <div className="mb-1 text-xs text-text-2">{a.label}</div>
                  <Segmented
                    ariaLabel={a.label}
                    fill
                    value={test.assume[a.key] === false ? 'came' : 'timeout'}
                    onChange={(v) => test.setAssume(a.key, v === 'came' ? false : undefined)}
                    options={a.options.map((o) => ({
                      value: o.value,
                      label: o.label,
                      testId: `assume-wait-${o.value}`,
                    }))}
                  />
                </div>
              ) : (
                <label key={a.key} className="flex flex-col gap-1">
                  <span className="text-xs text-text-2">{a.label}</span>
                  <Select
                    selectSize="sm"
                    aria-label={a.label}
                    value={typeof test.assume[a.key] === 'string' ? String(test.assume[a.key]) : ''}
                    onChange={(e) => test.setAssume(a.key, e.target.value || undefined)}
                    data-testid={`assume-${a.key}`}
                  >
                    {a.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                </label>
              ),
            )}
          </div>
        </div>
      ) : null}

      <Button
        className="mt-3.5 w-full"
        onClick={() => void test.start(sample?.id ?? null)}
        disabled={!canManage || errors > 0 || running || waiting}
        loading={test.busy && !waiting}
        data-testid="test-run"
      >
        <Play className="h-4 w-4" strokeWidth={1.75} />
        {running ? 'Test running…' : 'Run test'}
      </Button>
      {errors > 0 ? (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-danger-text">
          <AlertCircle className="mt-px h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
          Fix the red {errors === 1 ? 'item' : 'items'} in Checks, then run the test.
        </p>
      ) : null}

      <TestLog
        test={test}
        def={def}
        names={names}
        timeZone={timeZone}
        revision={revision}
        unsaved={unsaved}
        canManage={canManage}
        workspaceId={workspaceId}
        simulateOnly={simulateOnly}
      />
    </div>
  );
}

function StartingNote({ since }: { since: number }) {
  const [now, setNow] = useState(since);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div
      className="mt-4 flex items-center gap-2 rounded-menu bg-card-2 px-3 py-2.5 text-[13px] text-text-2"
      data-testid="test-starting"
    >
      <Loader2 className="h-4 w-4 flex-none animate-spin" strokeWidth={1.75} />
      {now - since > 15_000
        ? 'Still starting. The worker picks it up in a moment.'
        : 'Starting the test…'}
    </div>
  );
}

/** The live step log and how the test came out. */
function TestLog({
  test,
  def,
  names,
  timeZone,
  revision,
  unsaved,
  canManage,
  workspaceId,
  simulateOnly,
}: {
  test: WorkflowTest;
  def: WorkflowDefinition;
  names: WorkflowNames;
  timeZone: string;
  revision: number;
  unsaved: boolean;
  canManage: boolean;
  workspaceId: string;
  simulateOnly: boolean;
}) {
  if (test.startingSince !== null) return <StartingNote since={test.startingSince} />;
  const r = test.result;
  if (!r) return null;
  const run = r.run;
  const running = isLive(run.status);
  const current = run.testRevision === revision && !unsaved;
  const outcome = test.outcome;
  const failed = failedStep(def, r.steps);

  return (
    <div className="mt-4 border-t border-border pt-3.5" data-testid="test-log">
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-[13px] font-semibold">
          {run.testMode === 'send_to_me' ? 'Send to me' : 'Simulate'} · revision {run.testRevision}
        </span>
        {running ? (
          <span
            className="inline-flex items-center gap-1.5 text-xs font-medium text-accent-text"
            data-testid="test-live"
          >
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            Live · {r.steps.length} {r.steps.length === 1 ? 'step' : 'steps'} so far
          </span>
        ) : (
          <span className="text-xs text-text-3">
            {clockSeconds(run.startedAt, timeZone)} · not counted in stats
          </span>
        )}
      </div>

      <ol className="flex flex-col gap-2.5" data-testid="test-log-steps">
        {r.steps.map((row) => {
          const { stepId } = stepKeyParts(row.stepKey);
          const step = findStep(def, stepId)?.step;
          const message = messageOf(row);
          const knowledge = knowledgeUsed(row.output);
          const bad = row.status === 'failed' || row.status === 'dead';
          return (
            <li
              key={row.id}
              className="flex gap-2.5 text-[12.5px]"
              data-testid={`test-row-${stepId}`}
            >
              <span className="w-[62px] flex-none pt-px font-mono text-[11px] tabular-nums text-text-3">
                {clockSeconds(row.startedAt, timeZone).replace(/\s?[AP]M$/, '')}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">
                  {step ? stepLines(step, names, def).title : 'A step no longer in the draft'}
                </span>
                <span
                  className={cn('block', bad ? 'text-danger-text' : 'text-text-2')}
                  data-testid="test-row-note"
                >
                  {stepNote(step, row, { timeZone, names, def })}
                </span>
                {message && (row.output?.['simulated'] || row.output?.['sentToTester']) ? (
                  <span className="mt-1 block whitespace-pre-wrap break-words rounded-[8px] border border-border bg-card-2 px-2.5 py-1.5 text-text">
                    {message}
                  </span>
                ) : null}
                {knowledge.length ? (
                  <span className="mt-1 block text-xs text-text-3">
                    Knowledge used: {knowledge.join(', ')}
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
        {running && !r.steps.length ? (
          <li className="text-[12.5px] text-text-3">Starting at the first step…</li>
        ) : null}
      </ol>

      {running && canManage ? (
        <Button
          variant="secondary"
          size="sm"
          className="mt-3"
          onClick={() => void test.stop()}
          data-testid="test-stop"
        >
          <CircleStop className="h-4 w-4" strokeWidth={1.5} />
          Stop the test
        </Button>
      ) : null}

      {outcome === 'passed' ? (
        <Result tone="ok" outcome="passed">
          {simulateOnly
            ? current
              ? 'It runs through to the end. Each business still tests its own copy.'
              : 'The draft changed since. Run it again.'
            : current
              ? 'Test passed, ready to publish.'
              : 'This test passed, but the draft changed since. Run it again to publish.'}
        </Result>
      ) : outcome === 'failed' ? (
        <Result tone="danger" outcome="failed">
          The test didn’t pass.{' '}
          {failed
            ? `“${failed.step ? stepLines(failed.step, names, def).title : 'A step'}” failed: ${
                typeof failed.row.error?.['message'] === 'string'
                  ? failed.row.error['message']
                  : 'something went wrong'
              }`
            : 'A step failed.'}
        </Result>
      ) : outcome === 'outdated' ? (
        <Result tone="warning" outcome="outdated">
          The draft changed during the test, so it can’t count. Run it again.
        </Result>
      ) : outcome === 'stopped' ? (
        <Result tone="warning" outcome="stopped">
          The test was stopped before it finished.
        </Result>
      ) : null}
      {!running && !simulateOnly ? (
        <Link
          href={`/app/w/${workspaceId}/workflows/runs/${run.id}`}
          className="mt-2 inline-block text-xs font-medium text-accent-text hover:underline"
        >
          Open this test run
        </Link>
      ) : null}
    </div>
  );
}

function Result({
  tone,
  outcome,
  children,
}: {
  tone: 'ok' | 'danger' | 'warning';
  outcome: string;
  children: React.ReactNode;
}) {
  const Icon = tone === 'ok' ? CheckCircle2 : tone === 'danger' ? AlertCircle : AlertTriangle;
  return (
    <div
      className={cn(
        'mt-3 flex items-start gap-2 rounded-[10px] border px-3 py-2.5 text-[13px]',
        tone === 'ok'
          ? 'border-[color-mix(in_oklab,var(--success)_30%,var(--border))] bg-[color-mix(in_oklab,var(--success-soft)_60%,var(--card))]'
          : tone === 'danger'
            ? 'border-[color-mix(in_oklab,var(--danger)_35%,var(--border))] bg-[color-mix(in_oklab,var(--danger-soft)_60%,var(--card))]'
            : 'border-[color-mix(in_oklab,var(--warning)_35%,var(--border))] bg-[color-mix(in_oklab,var(--warning-soft)_60%,var(--card))]',
      )}
      data-testid="test-result"
      data-outcome={outcome}
    >
      <Icon
        className={cn(
          'mt-0.5 h-4 w-4 flex-none',
          tone === 'ok'
            ? 'text-success-text'
            : tone === 'danger'
              ? 'text-danger-text'
              : 'text-warning-text',
        )}
        strokeWidth={1.75}
      />
      <span className="min-w-0">{children}</span>
    </div>
  );
}
