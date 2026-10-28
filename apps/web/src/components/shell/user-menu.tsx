'use client';
import { AFFILIATE_PAGE_WORDS } from '@hfos/core';
import { HandCoins, LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { forgetOthersSearches } from '@/components/search/search-provider';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Me } from '@/lib/api/types';
import { supabaseBrowser } from '@/lib/supabase/client';

/**
 * Who's signed in, at the foot of the menu. Their name opens the account menu: selling HandsFreeOS as an affiliate
 * (20261027014500), and signing out, which also has its own button beside it.
 */
export function UserMenu({ user }: { user: Me['user'] }) {
  const router = useRouter();
  const name = user.fullName || user.email;
  const signOut = async () => {
    // Recent searches stay with the person who typed them: none are left for whoever signs in next.
    forgetOthersSearches(null);
    await supabaseBrowser().auth.signOut();
    router.replace('/sign-in');
    router.refresh();
  };
  return (
    <div className="mt-2 flex items-center gap-3 border-t border-border px-1.5 pt-3">
      <DropdownMenu>
        <DropdownMenuTrigger
          className="flex min-w-0 flex-1 items-center gap-3 rounded-menu text-left focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
          data-testid="account-menu"
        >
          <Avatar name={name} seed={user.id} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[13.5px] font-medium">{name}</span>
            <span className="truncate text-xs text-text-3">{user.email}</span>
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top">
          <DropdownMenuLabel className="truncate">{user.email}</DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={() => router.push('/affiliate')}
            data-testid="account-menu-affiliate"
          >
            <HandCoins className="h-4 w-4 text-text-2" strokeWidth={1.5} />
            {AFFILIATE_PAGE_WORDS.menuItem}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void signOut()}>
            <LogOut className="h-4 w-4 text-text-2" strokeWidth={1.5} />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        variant="ghost"
        size="icon"
        title="Sign out"
        aria-label="Sign out"
        data-testid="sign-out"
        onClick={() => void signOut()}
      >
        <LogOut className="h-[18px] w-[18px]" strokeWidth={1.5} />
      </Button>
    </div>
  );
}
