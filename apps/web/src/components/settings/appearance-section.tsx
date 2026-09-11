'use client';
import { useState } from 'react';
import { toast } from 'sonner';
import { applyTheme } from '@/components/shell/theme-sync';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { ThemeChoice } from '@/lib/theme';
import { cn } from '@/lib/utils';

const OPTIONS: { value: ThemeChoice; label: string; desc: string }[] = [
  { value: 'light', label: 'Light', desc: 'Always light' },
  { value: 'dark', label: 'Dark', desc: 'Always dark' },
  { value: 'system', label: 'System', desc: 'Follows this device' },
];

export function AppearanceSection({ initial }: { initial: ThemeChoice }) {
  const [theme, setTheme] = useState<ThemeChoice>(initial);

  async function choose(next: ThemeChoice) {
    setTheme(next);
    applyTheme(next);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/user.update_profile', {
          body: { settings: { theme: next } },
        }),
      );
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <div>
      <h2 className="text-lg font-semibold tracking-tight">Appearance</h2>
      <p className="mt-1 text-[13px] text-text-2">
        Saved to your account, so every device you sign in on follows it.
      </p>
      <div className="mt-4 grid grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={theme === o.value}
            data-testid={`theme-${o.value}`}
            onClick={() => void choose(o.value)}
            className={cn(
              'flex flex-col items-start gap-2 rounded-menu border border-border-strong bg-card p-3 text-left',
              theme === o.value && 'border-accent bg-accent-soft ring-1 ring-accent',
            )}
          >
            <span
              className={cn(
                'flex h-[34px] w-full items-end gap-1 rounded-[6px] border p-1.5',
                o.value === 'dark'
                  ? 'border-[#2c3139] bg-[#0f131a]'
                  : o.value === 'light'
                    ? 'border-[#e4e8ee] bg-[#f9fafd]'
                    : 'border-[#d2d6dd] bg-[linear-gradient(90deg,#f9fafd_50%,#0f131a_50%)]',
              )}
              aria-hidden
            >
              <span
                className={cn(
                  'h-2.5 flex-1 rounded-[3px] border',
                  o.value === 'dark'
                    ? 'border-[#2c3139] bg-[#191d25]'
                    : 'border-[#e4e8ee] bg-white',
                )}
              />
              <span
                className={cn(
                  'h-2.5 flex-1 rounded-[3px]',
                  o.value === 'system' ? 'border border-[#2c3139] bg-[#191d25]' : 'bg-accent',
                )}
              />
            </span>
            <span className="flex flex-col">
              <span className="font-medium">{o.label}</span>
              <span className="text-xs text-text-3">{o.desc}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
