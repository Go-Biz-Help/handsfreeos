import { useThemeName } from '@/theme';

/**
 * The AI teammate's violet, as the web mixes it (`components/workflows/chips.tsx` and `ai-team/mark.tsx`): #7c3aed in
 * oklab with the card or text colour. The web's tokens have no violet, so the phone's generated tokens don't either;
 * these are the same mixes worked out once with `scripts/mobile-tokens.mjs`'s `resolveColor`.
 */
const AI = {
  light: {
    /** color-mix(in oklab, #7c3aed 13%, var(--card)) */
    soft: '#ece8ff',
    /** color-mix(in oklab, #7c3aed 72%, var(--text)) */
    text: '#5e37b0',
    /** color-mix(in oklab, #7c3aed 85%, var(--text)) */
    fill: '#6b39cc',
    /** color-mix(in oklab, #7c3aed 62%, var(--border-strong)): a draft's dashed edge. */
    dash: '#9880eb',
  },
  dark: {
    soft: '#24233c',
    text: '#9878f4',
    fill: '#8b5ef1',
    dash: '#6145ac',
  },
} as const;

export interface AiColors {
  readonly soft: string;
  readonly text: string;
  readonly fill: string;
  readonly dash: string;
}

export function useAiColors(): AiColors {
  return AI[useThemeName()];
}
