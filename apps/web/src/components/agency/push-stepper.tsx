'use client';
import { suggestMapping, type WorkflowCatalogs } from '@hfos/core';
import { AlertCircle, Check, CheckCircle2, CircleX, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Select } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type {
  WorkflowCatalogsOut,
  WorkflowTemplateDetail,
  WorkflowTemplateInstall,
} from '@/lib/api/types';
import { refOptions } from '@/lib/workflows/fields';
import { cn } from '@/lib/utils';

type Business = { readonly id: string; readonly name: string };
type Mapping = Record<string, string | null>;
type Step = 'pick' | 'match' | 'review' | 'progress';

const STEPS: readonly { key: Exclude<Step, 'progress'>; label: string }[] = [
  { key: 'pick', label: 'Pick businesses' },
  { key: 'match', label: 'Match details' },
  { key: 'review', label: 'Review and push' },
];
const POLL_MS = 1500;
const POLL_TIMES = 60;
const KIND_WORD: Record<string, string> = {
  stage: 'stage',
  pipeline: 'pipeline',
  tag: 'tag',
  calendar: 'calendar',
  service: 'service',
  user: 'person',
  workflow: 'workflow',
};

function StepDots({ step }: { step: Step }) {
  const at = step === 'progress' ? STEPS.length : STEPS.findIndex((s) => s.key === step);
  return (
    <ol className="mb-4 flex flex-wrap items-center gap-x-1.5 gap-y-2" aria-label="Steps">
      {STEPS.map((s, i) => (
        <li key={s.key} className="flex items-center gap-1.5">
          {i > 0 ? <span aria-hidden className="h-px w-5 bg-border sm:w-8" /> : null}
          <span
            className={cn(
              'flex items-center gap-2 text-[13px] font-medium',
              i < at ? 'text-success-text' : i === at ? 'text-accent-text' : 'text-text-3',
            )}
            aria-current={i === at ? 'step' : undefined}
          >
            <span
              className={cn(
                'inline-flex h-6 w-6 items-center justify-center rounded-full border-[1.5px] text-xs',
                i < at && 'border-success bg-success text-white',
                i === at && 'border-accent bg-accent text-white',
                i > at && 'border-border-strong',
              )}
            >
              {i < at ? <Check className="h-3.5 w-3.5" strokeWidth={2.4} /> : i + 1}
            </span>
            {s.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Pushing a template: pick the businesses, match each placeholder to something in each business (matched
 * by name where it can be), review, push. Then each business's install, as the worker makes its draft.
 * Nothing runs until each business tests and publishes its copy.
 */
export function PushStepper({
  organizationId,
  template,
  installs: initialInstalls,
  businesses,
  onClose,
}: {
  organizationId: string;
  template: WorkflowTemplateDetail;
  installs: readonly WorkflowTemplateInstall[];
  businesses: readonly Business[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>('pick');
  const [chosen, setChosen] = useState<string[]>(() => businesses.map((b) => b.id));
  const [catalogs, setCatalogs] = useState<Record<string, WorkflowCatalogsOut>>({});
  const [mappings, setMappings] = useState<Record<string, Mapping>>({});
  const [installs, setInstalls] = useState(initialInstalls);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const placeholders = template.placeholders;
  const installOf = (id: string) => installs.find((i) => i.workspaceId === id);
  const picked = businesses.filter((b) => chosen.includes(b.id));

  // Matching: each chosen business's catalogs, and a mapping to start from (what it had, else by name).
  useEffect(() => {
    if (step !== 'match') return;
    let cancelled = false;
    for (const b of picked) {
      if (catalogs[b.id]) continue;
      apiBrowser()
        .POST('/v1/queries/workflow.catalogs', { body: { workspaceId: b.id } })
        .then((r) => {
          if (cancelled) return;
          const c = unwrap(r).catalogs;
          const stored = (initialInstalls.find((i) => i.workspaceId === b.id)?.mapping ??
            {}) as Record<string, unknown>;
          const suggested = suggestMapping(placeholders, c as WorkflowCatalogs);
          const start: Mapping = {};
          for (const p of placeholders) {
            const had = stored[p.key];
            start[p.key] = Object.prototype.hasOwnProperty.call(stored, p.key)
              ? typeof had === 'string'
                ? had
                : null
              : (suggested[p.key] ?? null);
          }
          setCatalogs((all) => ({ ...all, [b.id]: c }));
          setMappings((all) => ({ ...all, [b.id]: all[b.id] ?? start }));
        })
        .catch((e: unknown) => !cancelled && setError(errorMessage(e)));
    }
    return () => {
      cancelled = true;
    };
    // `picked` follows `chosen`; the catalogs loaded so far are skipped inside.
  }, [step, chosen]);

  // After the push: follow each install until the worker has made (or couldn't make) its draft.
  useEffect(() => {
    if (step !== 'progress') return;
    let times = 0;
    const timer = setInterval(() => {
      times += 1;
      apiBrowser()
        .POST('/v1/queries/workflow_template.get', {
          body: { organizationId, templateId: template.id },
        })
        .then((r) => {
          const next = unwrap(r).installs;
          setInstalls(next);
          const waiting = next.some(
            (i) => chosen.includes(i.workspaceId) && i.status === 'pending',
          );
          if (!waiting || times >= POLL_TIMES) clearInterval(timer);
        })
        .catch(() => {
          if (times >= POLL_TIMES) clearInterval(timer);
        });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [step, organizationId, template.id, chosen]);

  const unmatched = useMemo(
    () =>
      Object.fromEntries(
        picked.map((b) => [b.id, placeholders.filter((p) => !(mappings[b.id]?.[p.key] ?? null))]),
      ),
    [picked, placeholders, mappings],
  );
  const matchReady = picked.every((b) => catalogs[b.id] || !placeholders.length);

  async function push() {
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/workflow_template.push', {
          body: {
            organizationId,
            templateId: template.id,
            workspaceIds: chosen,
            mappings: Object.fromEntries(
              chosen.map((id) => [
                id,
                Object.fromEntries(placeholders.map((p) => [p.key, mappings[id]?.[p.key] ?? null])),
              ]),
            ),
          },
        }),
      );
      setInstalls((all) =>
        all.map((i) => (chosen.includes(i.workspaceId) ? { ...i, status: 'pending' } : i)),
      );
      setStep('progress');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function close() {
    if (step === 'progress') router.refresh();
    onClose();
  }

  const pendingLeft = picked.some((b) => (installOf(b.id)?.status ?? 'pending') === 'pending');

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent
        title={`Push “${template.name}”`}
        description={`Version ${template.latestVersion ?? 1} · to client businesses`}
        className="max-h-[calc(100dvh-24px)] w-[min(720px,calc(100vw-24px))] overflow-y-auto"
      >
        <div className="mt-4" data-testid="push-stepper">
          <StepDots step={step} />

          {step === 'pick' ? (
            <div className="flex flex-col gap-1">
              {businesses.map((b) => {
                const i = installOf(b.id);
                return (
                  <div
                    key={b.id}
                    className="flex min-h-11 items-center gap-2.5 rounded-control px-1 hover:bg-card-2"
                  >
                    <Checkbox
                      className="min-w-0 flex-1 py-2"
                      checked={chosen.includes(b.id)}
                      onChange={(e) =>
                        setChosen((c) =>
                          e.target.checked ? [...c, b.id] : c.filter((x) => x !== b.id),
                        )
                      }
                      data-testid={`push-business-${b.id}`}
                      label={
                        <span className="flex items-center gap-2">
                          <Avatar
                            name={b.name}
                            seed={b.id}
                            size="sm"
                            square
                            className="bg-card-3 text-text"
                          />
                          <span className="truncate">{b.name}</span>
                        </span>
                      }
                    />
                    <span className="flex-none text-xs text-text-3">
                      {!i
                        ? 'Not yet'
                        : i.status === 'failed'
                          ? 'Couldn’t install'
                          : i.installedVersion
                            ? `Has version ${i.installedVersion}`
                            : 'Installing'}
                    </span>
                  </div>
                );
              })}
              <p className="mt-2 text-xs text-text-3">
                {chosen.length} of {businesses.length} client businesses. A business that already
                has its copy keeps it and sees “Update available” instead.
              </p>
            </div>
          ) : null}

          {step === 'match' ? (
            <div className="flex flex-col gap-3">
              {!placeholders.length ? (
                <p className="text-[13px] text-text-2">
                  This template names nothing a business has to match. On to the review.
                </p>
              ) : (
                <p className="text-xs text-text-2">
                  Matched by name where we could. Pick the rest, or leave one for the business to
                  pick: its draft shows it in Checks, and it can’t publish until it’s picked.
                </p>
              )}
              {placeholders.length
                ? picked.map((b) => {
                    const c = catalogs[b.id];
                    const left = unmatched[b.id]?.length ?? 0;
                    return (
                      <section
                        key={b.id}
                        className="rounded-card border border-border p-3"
                        data-testid={`push-map-${b.id}`}
                      >
                        <div className="mb-2 flex items-center gap-2">
                          <Avatar
                            name={b.name}
                            seed={b.id}
                            size="sm"
                            square
                            className="bg-card-3 text-text"
                          />
                          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
                            {b.name}
                          </span>
                          {c ? (
                            left ? (
                              <Badge variant="danger" className="h-5 text-[11.5px]">
                                {left} not matched
                              </Badge>
                            ) : (
                              <Badge variant="ok" className="h-5 text-[11.5px]">
                                All matched
                              </Badge>
                            )
                          ) : null}
                        </div>
                        {!c ? (
                          <p className="flex items-center gap-2 text-xs text-text-3">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading its stages,
                            calendars and people…
                          </p>
                        ) : (
                          <div className="grid gap-2.5 sm:grid-cols-2">
                            {placeholders.map((p) => {
                              const value = mappings[b.id]?.[p.key] ?? '';
                              return (
                                <label key={p.key} className="flex min-w-0 flex-col gap-1">
                                  <span className="text-xs text-text-3">
                                    {p.label} · {KIND_WORD[p.kind] ?? p.kind}
                                  </span>
                                  <span className="flex items-center gap-1.5">
                                    <Select
                                      selectSize="sm"
                                      className={cn('min-w-0 flex-1', !value && 'border-danger')}
                                      aria-label={`${p.label} for ${b.name}`}
                                      value={value}
                                      onChange={(e) =>
                                        setMappings((all) => ({
                                          ...all,
                                          [b.id]: { ...all[b.id], [p.key]: e.target.value || null },
                                        }))
                                      }
                                      data-testid={`push-map-${b.id}-${p.key}`}
                                    >
                                      <option value="">Leave for them to pick</option>
                                      {refOptions(p.kind, c as WorkflowCatalogs).map((o) => (
                                        <option key={o.value} value={o.value}>
                                          {o.label}
                                        </option>
                                      ))}
                                    </Select>
                                    {value ? (
                                      <CheckCircle2
                                        aria-label="Matched"
                                        className="h-4 w-4 flex-none text-success-text"
                                        strokeWidth={1.75}
                                      />
                                    ) : (
                                      <AlertCircle
                                        aria-label="Not matched"
                                        className="h-4 w-4 flex-none text-danger-text"
                                        strokeWidth={1.75}
                                      />
                                    )}
                                  </span>
                                </label>
                              );
                            })}
                          </div>
                        )}
                      </section>
                    );
                  })
                : null}
            </div>
          ) : null}

          {step === 'review' ? (
            <ul className="flex flex-col gap-2 text-[13px] text-text-2" data-testid="push-review">
              <li className="flex items-start gap-2">
                <CheckCircle2
                  className="mt-px h-4 w-4 flex-none text-success-text"
                  strokeWidth={1.75}
                />
                {(() => {
                  const fresh = picked.filter((b) => !installOf(b.id)?.workflowId).length;
                  const has = picked.length - fresh;
                  return `${fresh} ${fresh === 1 ? 'draft' : 'drafts'}, one in each business${
                    has
                      ? `; ${has} already ${has === 1 ? 'has' : 'have'} a copy and will see “Update available”`
                      : ''
                  }`;
                })()}
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2
                  className="mt-px h-4 w-4 flex-none text-success-text"
                  strokeWidth={1.75}
                />
                Nothing runs until each business tests and publishes it
              </li>
              {picked
                .filter((b) => unmatched[b.id]?.length)
                .map((b) => (
                  <li key={b.id} className="flex items-start gap-2">
                    <CircleX
                      className="mt-px h-4 w-4 flex-none text-danger-text"
                      strokeWidth={1.75}
                    />
                    {b.name}’s draft can’t publish until{' '}
                    {unmatched[b.id]!.map((p) => p.label.toLowerCase()).join(', ')}{' '}
                    {unmatched[b.id]!.length === 1 ? 'is' : 'are'} picked
                  </li>
                ))}
            </ul>
          ) : null}

          {step === 'progress' ? (
            <ul className="flex flex-col gap-1.5" data-testid="push-progress">
              {picked.map((b) => {
                const i = installOf(b.id);
                const status = i?.status ?? 'pending';
                return (
                  <li
                    key={b.id}
                    className="flex min-h-11 flex-wrap items-center gap-2.5 rounded-control border border-border px-3 py-2"
                    data-testid={`push-status-${b.id}`}
                    data-status={status}
                  >
                    <Avatar
                      name={b.name}
                      seed={b.id}
                      size="sm"
                      square
                      className="bg-card-3 text-text"
                    />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                      {b.name}
                    </span>
                    {status === 'pending' ? (
                      <span className="flex items-center gap-1.5 text-xs text-text-3">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Making its draft…
                      </span>
                    ) : status === 'failed' ? (
                      <span className="text-xs text-danger-text">
                        Couldn’t install{i?.lastError ? `: ${i.lastError}` : ''}
                      </span>
                    ) : (
                      <span className="flex items-center gap-2 text-xs text-success-text">
                        <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                        {i?.installedVersion ? `Version ${i.installedVersion}` : 'Installed'}
                        {i?.workflowId ? (
                          <Link
                            href={`/app/w/${b.id}/workflows/${i.workflowId}`}
                            className="font-medium text-accent-text hover:underline"
                          >
                            Open its draft
                          </Link>
                        ) : null}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : null}

          {error ? <p className="mt-3 text-[13px] text-danger-text">{error}</p> : null}

          <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
            {step === 'match' && picked.some((b) => unmatched[b.id]?.length) ? (
              <span className="mr-auto text-xs text-text-3">
                You can push now and let them pick the rest later.
              </span>
            ) : null}
            {step === 'pick' ? (
              <>
                <Button variant="ghost" onClick={close}>
                  Cancel
                </Button>
                <Button
                  disabled={!chosen.length}
                  onClick={() => setStep('match')}
                  data-testid="push-next"
                >
                  Next: match details
                </Button>
              </>
            ) : step === 'match' ? (
              <>
                <Button variant="ghost" onClick={() => setStep('pick')}>
                  Back
                </Button>
                <Button
                  disabled={!matchReady}
                  onClick={() => setStep('review')}
                  data-testid="push-next"
                >
                  Next: review
                </Button>
              </>
            ) : step === 'review' ? (
              <>
                <Button variant="ghost" onClick={() => setStep('match')}>
                  Back
                </Button>
                <Button loading={busy} onClick={() => void push()} data-testid="push-submit">
                  Push to {chosen.length} {chosen.length === 1 ? 'business' : 'businesses'}
                </Button>
              </>
            ) : (
              <Button
                variant={pendingLeft ? 'secondary' : 'primary'}
                onClick={() => {
                  if (!pendingLeft)
                    toast.success('Pushed. Each business tests and publishes its copy.');
                  close();
                }}
                data-testid="push-done"
              >
                {pendingLeft ? 'Close (it keeps going)' : 'Done'}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
