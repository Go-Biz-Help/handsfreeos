'use client';
import { AGENCY_SETUP_WORDS, CLIENT_GROUPS } from '@hfos/core';
import { ArrowUpRight } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Segmented } from '@/components/ui/segmented';
import { behindBy } from '@/lib/agency/installs';
import { agencyHref } from '@/lib/agency/org';
import type { OnboardingClient, OnboardingClients, WorkflowTemplateGet } from '@/lib/api/types';
import { GROUP_BADGE, SetupSheet } from './setup-sheet';
import { InstallChip, type Business } from './template-list';

type Filter = 'all' | OnboardingClient['group'];

/**
 * The agency's client businesses: how far each has got setting up (HANDSFREEOS_ONBOARDING_IMPLEMENTATION_PLAN.md §6,
 * board 11), its templates, the version it has, and whether it's behind, with a way into the business itself.
 * All / Stuck / Setting up / Done narrows the list; a business's Setup opens its steps beside it.
 */
export function BusinessList({
  organizationId,
  businesses,
  templates,
  setup,
}: {
  organizationId: string;
  businesses: readonly Business[];
  templates: readonly WorkflowTemplateGet[];
  /** Each business's setup (`onboarding.clients`); null when HandsFreeOS couldn't say, and the list shows without. */
  setup: OnboardingClients | null;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<string | null>(null);
  const setupOf = new Map(setup?.businesses.map((c) => [c.workspaceId, c]) ?? []);
  const shown = businesses.filter((b) => filter === 'all' || setupOf.get(b.id)?.group === filter);
  if (!businesses.length)
    return (
      <Card>
        <EmptyState title="No client businesses yet">
          Create one from the workspace switcher; it joins this agency.
        </EmptyState>
      </Card>
    );
  const w = AGENCY_SETUP_WORDS;
  return (
    <>
      {setup ? (
        <Segmented<Filter>
          value={filter}
          onChange={setFilter}
          ariaLabel={w.column}
          className="mb-3"
          options={(['all', ...CLIENT_GROUPS] as const).map((f) => ({
            value: f,
            label: `${w.filters[f]} · ${setup.counts[f]}`,
            testId: `setup-filter-${f}`,
          }))}
        />
      ) : null}
      <Card className="overflow-hidden" data-testid="businesses-list">
        {shown.map((b) => {
          const s = setupOf.get(b.id);
          const here = templates
            .map((t) => ({ t, install: t.installs.find((i) => i.workspaceId === b.id) }))
            .filter((x) => x.install);
          const behind = here.filter((x) => behindBy(x.install!, x.t.template.latestVersion) > 0);
          return (
            <div
              key={b.id}
              className="flex flex-col gap-2 border-b border-border px-4 py-3.5 last:border-b-0 md:flex-row md:items-center md:gap-4 md:px-[18px]"
              data-testid={`business-row-${b.id}`}
            >
              <span className="flex min-w-0 items-center gap-2.5 md:w-[260px] md:flex-none">
                <Avatar name={b.name} seed={b.id} square className="bg-card-3 text-text" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-semibold">{b.name}</span>
                  <span className="text-xs text-text-3">
                    {here.length
                      ? `${here.length} ${here.length === 1 ? 'template' : 'templates'}${
                          behind.length ? ` · ${behind.length} behind` : ' · up to date'
                        }`
                      : 'No templates yet'}
                  </span>
                </span>
              </span>
              {s ? (
                <button
                  type="button"
                  onClick={() => setOpen(b.id)}
                  className="flex min-w-0 flex-col items-start gap-1 rounded-menu px-2 py-1 text-left hover:bg-card-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring md:w-[280px] md:flex-none"
                  data-testid={`setup-${b.id}`}
                  data-group={s.group}
                  aria-label={`${w.column}: ${b.name}`}
                >
                  <span className="flex items-center gap-2">
                    <span className="h-1.5 w-16 overflow-hidden rounded-full bg-card-2" aria-hidden>
                      <span
                        className="block h-full rounded-full bg-accent"
                        style={{ width: `${s.total ? (s.done / s.total) * 100 : 100}%` }}
                      />
                    </span>
                    <span className="text-xs tabular-nums text-text-2">
                      {s.done} of {s.total}
                    </span>
                    <Badge variant={GROUP_BADGE[s.group]}>{s.badge}</Badge>
                  </span>
                  <span className="max-w-full truncate text-xs text-text-3">{s.note}</span>
                </button>
              ) : null}
              <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                {here.map(({ t, install }) => (
                  <Link
                    key={t.template.id}
                    href={`${agencyHref(organizationId)}/${t.template.id}`}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card py-px pl-2.5 pr-px text-xs font-medium hover:bg-card-2"
                    title={t.template.name}
                  >
                    <span className="max-w-[180px] truncate">{t.template.name}</span>
                    <InstallChip install={install!} latest={t.template.latestVersion} />
                  </Link>
                ))}
              </span>
              <Link
                href={`/app/w/${b.id}`}
                className="inline-flex flex-none items-center gap-1 text-[13px] font-medium text-accent-text hover:underline"
              >
                Open
                <ArrowUpRight className="h-4 w-4" strokeWidth={1.5} />
              </Link>
            </div>
          );
        })}
        {shown.length === 0 ? (
          <p className="px-[18px] py-6 text-center text-[13px] text-text-3">
            No businesses here right now.
          </p>
        ) : null}
      </Card>
      <SetupSheet
        organizationId={organizationId}
        client={open ? (setupOf.get(open) ?? null) : null}
        onOpenChange={(o) => !o && setOpen(null)}
      />
    </>
  );
}
