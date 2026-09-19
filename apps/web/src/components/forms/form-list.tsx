'use client';
import { ClipboardList, Link2, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import type { FormSummary } from '@/lib/api/types';
import { answersLine, completionLine } from '@/lib/forms/words';
import { cn } from '@/lib/utils';
import { FormModeBadge, FormStatusBadge } from './chips';
import { NewFormDialog } from './new-form';

type Filter = 'all' | 'live' | 'draft' | 'closed';

const COLUMNS =
  'sm:grid sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_150px] sm:items-center sm:gap-4';

/**
 * Every form, survey and quiz: what it is, whether it is taking answers, how many people answered and how
 * many of the ones who started finished.
 */
export function FormList({
  workspaceId,
  items,
  canManage,
  siteSlug,
}: {
  workspaceId: string;
  items: FormSummary[];
  canManage: boolean;
  /** The business's public site name, for the link under each form. */
  siteSlug: string | null;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const base = `/app/w/${workspaceId}/forms`;

  const counts = {
    all: items.length,
    live: items.filter((f) => f.status === 'live').length,
    draft: items.filter((f) => f.status === 'draft').length,
    closed: items.filter((f) => f.status === 'closed').length,
  };
  const shown = items.filter(
    (f) =>
      (filter === 'all' || f.status === filter) &&
      (!q.trim() || f.name.toLowerCase().includes(q.trim().toLowerCase())),
  );

  if (!items.length) return <NoForms workspaceId={workspaceId} canManage={canManage} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          value={filter}
          onChange={setFilter}
          ariaLabel="Which forms to show"
          options={[
            { value: 'all', label: `All ${counts.all}` },
            { value: 'live', label: `Taking answers ${counts.live}` },
            { value: 'draft', label: `Drafts ${counts.draft}` },
            { value: 'closed', label: `Closed ${counts.closed}` },
          ]}
        />
        <div className="relative ml-auto w-full sm:w-64">
          <Search
            className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-text-3"
            strokeWidth={1.75}
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a form"
            className="pl-8"
            aria-label="Find a form"
          />
        </div>
      </div>

      <Card className="divide-y divide-border">
        <div
          className={cn(
            'hidden px-4 py-2 text-[12px] font-medium uppercase tracking-wide text-text-3 sm:block',
            COLUMNS,
          )}
        >
          <span>Form</span>
          <span>Answers</span>
          <span>Link</span>
          <span className="text-right">Status</span>
        </div>
        {shown.map((form) => (
          <Link
            key={form.formId}
            href={`${base}/${form.formId}`}
            className={cn('block px-4 py-3 transition-colors hover:bg-card-2', COLUMNS)}
            data-testid="form-row"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium text-text">{form.name}</span>
                <FormModeBadge mode={form.mode} />
              </div>
              <p className="mt-0.5 text-[12.5px] text-text-3">
                {form.questionCount === 1 ? '1 question' : `${form.questionCount} questions`}
                {form.version ? ` · version ${form.version}` : ' · never published'}
              </p>
            </div>
            <div className="mt-1 text-[13px] text-text-2 sm:mt-0">
              {answersLine(form.responseCount)}
              {completionLine(form.completionRate) ? (
                <span className="block text-[12.5px] text-text-3">
                  {completionLine(form.completionRate)}
                </span>
              ) : null}
            </div>
            <div className="mt-1 min-w-0 text-[12.5px] text-text-3 sm:mt-0">
              {siteSlug && form.status !== 'draft' ? (
                <span className="inline-flex items-center gap-1 truncate">
                  <Link2 className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
                  <span className="truncate">
                    /f/{siteSlug}/{form.slug}
                  </span>
                </span>
              ) : (
                <span>Not shared yet</span>
              )}
            </div>
            <div className="mt-2 sm:mt-0 sm:text-right">
              <FormStatusBadge status={form.status} />
            </div>
          </Link>
        ))}
        {!shown.length ? (
          <p className="px-4 py-8 text-center text-[13px] text-text-3">
            Nothing here. Try another filter.
          </p>
        ) : null}
      </Card>
    </div>
  );
}

function NoForms({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Card className="px-6 py-12 text-center">
      <ClipboardList className="mx-auto h-8 w-8 text-text-3" strokeWidth={1.5} />
      <h2 className="mt-3 text-[15px] font-medium text-text">No forms yet</h2>
      <p className="mx-auto mt-1 max-w-md text-[13px] text-text-2">
        A form collects answers and files them against the customer. The same builder makes a survey
        that asks how you did, or a quiz that scores the answers.
      </p>
      {canManage ? (
        <div className="mt-5">
          <Button onClick={() => setOpen(true)} data-testid="form-new-empty">
            <Plus className="h-4 w-4" strokeWidth={1.75} />
            New form
          </Button>
          <NewFormDialog workspaceId={workspaceId} open={open} onOpenChange={setOpen} />
        </div>
      ) : null}
    </Card>
  );
}
