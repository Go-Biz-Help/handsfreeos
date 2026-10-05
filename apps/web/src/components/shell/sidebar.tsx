import { AskButton } from '@/components/assistant/ask-button';
import { CallsPill } from '@/components/calls/calls-pill';
import { Brand } from '@/components/ui/brand';
import type { Me, WorkspaceSummary } from '@/lib/api/types';
import { GetHelp } from '@/components/support/get-help';
import { guideOf } from '@/lib/guide';
import { FootLinks, NavLinks } from './nav-links';
import { SearchField } from './search-field';
import { UserMenu } from './user-menu';
import { WorkspaceSwitcher } from './workspace-switcher';

/**
 * The sidebar: the business and search at the top, the person's own menu in the middle, and at the bottom the
 * places about HandsFreeOS itself (Add-ons, Ideas), Get help and the account. The menu scrolls on its own — a long
 * one, or a short screen, never pushes them off the bottom — and the padding around it leaves room for a focus ring
 * the scroller would otherwise clip.
 *
 * It is kept to the height of the window and pinned there, which is what makes the menu scroll at all: the page
 * beside it is as long as its own content, and a row of a flex container is as tall as its tallest child, so
 * without the cap the sidebar simply grew with the page. The menu then never overflowed, and the account went
 * off the bottom of the window with everything else.
 */
export function Sidebar({ me, current }: { me: Me; current: WorkspaceSummary }) {
  return (
    <aside className="sticky top-0 hidden max-h-[100dvh] w-60 flex-none flex-col border-r border-border bg-card px-3 pb-3 pt-4 md:flex print:hidden">
      <div className="flex-none">
        <div className="px-2.5 pb-3.5 pt-1">
          <Brand />
        </div>
        <WorkspaceSwitcher me={me} current={current} />
        <SearchField workspaceId={current.id} className="mt-2" />
        <AskButton className="mt-1.5" />
      </div>
      <div
        data-testid="sidebar-menu"
        className="-mx-1 mt-2.5 min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 py-0.5 [scrollbar-width:thin]"
      >
        <NavLinks
          workspaceId={current.id}
          permissions={current.permissions}
          addons={current.addons}
        />
      </div>
      <div className="flex-none pt-2">
        <CallsPill />
        <FootLinks workspaceId={current.id} permissions={current.permissions} />
        <GetHelp workspaceId={current.id} guide={guideOf(me, current.id)} />
        <UserMenu user={me.user} />
      </div>
    </aside>
  );
}
