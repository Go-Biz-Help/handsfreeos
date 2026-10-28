import type { SignatureStyle } from '@hfos/core';
import { Caveat, Dancing_Script, Homemade_Apple, Satisfy } from 'next/font/google';

/**
 * The handwriting a typed signature can take (answer 12a), by core's `SIGNATURE_STYLES`. The signature that's kept
 * is a picture of the name drawn in one of them, so the signed copy never needs the font.
 */
const caveat = Caveat({ subsets: ['latin'], weight: '600', display: 'swap' });
const dancing = Dancing_Script({ subsets: ['latin'], weight: '600', display: 'swap' });
const homemade = Homemade_Apple({ subsets: ['latin'], weight: '400', display: 'swap' });
const satisfy = Satisfy({ subsets: ['latin'], weight: '400', display: 'swap' });

export const SIGNATURE_FONTS: Readonly<
  Record<
    SignatureStyle,
    { readonly className: string; readonly family: string; readonly weight: number }
  >
> = {
  caveat: { className: caveat.className, family: caveat.style.fontFamily, weight: 600 },
  dancing: { className: dancing.className, family: dancing.style.fontFamily, weight: 600 },
  homemade: { className: homemade.className, family: homemade.style.fontFamily, weight: 400 },
  satisfy: { className: satisfy.className, family: satisfy.style.fontFamily, weight: 400 },
};
