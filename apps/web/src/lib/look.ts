/**
 * A business's logo and colour on the web (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4): where a
 * logo is seen, and the class and style that give part of a page the business's colour. The calls that change them
 * are in look-actions.ts.
 */
import { buttonColorFor, logoUrlFor } from '@hfos/core';
import type { CSSProperties } from 'react';
import { publicEnv } from '@/lib/env';

/** A logo the worker made, at Storage's public address. */
export const logoSrc = (path: string): string => logoUrlFor(publicEnv.supabaseUrl, path);

/**
 * The class and style that give part of a page the business's colour (globals.css, `.brand-look`): its buttons
 * darkened just enough for white words. Nothing for a business still in HandsFreeOS's blue.
 */
export function brandLook(color: string | null | undefined): {
  className?: string;
  style?: CSSProperties;
} {
  return color
    ? { className: 'brand-look', style: { '--accent': buttonColorFor(color) } as CSSProperties }
    : {};
}
