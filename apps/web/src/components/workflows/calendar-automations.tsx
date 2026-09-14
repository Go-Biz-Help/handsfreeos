'use client';
import {
  allSteps,
  parseDefinition,
  type CalendarConfig,
  type WorkflowDefinition,
} from '@hfos/core';
import { AlertTriangle, ChevronDown, Info, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { WorkflowSummary } from '@/lib/api/types';
import { useLiveVersion } from '@/lib/realtime/live-provider';
import { KindTile, recipeIcon, workflowIcon, WorkflowStatusBadge } from './chips';
import { StatusChangeDialog, type StatusChange } from './publish';

interface Row {
  readonly w: WorkflowSummary;
  /** It texts or emails before the appointment starts, as calendar reminders do. */
  readonly reminds: boolean;
}

/** A workflow that messages the customer before their appointment: what Notifications' reminders already do. */
export function sendsReminder(def: WorkflowDefinition): boolean {
  const locs = allSteps(def);
  const messages = locs.some(
    ({ step }) =>
      step.type === 'action' && (step.action === 'send_text' || step.action === 'send_email'),
  );
  if (!messages) return false;
  const beforeStart = (anchor: string, direction: string) =>
    anchor === 'appointment.starts_at' && direction === 'before';
  const t = def.trigger;
  if (t.kind === 'date' && beforeStart(t.anchor, t.offset.direction)) return true;
  return locs.some(
    ({ step }) =>
      step.type === 'wait' &&
      step.until.kind === 'date_field' &&
      beforeStart(step.until.anchor, step.until.offset.direction),
  );
}

const RECIPES = [
  { key: 'appointment_follow_up_review', label: 'Follow-up and review request' },
  { key: 'no_show_rebook', label: 'No-show rebook' },
] as const;

/**
 * The calendar builder's Automations: the workflows whose trigger names this calendar (or every calendar),
 * each with an on/off switch that pauses or resumes it, and "Add automation", which opens a recipe with this
 * calendar filled in. Workflows the calendar listed before M6 (`automations.workflowIds`) still show; nothing
 * writes that list any more.
 */
export function CalendarAutomations({
  workspaceId,
  calendarId,
  calendarName,
  notifications,
  legacyIds,
}: {
  workspaceId: string;
  calendarId: string;
  calendarName: string;
  notifications: CalendarConfig['notifications'];
  legacyIds: readonly string[];
}) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [target, setTarget] = useState<WorkflowSummary | null>(null);
  const [change, setChange] = useState<StatusChange | null>(null);
  const changes = useLiveVersion(['workflow']);
  const legacy = legacyIds.join(',');
  const remindersOn =
    notifications.reminders.length > 0 &&
    (notifications.reminderChannels.text || notifications.reminderChannels.email);

  const load = useCallback(async () => {
    try {
      const older = legacy ? legacy.split(',') : [];
      const [mine, all] = await Promise.all([
        apiBrowser().POST('/v1/queries/workflow.list', { body: { workspaceId, calendarId } }),
        older.length
          ? apiBrowser().POST('/v1/queries/workflow.list', { body: { workspaceId } })
          : Promise.resolve(null),
      ]);
      const list = unwrap(mine).items;
      const listed = all
        ? unwrap(all).items.filter((w) => older.includes(w.id) && !list.some((x) => x.id === w.id))
        : [];
      const flows = [...list, ...listed];
      const defs = await Promise.all(
        flows.map(async (w) => {
          try {
            const got = unwrap(
              await apiBrowser().POST('/v1/queries/workflow.get', {
                body: { workspaceId, workflowId: w.id },
              }),
            );
            return parseDefinition(got.workflow.definition);
          } catch {
            return null;
          }
        }),
      );
      setRows(flows.map((w, i) => ({ w, reminds: defs[i] ? sendsReminder(defs[i]!) : false })));
    } catch (e) {
      toast.error(errorMessage(e));
      setRows((had) => had ?? []);
    }
  }, [workspaceId, calendarId, legacy]);

  useEffect(() => {
    void load();
  }, [load, changes]);

  const add = (recipe: string) =>
    router.push(
      `/app/w/${workspaceId}/workflows/new?recipe=${recipe}&calendar=${encodeURIComponent(calendarId)}`,
    );

  return (
    <>
      <div className="mb-3">
        <h2 className="text-lg font-semibold tracking-tight">Automations</h2>
        <p className="mt-1 text-[13px] text-text-2">
          Workflows that start from {calendarName}’s appointments.
        </p>
      </div>
      <div className="flex flex-col gap-2" data-testid="calendar-automations">
        {rows === null ? (
          <p className="text-[13px] text-text-3">Loading workflows…</p>
        ) : !rows.length ? (
          <div className="rounded-[10px] border border-dashed border-border-strong bg-card-2 px-4 py-4 text-[13px] text-text-2">
            No workflows start from this calendar yet. Add one: a thank-you and a review request
            after each visit, or a text with the booking link after a no-show.
          </div>
        ) : (
          rows.map(({ w, reminds }) => (
            <div
              key={w.id}
              className="rounded-[10px] border border-border bg-card px-3.5 py-3"
              data-testid={`automation-${w.id}`}
            >
              <div className="flex items-center gap-3">
                <KindTile tone="act" icon={workflowIcon(w)} />
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/app/w/${workspaceId}/workflows/${w.id}`}
                    className="block truncate text-[14px] font-medium hover:underline"
                  >
                    {w.name}
                  </Link>
                  <span className="block text-xs text-text-2">
                    {w.trigger.summary}
                    {w.allCalendars ? ' · every calendar' : ''}
                  </span>
                </div>
                {w.status === 'active' || w.status === 'paused' ? (
                  <span className="flex flex-none items-center gap-2">
                    <span className="text-xs text-text-3">
                      {w.status === 'active' ? 'On' : 'Paused'}
                    </span>
                    <Switch
                      checked={w.status === 'active'}
                      onChange={(on) => {
                        setTarget(w);
                        setChange(on ? 'resume' : 'pause');
                      }}
                      label={w.status === 'active' ? `Pause ${w.name}` : `Resume ${w.name}`}
                      testId={`automation-switch-${w.id}`}
                    />
                  </span>
                ) : (
                  <WorkflowStatusBadge status={w.status} />
                )}
              </div>
              {reminds && remindersOn ? (
                <p
                  className="mt-2 flex items-start gap-1.5 text-xs text-warning-text"
                  data-testid="automation-reminder-warning"
                >
                  <AlertTriangle className="mt-px h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
                  It texts or emails before the appointment, and this calendar already sends
                  reminders, so customers could hear from you twice.
                </p>
              ) : null}
            </div>
          ))
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="sm" data-testid="automation-add">
              <Plus className="h-4 w-4" strokeWidth={1.75} />
              Add automation
              <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.75} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {RECIPES.map((r) => (
              <DropdownMenuItem
                key={r.key}
                onSelect={() => add(r.key)}
                data-testid={`automation-add-${r.key}`}
              >
                <KindTile tone="act" icon={recipeIcon(r.key)} size="xs" />
                {r.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="text-xs text-text-3">Opens a recipe with {calendarName} filled in.</span>
      </div>
      {remindersOn ? (
        <p className="mt-4 flex items-start gap-1.5 rounded-menu bg-card-2 px-3 py-2.5 text-xs text-text-2">
          <Info className="mt-px h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
          Reminders already go out from Notifications. A workflow that also sends a reminder would
          text customers twice.
        </p>
      ) : null}
      <StatusChangeDialog
        change={change}
        onClose={() => setChange(null)}
        workspaceId={workspaceId}
        workflow={
          target
            ? { id: target.id, name: target.name, activeRuns: target.activeRuns }
            : { id: '', name: 'this workflow' }
        }
        onDone={() => void load()}
      />
    </>
  );
}
