/**
 * AI Sales Coach's page: its tabs (the live call, coached calls, trends and playbooks), and the one shown (`?view=`, app/app/w/[workspaceId]/a/salescoach/page.tsx); or,
 * inside a Zoom meeting, the Zoom panel alone (`zoom`).
 */
import { SALESCOACH_VIEWS, SALESCOACH_WORDS as W } from '@hfos/core/addons/salescoach/words';
import Link from 'next/link';
import { PageHeader } from '@/components/shell/page-header';
import { cn } from '@/lib/utils';
import { CallDetail, CallsList } from './calls-view';
import { LiveCoach } from './live-coach';
import { PlaybooksView } from './playbooks-view';
import { TrendsView } from './trends-view';
import type { CoachTrends, CoachedCall, CoachedCallSummary, Playbook } from './types';
import { ZoomPanel } from './zoom-panel';

export type SalescoachShown =
  | { readonly view: 'live' }
  | { readonly view: 'zoom' }
  | { readonly view: 'calls'; readonly calls: readonly CoachedCallSummary[] }
  | { readonly view: 'calls'; readonly call: CoachedCall }
  | { readonly view: 'playbooks'; readonly playbooks: readonly Playbook[] }
  | {
      readonly view: 'trends';
      readonly trends: CoachTrends;
      readonly weeks: number;
      readonly rep: string | null;
    };

export const salescoachHref = (workspaceId: string, view: string, call?: string) =>
  `/app/w/${workspaceId}/a/salescoach?view=${view}${call ? `&call=${call}` : ''}`;

export function SalescoachHome({
  workspaceId,
  shown,
  canManage,
  reviews,
}: {
  workspaceId: string;
  shown: SalescoachShown;
  canManage: boolean;
  /** Sees everyone's coached calls. */
  reviews: boolean;
}) {
  // Inside Zoom's narrow side panel: the coach alone, no tabs.
  if (shown.view === 'zoom')
    return (
      <div data-testid="salescoach-home" className="mx-auto max-w-[520px]">
        <ZoomPanel workspaceId={workspaceId} />
      </div>
    );
  return (
    <div data-testid="salescoach-home" className="mx-auto max-w-[920px]">
      <PageHeader title={W.title} description={W.pageAbout} />
      <nav
        aria-label={W.title}
        className="mb-5 flex gap-0.5 overflow-x-auto border-b border-border [scrollbar-width:none]"
      >
        {SALESCOACH_VIEWS.map((v) => {
          const active = v === shown.view;
          return (
            <Link
              key={v}
              href={salescoachHref(workspaceId, v)}
              aria-current={active ? 'page' : undefined}
              data-testid={`salescoach-tab-${v}`}
              className={cn(
                '-mb-px flex h-10 flex-none items-center whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors max-md:h-11',
                active
                  ? 'border-accent text-accent-text'
                  : 'border-transparent text-text-2 hover:text-text',
              )}
            >
              {W.tabs[v]}
            </Link>
          );
        })}
      </nav>
      {shown.view === 'live' ? <LiveCoach workspaceId={workspaceId} /> : null}
      {shown.view === 'calls' && 'call' in shown ? (
        <CallDetail workspaceId={workspaceId} call={shown.call} />
      ) : null}
      {shown.view === 'calls' && 'calls' in shown ? (
        <CallsList workspaceId={workspaceId} calls={shown.calls} reviews={reviews} />
      ) : null}
      {shown.view === 'trends' ? (
        <TrendsView
          workspaceId={workspaceId}
          trends={shown.trends}
          weeks={shown.weeks}
          rep={shown.rep}
          reviews={reviews}
        />
      ) : null}
      {shown.view === 'playbooks' ? (
        <PlaybooksView
          workspaceId={workspaceId}
          playbooks={shown.playbooks}
          canManage={canManage}
        />
      ) : null}
    </div>
  );
}
