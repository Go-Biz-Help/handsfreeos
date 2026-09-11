'use client';
import { KeyRound } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { publicEnv } from '@/lib/env';
import { supabaseBrowser } from '@/lib/supabase/client';
import { safeNext } from '@/lib/utils';

export function PasskeyButton({ next }: { next?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  if (!publicEnv.passkeysEnabled) return null;
  return (
    <Button
      variant="secondary"
      size="lg"
      className="w-full"
      loading={busy}
      data-testid="passkey-sign-in"
      onClick={async () => {
        setBusy(true);
        const { error } = await supabaseBrowser().auth.signInWithPasskey();
        if (error) {
          setBusy(false);
          if (!/cancel|abort|not allowed/i.test(error.message)) toast.error(error.message);
          return;
        }
        router.replace(safeNext(next));
        router.refresh();
      }}
    >
      <KeyRound className="h-[18px] w-[18px]" />
      Sign in with a passkey
    </Button>
  );
}
