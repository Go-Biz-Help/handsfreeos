'use client';
import { AI_SETUP_WORDS, type TeammateCatalogs } from '@hfos/core';
import {
  AlertTriangle,
  BookOpen,
  CalendarCheck,
  ChevronRight,
  ClipboardCheck,
  Clock,
  Gauge,
  Hand,
  History as HistoryIcon,
  IdCard,
  MessagesSquare,
  Puzzle,
  Repeat,
  Reply,
  ShieldCheck,
  Sparkles,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { teammateActions } from '@/lib/ai-team/actions';
import {
  describeTeammate,
  MODULE_GROUPS,
  moduleOfField,
  MODULES,
  moduleSummary,
  teammateAddonsHere,
  plural,
  progressView,
  savedLine,
  type ModuleKey,
} from '@/lib/ai-team/describe';
import type {
  TeammateProgress,
  TeammateRevision,
  TeammateStatus,
  TeammateSummary,
} from '@/lib/ai-team/types';
import { useTeammateDraft, type TeammateDraftAdapter } from '@/lib/ai-team/use-draft';
import { errorMessage } from '@/lib/api/client';
import { dateOf, fmtMonthDay } from '@/lib/calendar/time';
import { cn } from '@/lib/utils';
import { useWide } from '@/lib/workflows/use-wide';
import { useWorkspaceShell } from '@/components/shell/workspace-shell';
import { FullScreen } from './full-screen';
import { SaveIndicator, TeammateHeader, TeammateSubnav } from './header';
import { TeammateHistory } from './history';
import { ModuleForm, type ModuleProps } from './modules';
import { Note } from './parts';
import {
  HowCard,
  IssueList,
  IssuesHeading,
  PhoneSummary,
  SaveCard,
  StatusCard,
  StatusConfirm,
} from './rail';
import { TestConsole } from './test-console';

const ICONS: Readonly<Record<ModuleKey, LucideIcon>> = {
  identity: IdCard,
  channels: MessagesSquare,
  respond: Reply,
  answer: BookOpen,
  qualify: ClipboardCheck,
  book: CalendarCheck,
  followUp: Repeat,
  hours: Clock,
  autonomy: ShieldCheck,
  limits: Gauge,
  handOff: Hand,
  addons: Puzzle,
};

const MODULE_NAMES = Object.fromEntries(MODULES.map((m) => [m.key, m.name])) as Readonly<
  Record<ModuleKey, string>
>;

function statusToast(from: TeammateStatus, to: TeammateStatus, name: string): string {
  if (to === 'off') return `${name} is off. New messages go to the team.`;
  if (to === 'automatic')
    return from === 'off' ? `${name} is on and works on its own.` : `${name} works on its own now.`;
  return from === 'automatic'
    ? `${name} is back in training wheels. Every message waits for an OK again.`
    : `${name} is on, with training wheels.`;
}

export interface TeammateBuilderProps {
  workspaceId: string;
  workspaceName: string;
  teammate: TeammateSummary;
  progress: TeammateProgress | null;
  revisions: readonly TeammateRevision[];
  catalogs: TeammateCatalogs;
  /** ai_team.manage: owners and admins change it; members see how it's set up. */
  canManage: boolean;
}

/**
 * The AI teammate builder: the module list, the chosen module's settings, and a right rail with its status
 * and training-wheels progress, how it works (with its labels), things to check with Fix buttons, and
 * Undo. The rules the server saves with run here on every change, and changes save on their own, with
 * Saved / Saving… at the top right. On phones the rail folds into a card at the top, and each module opens
 * full screen.
 */
export function TeammateBuilder(props: TeammateBuilderProps) {
  const { workspaceId, workspaceName, teammate, progress, revisions, catalogs, canManage } = props;
  const router = useRouter();
  const wide = useWide();
  const actions = useMemo(() => teammateActions(workspaceId), [workspaceId]);
  const adapter = useMemo<TeammateDraftAdapter>(
    () => ({
      save: (baseRevision, config) =>
        actions.saveConfig({ teammateId: teammate.id, baseRevision, config }),
      load: async () => {
        const got = await actions.load();
        if (!got.teammate) throw new Error('The AI teammate was removed.');
        return { revision: got.teammate.revision, config: got.teammate.config };
      },
    }),
    [actions, teammate.id],
  );
  const draft = useTeammateDraft({
    revision: teammate.revision,
    config: teammate.config,
    catalogs,
    readOnly: !canManage,
    adapter,
    // The new revision and its History row.
    onSaved: () => router.refresh(),
  });
  const config = draft.config;
  const name = config.identity.name;
  const status = teammate.status;
  const tz = catalogs.timeZone;
  const lines = useMemo(() => describeTeammate(config, catalogs), [config, catalogs]);
  const view = progressView(progress, config.autonomy.approvalsNeeded);
  const savedView = progressView(progress, draft.base.autonomy.approvalsNeeded);

  // Round seven: Add-ons is listed only while an add-on that offers the teammate something runs here.
  const running = useWorkspaceShell().addons;
  const modules = useMemo(
    () => MODULES.filter((m) => m.key !== 'addons' || teammateAddonsHere(running).length > 0),
    [running],
  );
  // The side menu's groups, holding only the modules listed here.
  const groups = useMemo(
    () =>
      MODULE_GROUPS.map((g) => ({
        ...g,
        modules: g.modules.filter((key) => modules.some((m) => m.key === key)),
      })).filter((g) => g.modules.length > 0),
    [modules],
  );
  const [module, setModule] = useState<ModuleKey>('identity');
  const [phoneModule, setPhoneModule] = useState<ModuleKey | null>(null);
  const [checksOpen, setChecksOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [ask, setAsk] = useState<'automatic' | 'training' | null>(null);

  const flagged = useMemo(() => {
    const out = new Map<ModuleKey, 'error' | 'warning'>();
    for (const issue of draft.issues)
      for (const f of issue.fields) {
        const key = moduleOfField(f);
        if (key && out.get(key) !== 'error') out.set(key, issue.severity);
      }
    return out;
  }, [draft.issues]);

  const latest = revisions[0];
  const automaticNote = teammate.automaticSince
    ? progress?.automaticVia === 'override'
      ? `Switched to automatic on ${fmtMonthDay(dateOf(teammate.automaticSince, tz))}, before the ${savedView.needed} approvals.`
      : `Automatic since ${fmtMonthDay(dateOf(teammate.automaticSince, tz))}, after ${savedView.needed} approvals.`
    : null;

  async function applyStatus(next: TeammateStatus) {
    setStatusBusy(true);
    try {
      // Turning it on checks the saved settings, so a change still waiting saves first.
      await draft.flush();
      await actions.setStatus({ teammateId: teammate.id, status: next });
      toast.success(statusToast(status, next, name));
      setAsk(null);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setStatusBusy(false);
    }
  }

  /** "Switch to automatic now" and "Back to training" ask first; the rest happen at once. */
  function requestStatus(next: TeammateStatus) {
    if (next === status) return;
    if (next === 'automatic' && status === 'training') return setAsk('automatic');
    if (next === 'training' && status === 'automatic') return setAsk('training');
    void applyStatus(next);
  }

  async function restore(revision: number) {
    setRestoring(revision);
    try {
      const settled = await draft.flush();
      if (!settled.clean && !confirm('Restoring drops your unsaved changes. Go ahead?')) return;
      const out = await actions.restore({
        teammateId: teammate.id,
        revision,
        baseRevision: settled.revision,
      });
      draft.discard();
      setHistoryOpen(false);
      toast.success(
        `Restored revision ${revision} as revision ${out.revision}. Training progress stays the same.`,
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRestoring(null);
    }
  }

  const formProps: ModuleProps = {
    workspaceId,
    workspaceName,
    draft: config,
    patch: draft.patch,
    catalogs,
    progress,
    readOnly: !canManage,
    flush: draft.flush,
  };
  const saveIndicator = canManage ? (
    <SaveIndicator state={draft.saveState} onRetry={() => void draft.save()} />
  ) : null;
  const openTest = canManage ? () => setTestOpen(true) : undefined;
  const statusCard = (bare: boolean) => (
    <StatusCard
      bare={bare}
      name={name}
      status={status}
      progress={savedView}
      blocking={draft.blocking}
      readOnly={!canManage}
      busy={statusBusy}
      automaticNote={automaticNote}
      onStatus={requestStatus}
    />
  );
  const issueList = (
    <IssueList
      workspaceId={workspaceId}
      issues={draft.issues}
      status={status}
      lastFix={draft.lastFix}
      readOnly={!canManage}
      onFix={draft.applyFix}
      onUndoFix={draft.undo}
    />
  );
  const menu = canManage ? (
    <>
      <DropdownMenuItem asChild>
        <Link href={`/app/w/${workspaceId}/settings/website-chat`}>Website chat settings</Link>
      </DropdownMenuItem>
      <DropdownMenuItem asChild>
        <Link href={`/app/w/${workspaceId}/knowledge`}>Knowledge</Link>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      {status === 'off' ? (
        <DropdownMenuItem disabled={draft.blocking} onSelect={() => requestStatus('training')}>
          Turn on, with training wheels
        </DropdownMenuItem>
      ) : (
        <DropdownMenuItem danger onSelect={() => requestStatus('off')}>
          Turn off {name}
        </DropdownMenuItem>
      )}
    </>
  ) : null;
  const phoneTitle = phoneModule ? MODULE_NAMES[phoneModule] : '';
  // Quick setup again: it starts from what's saved and shows what will change before saving (the owner's 55A).
  const setupHref = `/app/w/${workspaceId}/ai-team/setup`;

  return (
    <div data-testid="teammate-builder" data-teammate-id={teammate.id} className="pb-20 lg:pb-6">
      <TeammateHeader
        className="hidden lg:flex"
        name={name}
        status={status}
        saved={savedLine(teammate.revision, latest, tz)}
        saveState={saveIndicator}
        onTest={openTest}
        onHistory={() => setHistoryOpen(true)}
        menu={menu}
      />
      <PhoneSummary
        name={name}
        status={status}
        saved={savedLine(teammate.revision, latest, tz, true)}
        progress={savedView}
        issues={draft.issues}
        blocking={draft.blocking}
        readOnly={!canManage}
        busy={statusBusy}
        onStatus={requestStatus}
        onTest={openTest}
        onChecks={() => setChecksOpen(true)}
      />

      {draft.stale ? (
        <div
          className="mb-4 mt-3 flex flex-wrap items-center gap-3 rounded-menu bg-warning-soft px-3.5 py-2.5 text-[13px] text-warning-text lg:mt-0"
          data-testid="teammate-stale"
        >
          <AlertTriangle className="h-4 w-4 flex-none" strokeWidth={1.75} />
          <span className="flex-1">
            Someone saved {name}’s settings while you were editing. Saving now would be refused.
          </span>
          <Button variant="secondary" size="sm" onClick={() => void draft.loadTheirs()}>
            Load their version
          </Button>
        </div>
      ) : null}
      {!canManage ? (
        <Note className="mb-4 mt-3 lg:mt-0">
          Only owners and admins can change {name}. You can see how it’s set up.
        </Note>
      ) : null}

      <TeammateSubnav
        workspaceId={workspaceId}
        className="max-lg:-mx-4 max-lg:mb-0 max-lg:bg-card max-lg:px-2"
      />

      {/* Phones: the modules are a list in their groups, each opening full screen. */}
      <div className="-mx-4 lg:hidden" data-testid="teammate-phone-modules">
        {groups.map((g) => (
          <div key={g.key} role="group" aria-labelledby={`phone-module-group-${g.key}`}>
            <div
              id={`phone-module-group-${g.key}`}
              className="px-4 pb-1.5 pt-4 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3"
            >
              {g.name}
            </div>
            <div className="border-t border-border">
              {g.modules.map((key) => {
                const Icon = ICONS[key];
                const flag = flagged.get(key);
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setPhoneModule(key)}
                    data-testid={`phone-module-${key}`}
                    className="flex min-h-[60px] w-full items-center gap-3 border-b border-border bg-card px-4 py-2 text-left active:bg-card-2"
                  >
                    <span className="inline-flex h-6 w-6 flex-none items-center justify-center rounded-[7px] bg-card-2 text-text-2">
                      <Icon className="h-[13px] w-[13px]" strokeWidth={1.75} />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-[15px] font-medium">{MODULE_NAMES[key]}</span>
                      <span className="truncate text-xs text-text-3">
                        {moduleSummary(key, config, catalogs)}
                      </span>
                    </span>
                    {flag ? (
                      <span
                        className={cn(
                          'h-2 w-2 flex-none rounded-full',
                          flag === 'error' ? 'bg-danger' : 'bg-warning',
                        )}
                      >
                        <span className="sr-only">Something to check</span>
                      </span>
                    ) : null}
                    <ChevronRight className="h-4 w-4 flex-none text-text-3" strokeWidth={1.75} />
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {/* History lives in the rail's Save card on wide screens; phones reach it here. */}
        <button
          type="button"
          onClick={() => setHistoryOpen(true)}
          data-testid="phone-history"
          className="mt-4 flex min-h-[60px] w-full items-center gap-3 border-y border-border bg-card px-4 py-2 text-left active:bg-card-2"
        >
          <span className="inline-flex h-6 w-6 flex-none items-center justify-center rounded-[7px] bg-card-2 text-text-2">
            <HistoryIcon className="h-[13px] w-[13px]" strokeWidth={1.75} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-[15px] font-medium">History</span>
            <span className="truncate text-xs text-text-3">
              {plural(revisions.length, 'revision', 'revisions')} · see or restore an older version
            </span>
          </span>
          <ChevronRight className="h-4 w-4 flex-none text-text-3" strokeWidth={1.75} />
        </button>
        {canManage ? (
          <Link
            href={setupHref}
            data-testid="phone-run-quick-setup"
            className="flex min-h-[60px] w-full items-center gap-3 border-b border-border bg-card px-4 py-2 text-left active:bg-card-2"
          >
            <span className="inline-flex h-6 w-6 flex-none items-center justify-center rounded-[7px] bg-accent-soft text-accent-text">
              <Sparkles className="h-[13px] w-[13px]" strokeWidth={1.75} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-[15px] font-medium">{AI_SETUP_WORDS.runAgain}</span>
              <span className="truncate text-xs text-text-3">{AI_SETUP_WORDS.runAgainDetail}</span>
            </span>
            <ChevronRight className="h-4 w-4 flex-none text-text-3" strokeWidth={1.75} />
          </Link>
        ) : null}
      </div>

      {/* Wide screens: the module list, the module, and the rail. */}
      {wide ? (
        <div className="hidden items-start gap-5 lg:grid lg:grid-cols-[208px_minmax(0,1fr)] xl:grid-cols-[208px_minmax(0,1fr)_300px] 2xl:grid-cols-[232px_minmax(0,1fr)_344px]">
          <Card className="p-2" data-testid="teammate-modules">
            <nav aria-label={`${name}’s settings`}>
              {groups.map((g, i) => (
                <div
                  key={g.key}
                  role="group"
                  aria-labelledby={`module-group-${g.key}`}
                  data-testid={`module-group-${g.key}`}
                >
                  <div
                    id={`module-group-${g.key}`}
                    className={cn(
                      'px-2.5 pb-1.5 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3',
                      i ? 'pt-3' : 'pt-2',
                    )}
                  >
                    {g.name}
                  </div>
                  {g.modules.map((key) => {
                    const Icon = ICONS[key];
                    const active = module === key;
                    const flag = flagged.get(key);
                    return (
                      <button
                        key={key}
                        type="button"
                        aria-current={active ? 'page' : undefined}
                        data-testid={`module-${key}`}
                        onClick={() => setModule(key)}
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
                            {MODULE_NAMES[key]}
                          </span>
                          <span
                            className="block truncate text-[11.5px] leading-tight text-text-3"
                            data-testid={`module-summary-${key}`}
                          >
                            {moduleSummary(key, config, catalogs)}
                          </span>
                        </span>
                        {flag ? (
                          <span
                            title="Something to check"
                            className={cn(
                              'h-2 w-2 flex-none rounded-full',
                              flag === 'error' ? 'bg-danger' : 'bg-warning',
                            )}
                          >
                            <span className="sr-only">Something to check</span>
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ))}
            </nav>
            {canManage ? (
              <>
                <div className="mx-2.5 my-2 border-t border-border" />
                <Link
                  href={setupHref}
                  data-testid="ai-team-run-quick-setup"
                  title={AI_SETUP_WORDS.runAgainDetail}
                  className="flex min-h-[40px] w-full items-center gap-2.5 rounded-control px-2.5 py-1.5 text-[13.5px] font-medium text-accent-text transition-colors hover:bg-accent-soft"
                >
                  <Sparkles className="h-4 w-4 flex-none" strokeWidth={1.5} />
                  {AI_SETUP_WORDS.runAgain}
                </Link>
              </>
            ) : null}
          </Card>

          <Card
            className="@container min-w-0 px-5 py-5 md:px-6 md:py-[22px]"
            data-testid={`module-panel-${module}`}
          >
            <ModuleForm module={module} {...formProps} />
          </Card>

          <aside className="flex flex-col gap-3 lg:col-span-2 xl:col-span-1">
            {statusCard(false)}
            <HowCard name={name} tags={draft.labels.tags} lines={lines} />
            <Card className="px-[18px] py-4" data-testid="teammate-issues">
              <IssuesHeading issues={draft.issues} />
              {issueList}
            </Card>
            <SaveCard
              saveState={draft.saveState}
              revision={draft.revision}
              readOnly={!canManage}
              canUndo={draft.canUndo}
              undoLabel={draft.undoLabel}
              onUndo={draft.undo}
              onHistory={() => setHistoryOpen(true)}
            />
          </aside>
        </div>
      ) : null}

      <FullScreen
        open={!!phoneModule && !wide}
        onOpenChange={(o) => !o && setPhoneModule(null)}
        title={phoneTitle}
        testId="teammate-module-screen"
        action={
          canManage ? (
            <span className="flex items-center gap-1">
              {saveIndicator}
              {draft.canUndo ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={draft.undo}
                  aria-label={draft.undoLabel ? `Undo: ${draft.undoLabel}` : 'Undo'}
                >
                  <Undo2 className="h-4 w-4" strokeWidth={1.75} />
                </Button>
              ) : null}
            </span>
          ) : null
        }
      >
        {phoneModule ? (
          <div className="@container px-4 pb-24 pt-4">
            <ModuleForm module={phoneModule} {...formProps} />
          </div>
        ) : null}
      </FullScreen>

      <Sheet open={checksOpen && !wide} onOpenChange={setChecksOpen}>
        <SheetContent
          title={`${name}’s status`}
          description="Its status, anything to check, and what its settings add up to."
        >
          <div className="flex flex-col gap-5" data-testid="teammate-phone-sheet">
            {statusCard(true)}
            <div>
              <IssuesHeading issues={draft.issues} />
              {issueList}
            </div>
            <HowCard bare name={name} tags={draft.labels.tags} lines={lines} />
          </div>
        </SheetContent>
      </Sheet>

      <StatusConfirm
        ask={ask}
        name={name}
        needed={view.needed}
        busy={statusBusy}
        onCancel={() => setAsk(null)}
        onConfirm={() => {
          if (ask) void applyStatus(ask);
        }}
      />
      <TeammateHistory
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        name={name}
        revisions={revisions}
        currentRevision={teammate.revision}
        timeZone={tz}
        restoring={restoring}
        onRestore={(r) => void restore(r)}
        canRestore={canManage}
        progress={progress ? savedView : null}
        status={status}
        trainingStartedAt={teammate.trainingStartedAt}
      />
      {canManage ? (
        <TestConsole
          open={testOpen}
          onOpenChange={setTestOpen}
          workspaceId={workspaceId}
          name={name}
          timeZone={tz}
          config={config}
          unsaved={draft.dirty}
        />
      ) : null}
    </div>
  );
}
