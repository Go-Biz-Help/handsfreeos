'use client';
import { AlertTriangle, Check, Clock, Info, LayoutTemplate, Plus, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { agencyHref } from '@/lib/agency/org';
import type { WorkflowTemplateGet, WorkflowTemplateInstall } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { PushStepper } from './push-stepper';
import { SaveAsTemplateDialog } from './save-as-template';

export type Business = { readonly id: string; readonly name: string };

const COLUMNS =
  'lg:grid lg:grid-cols-[minmax(0,1.5fr)_88px_minmax(0,1.35fr)_minmax(0,1fr)_104px] lg:items-center lg:gap-4';

/** Versions an install is behind the newest (0 when current, not installed, or never published). */
export function behindBy(i: WorkflowTemplateInstall, latest: number | null): number {
  return i.status === 'installed' && latest ? Math.max(0, latest - (i.installedVersion ?? 0)) : 0;
}

/** One business's copy: its version, and whether it's current, behind, installing or failed. */
export function InstallChip({
  install,
  latest,
}: {
  install: WorkflowTemplateInstall;
  latest: number | null;
}) {
  const behind = behindBy(install, latest);
  const state =
    install.status === 'failed'
      ? 'failed'
      : install.status === 'pending'
        ? 'pending'
        : behind
          ? 'behind'
          : 'current';
  const Icon = { failed: AlertTriangle, pending: Clock, behind: RefreshCw, current: Check }[state];
  const title = {
    failed: `${install.workspaceName}: couldn’t install. ${install.lastError ?? ''}`,
    pending: `${install.workspaceName}: installing`,
    behind: `${install.workspaceName}: ${behind} behind`,
    current: `${install.workspaceName}: up to date`,
  }[state];
  return (
    <span
      className="inline-flex h-6 items-center gap-1.5 rounded-full bg-card-2 pl-[3px] pr-2 text-xs font-medium text-text"
      title={title}
      data-testid={`install-${install.workspaceId}`}
      data-status={state}
    >
      <Avatar
        name={install.workspaceName}
        seed={install.workspaceId}
        size="sm"
        square
        className="h-[18px] w-[18px] rounded-[6px] text-[9px]"
      />
      <span className="sr-only">{install.workspaceName}</span>
      <span>{install.installedVersion ? `v${install.installedVersion}` : '–'}</span>
      <Icon
        aria-hidden
        className={cn(
          'h-3.5 w-3.5',
          state === 'failed' && 'text-danger-text',
          state === 'pending' && 'text-text-3',
          state === 'behind' && 'text-warning-text',
          state === 'current' && 'text-success-text',
        )}
        strokeWidth={2}
      />
    </span>
  );
}

/** "Summit Roofing is 1 behind", "All up to date", or what went wrong. */
export function behindLine(
  installs: readonly WorkflowTemplateInstall[],
  latest: number | null,
): { text: string; tone: 'ok' | 'warning' | 'danger' | 'muted' } {
  if (!installs.length) return { text: 'Not installed yet', tone: 'muted' };
  const failed = installs.filter((i) => i.status === 'failed');
  if (failed.length)
    return {
      text: `${failed.map((i) => i.workspaceName).join(', ')} couldn’t install`,
      tone: 'danger',
    };
  if (installs.some((i) => i.status === 'pending')) return { text: 'Installing…', tone: 'muted' };
  const behind = installs.filter((i) => behindBy(i, latest) > 0);
  if (!behind.length) return { text: 'All up to date', tone: 'ok' };
  if (behind.length === 1)
    return {
      text: `${behind[0]!.workspaceName} is ${behindBy(behind[0]!, latest)} behind`,
      tone: 'warning',
    };
  return { text: `${behind.length} businesses are behind`, tone: 'warning' };
}

const TONE = {
  ok: 'text-success-text',
  warning: 'text-warning-text',
  danger: 'text-danger-text',
  muted: 'text-text-3',
} as const;

/** "Save a workflow as a template": pick a business and one of its workflows. */
export function NewTemplateButton({
  organizationId,
  agencyName,
  businesses,
}: {
  organizationId: string;
  agencyName: string;
  businesses: readonly Business[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)} data-testid="template-new">
        <Plus className="h-4 w-4" strokeWidth={1.75} />
        Save a workflow as a template
      </Button>
      {open ? (
        <SaveAsTemplateDialog
          onOpenChange={setOpen}
          organizationId={organizationId}
          agencyName={agencyName}
          businesses={businesses}
        />
      ) : null}
    </>
  );
}

/**
 * The agency's templates: each one's newest version, the businesses it's in (and on which version), who is
 * behind, and Push.
 */
export function TemplateList({
  organizationId,
  agencyName,
  rows,
  businesses,
}: {
  organizationId: string;
  agencyName: string;
  rows: readonly WorkflowTemplateGet[];
  businesses: readonly Business[];
}) {
  const [pushing, setPushing] = useState<string | null>(null);
  const target = rows.find((r) => r.template.id === pushing);

  if (!rows.length)
    return (
      <Card data-testid="templates-empty">
        <EmptyState
          title="No templates yet"
          actions={
            <NewTemplateButton
              organizationId={organizationId}
              agencyName={agencyName}
              businesses={businesses}
            />
          }
        >
          Save one of your businesses’ workflows as a template, publish it, then push it to the
          others.
        </EmptyState>
      </Card>
    );

  return (
    <>
      <Card className="overflow-hidden" data-testid="templates-list">
        <div
          className={cn(
            'hidden border-b border-border bg-card-2 px-[18px] py-[9px] text-xs font-medium text-text-3',
            COLUMNS,
          )}
        >
          <span>Template</span>
          <span>Version</span>
          <span>Installed in</span>
          <span>Who’s behind</span>
          <span />
        </div>
        {rows.map(({ template: t, installs }) => {
          const line = behindLine(installs, t.latestVersion);
          const placeholders = t.placeholders.length;
          return (
            <div
              key={t.id}
              data-testid={`template-row-${t.id}`}
              className={cn(
                'relative flex flex-col gap-2.5 border-b border-border px-4 py-3.5 last:border-b-0 hover:bg-card-2 lg:px-[18px] lg:py-3',
                COLUMNS,
              )}
            >
              <span className="flex min-w-0 items-start gap-2.5">
                <span className="inline-flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[8px] bg-accent-soft text-accent-text">
                  <LayoutTemplate className="h-[15px] w-[15px]" strokeWidth={1.75} />
                </span>
                <span className="flex min-w-0 flex-col">
                  <Link
                    href={`${agencyHref(organizationId)}/${t.id}`}
                    className="truncate rounded-[4px] text-[15px] font-semibold leading-tight after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring lg:text-sm lg:font-medium"
                  >
                    {t.name}
                  </Link>
                  <span className="truncate text-xs text-text-3">
                    {t.description ||
                      (placeholders
                        ? `${placeholders} ${placeholders === 1 ? 'detail' : 'details'} to match`
                        : 'Nothing to match')}
                  </span>
                </span>
              </span>
              <span className="flex items-center gap-2 lg:block">
                {t.latestVersion ? (
                  <Badge variant="accent" className="h-5 text-[11.5px]">
                    v{t.latestVersion}
                  </Badge>
                ) : (
                  <Badge className="h-5 text-[11.5px]">Not published</Badge>
                )}
              </span>
              <span className="flex flex-wrap items-center gap-1.5">
                {installs.length ? (
                  installs.map((i) => (
                    <InstallChip key={i.id} install={i} latest={t.latestVersion} />
                  ))
                ) : (
                  <span className="text-xs text-text-3">No businesses yet</span>
                )}
              </span>
              <span className={cn('text-[13px]', TONE[line.tone])} data-testid="template-behind">
                {line.text}
              </span>
              <span className="relative z-10 flex lg:justify-end">
                <Button
                  variant={installs.length ? 'secondary' : 'primary'}
                  size="sm"
                  disabled={!t.latestVersion}
                  title={t.latestVersion ? undefined : 'Publish it first'}
                  onClick={() => setPushing(t.id)}
                  data-testid={`template-push-${t.id}`}
                >
                  Push…
                </Button>
              </span>
            </div>
          );
        })}
      </Card>
      <p className="mt-3 flex items-start gap-1.5 text-xs text-text-3">
        <Info className="mt-px h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
        Stages, calendars, tags and people become details each business matches, so a template fits
        any business. Each gets a draft, which it tests and publishes itself.
      </p>
      {target ? (
        <PushStepper
          organizationId={organizationId}
          template={target.template}
          installs={target.installs}
          businesses={businesses}
          onClose={() => setPushing(null)}
        />
      ) : null}
    </>
  );
}
