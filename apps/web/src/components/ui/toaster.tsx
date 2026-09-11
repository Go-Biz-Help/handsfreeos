'use client';
import { Toaster as Sonner } from 'sonner';

export function Toaster() {
  return (
    <Sonner
      position="bottom-center"
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
