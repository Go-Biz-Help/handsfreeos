'use client';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CircleDot,
  Info,
  Lock,
  RefreshCw,
  Trash2,
  Undo2,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { MigrationDetail, MigrationReviewQueue } from '@/lib/agency/migration-words';
import { STATUS_WORDS, stepOf } from '@/lib/agency/migration-words';
import { cn } from '@/lib/utils';

type Scope = MigrationDetail['scopes'][number];
type Inventory = MigrationDetail['inventory'][number];
type Finding = MigrationDetail['findings'][number];

/** The severity colours, from "worth knowing" to "read this before you press anything". */
const SEVERITY: Record<string, { tone: 'neutral' | 'warning' | 'danger'; icon: typeof Info }> = {
  info: { tone: 'neutral', icon: Info },
  review: { tone: 'neutral', icon: CircleDot },
  action: { tone: 'warning', icon: AlertTriangle },
  blocking: { tone: 'danger', icon: AlertTriangle },
};

export function MigrationWizard({
  organizationId,
  workspaceId,
  detail,
  businesses,
}: {
  organizationId: string;
  /**
   * Set when this is a business's own Settings page. Every command then goes through the workspace door and
   * reaches that business's part of the migration and no other's. Left out on the agency's page, where the
   * whole migration is in view.
   */
  workspaceId?: string;
  detail: MigrationDetail;
  businesses: readonly { id: string; name: string }[];
}) {
  const router = useRouter();
  const mapped = detail.scopes.some((s) => s.selected && s.workspaceId);
  const step = stepOf(detail.migration.status, mapped);

  // While it is working, the page keeps itself up to date without anybody pressing anything.
  useEffect(() => {
    if (step !== 'importing') return;
    const timer = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(timer);
  }, [step, router]);

  return (
    <div className="flex flex-col gap-5">
      <Progress detail={detail} step={step} />
      {step === 'map' ? (
        <>
          <MapScopes
            organizationId={organizationId}
            workspaceId={workspaceId}
            detail={detail}
            businesses={businesses}
          />
          {/* What was found, while somebody is still deciding where it lands. Reading it is half of
              deciding, so it is on this step too — just not editable until the businesses are settled. */}
          <ChooseWhat
            organizationId={organizationId}
            workspaceId={workspaceId}
            detail={detail}
            readOnly
          />
        </>
      ) : null}
      {step === 'review' ? (
        <>
          <ChooseWhat organizationId={organizationId} workspaceId={workspaceId} detail={detail} />
          <ReviewPlan organizationId={organizationId} workspaceId={workspaceId} detail={detail} />
        </>
      ) : null}
      {step === 'importing' ? (
        <Running organizationId={organizationId} workspaceId={workspaceId} detail={detail} />
      ) : null}
      {step === 'done' ? (
        <Finished organizationId={organizationId} workspaceId={workspaceId} detail={detail} />
      ) : null}
      <Findings findings={detail.findings} />
      {/* On every step, because the move people most want rid of is the one that never got off the first
          one — connected to the wrong sub-account, or a second go at the same one. */}
      <Discard organizationId={organizationId} workspaceId={workspaceId} detail={detail} />
    </div>
  );
}

/** Where it is, in one line, without the database's words. */
function Progress({ detail, step }: { detail: MigrationDetail; step: string }) {
  const steps = [
    { key: 'map', label: 'Where it lands' },
    { key: 'review', label: 'What to bring' },
    { key: 'importing', label: 'Bringing it across' },
    { key: 'done', label: 'Done' },
  ];
  const at = steps.findIndex((s) => s.key === step);
  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">
          {STATUS_WORDS[detail.migration.status] ?? detail.migration.status}
        </span>
        <span className="text-[13px] text-text-3">
          from {detail.migration.sourceLabel}
          {detail.connection.missingScopes.length > 0
            ? ` · ${detail.connection.missingScopes.length} ${
                detail.connection.missingScopes.length === 1 ? 'thing' : 'things'
              } this sign-in cannot read`
            : ''}
        </span>
      </div>
      <ol className="flex flex-wrap gap-1.5">
        {steps.map((s, i) => (
          <li
            key={s.key}
            className={cn(
              'flex items-center gap-1.5 rounded-control px-2.5 py-1 text-[13px]',
              i < at
                ? 'bg-card-2 text-text-3'
                : i === at
                  ? 'bg-accent-soft font-medium text-accent-text'
                  : 'text-text-3',
            )}
          >
            {i < at ? <Check className="h-3.5 w-3.5" strokeWidth={2} /> : null}
            {s.label}
          </li>
        ))}
      </ol>
      {detail.migration.lastError ? (
        <p className="text-[13px] text-danger-text">{detail.migration.lastError}</p>
      ) : null}
    </Card>
  );
}

/** Step one: which business each sub-account of the old system becomes. */
function MapScopes({
  organizationId,
  workspaceId,
  detail,
  businesses,
}: {
  organizationId: string;
  workspaceId?: string;
  detail: MigrationDetail;
  businesses: readonly { id: string; name: string }[];
}) {
  const router = useRouter();
  const [choices, setChoices] = useState<Record<string, string>>(() =>
    Object.fromEntries(detail.scopes.map((s) => [s.id, s.workspaceId ?? 'new'])),
  );
  const [busy, setBusy] = useState(false);

  // How many sub-accounts point at each business: two or more is allowed, and says what it mixes.
  const sharing = new Map<string, string[]>();
  for (const s of detail.scopes) {
    const target = choices[s.id];
    if (!target || target === 'skip' || target === 'new') continue;
    sharing.set(target, [...(sharing.get(target) ?? []), s.name]);
  }

  async function save() {
    setBusy(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/migration.map_scopes', {
          body: {
            organizationId,
            workspaceId,
            migrationId: detail.migration.id,
            scopes: detail.scopes.map((s) => {
              const target = choices[s.id];
              if (target === 'skip') return { scopeId: s.id, skip: true };
              if (target === 'new')
                return {
                  scopeId: s.id,
                  createWorkspace: { name: s.name, timezone: s.timezone ?? undefined },
                };
              return { scopeId: s.id, workspaceId: target };
            }),
          },
        }),
      );
      toast.success(
        out.mapped === 1
          ? 'One business set up.'
          : `${out.mapped} businesses set up${out.skipped ? `, ${out.skipped} skipped` : ''}.`,
      );
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // Nothing has been found yet, so there is nothing to point anywhere. That happens when the look has not
  // been done — or did not finish — and an empty list with a Save button under it is a dead end rather than
  // an answer. So the offer is the one thing worth doing here: look again.
  if (detail.scopes.length === 0)
    return (
      <LookAgain
        organizationId={organizationId}
        workspaceId={workspaceId}
        migrationId={detail.migration.id}
      />
    );

  return (
    <Card className="p-5" data-testid="migration-map">
      <h2 className="text-base font-semibold">Where each one lands</h2>
      <p className="mt-1 text-[13px] text-text-2">
        Each sub-account of the old system becomes a business here, or joins one you already have.
        Two can share a business — we&apos;ll say what that mixes before anything moves.
      </p>
      <div className="mt-4 flex flex-col gap-2">
        {detail.scopes.map((s) => (
          <ScopeRow
            key={s.id}
            scope={s}
            businesses={businesses}
            value={choices[s.id] ?? 'new'}
            shared={(sharing.get(choices[s.id] ?? '') ?? []).length > 1}
            onChange={(v) => setChoices((c) => ({ ...c, [s.id]: v }))}
          />
        ))}
      </div>
      <div className="mt-4 flex justify-end">
        <Button onClick={save} loading={busy} data-testid="migration-map-save">
          Save and choose what to bring
          <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
        </Button>
      </div>
    </Card>
  );
}

/**
 * A migration with nothing found in it yet. Read-only, like every look: it counts what is there and writes
 * nothing to the business, so pressing it again is always safe.
 */
function LookAgain({
  organizationId,
  workspaceId,
  migrationId,
}: {
  organizationId: string;
  workspaceId?: string;
  migrationId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function look() {
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/migration.scan', {
          body: { organizationId, workspaceId, migrationId },
        }),
      );
      toast.success('Looking at the old system. This only reads — nothing moves yet.');
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5" data-testid="migration-look-again">
      <h2 className="text-base font-semibold">Nothing found in the old system yet</h2>
      <p className="mt-1 text-[13px] text-text-2">
        We haven&apos;t counted what&apos;s in there — or the last look didn&apos;t finish. Looking
        only reads: it counts what is there and changes nothing, in the old system or here, so it is
        always safe to press again.
      </p>
      <div className="mt-4 flex justify-end">
        <Button onClick={look} loading={busy} data-testid="migration-look-again-go">
          Look at the old system
          <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
        </Button>
      </div>
    </Card>
  );
}

function ScopeRow({
  scope,
  businesses,
  value,
  shared,
  onChange,
}: {
  scope: Scope;
  businesses: readonly { id: string; name: string }[];
  value: string;
  shared: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-control border border-border p-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{scope.name}</div>
        <div className="truncate text-xs text-text-3">
          {scope.timezone ?? 'No time zone'} · {scope.externalScopeId}
        </div>
        {shared ? (
          <div className="mt-1 text-xs text-warning-text">
            Sharing this business with another sub-account. Customers with the same number or email
            will be joined; anything else stays separate.
          </div>
        ) : null}
      </div>
      <select
        aria-label={`Where ${scope.name} lands`}
        data-testid={`migration-scope-${scope.externalScopeId}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 rounded-control border border-border bg-card px-2.5 text-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
      >
        <option value="new">Make a new business</option>
        {businesses.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
        <option value="skip">Don&apos;t bring this one</option>
      </select>
    </div>
  );
}

/** Step two: what to bring. Everything importable starts ticked; requirements are added and locked. */
function ChooseWhat({
  organizationId,
  workspaceId,
  detail,
  readOnly,
}: {
  organizationId: string;
  workspaceId?: string;
  detail: MigrationDetail;
  readOnly?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(detail.inventory.map((i) => [i.category, i.selected])),
  );

  async function save() {
    setBusy(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/migration.select', {
          body: {
            organizationId,
            workspaceId,
            migrationId: detail.migration.id,
            choices: detail.inventory
              .filter((i) => !i.locked && i.resourceId === null)
              .map((i) => ({ category: i.category, selected: picked[i.category] ?? false })),
          },
        }),
      );
      for (const added of out.added) toast.info(added.reason);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const rows = detail.inventory.filter((i) => i.resourceId === null);
  return (
    <Card className="p-5" data-testid={readOnly ? 'migration-inventory' : 'migration-choose'}>
      <h2 className="text-base font-semibold">
        {readOnly ? 'What’s in the old system' : 'What to bring'}
      </h2>
      <p className="mt-1 text-[13px] text-text-2">
        {readOnly
          ? 'Counted, not moved. Say where each business lands and you can choose what comes across.'
          : 'Everything we can bring is ticked. Anything a choice needs is added for you and locked, with a line saying which choice asked for it.'}
      </p>
      <div className="mt-4 flex flex-col divide-y divide-border">
        {rows.map((i) => (
          <InventoryRow
            key={i.category}
            row={i}
            readOnly={readOnly}
            checked={picked[i.category] ?? i.selected}
            onChange={(v) => setPicked((p) => ({ ...p, [i.category]: v }))}
          />
        ))}
      </div>
      {readOnly ? null : (
        <div className="mt-4 flex justify-end">
          <Button
            variant="secondary"
            onClick={save}
            loading={busy}
            data-testid="migration-choose-save"
          >
            Save what to bring
          </Button>
        </div>
      )}
    </Card>
  );
}

function InventoryRow({
  row,
  checked,
  readOnly,
  onChange,
}: {
  row: Inventory;
  checked: boolean;
  readOnly?: boolean;
  onChange: (value: boolean) => void;
}) {
  const bringable = row.capability === 'ready' || row.capability === 'needs_review';
  return (
    <div className="flex items-start gap-3 py-3" data-testid={`migration-row-${row.category}`}>
      <div className="pt-0.5">
        {/* Nothing is tickable while the businesses are still being decided, so the row simply has no
            control — a padlock there would read as "locked forever", which is a different thing. */}
        {readOnly ? (
          <span className="block h-[18px] w-[18px]" aria-hidden />
        ) : row.locked || !bringable ? (
          <Lock className="h-4 w-4 text-text-3" strokeWidth={1.5} aria-hidden />
        ) : (
          <Checkbox
            checked={checked}
            onChange={(e) => onChange(e.currentTarget.checked)}
            label={<span className="sr-only">Bring {row.categoryLabel}</span>}
          />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{row.categoryLabel}</span>
          {/* The words, never the raw number: a count nobody was allowed to make must not read as zero. */}
          <span className="text-[13px] text-text-3" data-testid={`migration-count-${row.category}`}>
            {row.countLabel}
          </span>
          {row.capability !== 'ready' ? (
            <Badge variant={row.capability === 'not_available' ? 'pending' : 'gray'}>
              {row.capabilityLabel}
            </Badge>
          ) : null}
        </div>
        {row.autoAdded && row.requiredBy.length > 0 ? (
          <p className="mt-0.5 text-xs text-text-3">
            Added because {row.requiredBy.join(' and ')} need it.
          </p>
        ) : (
          <p className="mt-0.5 text-xs text-text-3">{row.blurb}</p>
        )}
        {row.notes ? <p className="mt-0.5 text-xs text-text-3">{row.notes}</p> : null}
      </div>
    </div>
  );
}

/** Step three: the plan, and the button that starts it. */
function ReviewPlan({
  organizationId,
  workspaceId,
  detail,
}: {
  organizationId: string;
  workspaceId?: string;
  detail: MigrationDetail;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const bringing = detail.inventory.filter((i) => i.selected && i.resourceId === null);
  const blocking = detail.findings.filter((f) => f.blocksImport && !f.acknowledged);
  const landing = detail.scopes.filter((s) => s.selected && s.workspaceId);

  async function start() {
    setBusy(true);
    try {
      await apiBrowser().POST('/v1/commands/migration.start', {
        body: {
          organizationId,
          workspaceId,
          migrationId: detail.migration.id,
          acknowledgedFindingIds: blocking.map((f) => f.id),
        },
      });
      toast.success('Bringing it across. You can leave this page — it keeps going.');
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5" data-testid="migration-review">
      <h2 className="text-base font-semibold">The plan</h2>
      <dl className="mt-3 flex flex-col gap-2 text-[13px]">
        <div className="flex gap-2">
          <dt className="w-40 flex-none text-text-3">Businesses</dt>
          <dd>
            {landing.map((s) => `${s.name} → ${s.workspaceName ?? 'a new business'}`).join(', ') ||
              'None yet'}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-40 flex-none text-text-3">Bringing</dt>
          <dd>{bringing.map((i) => `${i.categoryLabel} (${i.countLabel})`).join(', ')}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-40 flex-none text-text-3">Staying behind</dt>
          <dd>
            Your automations, websites and funnels. They keep working where they are, and we never
            cancel your old account.
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-40 flex-none text-text-3">While it runs</dt>
          <dd>
            No text, email, invoice or reminder goes out because of this. History arrives with the
            dates it really happened on.
          </dd>
        </div>
      </dl>
      <div className="mt-4 flex justify-end">
        <Button onClick={start} loading={busy} data-testid="migration-start-import">
          Bring it across
        </Button>
      </div>
    </Card>
  );
}

/** While it runs: what is done, what needs a person, and the controls. */
function Running({
  organizationId,
  workspaceId,
  detail,
}: {
  organizationId: string;
  workspaceId?: string;
  detail: MigrationDetail;
}) {
  const router = useRouter();
  const act = async (command: string, extra: Record<string, unknown> = {}) => {
    try {
      await apiBrowser().POST(`/v1/commands/${command}` as '/v1/commands/migration.pause', {
        body: { organizationId, workspaceId, migrationId: detail.migration.id, ...extra },
      });
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const byCategory = new Map<string, { imported: number; found: number; failed: number }>();
  for (const p of detail.progress) {
    const at = byCategory.get(p.categoryLabel) ?? { imported: 0, found: 0, failed: 0 };
    byCategory.set(p.categoryLabel, {
      imported: at.imported + p.imported + p.merged,
      found: at.found + p.found,
      failed: at.failed + p.failed,
    });
  }
  return (
    <Card className="p-5" data-testid="migration-running">
      <h2 className="text-base font-semibold">Bringing it across</h2>
      <div className="mt-3 flex flex-col gap-2">
        {[...byCategory.entries()].map(([label, c]) => (
          <div key={label} className="flex items-center gap-3 text-[13px]">
            <span className="w-40 flex-none truncate">{label}</span>
            <span className="tabular-nums text-text-2">
              {c.imported.toLocaleString()} of {c.found.toLocaleString()}
            </span>
            {c.failed > 0 ? <Badge variant="pending">{c.failed} need another go</Badge> : null}
          </div>
        ))}
        {byCategory.size === 0 ? <p className="text-[13px] text-text-3">Starting…</p> : null}
      </div>
      {detail.needsReview > 0 ? (
        <ReviewQueue
          organizationId={organizationId}
          workspaceId={workspaceId}
          migrationId={detail.migration.id}
          waiting={detail.needsReview}
        />
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        {detail.migration.status === 'paused' ? (
          <Button variant="secondary" onClick={() => act('migration.resume')}>
            Carry on
          </Button>
        ) : (
          <Button
            variant="secondary"
            onClick={() => act('migration.pause')}
            data-testid="migration-pause"
          >
            Pause
          </Button>
        )}
        {detail.retryable > 0 ? (
          <Button
            variant="ghost"
            onClick={() => act('migration.retry')}
            data-testid="migration-retry"
          >
            <RefreshCw className="h-4 w-4" strokeWidth={1.75} />
            Try {detail.retryable} again
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

type Candidate = MigrationReviewQueue['candidates'][number];

/**
 * The customers the import would not guess about, and the question each one is waiting on.
 *
 * The line "1 customer needs you to say whether they're somebody you already have" used to be the whole of
 * it: there was nowhere on the screen to say so, and the customer waited forever. This is where. Each one
 * shows who arrived and who here they might be, and the answer is a button — that person, or nobody here.
 * Deciding queues the record to be brought across the decided way; the count above comes down as it lands.
 *
 * Loaded here rather than with the page, because it is asked for again after every answer and the rest of
 * the page has no reason to reload for it.
 */
function ReviewQueue({
  organizationId,
  workspaceId,
  migrationId,
  waiting,
}: {
  organizationId: string;
  workspaceId?: string;
  migrationId: string;
  /** How many are waiting, from the page: a change to it is the cue to ask for the list again. */
  waiting: number;
}) {
  const router = useRouter();
  const [candidates, setCandidates] = useState<readonly Candidate[] | null>(null);
  const [remaining, setRemaining] = useState(waiting);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const out = unwrap(
          await apiBrowser().POST('/v1/queries/migration.review_queue', {
            body: { organizationId, workspaceId, migrationId, limit: 10 },
          }),
        );
        if (cancelled) return;
        setCandidates(out.candidates);
        setRemaining(out.remaining);
      } catch (err) {
        if (!cancelled) toast.error(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [organizationId, workspaceId, migrationId, waiting]);

  const decide = async (
    candidate: Candidate,
    decision: { decision: 'separate' } | { decision: 'remap'; targetId: string },
  ) => {
    setBusy(candidate.id);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/migration.resolve_merge', {
          body: {
            organizationId,
            workspaceId,
            migrationId,
            candidateId: candidate.id,
            ...decision,
          },
        }),
      );
      setCandidates((list) => (list ?? []).filter((c) => c.id !== candidate.id));
      setRemaining((n) => Math.max(0, n - 1));
      toast.success(
        decision.decision === 'separate'
          ? `${candidate.incoming.name} is coming across as a new customer.`
          : `${candidate.incoming.name} is being joined to the customer you chose.`,
      );
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const who = (p: { name: string; email: string | null; phone: string | null }) =>
    [p.name, p.email, p.phone].filter(Boolean).join(' · ');

  return (
    <div
      className="mt-4 rounded-control border border-border p-3"
      data-testid="migration-review-queue"
    >
      <h3 className="text-sm font-medium">
        {remaining} {remaining === 1 ? 'customer needs' : 'customers need'} you to say whether
        they&apos;re somebody you already have
      </h3>
      <p className="mt-0.5 text-xs text-text-3">
        The rest carries on without them. Each one is brought across the way you say, and nothing is
        guessed.
      </p>
      {candidates === null ? (
        <p className="mt-3 text-[13px] text-text-3">Looking them up…</p>
      ) : candidates.length === 0 ? (
        <p className="mt-3 text-[13px] text-text-3">
          All decided. They are being brought across now.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col divide-y divide-border">
          {candidates.map((c) => (
            <li
              key={c.id}
              className="flex flex-col gap-2 py-3"
              data-testid={`migration-review-candidate-${c.id}`}
            >
              <div className="min-w-0">
                <p className="text-[13px] font-medium">{who(c.incoming)}</p>
                <p className="text-xs text-text-3">
                  From {c.scopeName}. {c.reason}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {c.here.map((h) => (
                  <Button
                    key={h.id}
                    variant="secondary"
                    size="sm"
                    loading={busy === c.id}
                    disabled={busy !== null && busy !== c.id}
                    onClick={() => decide(c, { decision: 'remap', targetId: h.id })}
                  >
                    Same as {who(h)}
                  </Button>
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  loading={busy === c.id}
                  disabled={busy !== null && busy !== c.id}
                  onClick={() => decide(c, { decision: 'separate' })}
                  data-testid="migration-review-separate"
                >
                  Somebody new
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Afterwards: what came across, what is left for a person, and the way back. */
function Finished({
  organizationId,
  workspaceId,
  detail,
}: {
  organizationId: string;
  workspaceId?: string;
  detail: MigrationDetail;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const total = detail.progress.reduce((t, p) => t + p.imported + p.merged, 0);
  const open = detail.tasks.filter((t) => t.state !== 'done' && t.state !== 'not_needed');

  const rollback = async () => {
    if (
      !confirm(
        'Take back everything this migration put here? Customers you already had are never deleted.',
      )
    )
      return;
    setBusy(true);
    try {
      await askForRollback(organizationId, workspaceId, detail.migration.id);
      toast.success('Taking it back. Anything you changed since is left as it is.');
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5" data-testid="migration-done">
      <h2 className="text-base font-semibold">
        {detail.migration.status === 'rolled_back' ? 'Taken back' : 'Brought across'}
      </h2>
      <p className="mt-1 text-[26px] font-semibold tabular-nums">{total.toLocaleString()}</p>
      <p className="text-[13px] text-text-3">records now here</p>
      {/* Somebody the import was not sure about is still waiting after it finished: the question stays on
          the screen until it is answered, and answering brings them across. */}
      {detail.needsReview > 0 && detail.migration.status !== 'rolled_back' ? (
        <ReviewQueue
          organizationId={organizationId}
          workspaceId={workspaceId}
          migrationId={detail.migration.id}
          waiting={detail.needsReview}
        />
      ) : null}
      {/* Setup items are not failures, and the page never counts them as such. */}
      {open.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-sm font-medium">
            {open.length} {open.length === 1 ? 'thing' : 'things'} left for you
          </h3>
          <ul className="mt-2 flex flex-col gap-1.5">
            {open.map((t) => (
              <li key={t.id} className="text-[13px] text-text-2">
                {/* The place it is done, when the task names one: a list of chores with no way to them is
                    the treasure hunt `settings_path` exists to prevent. */}
                {t.workspaceId && t.settingsPath?.startsWith('/') ? (
                  <Link
                    href={`/app/w/${t.workspaceId}${t.settingsPath}`}
                    className="font-medium text-accent-text hover:underline"
                  >
                    {t.label}
                  </Link>
                ) : (
                  t.label
                )}
                {t.instructions ? <span className="text-text-3"> — {t.instructions}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {detail.migration.status === 'transition' && detail.migration.transitionEndsAt ? (
        <p className="mt-4 text-[13px] text-text-2">
          Still keeping up with {detail.migration.sourceLabel} until{' '}
          {new Date(detail.migration.transitionEndsAt).toLocaleDateString()}. When that runs out it
          asks rather than stopping quietly.
        </p>
      ) : null}
      {/* Taking it back is the way out of a finished move; deleting is the card below, on every step. */}
      {detail.migration.status !== 'rolled_back' ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            variant="ghost"
            onClick={rollback}
            loading={busy}
            data-testid="migration-rollback"
          >
            <Undo2 className="h-4 w-4" strokeWidth={1.75} />
            Take it back
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

/** Where the engine may still be writing, so what the move has done is not a settled question yet. */
const RUNNING_STATUSES = ['scanning', 'importing', 'rolling_back', 'cancelling'];
/** Where taking it back is something a person can press. Anywhere else, it has to be paused first. */
const ROLLBACKABLE_STATUSES = [
  'imported',
  'transition',
  'completed',
  'needs_attention',
  'failed',
  'paused',
];

/** Taking a move back: the same call from the card that finishes one and the card that clears one. */
async function askForRollback(
  organizationId: string,
  workspaceId: string | undefined,
  migrationId: string,
) {
  await apiBrowser().POST('/v1/commands/migration.rollback', {
    body: { organizationId, workspaceId, migrationId, confirm: true },
  });
}

/**
 * Taking a move off the list, at whatever step it stopped on.
 *
 * **This is on every step, and that is the point of it.** The move people most want rid of is not the one
 * that finished — it is the one that never got going: connected to the wrong sub-account, pointed at the
 * wrong system, or a second go at the same one that is now two rows in the list. Until 0088 the only way
 * out was the finished card, which those moves never reach, so they stayed forever.
 *
 * **What it asks for turns on one thing: whether the move has put anything here.** Nothing here, nothing to
 * put back, so it just goes — no rollback with no work to do, and no name to copy out to clear an empty
 * draft. Something here, and the order from 0086 stands: take it back, look at what came back, then delete,
 * with the name typed out because that one ends with records gone rather than put away.
 */
function Discard({
  organizationId,
  workspaceId,
  detail,
}: {
  organizationId: string;
  workspaceId?: string;
  detail: MigrationDetail;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const { id, name, status, putRecordsHere } = detail.migration;

  const remove = async () => {
    let confirmName: string | undefined;
    if (putRecordsHere) {
      const typed = prompt(`Type the name of this move to delete it: ${name}`, '');
      if (typed === null) return;
      confirmName = typed;
    } else if (
      !confirm(`Delete “${name}”? It has put nothing here, so nothing of yours goes with it.`)
    )
      return;
    setBusy(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/migration.delete', {
          body: {
            organizationId,
            workspaceId,
            migrationId: id,
            ...(confirmName === undefined ? {} : { confirmName }),
          },
        }),
      );
      toast.success(
        !out.hadRecords
          ? 'Deleted. It had put nothing here, so nothing of yours went with it.'
          : out.kept > 0
            ? `Deleted. ${out.removed} removed; ${out.kept} kept because they have history here.`
            : `Deleted. ${out.removed} records removed.`,
      );
      // The page this card is on went with it, so there is nothing here to refresh back into.
      router.replace(
        workspaceId
          ? `/app/w/${workspaceId}/settings/migrations`
          : `/app/org/${organizationId}/migrations`,
      );
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(false);
    }
  };

  const takeItBack = async () => {
    if (
      !confirm(
        'Take back everything this migration put here? Customers you already had are never deleted.',
      )
    )
      return;
    setBusy(true);
    try {
      await askForRollback(organizationId, workspaceId, id);
      toast.success('Taking it back. You can delete it once that has finished.');
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // Said in the order a person meets them: still going, then nothing to undo, then the two-step way out.
  const say = (): { line: string; button?: 'delete' | 'rollback' } => {
    if (status === 'rolling_back')
      return { line: 'This move is being taken back. You can delete it once that has finished.' };
    if (RUNNING_STATUSES.includes(status))
      return { line: 'Pause this move first, and the way to delete it appears here.' };
    if (!putRecordsHere)
      return {
        line: "This move hasn't put anything here — nothing was brought across. Deleting it takes nothing of yours with it, and the import can be set up again from scratch.",
        button: 'delete',
      };
    if (status === 'rolled_back')
      return {
        line: 'The customers it made are put away, not gone. Delete the move to finish them off and start the import again from scratch — anyone who has been texted, booked or billed since is kept.',
        button: 'delete',
      };
    if (ROLLBACKABLE_STATUSES.includes(status))
      return {
        line: 'This move has put records here, so take it back before deleting it. Taking it back puts them away and shows you what it could not undo; deleting is what finishes them off.',
        button: 'rollback',
      };
    // `verifying` and `finalizing`: still one of its own steps, and taking one back wants it stopped first.
    return { line: 'Pause this move, then take it back, and it can be deleted.' };
  };
  const { line, button } = say();

  return (
    <Card className="p-5" data-testid="migration-discard">
      <h2 className="text-base font-semibold">Delete this move</h2>
      <p className="mt-1 text-[13px] text-text-2">{line}</p>
      {button === 'delete' ? (
        <Button
          variant="danger"
          className="mt-3"
          onClick={remove}
          loading={busy}
          data-testid="migration-delete"
        >
          <Trash2 className="h-4 w-4" strokeWidth={1.75} />
          Delete this move
        </Button>
      ) : null}
      {button === 'rollback' ? (
        <Button
          variant="ghost"
          className="mt-3"
          onClick={takeItBack}
          loading={busy}
          data-testid="migration-discard-rollback"
        >
          <Undo2 className="h-4 w-4" strokeWidth={1.75} />
          Take it back
        </Button>
      ) : null}
    </Card>
  );
}

/** Everything that will not fit, grouped the way the report groups it. */
function Findings({ findings }: { findings: readonly Finding[] }) {
  if (findings.length === 0) return null;
  // The same gap is raised once per sub-account. A person wants to read it once, with how many it covers.
  const folded = new Map<string, { finding: Finding; times: number }>();
  for (const f of findings) {
    const key = `${f.code}:${f.summary}`;
    const at = folded.get(key);
    if (at) at.times += 1;
    else folded.set(key, { finding: f, times: 1 });
  }
  const groups = new Map<string, { finding: Finding; times: number }[]>();
  for (const entry of folded.values())
    groups.set(entry.finding.groupTitle, [...(groups.get(entry.finding.groupTitle) ?? []), entry]);
  return (
    <Card className="p-5" data-testid="migration-findings">
      <h2 className="text-base font-semibold">What we found</h2>
      <div className="mt-3 flex flex-col gap-4">
        {[...groups.entries()].map(([title, list]) => (
          <div key={title}>
            <h3 className="text-[13px] font-medium text-text-3">{title}</h3>
            <ul className="mt-1.5 flex flex-col gap-2">
              {list.map(({ finding: f, times }) => {
                const { icon: Icon, tone } = SEVERITY[f.severity] ?? SEVERITY.info!;
                return (
                  <li key={f.id} className="flex gap-2" data-testid={`migration-finding-${f.code}`}>
                    <Icon
                      className={cn(
                        'mt-0.5 h-4 w-4 flex-none',
                        tone === 'danger'
                          ? 'text-danger-text'
                          : tone === 'warning'
                            ? 'text-warning-text'
                            : 'text-text-3',
                      )}
                      strokeWidth={1.75}
                      aria-hidden
                    />
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium">
                        {f.summary}
                        {times > 1 ? (
                          <span className="font-normal text-text-3"> · in {times} of them</span>
                        ) : null}
                      </p>
                      {f.whatChanges ? (
                        <p className="text-xs text-text-2">{f.whatChanges}</p>
                      ) : null}
                      {f.recommendedAction ? (
                        <p className="text-xs text-text-3">{f.recommendedAction}</p>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </Card>
  );
}
