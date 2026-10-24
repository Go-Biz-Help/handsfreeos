/**
 * An exact message's blanks: `{first_name}`, `{session_time}`, `{join_link}` and `{business}`. Browser-safe, so the
 * steps preview a message with a pretend lead's details and the worker sends it with the real ones.
 */
import { FUNNEL_FILLS, type FunnelFill } from './definition';

export type FunnelFillValues = Partial<Readonly<Record<FunnelFill, string | null>>>;

/** What a blank becomes when it has no value: the sentence still reads. */
const MISSING: Readonly<Record<FunnelFill, string>> = {
  first_name: 'there',
  session_time: 'your session',
  join_link: '',
  business: 'us',
};

/** The blanks a message uses, in order, once each. */
export function funnelBlanks(text: string): FunnelFill[] {
  const out: FunnelFill[] = [];
  for (const m of text.matchAll(/\{([a-z_]+)\}/g)) {
    const key = m[1] as FunnelFill;
    if ((FUNNEL_FILLS as readonly string[]).includes(key) && !out.includes(key)) out.push(key);
  }
  return out;
}

/** Blanks it doesn't know (`{firstname}`), for the steps to point out before they're sent as typed. */
export function funnelUnknownBlanks(text: string): string[] {
  return [...text.matchAll(/\{([^{}\s]{1,40})\}/g)]
    .map((m) => m[1]!)
    .filter((k) => !(FUNNEL_FILLS as readonly string[]).includes(k));
}

export function fillFunnelText(text: string, values: FunnelFillValues): string {
  return text
    .replace(/\{([a-z_]+)\}/g, (whole, key: string) => {
      if (!(FUNNEL_FILLS as readonly string[]).includes(key)) return whole;
      const v = values[key as FunnelFill];
      return v && v.trim() ? v.trim() : MISSING[key as FunnelFill];
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,!?])/g, '$1')
    .trim();
}
