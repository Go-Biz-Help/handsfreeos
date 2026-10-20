'use client';
import { LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { forgetOthersSearches } from '@/components/search/search-provider';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import type { Me } from '@/lib/api/types';
import { supabaseBrowser } from '@/lib/supabase/client';

export function UserMenu({ user }: { user: Me['user'] }) {
  const router = useRouter();
  const name = user.fullName || user.email;
  return (
    <div className="mt-2 flex items-center gap-3 border-t border-border px-1.5 pt-3">
      <Avatar name={name} seed={user.id} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13.5px] font-medium">{name}</span>
        <span className="truncate text-xs text-text-3">{user.email}</span>
      </span>
      <Button
        variant="ghost"
        size="icon"
        title="Sign out"
        aria-label="Sign out"
        data-testid="sign-out"
        onClick={async () => {
          // Recent searches stay with the person who typed them: none are left for whoever signs in next.
          forgetOthersSearches(null);
          await supabaseBrowser().auth.signOut();
          router.replace('/sign-in');
          router.refresh();
        }}
      >
        <LogOut className="h-[18px] w-[18px]" strokeWidth={1.5} />
      </Button>
    </div>
  );
}
