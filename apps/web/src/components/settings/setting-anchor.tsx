import { settingAnchor, type SettingKey } from '@hfos/core';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * What marks a setting on its page, so settings search can jump to it and ring it: its id (`quiet-hours`), which
 * emails and links name too, and its key in `data-setting`. TypeScript refuses a key core's catalogue doesn't have
 * (`packages/core/src/settings/catalog.ts`), and `test/settings-catalog.test.ts` checks each is marked once.
 */
export function settingAttrs(setting: SettingKey | undefined): {
  id?: string;
  'data-setting'?: string;
} {
  return setting ? { id: settingAnchor(setting), 'data-setting': setting } : {};
}

/** Leaves room above a setting the jump scrolls to. */
export const SETTING_TARGET = 'scroll-mt-20';

/**
 * Something that is one setting but has no element of its own to mark (a form's field, a section of a card), as
 * settings search finds it. Draws its children and nothing else. A `row` is filled when it's rung, as a row in a card
 * is; anything else is a card, and only ringed.
 */
export function SettingAnchor({
  setting,
  as: Tag = 'div',
  row = false,
  className,
  ...rest
}: HTMLAttributes<HTMLElement> & {
  setting: SettingKey;
  as?: 'div' | 'section' | 'fieldset';
  row?: boolean;
}) {
  return (
    <Tag
      {...rest}
      {...settingAttrs(setting)}
      className={cn(!row && 'rounded-card', SETTING_TARGET, className)}
    />
  );
}
