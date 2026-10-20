import type { SettingKey } from '@hfos/core';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { SETTING_TARGET, settingAttrs } from './setting-anchor';

/** One setting: its name and a short explanation on the left, the control on the right. */
export function SetRow({
  title,
  description,
  children,
  first,
  center,
  className,
  body,
  setting,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** The control on the right. */
  children?: ReactNode;
  /** The first row in a card has no rule above it. */
  first?: boolean;
  center?: boolean;
  className?: string;
  /** Extra controls under the explanation (quiet hours' time pickers). */
  body?: ReactNode;
  /** The setting it is in core's catalogue, so settings search can jump to it and ring it. */
  setting?: SettingKey;
}) {
  return (
    <div
      {...settingAttrs(setting)}
      className={cn(
        'flex justify-between gap-4 py-3.5',
        center ? 'items-center' : 'items-start',
        first ? 'pt-1' : 'border-t border-border',
        setting && SETTING_TARGET,
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="text-[13px] font-medium">{title}</div>
        {description ? (
          <div className="max-w-[420px] text-xs text-text-3">{description}</div>
        ) : null}
        {body}
      </div>
      {children ? <div className="flex-none">{children}</div> : null}
    </div>
  );
}
