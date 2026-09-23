'use client';
/**
 * Settings → Automations: everything HandsFreeOS does on its own, grouped the way an owner thinks about it, one
 * row each: a plain name, one sentence, what it touches (texts customers, just alerts you, updates records), a
 * switch, and Adjust for its timing and wording.
 *
 * A switch writes to wherever that automation's setting has always lived (the Action Center's kinds, the AI
 * teammate's skills, or Automations' own document), through that document's own command, so everything that
 * already reads those settings keeps working unchanged.
 */
import {
  AUTOMATION_EFFECT_LABELS,
  AUTOMATION_GROUP_TITLES,
  AUTOMATION_SECTIONS,
  automationCounts,
  automationPatch,
  automationRows,
  DEFAULT_FOLLOW_UP_LADDER_HOURS,
  type AdjustPanel,
  type AttentionSettings,
  type AutomationEffect,
  type AutomationId,
  type AutomationRow,
  type AutomationSettings,
  type NudgeCheckContext,
  type TeammateStatus,
} from '@hfos/core';
import { Bell, ChevronRight, ClipboardList, Lock, MessageSquare, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useState, type ComponentType } from 'react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { Pipeline, Role } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { AdjustPanelView, type FollowUpView, type IntakeFormOption, type PanelEnv } from './panels';
import { useQueuedSave } from './use-queued-save';

/** The AI teammate, as this page needs it. */
export interface TeammateOnPage {
  readonly id: string;
  readonly name: string;
  readonly status: TeammateStatus;
  readonly revision: number;
  readonly config: Record<string, unknown>;
}

const EFFECT_ICONS: Readonly<Record<AutomationEffect, ComponentType<{ className?: string }>>> = {
  texts: MessageSquare,
  alerts: Bell,
  records: ClipboardList,
};

/** What a toast says when a row is flipped. */
function flipped(label: string, on: boolean): string {
  return on ? `${label} is on.` : `${label} is off.`;
}

export function AutomationsSettings({
  workspaceId,
  role,
  businessName,
  initialAttention,
  initialAutomations,
  teammate: initialTeammate,
  workedOut,
  typicalFrom,
  pipelines,
  replyMinutes,
  check,
  senderName,
  forms,
  maintenanceReady,
}: {
  workspaceId: string;
  role: Role;
  businessName: string;
  initialAttention: AttentionSettings;
  initialAutomations: AutomationSettings;
  teammate: TeammateOnPage | null;
  workedOut: number;
  typicalFrom: 'won_median' | 'default';
  pipelines: readonly Pipeline[];
  replyMinutes: number;
  check: NudgeCheckContext;
  senderName: string;
  forms: readonly IntakeFormOption[];
  /** Whether any service repeats or plan names a service ("Maintenance due" has something to go on). */
  maintenanceReady: boolean;
}) {
  const attention = useQueuedSave(initialAttention, async (settings) => {
    const out = unwrap(
      await apiBrowser().POST('/v1/commands/attention.save_settings', {
        body: { workspaceId, settings },
      }),
    );
    return out.settings;
  });
  const automations = useQueuedSave(initialAutomations, async (settings) => {
    const out = unwrap(
      await apiBrowser().POST('/v1/commands/automations.save_settings', {
        body: { workspaceId, settings },
      }),
    );
    return out.settings;
  });
  // The teammate's revision moves with every save; the next save builds on the one the server gave back.
  const teammate = useQueuedSave<TeammateOnPage | null>(initialTeammate, async (next) => {
    if (!next) return next;
    const out = unwrap(
      await apiBrowser().POST('/v1/commands/ai_teammate.save_config', {
        body: {
          workspaceId,
          teammateId: next.id,
          baseRevision: next.revision,
          config: next.config,
        },
      }),
    );
    return { ...next, revision: out.revision };
  });
  const [adjusting, setAdjusting] = useState<AutomationRow | null>(null);

  const ctx = {
    attention: attention.value,
    automations: automations.value,
    teammate: teammate.value,
    maintenanceReady,
  };
  const rows = automationRows(ctx);
  const counts = automationCounts(rows);
  const training = teammate.value?.status === 'training';
  const ai = teammate.value?.name ?? 'Your AI teammate';

  function flip(row: AutomationRow, on: boolean) {
    // Its wording is read first: the switch opens it instead, where "Looks good, turn on" is.
    if (on && row.awaitingReview) {
      toast('Read the message first, then use Looks good, turn on.');
      setAdjusting(row);
      return;
    }
    const patch = automationPatch(row.def.id as AutomationId, on, ctx);
    if (!patch) {
      if (!teammate.value) toast('Set up your AI teammate first.');
      return;
    }
    const done = flipped(row.def.label, on);
    switch (patch.store) {
      case 'attention':
        void attention.save(() => patch.settings, done);
        return;
      case 'automations':
        void automations.save(() => patch.settings, done);
        return;
      case 'teammate':
        void teammate.save((t) => (t ? { ...t, config: patch.config } : t), done);
        return;
    }
  }

  const followUpOf = (config: Record<string, unknown>): FollowUpView => {
    const f = (config['followUp'] ?? {}) as Partial<FollowUpView>;
    return {
      enabled: f.enabled ?? true,
      ladderHours: f.ladderHours ?? DEFAULT_FOLLOW_UP_LADDER_HOURS,
      monthlyForMonths: f.monthlyForMonths ?? 6,
    };
  };
  const env: PanelEnv = {
    workspaceId,
    role,
    businessName,
    attention: attention.value,
    saveAttention: attention.save,
    automations: automations.value,
    saveAutomations: automations.save,
    followUp: teammate.value ? followUpOf(teammate.value.config) : null,
    saveFollowUp: (patch, done) =>
      teammate.save(
        (t) =>
          t
            ? {
                ...t,
                config: {
                  ...t.config,
                  followUp: { ...(t.config['followUp'] as object), ...patch },
                },
              }
            : t,
        done,
      ),
    workedOut,
    typicalFrom,
    pipelines,
    replyMinutes,
    check,
    senderName,
    teammateName: teammate.value?.name ?? null,
    forms,
  };

  return (
    <div className="flex flex-col gap-7" data-testid="automations-settings">
      <div className="flex flex-col gap-1">
        <p className="text-[13.5px] text-text-2" data-testid="automations-count">
          {counts.working} of {counts.total} automations are working.
          {counts.needsSetup
            ? ` ${counts.needsSetup} ${counts.needsSetup === 1 ? 'needs' : 'need'} something set up first.`
            : ''}{' '}
          Turn off anything you don’t want, and use Adjust to change when it happens or what it
          says.
        </p>
        {training ? (
          <p
            className="flex items-center gap-1.5 text-[13px] text-text-2"
            data-testid="automations-training"
          >
            <Sparkles className="h-4 w-4 flex-none text-accent-text" aria-hidden />
            {ai} is still training, so anything it writes waits for your approval before it goes.
          </p>
        ) : null}
      </div>

      {AUTOMATION_SECTIONS.map((section) => {
        const groups = section.groups
          .map((g) => ({ group: g, rows: rows.filter((r) => r.def.group === g) }))
          .filter((g) => g.rows.length > 0);
        if (groups.length === 0) return null;
        return (
          <section
            key={section.id}
            className="flex flex-col gap-4"
            data-testid={`section-${section.id}`}
          >
            <h2 className="text-lg font-semibold leading-[1.3] tracking-[-0.005em]">
              {section.title}
            </h2>
            {groups.map(({ group, rows: inGroup }) => (
              <div key={group} className="flex flex-col gap-2" data-testid={`group-${group}`}>
                <h3 className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
                  {AUTOMATION_GROUP_TITLES[group]}
                </h3>
                <Card className="divide-y divide-border px-[18px]">
                  {inGroup.map((row) => (
                    <AutomationRowView
                      key={row.def.id}
                      row={row}
                      workspaceId={workspaceId}
                      canFlip={
                        !row.locked && (row.def.binding.store !== 'teammate' || !!teammate.value)
                      }
                      onFlip={(on) => flip(row, on)}
                      onAdjust={() => setAdjusting(row)}
                    />
                  ))}
                </Card>
              </div>
            ))}
          </section>
        );
      })}

      <Sheet open={adjusting !== null} onOpenChange={(open) => (open ? null : setAdjusting(null))}>
        {adjusting && adjusting.def.adjust ? (
          <SheetContent title={adjusting.def.label} description={adjusting.def.oneLiner}>
            <AdjustPanelView panel={adjusting.def.adjust as AdjustPanel} env={env} />
          </SheetContent>
        ) : null}
      </Sheet>
    </div>
  );
}

function AutomationRowView({
  row,
  workspaceId,
  canFlip,
  onFlip,
  onAdjust,
}: {
  row: AutomationRow;
  workspaceId: string;
  canFlip: boolean;
  onFlip: (on: boolean) => void;
  onAdjust: () => void;
}) {
  const { def } = row;
  const Icon = EFFECT_ICONS[def.effect];
  return (
    <div
      className="flex items-start justify-between gap-4 py-3.5"
      data-testid={`automation-${def.id}`}
      data-on={row.on}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-[13.5px] font-medium">{def.label}</span>
        <span className="text-[12.5px] text-text-2">{def.oneLiner}</span>
        {row.needsSetup && row.on ? (
          <span className="text-[12.5px] text-warning-text" data-testid={`needs-setup-${def.id}`}>
            {row.needsSetup.text}{' '}
            {row.needsSetup.code === 'maintenance_schedule' ? (
              <Link
                href={`/app/w/${workspaceId}/settings/calendars/services`}
                className="font-medium hover:underline"
                data-testid={`needs-setup-open-${def.id}`}
              >
                Go to Services
              </Link>
            ) : row.needsSetup.code === 'intake_form' ? (
              <button
                type="button"
                onClick={onAdjust}
                className="font-medium hover:underline"
                data-testid={`needs-setup-open-${def.id}`}
              >
                Pick a form
              </button>
            ) : (
              <Link href={`/app/w/${workspaceId}/ai-team`} className="font-medium hover:underline">
                Go to AI teammate
              </Link>
            )}
          </span>
        ) : null}
        {row.fallback && row.on ? (
          <span className="text-[12.5px] text-text-2" data-testid={`fallback-${def.id}`}>
            {row.fallback}
          </span>
        ) : null}
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-3">
          <span
            className={cn(
              'inline-flex items-center gap-1',
              def.effect === 'texts' && 'text-accent-text',
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
            {AUTOMATION_EFFECT_LABELS[def.effect]}
          </span>
          {row.drafts && row.on ? <span>· Waits for your approval while training</span> : null}
          {row.awaitingReview ? <span>· Read the message first</span> : null}
          {def.adjust ? (
            <>
              <span aria-hidden>·</span>
              <button
                type="button"
                onClick={onAdjust}
                className="inline-flex items-center font-medium text-accent-text hover:underline"
                data-testid={`adjust-open-${def.id}`}
              >
                Adjust
                <ChevronRight className="h-3.5 w-3.5" aria-hidden />
              </button>
            </>
          ) : null}
        </span>
      </div>
      <span className="flex flex-none items-center pt-0.5">
        {row.locked ? (
          <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11.5px] font-medium text-text-3">
            <Lock className="h-3 w-3" strokeWidth={1.75} aria-hidden />
            Always on
          </span>
        ) : (
          <Switch
            checked={row.on}
            disabled={!canFlip}
            label={row.on ? `Turn off ${def.label}` : `Turn on ${def.label}`}
            onChange={onFlip}
            testId={`automation-switch-${def.id}`}
          />
        )}
      </span>
    </div>
  );
}
