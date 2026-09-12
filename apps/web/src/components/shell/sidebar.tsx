import { CallsPill } from '@/components/calls/calls-pill';
import { Brand } from '@/components/ui/brand';
import type { Me, WorkspaceSummary } from '@/lib/api/types';
import { NavLinks } from './nav-links';
import { SearchField } from './search-field';
import { UserMenu } from './user-menu';
import { WorkspaceSwitcher } from './workspace-switcher';

export function Sidebar({ me, current }: { me: Me; current: WorkspaceSummary }) {
  return (
    <aside className="hidden w-60 flex-none flex-col gap-1 border-r border-border bg-card px-3 pb-3 pt-4 md:flex">
      <div className="px-2.5 pb-3.5 pt-1">
        <Brand />
      </div>
      <WorkspaceSwitcher me={me} current={current} />
      <SearchField workspaceId={current.id} className="mt-2" />
      <NavLinks workspaceId={current.id} />
      <div className="flex-1" />
      <CallsPill />
      <UserMenu user={me.user} />
    </aside>
  );
}
