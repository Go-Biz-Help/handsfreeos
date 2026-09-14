import { ArrowUpRight } from 'lucide-react';
import Link from 'next/link';
import { Avatar } from '@/components/ui/avatar';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { behindBy } from '@/lib/agency/installs';
import { agencyHref } from '@/lib/agency/org';
import type { WorkflowTemplateGet } from '@/lib/api/types';
import { InstallChip, type Business } from './template-list';

/**
 * The agency's client businesses: each one's templates, the version it has, and whether it's behind, with a
 * way into the business itself.
 */
export function BusinessList({
  organizationId,
  businesses,
  templates,
}: {
  organizationId: string;
  businesses: readonly Business[];
  templates: readonly WorkflowTemplateGet[];
}) {
  if (!businesses.length)
    return (
      <Card>
        <EmptyState title="No client businesses yet">
          Create one from the workspace switcher; it joins this agency.
        </EmptyState>
      </Card>
    );
  return (
    <Card className="overflow-hidden" data-testid="businesses-list">
      {businesses.map((b) => {
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
    </Card>
  );
}
