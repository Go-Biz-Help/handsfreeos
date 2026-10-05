/**
 * The fixed fair-housing check (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Fair housing"; Chris, 2026-09-30):
 * words and phrases that state or hint at a preference about who should live somewhere, by the federal Fair Housing
 * Act's protected classes (race, color, religion, sex, disability, familial status, national origin) and the proxies
 * agents are trained to avoid ("safe neighborhood", "good schools", "you'll fit right in"). Each flag says why, and a
 * safer way to say it. A flag is a prompt to look, never a verdict: the agent fixes it or confirms it with a reason.
 * The model checks every draft as well (the worker). Browser-safe and pure: the editor marks the same words.
 */

export const FAIR_HOUSING_WORDS_VERSION = 'fh-words-2';

export const FAIR_HOUSING_CATEGORIES = {
  race_color: 'Race or color',
  national_origin: 'National origin',
  religion: 'Religion',
  sex: 'Sex',
  disability: 'Disability',
  familial_status: 'Children and families',
  steering: 'Steering',
} as const;
export type FairHousingCategory = keyof typeof FAIR_HOUSING_CATEGORIES;

export interface FairHousingFlag {
  /** The words as they appear in the draft. */
  readonly phrase: string;
  readonly category: FairHousingCategory;
  /** Why it could read as a preference. */
  readonly reason: string;
  /** A safer way to say it. */
  readonly safer: string;
}

interface Rule {
  readonly pattern: RegExp;
  readonly category: FairHousingCategory;
  readonly reason: string;
  readonly safer: string;
}

const rule = (
  words: readonly string[],
  category: FairHousingCategory,
  reason: string,
  safer: string,
): Rule => ({
  // Whole words, any case; a phrase's spaces match any run of spaces or a hyphen.
  pattern: new RegExp(
    `\\b(?:${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[ -]+/g, '[\\s-]+')).join('|')})\\b`,
    'gi',
  ),
  category,
  reason,
  safer,
});

const RULES: readonly Rule[] = [
  rule(
    [
      'no kids',
      'no children',
      'adults only',
      'adult only',
      'not suitable for children',
      'not for children',
      'perfect for singles',
      'ideal for singles',
      'perfect for a couple',
      'ideal for a couple',
      'perfect for couples',
      'empty nesters',
      'mature couple',
      'no families',
    ],
    'familial_status',
    'It says who should or shouldn’t live there by whether they have children.',
    'Describe the home itself: its size, its rooms, its features.',
  ),
  rule(
    [
      'family-friendly',
      'great for families',
      'perfect for families',
      'ideal for families',
      // Round three: how a listing's description tends to say it.
      'growing family',
      'perfect for a family',
      'great for a family',
      'ideal for a family',
    ],
    'familial_status',
    'It can read as preferring households with children.',
    'Name what’s there instead: “a fenced yard”, “near a park”.',
  ),
  rule(
    [
      'white neighborhood',
      'black neighborhood',
      'mostly white',
      'predominantly white',
      'predominantly black',
      'ethnic neighborhood',
      'integrated neighborhood',
      'minority neighborhood',
      'racially mixed',
    ],
    'race_color',
    'It describes the people who live there by race or color.',
    'Leave out who lives there; describe the home and what’s nearby.',
  ),
  rule(
    [
      'hispanic neighborhood',
      'latino neighborhood',
      'asian neighborhood',
      'immigrant neighborhood',
      'english speaking',
      'english-speaking only',
      'no foreigners',
      'american family',
    ],
    'national_origin',
    'It describes or prefers people by where they or their families are from.',
    'Leave out who lives there; describe the home and what’s nearby.',
  ),
  rule(
    [
      'christian neighborhood',
      'christian community',
      'jewish neighborhood',
      'jewish community',
      'muslim neighborhood',
      'muslim community',
      'catholic neighborhood',
      'near your church',
      'near your synagogue',
      'near your mosque',
      'your kind of church',
    ],
    'religion',
    'It ties the home to a religion, or to one the client practices.',
    'Name places by their name and distance only if the client asked about them.',
  ),
  rule(
    [
      'bachelor pad',
      'perfect for a bachelor',
      'single woman',
      'single man',
      'female only',
      'male only',
      'women only',
      'men only',
      'man cave',
    ],
    'sex',
    'It suggests the home suits one sex over another.',
    'Describe the room or home by what it is: “a finished basement”, “a studio”.',
  ),
  rule(
    [
      'able-bodied',
      'no wheelchairs',
      'handicapped',
      'not suitable for the disabled',
      'no disabled',
      'must be able to climb',
      'mentally ill',
      'healthy people',
    ],
    'disability',
    'It suggests people with a disability aren’t wanted or wouldn’t fit.',
    'Describe the features instead: “two flights of stairs”, “step-free entry”.',
  ),
  rule(
    [
      'safe neighborhood',
      'safe area',
      'safer neighborhood',
      'low crime',
      'crime-free',
      'good schools',
      'best schools',
      'better schools',
      'good neighborhood',
      'bad neighborhood',
      'the right kind of people',
      'people like you',
      'you’ll fit right in',
      "you'll fit right in",
      'you will fit in',
      'exclusive neighborhood',
      'changing neighborhood',
      'desirable neighborhood',
    ],
    'steering',
    'It can steer a buyer toward or away from an area by who lives there, rather than by facts they can check.',
    'Point to facts the client can check themselves: the school district’s own reports, the police department’s crime maps.',
  ),
];

/** Every flag in a draft's words, in the order they appear, each phrase once. */
export function checkWords(text: string): FairHousingFlag[] {
  const found: { at: number; flag: FairHousingFlag }[] = [];
  const seen = new Set<string>();
  for (const r of RULES)
    for (const m of text.matchAll(r.pattern)) {
      const phrase = m[0];
      if (seen.has(phrase.toLowerCase())) continue;
      seen.add(phrase.toLowerCase());
      found.push({
        at: m.index ?? 0,
        flag: { phrase, category: r.category, reason: r.reason, safer: r.safer },
      });
    }
  return found.sort((a, b) => a.at - b.at).map((f) => f.flag);
}
