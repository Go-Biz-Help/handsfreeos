'use client';
import {
  applyPatch,
  hasBlockingIssues,
  inferLabels,
  parseConfig,
  validateCalendar,
  type CalendarConfig,
  type CalendarIssue,
  type ConfigPatch,
  type Impact,
  type ImpactDecision,
} from '@hfos/core';
import {
  AlertCircle,
  AlertTriangle,
  BellRing,
  CalendarClock,
  CalendarX,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Clock,
  Contact,
  Copy,
  CreditCard,
  ExternalLink,
  Eye,
  History,
  Link2,
  ListOrdered,
  Map as MapIcon,
  MapPin,
  Repeat,
  Timer,
  Truck,
  Users,
  UsersRound,
  Workflow,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { copyText } from '@/components/ui/copy-field';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type {
  CalendarDetail,
  CalendarRevision,
  CalendarSaveBody,
  CalendarStatus,
  Pipeline,
  ResourceItem,
  ServiceItem,
  TerritoryItem,
} from '@/lib/api/types';
import { buildCatalogs } from '@/lib/calendar/catalogs';
import {
  describeCalendar,
  moduleOfField,
  MODULES,
  moduleSummary,
  type ModuleKey,
} from '@/lib/calendar/describe';
import { dateOf, fmtMonthDay, fmtTime, todayIn } from '@/lib/calendar/time';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { usePublicOrigin } from '@/lib/use-origin';
import { cn } from '@/lib/utils';
import { CalendarDot, CalendarStatusBadge, LabelChips } from './chips';
import { HistorySheet } from './history-sheet';
import { ImpactDialog } from './impact-dialog';
import { ModuleForm, type BuilderPayments, type BuilderPerson } from './modules';

const ICONS: Record<ModuleKey, LucideIcon> = {
  team: Users,
  services: Wrench,
  availability: Clock,
  capacity: UsersRound,
  locations: MapPin,
  resources: Truck,
  buffers: Timer,
  territories: MapIcon,
  window: CalendarClock,
  repeats: Repeat,
  waitlist: ListOrdered,
  intake: ClipboardList,
  rules: CalendarX,
  notify: BellRing,
  connections: Link2,
  crm: Contact,
  payments: CreditCard,
  automations: Workflow,
};

const COLORS = [
  '#2d69d8',
  '#0e7490',
  '#7c3aed',
  '#c2410c',
  '#008743',
  '#be185d',
  '#996300',
  '#5b616a',
];

interface Details {
  name: string;
  color: string;
  description: string | null;
}
interface Edit {
  rev: number;
  base: CalendarConfig;
  draft: CalendarConfig;
  details: Details;
  baseDetails: Details;
}

/** JSON with object keys sorted, so two equal settings compare equal whatever order they were built in. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}
const dirtyOf = (e: Edit) =>
  stable(e.draft) !== stable(e.base) || stable(e.details) !== stable(e.baseDetails);
const refusal = (e: unknown) =>
  (e as { issues?: { message?: string }[] }).issues?.[0]?.message ?? 'That value isn’t allowed.';

export interface BuilderProps {
  workspaceId: string;
  myUserId: string;
  calendar: CalendarDetail;
  revisions: CalendarRevision[];
  people: BuilderPerson[];
  services: ServiceItem[];
  resources: ResourceItem[];
  territories: TerritoryItem[];
  pipelines: Pipeline[];
  textingReady: boolean;
  /** Settings → Payments: the connected accounts and the deposit the business asks for by default. */
  payments: BuilderPayments;
  /** Their own domain when one is serving (M17): the booking link in the right rail is on it. */
  brandedOrigin: string | null;
}

/**
 * The calendar builder: a module list, the chosen module's settings, and a right rail with how it works,
 * the inferred labels, the booking link, conflicts with Fix buttons and Save (with the impact review).
 * The same rules the server saves with run here on every change.
 */
export function CalendarBuilder(props: BuilderProps) {
  const { workspaceId, calendar, revisions } = props;
  const router = useRouter();
  const origin = usePublicOrigin(props.brandedOrigin);
  useLiveRefresh(['calendar', 'service', 'resource', 'territory', 'booking_site', 'schedule']);

  const saved = useMemo(() => parseConfig(calendar.config), [calendar.config]);
  const savedDetails = useMemo<Details>(
    () => ({ name: calendar.name, color: calendar.color, description: calendar.description }),
    [calendar.name, calendar.color, calendar.description],
  );
  const fresh: Edit = {
    rev: calendar.revision,
    base: saved,
    draft: saved,
    details: savedDetails,
    baseDetails: savedDetails,
  };
  const [edit, setEdit] = useState<Edit>(fresh);
  // A newer revision (a teammate's save, or our own coming back) replaces the draft unless it has edits.
  const newer = calendar.revision > edit.rev;
  const current = newer && !dirtyOf(edit) ? fresh : edit;
  const stale = newer && dirtyOf(edit);
  const dirty = dirtyOf(current);
  const draft = current.draft;

  const catalogs = useMemo(
    () =>
      buildCatalogs({
        timeZone: calendar.timezone,
        people: props.people,
        departed: draft.team.members.map((m) => m.userId),
        services: props.services,
        resources: props.resources,
        territories: props.territories,
        pipelines: props.pipelines,
        textingReady: props.textingReady,
        paymentAccounts: props.payments.accounts,
        businessDeposit: props.payments.deposit,
      }),
    [
      calendar.timezone,
      props.people,
      draft.team.members,
      props.services,
      props.resources,
      props.territories,
      props.pipelines,
      props.textingReady,
      props.payments.accounts,
      props.payments.deposit,
    ],
  );
  const [now] = useState(() => Date.now());
  const issues = useMemo(() => validateCalendar(draft, catalogs, now), [draft, catalogs, now]);
  const labels = useMemo(() => inferLabels(draft), [draft]);
  const how = useMemo(() => describeCalendar(draft, catalogs), [draft, catalogs]);
  const blocking = hasBlockingIssues(issues);
  const blocksSave = calendar.status === 'active' && blocking;

  const [module, setModule] = useState<ModuleKey>('team');
  const [lastFix, setLastFix] = useState<{ label: string; before: CalendarConfig } | null>(null);
  const [saving, setSaving] = useState(false);
  const [impact, setImpact] = useState<{ impacts: Impact[]; restore: number | null } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [linking, setLinking] = useState(false);

  const setDraft = (next: CalendarConfig) => {
    setEdit({ ...current, draft: next });
    setLastFix(null);
  };
  const patch = (p: ConfigPatch) => {
    try {
      setDraft(applyPatch(draft, p));
    } catch (e) {
      toast.error(refusal(e));
    }
  };
  function applyFix(issue: CalendarIssue, fix: CalendarIssue['fixes'][number]) {
    try {
      const next = applyPatch(draft, fix.patch);
      setEdit({ ...current, draft: next });
      setLastFix({ label: fix.label, before: draft });
    } catch (e) {
      toast.error(refusal(e));
    }
    void issue;
  }

  const personName = (id: string) =>
    props.people.find((p) => p.userId === id)?.fullName ?? 'Someone';
  const resourceName = (id: string) =>
    props.resources.find((r) => r.id === id)?.name ?? 'A resource';

  function afterSave(out: {
    revision: number;
    diff: string[];
    actions: { reassigned: string[]; cancelled: string[] };
  }) {
    const parts = [
      out.diff.length
        ? `Saved as revision ${out.revision}. The link and appointments stay the same.`
        : 'Nothing changed, so nothing new was saved.',
      out.actions.reassigned.length
        ? `${out.actions.reassigned.length} moved to someone else.`
        : '',
      out.actions.cancelled.length
        ? `${out.actions.cancelled.length} cancelled, and the customers are being told.`
        : '',
    ];
    toast.success(parts.filter(Boolean).join(' '));
  }

  function handleSaveError(e: unknown, restore: number | null) {
    if (e instanceof ApiError && e.rule === 'impact_review_required') {
      setImpact({ impacts: (e.details as { impacts: Impact[] }).impacts, restore });
      return;
    }
    if (e instanceof ApiError && e.rule === 'revision_conflict') {
      toast.error(e.message, {
        action: {
          label: 'Reload',
          onClick: () => {
            setEdit(fresh);
            router.refresh();
          },
        },
      });
      return;
    }
    toast.error(errorMessage(e));
  }

  async function save(decisions: Record<string, ImpactDecision> = {}) {
    setSaving(true);
    try {
      const d = current.details;
      const changedDetails = stable(d) !== stable(current.baseDetails);
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/calendar.save', {
          body: {
            workspaceId,
            calendarId: calendar.id,
            baseRevision: current.rev,
            draft: draft as unknown as CalendarSaveBody['draft'],
            impactDecisions: decisions,
            ...(changedDetails ? { name: d.name, color: d.color, description: d.description } : {}),
          },
        }),
      );
      setImpact(null);
      setEdit({ rev: out.revision, base: draft, draft, details: d, baseDetails: d });
      setLastFix(null);
      afterSave(out);
      router.refresh();
    } catch (e) {
      handleSaveError(e, null);
    } finally {
      setSaving(false);
    }
  }

  async function restore(revision: number, decisions: Record<string, ImpactDecision> = {}) {
    if (dirty && !confirm('Restoring drops your unsaved changes. Go ahead?')) return;
    setRestoring(revision);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/calendar.restore_revision', {
          body: {
            workspaceId,
            calendarId: calendar.id,
            revision,
            baseRevision: current.rev,
            impactDecisions: decisions,
          },
        }),
      );
      setImpact(null);
      setEdit(fresh);
      setHistoryOpen(false);
      toast.success(
        `Restored revision ${revision} as revision ${out.revision}. The link and appointments stay the same.`,
      );
      router.refresh();
    } catch (e) {
      handleSaveError(e, revision);
    } finally {
      setRestoring(null);
    }
  }

  async function setStatus(status: CalendarStatus) {
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/calendar.set_status', {
          body: { workspaceId, calendarId: calendar.id, status },
        }),
      );
      toast.success(
        status === 'active'
          ? `${calendar.name} is on.`
          : status === 'paused'
            ? `${calendar.name} is paused. Its link says it isn’t taking bookings; upcoming appointments stay.`
            : status === 'archived'
              ? `${calendar.name} is archived.`
              : `${calendar.name} is back to a draft.`,
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const latest = revisions[0];
  const savedBy = latest?.changedBy?.fullName.split(/\s+/)[0] ?? 'HandsFreeOS';
  const savedAt = latest
    ? dateOf(latest.createdAt, calendar.timezone) === todayIn(calendar.timezone)
      ? `today at ${fmtTime(latest.createdAt, calendar.timezone)}`
      : `on ${fmtMonthDay(dateOf(latest.createdAt, calendar.timezone))}`
    : '';
  const link = calendar.bookingPath ?? calendar.permanentPath;
  const fullLink = `${origin}${link}`;
  const flagged = new Set(
    issues.flatMap((i) => i.fields.map(moduleOfField).filter((m): m is ModuleKey => !!m)),
  );
  const errors = issues.filter((i) => i.severity === 'error').length;
  const base = `/app/w/${workspaceId}/settings`;
  const d = current.details;

  return (
    <div data-testid="calendar-builder" data-calendar-id={calendar.id} className="pb-6">
      <div className="mb-2 flex items-center gap-1 text-xs text-text-3">
        <Link href={base} className="text-accent-text hover:underline">
          Settings
        </Link>
        <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.5} />
        <Link href={`${base}/calendars`} className="text-accent-text hover:underline">
          Calendars
        </Link>
        <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.5} />
        <span className="truncate">{d.name}</span>
      </div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <CalendarDot color={d.color} className="h-3 w-3" />
          <h1
            className="text-[22px] font-semibold leading-tight tracking-[-0.01em] md:text-2xl"
            data-testid="builder-name"
          >
            {d.name}
          </h1>
          <CalendarStatusBadge status={calendar.status} />
          <span className="text-[13px] text-text-3" data-testid="builder-revision">
            Revision {calendar.revision}
            {latest ? ` · saved by ${savedBy} ${savedAt}` : ''}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {calendar.status === 'draft' || calendar.status === 'paused' ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => void setStatus('active')}
              data-testid="calendar-turn-on"
            >
              {calendar.status === 'draft' ? 'Turn on' : 'Resume'}
            </Button>
          ) : null}
          <Button variant="secondary" size="sm" onClick={() => setHistoryOpen(true)}>
            <History className="h-4 w-4" strokeWidth={1.5} />
            History
          </Button>
          <a
            href={link}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center gap-2 rounded-control border border-border-strong bg-card px-2.5 text-[13px] font-medium shadow-1 hover:bg-card-2"
          >
            <Eye className="h-4 w-4" strokeWidth={1.5} />
            Preview booking page
          </a>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                aria-label="More for this calendar"
                data-testid="builder-menu"
              >
                More
                <ChevronDown className="h-4 w-4" strokeWidth={1.5} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={() => setRenaming(true)}>Rename…</DropdownMenuItem>
              {calendar.bookingPath ? (
                <DropdownMenuItem onSelect={() => setLinking(true)}>Change link…</DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              {calendar.status === 'active' ? (
                <DropdownMenuItem onSelect={() => void setStatus('paused')}>Pause</DropdownMenuItem>
              ) : null}
              {calendar.status !== 'draft' && calendar.status !== 'archived' ? (
                <DropdownMenuItem onSelect={() => void setStatus('draft')}>
                  Back to draft
                </DropdownMenuItem>
              ) : null}
              {calendar.status === 'archived' ? (
                <DropdownMenuItem onSelect={() => void setStatus('draft')}>
                  Bring back as a draft
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  danger
                  onSelect={() => {
                    if (
                      confirm(
                        `Archive ${calendar.name}? It stops taking bookings and leaves the calendar. Its history stays.`,
                      )
                    )
                      void setStatus('archived');
                  }}
                >
                  Archive
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {stale ? (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-menu bg-warning-soft px-3.5 py-2.5 text-[13px] text-warning-text">
          <AlertTriangle className="h-4 w-4 flex-none" strokeWidth={1.75} />
          <span className="flex-1">
            Someone saved this calendar while you were editing. Saving now would be refused.
          </span>
          <Button variant="secondary" size="sm" onClick={() => setEdit(fresh)}>
            Load their version
          </Button>
        </div>
      ) : null}

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[208px_minmax(0,1fr)] xl:grid-cols-[208px_minmax(0,1fr)_300px] 2xl:grid-cols-[232px_minmax(0,1fr)_344px]">
        <div className="lg:hidden">
          <Select
            aria-label="Settings on this calendar"
            value={module}
            onChange={(e) => setModule(e.target.value as ModuleKey)}
          >
            {MODULES.map((m) => (
              <option key={m.key} value={m.key}>
                {m.name}
                {flagged.has(m.key) ? ' •' : ''}
              </option>
            ))}
          </Select>
        </div>
        <Card className="hidden p-2 lg:block" data-testid="builder-modules">
          <nav aria-label="Settings on this calendar">
            <div className="px-2.5 pb-1.5 pt-2 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
              Settings on this calendar
            </div>
            {MODULES.map((m) => {
              const Icon = ICONS[m.key];
              const active = module === m.key;
              return (
                <button
                  key={m.key}
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  data-testid={`module-${m.key}`}
                  onClick={() => setModule(m.key)}
                  className={cn(
                    'flex min-h-[42px] w-full items-center gap-2.5 rounded-control px-2.5 py-1.5 text-left transition-colors',
                    active
                      ? 'bg-accent-soft text-accent-text'
                      : 'text-text-2 hover:bg-card-2 hover:text-text',
                  )}
                >
                  <Icon className="h-4 w-4 flex-none" strokeWidth={1.5} />
                  <span className="min-w-0 flex-1">
                    <span className="block whitespace-nowrap text-[13.5px] font-medium leading-tight">
                      {m.name}
                    </span>
                    <span className="block truncate text-[11.5px] leading-tight text-text-3">
                      {moduleSummary(m.key, draft, catalogs)}
                    </span>
                  </span>
                  {flagged.has(m.key) ? (
                    <span
                      className={cn(
                        'h-2 w-2 flex-none rounded-full',
                        issues.some(
                          (i) =>
                            i.severity === 'error' &&
                            i.fields.some((f) => moduleOfField(f) === m.key),
                        )
                          ? 'bg-danger'
                          : 'bg-warning',
                      )}
                      title="Something to check"
                    />
                  ) : null}
                </button>
              );
            })}
          </nav>
        </Card>

        <Card className="@container p-5 md:p-6" data-testid={`module-panel-${module}`}>
          <ModuleForm
            module={module}
            workspaceId={workspaceId}
            draft={draft}
            patch={patch}
            catalogs={catalogs}
            people={props.people}
            services={props.services}
            resources={props.resources}
            territories={props.territories}
            pipelines={props.pipelines}
            calendarId={calendar.id}
            calendarName={calendar.name}
            payments={props.payments}
          />
        </Card>

        <aside className="flex flex-col gap-3 lg:col-span-2 xl:col-span-1">
          <Card className="px-[18px] py-4" data-testid="builder-how">
            <h3 className="mb-2.5 text-[15px] font-semibold">How this calendar works</h3>
            <ul className="flex flex-col gap-1.5">
              {how.map((s) => (
                <li key={s} className="flex items-start gap-2.5 text-[13px]">
                  <Check className="mt-0.5 h-4 w-4 flex-none text-accent-text" strokeWidth={1.75} />
                  <span>{s}</span>
                </li>
              ))}
            </ul>
          </Card>
          <Card className="px-[18px] py-4">
            <h3 className="mb-2.5 text-[15px] font-semibold">Labels</h3>
            <LabelChips tags={labels.tags} testId="builder-labels" />
            <p className="mt-2 text-[12.5px] text-text-3">
              Worked out from the settings. They describe the calendar and never limit what you can
              change.
            </p>
          </Card>
          <Card className="px-[18px] py-4" data-testid="builder-link">
            <h3 className="mb-2.5 text-[15px] font-semibold">Booking link</h3>
            <div
              className="break-all rounded-control border border-border bg-card-2 px-3 py-2 font-mono text-xs leading-normal"
              data-testid="booking-link"
            >
              {fullLink.replace(/^https?:\/\//, '')}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void copyText(fullLink, 'Link copied')}
              >
                <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />
                Copy
              </Button>
              <a
                href={link}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 items-center gap-2 rounded-control px-2.5 text-[13px] font-medium text-text-2 hover:bg-card-2 hover:text-text"
              >
                <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.5} />
                Open
              </a>
            </div>
            <p className="mt-1.5 text-[12.5px] text-text-3">
              {calendar.bookingPath
                ? 'It stays the same when you rename the calendar or change how it works. Changing the link keeps the old one working.'
                : 'This link never changes. Set up the booking site for a named one.'}
            </p>
            {!calendar.bookingPath ? (
              <Link
                href={`${base}/calendars/booking-site`}
                className="mt-1 inline-block text-[13px] font-medium text-accent-text hover:underline"
              >
                Set up the booking site
              </Link>
            ) : null}
            <label className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3 text-[13px] font-medium">
              Customers can book it online
              <Switch
                checked={draft.public}
                label="Customers can book it online"
                onChange={(v) => patch({ public: v })}
                testId="builder-public"
              />
            </label>
          </Card>
          <Card className="px-[18px] py-4" data-testid="builder-issues">
            <div className="mb-2.5 flex items-center justify-between">
              <h3 className="text-[15px] font-semibold">Things to check</h3>
              <Badge variant={issues.length ? (errors ? 'danger' : 'pending') : 'ok'}>
                {issues.length
                  ? `${issues.length} ${issues.length === 1 ? 'item' : 'items'}`
                  : 'All clear'}
              </Badge>
            </div>
            <div className="flex flex-col gap-2">
              {lastFix ? (
                <div className="flex items-start gap-2.5 rounded-menu border border-[color-mix(in_oklab,var(--success)_30%,var(--border))] bg-[color-mix(in_oklab,var(--success-soft)_60%,var(--card))] px-3.5 py-3">
                  <CheckCircle2
                    className="mt-0.5 h-4 w-4 flex-none text-success-text"
                    strokeWidth={1.75}
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-[13px] font-medium">Done: {lastFix.label}.</span>
                    <span className="mt-0.5 text-xs text-text-2">
                      Nothing else changed. Save when you’re ready.
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEdit({ ...current, draft: lastFix.before });
                      setLastFix(null);
                    }}
                  >
                    Undo
                  </Button>
                </div>
              ) : null}
              {issues.map((issue) => {
                const error = issue.severity === 'error';
                return (
                  <div
                    key={`${issue.code}-${issue.message}`}
                    data-testid={`issue-${issue.code}`}
                    className={cn(
                      'flex items-start gap-2.5 rounded-menu border px-3.5 py-3',
                      error
                        ? 'border-[color-mix(in_oklab,var(--danger)_35%,var(--border))] bg-[color-mix(in_oklab,var(--danger-soft)_60%,var(--card))]'
                        : 'border-[color-mix(in_oklab,var(--warning)_35%,var(--border))] bg-[color-mix(in_oklab,var(--warning-soft)_60%,var(--card))]',
                    )}
                  >
                    {error ? (
                      <AlertCircle
                        className="mt-0.5 h-4 w-4 flex-none text-danger-text"
                        strokeWidth={1.75}
                      />
                    ) : (
                      <AlertTriangle
                        className="mt-0.5 h-4 w-4 flex-none text-warning-text"
                        strokeWidth={1.75}
                      />
                    )}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-[13px] font-medium">{issue.message}</span>
                      <span
                        className={cn(
                          'mt-0.5 text-xs font-medium',
                          error ? 'text-danger-text' : 'text-warning-text',
                        )}
                      >
                        {error
                          ? calendar.status === 'active'
                            ? 'Blocks saving while active'
                            : 'Blocks turning it on'
                          : 'Doesn’t block saving'}
                      </span>
                      {issue.fixes.length ? (
                        <span className="mt-2.5 flex flex-wrap items-center gap-1.5">
                          <span className="mr-0.5 text-xs font-semibold text-text-3">Fix:</span>
                          {issue.fixes.map((fix) => (
                            <Button
                              key={fix.id}
                              variant="secondary"
                              size="sm"
                              className="h-7 text-[12.5px]"
                              data-testid={`fix-${issue.code}-${fix.id}`}
                              onClick={() => applyFix(issue, fix)}
                            >
                              {fix.label}
                            </Button>
                          ))}
                          {/* The other way out of this one is a page to visit, not a settings patch. */}
                          {issue.code === 'payment_unavailable' ? (
                            <ButtonLink
                              href={`/app/w/${workspaceId}/settings/payments`}
                              size="sm"
                              className="h-7 text-[12.5px]"
                              data-testid="fix-payment_unavailable-connect_account"
                            >
                              Connect an account
                            </ButtonLink>
                          ) : null}
                        </span>
                      ) : null}
                    </span>
                  </div>
                );
              })}
              {!issues.length && !lastFix ? (
                <div className="flex items-center gap-2.5 rounded-menu border border-[color-mix(in_oklab,var(--success)_30%,var(--border))] bg-[color-mix(in_oklab,var(--success-soft)_60%,var(--card))] px-3.5 py-3 text-[13px]">
                  <CheckCircle2
                    className="h-4 w-4 flex-none text-success-text"
                    strokeWidth={1.75}
                  />
                  Nothing to fix. Ready to save.
                </div>
              ) : null}
            </div>
          </Card>
          <Card className="flex items-center gap-2.5 py-3 pl-[18px] pr-3">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-[13px] font-medium" data-testid="builder-save-note">
                {blocksSave
                  ? 'Fix the red item to save'
                  : dirty
                    ? 'Unsaved changes'
                    : `All changes saved · revision ${current.rev}`}
              </span>
              <button
                type="button"
                onClick={() => setHistoryOpen(true)}
                className="self-start text-xs text-accent-text hover:underline"
              >
                See history
              </button>
            </span>
            <Button
              onClick={() => void save()}
              loading={saving}
              disabled={!dirty || blocksSave}
              data-testid="builder-save"
            >
              Save
            </Button>
          </Card>
        </aside>
      </div>

      {impact ? (
        <ImpactDialog
          open
          impacts={impact.impacts}
          calendarName={d.name}
          personName={personName}
          resourceName={resourceName}
          saving={saving || restoring !== null}
          onBack={() => setImpact(null)}
          onSave={(decisions) =>
            impact.restore !== null ? void restore(impact.restore, decisions) : void save(decisions)
          }
        />
      ) : null}
      <HistorySheet
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        calendarName={d.name}
        revisions={revisions}
        currentRevision={calendar.revision}
        timeZone={calendar.timezone}
        restoring={restoring}
        onRestore={(r) => void restore(r)}
      />
      <RenameDialog
        open={renaming}
        onOpenChange={setRenaming}
        details={d}
        onApply={(details) => {
          setEdit({ ...current, details });
          setRenaming(false);
        }}
      />
      {calendar.bookingPath ? (
        <SlugDialog
          open={linking}
          onOpenChange={setLinking}
          workspaceId={workspaceId}
          calendarId={calendar.id}
          slug={calendar.slug}
          prefix={`${origin.replace(/^https?:\/\//, '')}${calendar.bookingPath.slice(0, calendar.bookingPath.lastIndexOf('/') + 1)}`}
        />
      ) : null}
    </div>
  );
}

function RenameDialog({
  open,
  onOpenChange,
  details,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  details: Details;
  onApply: (details: Details) => void;
}) {
  const [form, setForm] = useState(details);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) setForm(details);
        onOpenChange(o);
      }}
    >
      <DialogContent title="Name and color" description="Saved with the rest of your changes.">
        <div className="mt-4 flex flex-col gap-3.5">
          <Field label="Name" htmlFor="rename-name">
            <Input
              id="rename-name"
              value={form.name}
              maxLength={120}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field
            label="Description (optional)"
            htmlFor="rename-description"
            hint="What it’s for. Shown on the booking page, and your AI teammate reads it to pick this calendar."
          >
            <Textarea
              id="rename-description"
              value={form.description ?? ''}
              maxLength={2000}
              onChange={(e) => setForm({ ...form, description: e.target.value || null })}
            />
          </Field>
          <div>
            <div className="mb-1.5 text-[13px] font-medium">Color</div>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Color">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={form.color.toLowerCase() === c}
                  aria-label={c}
                  onClick={() => setForm({ ...form, color: c })}
                  className={cn(
                    'h-7 w-7 rounded-full ring-offset-2 ring-offset-card',
                    form.color.toLowerCase() === c && 'ring-2 ring-accent',
                  )}
                  style={{ background: c }}
                />
              ))}
            </div>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!form.name.trim()}
            onClick={() => onApply({ ...form, name: form.name.trim() })}
          >
            Apply
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SlugDialog({
  open,
  onOpenChange,
  workspaceId,
  calendarId,
  slug,
  prefix,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  calendarId: string;
  slug: string;
  prefix: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState(slug);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/calendar.set_slug', {
          body: { workspaceId, calendarId, slug: value.trim().toLowerCase() },
        }),
      );
      toast.success('Link changed. The old link keeps working.');
      onOpenChange(false);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) setValue(slug);
        onOpenChange(o);
      }}
    >
      <DialogContent
        title="Change the link"
        description="The old link keeps working and sends people here."
      >
        <div className="mt-4">
          <Field label="Link name" htmlFor="slug" hint="Letters, numbers and dashes.">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-mono text-xs text-text-3">{prefix}</span>
              <Input
                id="slug"
                value={value}
                maxLength={64}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
          </Field>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!value.trim() || value === slug}
            onClick={() => void save()}
          >
            Change link
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
