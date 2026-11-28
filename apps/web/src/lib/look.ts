/**
 * A business's logo and colour on the web (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4): where a
 * logo is seen, and the class and style that give part of a page the business's colour. The calls that change them
 * are in look-actions.ts.
 */
import {
  buttonColorFor,
  logoUrlFor,
  pageKitOf,
  pictureUrlFor,
  type LookCorners,
  type PictureRef,
} from '@hfos/core';
import type { CSSProperties } from 'react';
import { publicEnv } from '@/lib/env';

/** A logo the worker made, at Storage's public address. */
export const logoSrc = (path: string): string => logoUrlFor(publicEnv.supabaseUrl, path);

/** A picture from Your pictures, at Storage's public address: light enough for the public form page. */
export const pictureSrc = (path: string): string => pictureUrlFor(publicEnv.supabaseUrl, path);

/**
 * A form's background picture, behind it on its own page (not on a website, where the site is behind it): filling the
 * space, centred. The path is a library picture's (uuid/uuid.webp), so nothing in it can break out of the url().
 */
export const backdropStyle = (picture: PictureRef | null | undefined): CSSProperties | undefined =>
  picture
    ? {
        backgroundImage: `url("${pictureSrc(picture.path)}")`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }
    : undefined;

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

/**
 * A customer's page in the brand kit (design tools, part 7): the business's colour on its buttons, and the kit's font
 * and corners, with where the browser gets the font (a `<link>` the page puts in its head). Pages with a design of
 * their own (forms, booking pages) use theirs instead. Nothing changes for a business whose kit has none of these.
 */
export function kitLook(
  look:
    | {
        readonly color?: string | null;
        readonly font?: string | null;
        readonly corners?: LookCorners | null;
      }
    | null
    | undefined,
): { className: string; style?: CSSProperties; fontHref: string | null } {
  const brand = brandLook(look?.color);
  const kit = pageKitOf(look);
  return {
    className: ['kit-look', brand.className].filter(Boolean).join(' '),
    style: { ...brand.style, ...kit.vars } as CSSProperties,
    fontHref: kit.fontHref,
  };
}
