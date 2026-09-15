/**
 * Hot-lead signals as explainable rules (AI intent scoring can come later). Browser-safe.
 * - `readyToBook`: the customer's words say they want to go ahead: book, schedule, available, come out, how soon,
 *   today or tomorrow (when they're asking for someone), ASAP, a quote… "Not ready to schedule" doesn't count, nor
 *   does "we went with someone else", nor anything with an opt-out in it.
 * - `repeatCustomer`: they've bought, or been seen, before.
 * - `cameInToday`: the lead arrived today in the business's time zone.
 */
import { optOutPhrase, plainSmsText } from '../ai-team/guardrails';
import { addDays, localDateOf, localInstant } from '../calendar/engine/zoned';

const SHORTHAND: readonly (readonly [RegExp, string])[] = [
  [/\b(?:tmrw|tmrow|tmrrw|tmr|tmw|2morrow|2moro|tomorow|tommorow|tommorrow)\b/g, 'tomorrow'],
  [/\b2day\b/g, 'today'],
  [/\b(?:2nite|tonite)\b/g, 'tonight'],
  [/\bu\b/g, 'you'],
  [/\bur\b/g, 'your'],
  [/\b(?:pls|plz)\b/g, 'please'],
  [/\bappt\b/g, 'appointment'],
];

/** Lower case, plain punctuation, one space between words, texting shorthand spelled out. */
function words(text: string): string {
  let t = plainSmsText(text.normalize('NFKC')).toLowerCase().replace(/\s+/g, ' ');
  for (const [re, to] of SHORTHAND) t = t.replace(re, to);
  return t;
}

/** A "not" in one clause doesn't reach the next. */
const clauses = (t: string) =>
  t
    .split(/[.!?;,\n]+|\s+but\s+|\s+-\s+/)
    .map((c) => c.trim())
    .filter(Boolean);

const NEGATION =
  /\b(?:not|no|never|don't|dont|do not|doesn't|doesnt|didn't|didnt|won't|wont|can't|cant|cannot|isn't|aren't|wasn't|without)\b/;

const PERSON = String.raw`(?:someone|somebody|anyone|anybody|a\s+tech(?:nician)?|a\s+guy|a\s+plumber|an?\s+electrician|a\s+crew)\b`;
const DAY_WORD = String.raw`(?:today|tonight|tomorrow|this\s+(?:morning|afternoon|evening|week|weekend)|(?:mon|tues|wednes|thurs|fri|satur|sun)day)`;

interface Rule {
  readonly re: RegExp;
  /** The rule doesn't count in a clause that also matches this. */
  readonly unless?: RegExp;
}

/** Wording that says they want to go ahead, on its own. */
const STRONG: readonly Rule[] = [
  { re: /\b(?:book|booking|schedule|scheduling|reserve)\b/ },
  {
    re: /\b(?:make|set\s+up|get|need|want|like|request|have)\s+(?:(?:a|an|another|the)\s+)?appointment\b/,
  },
  { re: new RegExp(String.raw`\bappointment\s+(?:for|on|at|${DAY_WORD})\b`) },
  { re: /\bset\s+up\s+(?:a|an)\s+(?:time|visit|call|service\s+call)\b/ },
  {
    re: /\b(?:you|y'all|anyone|anybody|someone|somebody|guys|techs?|there)\s+(?:be\s+)?(?:available|free)\b(?!\s+to\s+(?:talk|chat))/,
  },
  { re: /\bavailability\b/ },
  {
    re: new RegExp(
      String.raw`\bavailable\s+(?:${DAY_WORD}|next|on|at|to\s+come|for\s+(?:a|an)\s+(?:appointment|visit|service))\b`,
    ),
  },
  { re: /\bopenings?\b/ },
  { re: /\bsame[\s-]day\b/ },
  {
    re: /\bcome\s+(?:out|by|over|look|take\s+a\s+look|check|fix|see|and\s+(?:look|check|fix|see|take))\b/,
  },
  { re: /\b(?:swing|stop|drop)\s+by\b/ },
  { re: new RegExp(String.raw`\bsend\s+(?:out\s+)?${PERSON}`) },
  {
    re: new RegExp(
      String.raw`\b(?:need|get|have)\s+${PERSON}\s+(?:to\s+)?(?:come|out|over|here|look|check|fix|take)\b`,
    ),
  },
  { re: /\bhow\s+(?:soon|quickly|fast|early)\b/ },
  { re: /\b(?:soonest|earliest)\b/ },
  {
    re: new RegExp(
      String.raw`\bwhen\s+(?:can|could|would|will)\s+(?:you\b|y'all\b|i\s+get\b|we\s+get\b|${PERSON})`,
    ),
  },
  { re: /\bnext\s+(?:available|opening)\b/ },
  { re: /\basap\b|\bas\s+soon\s+as\s+(?:possible|you\s+can)\b|\bright\s+away\b|\bimmediately\b/ },
  {
    re: /\b(?:get|need|want|like|looking\s+for|send|give|request|have|free)\s+(?:(?:me|us)\s+)?(?:(?:a|an|the|some|your)\s+)?(?:[\w-]+\s+){0,3}?(?:quote|estimate|bid)s?\b/,
  },
  { re: /\b(?:quote|estimate|bid)s?\s+(?:for|on)\b/ },
  { re: /\bpric(?:e|es|ing)\s+(?:for|on)\b/ },
  {
    re: /\bhow\s+much\s+(?:would|will|does|do|is|for|to)\b/,
    unless: /\b(?:owe|owed|invoice|bill|billed|charged|paid|receipt|balance)\b/,
  },
  { re: /\b(?:i'm|im|i\s+am|we're|we\s+are)\s+ready\b/ },
  {
    re: /\bready\s+to\s+(?:go|book|schedule|move\s+forward|get\s+started|start|buy|sign|do\s+it)\b/,
  },
  {
    re: /\b(?:let's|lets)\s+(?:do\s+it|do\s+this|go\s+ahead|get\s+(?:it|this|you)\s+(?:on|scheduled|booked|going|started|done))\b/,
  },
  { re: /\bgo\s+ahead\s+(?:and|with)\b/ },
  { re: /\bsign\s+(?:me|us)\s+up\b/ },
  { re: /\bmove\s+forward\b/ },
  { re: /\b(?:fit|squeeze|get)\s+(?:me|us)\s+in\b/ },
  {
    re: /\binterested\s+in\s+(?:a|an|getting|having|the|your|new|replacing|installing|booking|scheduling)\b/,
  },
  {
    re: /\bneeds?\s+(?:[\w']+\s+){0,4}?(?:fixed|repaired|replaced|installed|serviced|looked\s+at|checked|cleaned|tuned\s+up|inspected)\b/,
  },
];

/** "Today", "tomorrow", "this week", "Thursday": they count when the same clause asks for someone or a time. */
const TIMING = new RegExp(String.raw`\b${DAY_WORD}\b`);
const TIMING_ASK = new RegExp(
  String.raw`\b(?:can|could|would|will)\s+(?:you\b|y'all\b|${PERSON})\s*(?:[\w']+\s+)?(?:come|do|make|fit|get|be|send|swing|stop|squeeze|check|look|fix|help|service|see)\b|\bneeds?\b|\bneeded\b|\bcome\b|\bfix\b|\bcheck\b|\blook\s+at\b|\bopen\b|\bslots?\b|\bspots?\b|\bhave\s+time\b`,
);

/** Wording that rules the whole message out. */
const NOT_BUYING: readonly RegExp[] = [
  /\b(?:went|going|gone|go)\s+with\s+(?:someone|somebody|another|a\s+different|other|them|a\s+competitor)\b/,
  /\b(?:booked|hired|scheduled|found|chose|picked)\s+(?:with\s+)?(?:someone|somebody|another|a\s+different|other)\b/,
  /\bnot\s+interested\b/,
  /\bnever\s?mind\b/,
  /\bjust\s+(?:browsing|curious)\b|\bjust\s+looking(?!\s+(?:for|to|into))\b/,
  /\b(?:already|all)\s+(?:fixed|taken\s+care\s+of|sorted)\b|\bgot\s+it\s+(?:fixed|working|sorted)\b/,
  /\bno\s+longer\s+need\b/,
];

function strongIn(clause: string): boolean {
  return STRONG.some(({ re, unless }) => {
    const m = re.exec(clause);
    return (
      m !== null && !(unless && unless.test(clause)) && !NEGATION.test(clause.slice(0, m.index))
    );
  });
}

function timingIn(clause: string): boolean {
  const when = TIMING.exec(clause);
  const ask = TIMING_ASK.exec(clause);
  if (!when || !ask) return false;
  return !NEGATION.test(clause.slice(0, Math.max(when.index, ask.index)));
}

/** The customer's words say they're ready to book (a strong hot-lead signal). */
export function readyToBook(text: string | null | undefined): boolean {
  if (!text?.trim()) return false;
  if (optOutPhrase(text)) return false;
  const t = words(text);
  if (NOT_BUYING.some((re) => re.test(t))) return false;
  return clauses(t).some((c) => strongIn(c) || timingIn(c));
}

export interface RepeatCustomerFacts {
  /** Won leads for the same customer, not counting this one. */
  readonly otherWonLeads: number;
  /** Appointments they came to before now (attended, or completed). */
  readonly pastVisits: number;
}

/** They've bought, or been seen, before (a weak hot-lead signal). */
export function repeatCustomer(facts: RepeatCustomerFacts): boolean {
  return facts.otherWonLeads > 0 || facts.pastVisits > 0;
}

const msOf = (now: Date | number) => (typeof now === 'number' ? now : now.getTime());

/** The lead arrived today in the business's time zone (a weak hot-lead signal; never for an import). */
export function cameInToday(createdAt: string, timeZone: string, now: Date | number): boolean {
  return localDateOf(Date.parse(createdAt), timeZone) === localDateOf(msOf(now), timeZone);
}

/** The next local midnight after `now`, when "came in today" stops counting. */
export function nextLocalMidnight(now: Date | number, timeZone: string): number {
  return localInstant(addDays(localDateOf(msOf(now), timeZone), 1), '00:00', timeZone);
}
