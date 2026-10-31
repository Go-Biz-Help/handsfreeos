/**
 * How Sales Coach sells: the question-led method (docs/salescoach.md, "The question-led method"; Chris, 2026-10-31).
 * Browser-safe: the screens show the stages and the builder's questions, and the prompts read the same rules.
 *
 * The rep asks more than they tell. Calm, curious questions let the customer say what they have now, what's wrong
 * with it, what they want instead, what waiting would cost and how much it matters, in their own words. Only then
 * does the rep show how the business fixes the problems the customer named, and ask whether it feels right. The
 * customer talks themselves into changing, so there's little to push and little to argue.
 *
 * Written in HandsFreeOS's own words from the owner's sales training. It names no outside program and copies none of
 * its text (the owner's decision), and it leaves out tricks that make people think the rep is someone they're not.
 */

/** The stages of a call, in order. A script step names the one it belongs to, so the coach knows where the call is. */
export const SALES_STAGES = [
  'connect',
  'situation',
  'problem',
  'future',
  'consequence',
  'importance',
  'bridge',
  'present',
  'commit',
] as const;
export type SalesStage = (typeof SALES_STAGES)[number];

export const SALES_STAGE_LABELS: Readonly<Record<SalesStage, string>> = {
  connect: 'Connect',
  situation: 'Their situation',
  problem: 'The problem',
  future: 'What they want',
  consequence: 'If nothing changes',
  importance: 'How much it matters',
  bridge: 'Bridge',
  present: 'Show how',
  commit: 'Ask for a yes',
};

/** What each stage is for: the screens show it under the stage, and the AI writes each step to do it. */
export const SALES_STAGE_ABOUT: Readonly<Record<SalesStage, string>> = {
  connect:
    'Lower their guard. Say plainly who you are and why you’re calling, ask what made them reach out, and say the call is just to see where they are, where they want to be and whether you can help.',
  situation:
    'Learn what they have and do now, and for how long, so you both see it clearly. Plain facts, asked with interest.',
  problem:
    'Help them find what isn’t working and how it affects them. Ask what they like and don’t like, then “what do you mean by that?” and “how long has that been going on?”',
  future:
    'Help them picture it fixed. What they’ve tried, what they’d want instead, why it matters now, and what it would mean for them.',
  consequence:
    'Ask, with real concern, what happens if nothing changes, built only from what they told you.',
  importance:
    'Ask how important it is to them to fix it, and why now. Their answer tells you whether to go on.',
  bridge:
    'Sum up in their words what they want, the problem in the way, and how it’s been making them feel. Then ask if they’d like to see how you could help.',
  present:
    'Show only how you fix the problems they named: the problem, how you solve it, what it means for them. Check in often: “Does that make sense?”',
  commit:
    'Ask how they feel about it (“Do you feel this could be what you’re looking for? Why?”), then agree the next step together.',
};

/**
 * The kinds of call the builder writes a script for, each with its own opening. The rest of the call follows the
 * same stages. `estimate`, `follow_up` and `any` keep their place for scripts written before.
 */
export const CALL_OPENINGS = {
  cold_call:
    'Nobody asked for this call. Say who you are and the business, then ask if they could help you out for a moment. Then ask whether they’d be open to looking at any gaps in what they have now that might be costing them. If they ask what it’s about, give a short line: “You know how a lot of [their kind of business] get frustrated with [three common problems]? We help with that.” Then ask whether that sounds like them.',
  new_lead:
    'They asked to be called, recently. Say who you are and that they asked about [what they asked about] so they could [the result they want], and check that’s right. Ask what caught their eye, and whether they know what they’re looking for. Then say what the call is for and ask if that would help.',
  aged_lead:
    'They asked a while ago and may not remember. Say who you are, slowly. Say it looks like they asked about [what they asked about] some time back and it was never followed up, and ask whether they found what they were looking for or are still looking. Never act as if they should know you.',
  booked_call:
    'They booked this time. Thank them, say it looks like they booked about [what they booked for] so they could [the result they want], and check that’s right. Ask what made them book, say what the call is for, and ask what they hope to get from it.',
  first_call:
    'A first call with someone new. Say who you are, ask what made them reach out, and say what the call is for.',
  estimate:
    'Going over an estimate. Remind them what they asked for and why, check nothing has changed, then present only what fixes what they told you.',
  follow_up:
    'Following up. Remind them where you left off in their words, and ask what has changed since.',
  any: 'Open as the call needs: who you are, why you’re calling, and what the call is for.',
} as const;
export type CallOpeningKind = keyof typeof CALL_OPENINGS;

/** The kinds the builder offers, in order: one script each. */
export const BUILDER_KINDS = ['new_lead', 'booked_call', 'aged_lead', 'cold_call'] as const;
export type BuilderKind = (typeof BUILDER_KINDS)[number];

/** How the coach and the scripts sound and what they never do: every Sales Coach prompt reads these. */
export const METHOD_RULES = [
  'Sell by asking, not telling. The customer talks most; the rep asks one short question at a time and listens.',
  'Build each question from what the customer just said, in their own words: “You said the job boards bring the wrong people. What do you mean by that?”',
  'Sound calm, curious and a little concerned, never eager or pushy. Slow down on the big questions. Small cues like “oh, and…” or “I see, and…” join one question to the next so it sounds like a talk, not a script. Softeners like “probably a silly question, but…” take the pressure off.',
  'Let the customer say why they want to change. Never tell them they have a problem; ask until they say it.',
  'Ask what happens if nothing changes only from what they told you, with real concern. Never invent deadlines, urgency, scarcity or scary facts.',
  'Present only to the problems they named: the problem, how the business solves it, what that means for them. Check in as you go. No long pitch, no claim to be the best.',
  'Ask how they feel, not what they think: “Do you feel this could be what you’re looking for?” When they sound unsure, ask about it gently before going on.',
  'Never mislead. Say who you are and why you’re calling. Never act as if they should already know you, pose as anyone official, or use props or tricks to seem like something you’re not.',
  'Never suggest they borrow, use a credit card or loan, or take money from savings or retirement to pay. Offer only the payment options the business has said it has.',
];

/** How objections are answered: by asking, the same way. The builder writes each answer like this. */
export const OBJECTION_RULES = [
  'An objection is a concern, not a no. Don’t argue or rush to facts.',
  'First clarify: ask what they mean and what’s behind it (“When you say it’s a lot, how do you mean?”).',
  'Then talk it over together, like two people on the same side.',
  'Then let them solve it with a question: “Suppose there were a way to…, would that help?” or “How do you see yourself handling that so you can [what they said they wanted]?”',
  '“Send me some information”, “just send a quote”, “call me back” and “I need to think it over”: say that’s fine, ask what they’d want to see or go over, and book a set time to talk again.',
  '“I need to talk to my partner”: ask what they think their partner will want to know, and offer a time when both can be there.',
];

/**
 * What the builder asks the owner, so a script fits what they sell (Chris, 2026-10-31: "it builds from what
 * HandsFreeOS knows, then asks 5 or 6 short questions to fill gaps"). The AI answers what it can from the business's
 * profile and knowledge first; the owner fills in or fixes the rest.
 */
export const SALES_BRIEF_KEYS = [
  'offer',
  'buyers',
  'problems',
  'result',
  'why',
  'nextStep',
] as const;
export type SalesBriefKey = (typeof SALES_BRIEF_KEYS)[number];

export const SALES_BRIEF_QUESTIONS: Readonly<
  Record<SalesBriefKey, { readonly ask: string; readonly hint: string }>
> = {
  offer: {
    ask: 'What do you sell on these calls?',
    hint: 'The main service or product, in a sentence.',
  },
  buyers: {
    ask: 'Who buys it?',
    hint: 'Homeowners, landlords, small businesses, families…',
  },
  problems: {
    ask: 'What problems do they usually have before they call you?',
    hint: 'Two or three, in the words customers use.',
  },
  result: {
    ask: 'What result do they want?',
    hint: 'What changes for them once it’s fixed.',
  },
  why: {
    ask: 'Why do people pick you over others?',
    hint: 'What you do that others don’t.',
  },
  nextStep: {
    ask: 'What’s the next step when a call goes well?',
    hint: 'Book a visit, send an estimate, book a demo, take payment…',
  },
};

/** Each answer's longest. */
export const SALES_BRIEF_MAX = 400;

// ---------- on a call (round five, part two) ----------

/** A script step as far as the stages go: its id, and the stage it belongs to when it names one. */
interface StagedStep {
  readonly id: string;
  readonly stage: SalesStage | null;
}

/** The stages a script's steps name, in the method's order. Empty for a script written before stages. */
export function playbookStages(steps: readonly StagedStep[]): SalesStage[] {
  const named = new Set(steps.flatMap((s) => (s.stage ? [s.stage] : [])));
  return SALES_STAGES.filter((st) => named.has(st));
}

/**
 * The stage the call is in at a step: the step's own, else the nearest one before it that names one (a step left
 * without a stage carries on the stage before). Null before the first step, or with no stages at all.
 */
export function stageAt(steps: readonly StagedStep[], stepId: string | null): SalesStage | null {
  const at = steps.findIndex((s) => s.id === stepId);
  for (let i = at; i >= 0; i--) if (steps[i]!.stage) return steps[i]!.stage;
  return null;
}

/** A lead whose newest open lead is this many days old or less is new; older is an older lead. */
export const NEW_LEAD_DAYS = 14;

/** How a call started, as far as the coach can tell, so it opens with the script for it. */
export interface CallStart {
  /** A HandsFreeOS video call or a Zoom meeting: someone booked it. */
  readonly meeting: boolean;
  /** A phone call's way; null for a meeting. */
  readonly direction: 'inbound' | 'outbound' | null;
  /** The customer has an appointment with the business starting within half an hour of now. */
  readonly booked: boolean;
  /** The call is with someone the business has on file. */
  readonly known: boolean;
  /** Days since their newest open lead was made; null with no open lead. */
  readonly leadAgeDays: number | null;
}

/**
 * The kind of script a call wants (Chris, 2026-10-31: one script per kind of call): a booked call for a meeting or a
 * call at an appointment's time, and for a call the rep made, a new lead, an older lead or a cold call. A call the
 * customer made, or a call to a customer with no open lead, wants the usual script: null.
 */
export function callKindFor(start: CallStart): BuilderKind | null {
  if (start.meeting || start.booked) return 'booked_call';
  if (start.direction !== 'outbound') return null;
  if (start.leadAgeDays !== null)
    return start.leadAgeDays <= NEW_LEAD_DAYS ? 'new_lead' : 'aged_lead';
  return start.known ? null : 'cold_call';
}
