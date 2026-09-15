'use client';
import { Toaster as Sonner } from 'sonner';
import { useMatches } from '@/lib/use-media';

// On a phone the bottom of the screen belongs to the composer, the draft bar and the tab bar, so toasts come in from
// the top there, just under the 56 px top bar (the thread's and the Assistant's headers are the same height).
// Sonner reads `mobileOffset` up to 600 px wide and `offset` above that, so both carry it. The other sides keep
// Sonner's defaults, which leaves the desktop's bottom-center toasts where they were.
const UNDER_TOP_BAR = 'calc(env(safe-area-inset-top) + 64px)';

export function Toaster() {
  const phone = useMatches('(max-width: 767px)');
  return (
    <Sonner
      position={phone ? 'top-center' : 'bottom-center'}
      offset={{ top: UNDER_TOP_BAR }}
      mobileOffset={{ top: UNDER_TOP_BAR }}
      duration={2600}
      toastOptions={{
        classNames: {
          toast:
            'rounded-menu border border-border bg-card text-text shadow-2 text-[13.5px] font-sans',
          error: 'bg-danger text-white border-transparent',
        },
      }}
    />
  );
}
