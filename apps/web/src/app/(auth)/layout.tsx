import type { ReactNode } from 'react';
import { Brand } from '@/components/ui/brand';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-6 py-12 [background:radial-gradient(70%_45%_at_50%_0%,color-mix(in_oklab,var(--accent)_9%,transparent),transparent_75%)]">
      <Brand size={32} className="text-base" />
      {children}
    </div>
  );
}
