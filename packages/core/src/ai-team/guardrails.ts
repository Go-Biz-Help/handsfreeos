/**
 * The teammate's safety rules in code, not only in the prompt. Pure and deterministic.
 *
 * - `checkTeammateReply` runs before any draft is shown or message sent: length, links, phone numbers and
 *   emails, money, leftover placeholders, false "you're booked" claims, and disclosure. A failing reply
 *   gets one rewrite (its problems go back to the model), then goes to a person.
 * - The detectors read each customer message: a sincere "are you a bot?", asking for a person,
 *   frustration, plain-language opt-outs, emergencies and sensitive topics.
 *
 * Browser-safe: the builder's test console shows the same verdicts the worker acts on.
 */
import { normalizePhone } from '../crm/phone';
import { smsKeyword } from '../messaging/sms';
import type { DisclosureMode, TeammateChannel } from './config';

// ---- Plain text ----

/** A character class from code points, so no invisible characters sit in the source. */
const charClass = (...codes: number[]) => new RegExp(`[${String.fromCodePoint(...codes)}]`, 'g');
/** ‘ ’ ‚ ‛ ′ */
const SINGLE_QUOTES = charClass(0x2018, 0x2019, 0x201a, 0x201b, 0x2032);
/** “ ” „ ‟ ″ */
const DOUBLE_QUOTES = charClass(0x201c, 0x201d, 0x201e, 0x201f, 0x2033);
/** Figure dash, en dash, em dash, horizontal bar, minus sign. */
const DASHES = charClass(0x2012, 0x2013, 0x2014, 0x2015, 0x2212);
const ELLIPSIS = charClass(0x2026);
/** No-break, en, em, figure, thin, hair and narrow no-break spaces. */
const ODD_SPACES = charClass(0x00a0, 0x2002, 0x2003, 0x2007, 0x2009, 0x200a, 0x202f);
/** Zero-width space, non-joiner and joiner, word joiner, byte-order mark. */
const INVISIBLE = charClass(0x200b, 0x200c, 0x200d, 0x2060, 0xfeff);
/** Look-alike dots: ideographic full stop, halfwidth full stop, one-dot leader, hyphenation point. */
const ODD_DOTS = charClass(0x3002, 0xff61, 0x2024, 0x2027);

/**
 * The plain form of a text: curly quotes, long dashes, ellipses and odd spaces become plain ones and
 * invisible characters go, so it stays in the cheaper GSM-7 encoding. The worker sends this form, and the
 * length check counts it.
 */
export function plainSmsText(text: string): string {
  return text
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, '-')
    .replace(ELLIPSIS, '...')
    .replace(ODD_SPACES, ' ')
    .replace(INVISIBLE, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/** Lower case, plain punctuation, one space between words: what the detectors read. */
function norm(text: string): string {
  return plainSmsText(text.normalize('NFKC')).replace(/\s+/g, ' ').toLowerCase();
}

const sentences = (text: string) => text.split(/(?<=[.!?;])\s+|\n+/);
const anyOf = (list: readonly RegExp[], text: string) => list.some((re) => re.test(text));

// ---- Being honest about being AI ----

const I_AM = String.raw`\b(?:i am|i'm|im)`;
const PADDING = String.raw`(?:(?:definitely|really|actually|totally|truly|absolutely|just|only|still|100%|a|an)\s+)*`;
const HUMAN = String.raw`(?:(?:real|actual|live|genuine)\s+)?(?:human(?:\s+being)?|person)\b`;
const MACHINE = String.raw`(?:a\s+|an\s+)?(?:bot|robot|ai|a\.i\.|machine|computer|chat\s?bot|program|automated|automatic|recording|auto[- ]?reply|virtual assistant|artificial intelligence)(?![a-z])`;
const TALKING = String.raw`(?:talking|chatting|texting|speaking|messaging)\s+(?:to|with)`;

const HUMAN_CLAIMS: readonly RegExp[] = [
  new RegExp(String.raw`${I_AM}\s+${PADDING}${HUMAN}`),
  new RegExp(String.raw`${I_AM}\s+(?:not|no)\s+${MACHINE}`),
  new RegExp(String.raw`\b(?:this|it)\s*(?:is\s+not|isn't|'s\s+not)\s+${MACHINE}`),
  new RegExp(String.raw`\b(?:you're|you are)\s+not\s+${TALKING}\s+${MACHINE}`),
  new RegExp(
    String.raw`\b(?:this is|it's|you're ${TALKING}|you are ${TALKING})\s+${PADDING}${HUMAN}`,
  ),
  new RegExp(String.raw`\b(?:nope|no|definitely|certainly)[,.!]?\s+not\s+${MACHINE}`),
  new RegExp(String.raw`${I_AM}\s+(?:very\s+)?real\b(?=\s*(?:$|[.!,;]|and\b|i promise))`),
];

/** A reply that says (or implies) it's a person, or denies being a bot. Never allowed, whatever the disclosure setting. */
export function claimsHuman(text: string): boolean {
  return anyOf(HUMAN_CLAIMS, norm(text));
}

const DISCLOSURES: readonly RegExp[] = [
  /\b(?:ai|a\.i\.)(?![a-z])/,
  /\bartificial\s+intelligence\b/,
  /\b(?:virtual|automated|digital)\s+(?:assistant|agent|receptionist|helper|teammate)\b/,
  /\bchat\s?bot\b/,
  /\b(?:i am|i'm|im|this is|it's)\s+(?:just\s+)?(?:a|an)\s+(?:bot|robot)\b/,
  /\bnot\s+(?:a\s+)?(?:real\s+)?(?:person|human)\b/,
];

/** A reply that says it's an AI assistant (and doesn't also claim to be a person). */
export function disclosesAi(text: string): boolean {
  return !claimsHuman(text) && anyOf(DISCLOSURES, norm(text));
}

const ASK_TARGET = String.raw`(?:bot|robot|ai[- ](?:generated|written)|ai|a\.i\.|machine|computer|chat\s?bot|chatgpt|gpt|recording|recorded message|auto[- ]?(?:reply|responder|response)|automated(?:\s+(?:message|reply|text|system|response|service))?|automatic(?:\s+(?:message|reply))?|virtual assistant|program|human(?!\s+resources)(?:\s+being)?|person|people|live\s+(?:agent|person)|real\s+(?:person|human|people|one)|real(?=\s*(?:$|[?.!,;]|or\b)))(?![a-z])`;
const ASK_FILL = String.raw`(?:(?:a|an|the|even|really|actually|just|real|actual|live|like|some\s+(?:kind|sort)\s+of)\s+)*`;
const ASKS_IF_HUMAN: readonly RegExp[] = [
  new RegExp(
    String.raw`\b(?:are\s+(?:you|u|ya)|r\s+u|am\s+i\s+${TALKING})\s+${ASK_FILL}${ASK_TARGET}`,
  ),
  new RegExp(
    String.raw`\bis\s+(?:this|that|it)\s+${ASK_FILL}${ASK_TARGET}(?=\s*(?:$|[?.!,;]|or\b))`,
  ),
  /^\s*(?:are\s+you\s+)?(?:a\s+)?(?:bot|robot|ai|human|real person|person|real)\s*\?+\s*$/,
  /\b(?:sound|sounds|talk|talks|write|writes|type|types)\s+like\s+(?:a\s+|an\s+)?(?:bot|robot|ai|machine|computer)\b[^?]*\?/,
];
const EITHER =
  /\b(?:human|person|real)\b[^.?!]{0,25}\bor\b[^.?!]{0,25}\b(?:bot|robot|ai|machine|computer|automated)\b|\b(?:bot|robot|ai|machine|computer|automated)\b[^.?!]{0,25}\bor\b[^.?!]{0,25}\b(?:human|person|real)\b/;
const INSINCERE = /\b(?:jk|j\/k|just kidding|kidding|joking)\b/;

/** A customer sincerely asking whether they're talking to a bot. The answer is always the truth. */
export function asksIfHuman(text: string): boolean {
  const t = norm(text);
  if (INSINCERE.test(t)) return false;
  return anyOf(ASKS_IF_HUMAN, t) || (EITHER.test(t) && t.includes('?'));
}

// ---- Asking for a person, frustration, opting out ----

const PERSON = String.raw`(?:(?:a|an|the|your|some|one\s+of\s+your)\s+)?(?:(?:real|live|actual|human)\s+)?(?:person|human(?!\s+resources)|human\s+being|someone|somebody|anyone|agent|representative|rep|manager|owner|supervisor|operator|staff(?:\s+member)?|team\s+member|people|technician|tech|boss)\b`;
const TALK = String.raw`(?:talk|speak|chat|get\s+through)\s+(?:to|with)`;
const PERSON_ASKS: readonly RegExp[] = [
  new RegExp(
    String.raw`\b(?:want|wanna|need|would\s+like|'d\s+like|id\s+like|let\s+me|lemme|can\s+i|could\s+i|may\s+i|have\s+to|trying\s+to|please)\s+(?:to\s+)?${TALK}\s+${PERSON}`,
  ),
  new RegExp(String.raw`(?:^|[.!?,]\s*)(?:please\s+)?${TALK}\s+${PERSON}`),
  new RegExp(
    String.raw`\b(?:get|give|put|connect|transfer|send|pass)\s+me\s+(?:(?:to|through\s+to|with|over\s+to)\s+)?${PERSON}`,
  ),
  /\b(?:human|real\s+person|live\s+person|live\s+agent|representative|operator|agent|a\s+person|someone)\s*,?\s*(?:please|pls|plz)\b/,
  /^\s*(?:an?\s+)?(?:operator|agent|representative|rep|human|real\s+person|live\s+agent|live\s+person|person|manager)\s*[.!?]*\s*$/,
  /\b(?:have|get|need|want)\s+(?:someone|somebody|a\s+(?:real\s+)?(?:person|human)|the\s+owner|a\s+manager|a\s+tech(?:nician)?)\s+(?:to\s+)?(?:call|text|email|contact|reach\s+out\s+to|get\s+back\s+to)\s+me\b/,
  /\b(?:can|could|would|will)\s+(?:someone|somebody|a\s+(?:real\s+)?(?:person|human)|anyone|the\s+owner|a\s+manager|you)\s+(?:please\s+)?(?:call|phone|ring)\s+me\b/,
  /\bis\s+there\s+(?:(?:a|an)\s+)?(?:(?:real|actual|live)\s+)?(?:person|human|someone|anyone|manager)\s+(?:i\s+can|to|who\s+can)\s+(?:talk|speak|chat)\b/,
  /\b(?:want|need|would\s+like|'d\s+like|wanna)\s+(?:a|an)\s+(?:(?:real|live|actual)\s+)?(?:person|human(?!\s+resources)|manager|agent|representative|supervisor)\b(?!\s+to\s+(?:come|look|fix|check|install|repair|do|be|see))/,
];

/** The customer asks for a person. It always hands over. */
export function asksForPerson(text: string): boolean {
  return anyOf(PERSON_ASKS, norm(text));
}

const FRUSTRATION: readonly RegExp[] = [
  /\b(?:this|that|it)\s+is\s+(?:so\s+|just\s+|absolutely\s+|completely\s+)?(?:ridiculous|unacceptable|absurd|insane|a joke|a nightmare|bs|bullshit)\b/,
  /\btaking\s+(?:forever|so\s+long|way\s+too\s+long)\b/,
  /\b(?:ridiculous|unacceptable|outrageous)\b/,
  /\b(?:i am|i'm|im)\s+(?:so\s+|very\s+|really\s+|extremely\s+|getting\s+|beyond\s+)?(?:frustrated|fed up|annoyed|angry|upset|pissed(?:\s+off)?|livid|furious|irritated|mad)\b/,
  /\bfed\s+up\b/,
  /\b(?:wtf|wth|ffs)\b/,
  /\bwhat\s+the\s+(?:hell|fuck|f)\b/,
  /\b(?:you're|you are|ur)\s+(?:so\s+|completely\s+)?(?:useless|no\s+help|not\s+helping|not\s+listening|stupid|an?\s+idiot|incompetent|a\s+joke)\b/,
  /\b(?:nobody|no\s+one|no-one)\s+(?:is\s+|has\s+|ever\s+)?(?:listening|answering|responding|helping|calls?\s+back|called\s+back|got\s+back|gets\s+back)\b/,
  /\b(?:are|r)\s+(?:you|u)\s+(?:even\s+)?(?:listening|reading)\b/,
  /\b(?:waste|wasting|wasted)\s+(?:of\s+)?(?:my\s+)?time\b/,
  /\b(?:worst|terrible|horrible|awful|lousy|pathetic)\s+(?:customer\s+)?(?:service|experience|company|communication|business|support)\b/,
  /\b(?:done|finished)\s+with\s+(?:you|your\s+company|this\s+company)\b/,
  /\bfor\s+the\s+(?:second|third|fourth|fifth|last|\d+(?:st|nd|rd|th)?)\s+time\b/,
  /\bhow\s+many\s+times\s+(?:do|have|must|will)\b/,
  /\b(?:asked|told|called|texted|messaged)\s+(?:you\s+)?(?:two|three|four|five|several|multiple|many|\d+)\s+times\b/,
  /\b(?:i've|i have|ive)\s+been\s+waiting\s+(?:for\s+)?(?:\d+|a|an|two|three|several|all|over)\s+(?:\w+\s+)?(?:hours?|days?|weeks?|morning|afternoon)\b/,
  /\bstill\s+(?:no\s+(?:reply|response|answer|word|call)|haven't\s+heard|waiting\s+(?:for|on)\s+(?:a|an|your)\s+(?:reply|response|answer|call|callback))\b/,
  /\?{3,}/,
];

/** Common all-caps words that aren't shouting. */
const ACRONYMS = new Set(
  'HVAC AC ASAP OK USA TV AM PM ZIP SEER BTU CO LED FAQ ETA ID LLC INC DIY GPS EV IAQ UV ERV HRV MERV PSI GFCI RV AI SMS PDF'.split(
    ' ',
  ),
);

function shouting(text: string): boolean {
  const words = text.match(/[A-Za-z']+/g) ?? [];
  const loud = words.filter(
    (w) => w.length >= 3 && /[A-Z]/.test(w) && w === w.toUpperCase() && !ACRONYMS.has(w),
  );
  return loud.length >= 3 && loud.length * 2 >= words.length;
}

/** The customer sounds frustrated (with the handOff.onFrustration setting on, it hands over). */
export function looksFrustrated(text: string): boolean {
  return anyOf(FRUSTRATION, norm(text)) || shouting(plainSmsText(text));
}

const ENDISH = String.raw`(?=\s*(?:$|[.!,;]|please|pls|now|immediately|thanks|thank you|already|forever|and\b|or\b|ever|anymore|any\s*more|again|asap))`;
const OPT_OUTS: readonly RegExp[] = [
  new RegExp(
    String.raw`\b(?:please\s+)?(?:stop|quit|cease)\s+(?:texting|messaging|contacting|emailing|calling|spamming|bothering)(?:\s+(?:me|us|this\s+number))?${ENDISH}`,
  ),
  new RegExp(
    String.raw`\b(?:stop|quit)\s+sending\s+(?:me\s+)?(?:texts|messages|emails|these)${ENDISH}`,
  ),
  new RegExp(
    String.raw`\b(?:don't|dont|do\s+not|never)\s+(?:text|message|contact|email|call)\s+(?:me|us|this\s+number)(?:\s+(?:again|anymore|any\s*more|ever\s+again))?${ENDISH}`,
  ),
  /\b(?:remove|take)\s+me\s+(?:off|from)\s+(?:of\s+)?(?:your|the|this)\s+(?:list|texts|contacts|contact\s+list|mailing\s+list|texting\s+list|database)\b/,
  /\bunsubscribe\b/,
  /\bopt\s*(?:me\s+)?out\b/,
  /\b(?:don't|dont|do\s+not)\s+want\s+(?:any\s*more\s+|these\s+|your\s+|any\s+)?(?:texts|messages|emails)\b/,
  /\bno\s+more\s+(?:texts|messages|emails|texting)\b/,
  /\bleave\s+me\s+alone\b/,
  /\b(?:lose|delete|forget|erase)\s+my\s+(?:number|phone\s+number|email)\b/,
];

/**
 * A request to stop being contacted, in plain words ("stop texting me", "unsubscribe") or as a carrier
 * keyword (STOP): the matched words, or null. Any reasonable request to stop counts, so it opts them out.
 */
export function optOutPhrase(text: string): string | null {
  if (smsKeyword(text) === 'stop') return text.trim();
  const t = norm(text);
  for (const re of OPT_OUTS) {
    const m = re.exec(t);
    if (m) return m[0].trim();
  }
  return null;
}

// ---- Emergencies and sensitive topics ----

export const EMERGENCY_KINDS = ['gas', 'carbon_monoxide', 'fire', 'flooding', 'injury'] as const;
export type EmergencyKind = (typeof EMERGENCY_KINDS)[number];

const EMERGENCIES: readonly (readonly [EmergencyKind, RegExp])[] = [
  [
    'gas',
    /\b(?:smell|smells|smelling|smelled|smelt|odor|odour|whiff)\s+(?:of\s+|like\s+)?(?:natural\s+)?gas\b/,
  ],
  ['gas', /\bgas\s+(?:smell|odor|odour|leak|leaking)s?\b|\bleaking\s+gas\b/],
  [
    'gas',
    /\b(?:rotten[- ]eggs?|sulfur|sulphur)\s+(?:smell|odor|odour)\b|\bsmells?\s+like\s+(?:rotten\s+)?eggs?\b/,
  ],
  ['carbon_monoxide', /\bcarbon\s+monoxide\b/],
  [
    'carbon_monoxide',
    /\bco\s+(?:alarm|detector|monitor|sensor)s?\s+(?:is\s+|are\s+|keeps\s+|just\s+)?(?:going\s+off|went\s+off|goes\s+off|beeping|sounding|alarming|ringing)\b/,
  ],
  [
    'fire',
    /\b(?:on\s+fire|caught\s+(?:on\s+)?fire)\b|\bfire\s+(?:in|inside|coming|started|from|behind|under)\b/,
  ],
  ['fire', /\bflames\b/],
  [
    'fire',
    /\bsmoke\s+(?:is\s+)?(?:coming|pouring|billowing|from|out\s+of)\b|\bsmoke\s+in\s+the\s+(?:house|room|attic|basement|kitchen)\b|\b(?:is|are|it's|keeps)\s+smoking\b/,
  ],
  [
    'fire',
    /\b(?:burning|burnt)\s+(?:smell|odor|odour)\b|\bsmells?\s+like\s+(?:something\s+)?(?:is\s+)?burning\b|\bsmell\s+of\s+burning\b/,
  ],
  ['fire', /\bsparks?\s+(?:flying|coming|from|out)\b|\bsparking\b/],
  ['flooding', /\bflooding\b|\b(?:is|are|got|getting|keeps|been)\s+flooded\b/],
  [
    'flooding',
    /\bwater\s+(?:is\s+)?(?:everywhere|pouring|gushing|spraying|flooding|coming\s+(?:through|from|in\s+through)\s+the\s+(?:ceiling|wall|light))\b/,
  ],
  [
    'flooding',
    /\b(?:burst|broken|busted|exploded)\s+(?:water\s+)?pipes?\b|\bpipes?\s+(?:burst|exploded|broke)\b/,
  ],
  ['flooding', /\bceiling\s+(?:is\s+)?(?:collapsing|caving|falling)\b/],
  [
    'injury',
    /\b(?:someone|somebody|he|she|they|i|we|my\s+(?:son|daughter|husband|wife|kid|child|baby|dad|mom|father|mother|friend|neighbor|brother|sister|partner|tech))(?:\s+(?:is|got|was|has\s+been|have\s+been|am|are)|'s|'m|'re)\s+(?:badly\s+|really\s+|seriously\s+|been\s+)?(?:hurt|injured|electrocuted|burned|burnt|unconscious|bleeding)\b/,
  ],
  ['injury', /\b(?:got|getting|been)\s+electrocuted\b/],
  [
    'injury',
    /\bgot\s+(?:an?\s+)?(?:electric(?:al)?\s+)?shock(?:ed)?\s+(?:from|by|off)\s+(?:the\s+|a\s+|an\s+)?(?:panel|outlet|unit|wire|wiring|breaker|furnace|ac|a\/c|heater|box|switch)\b/,
  ],
  ['injury', /\b(?:can't|cannot|can\s+not)\s+breathe\b|\bnot\s+breathing\b|\bpassed\s+out\b/],
  ['injury', /\b(?:call(?:ed|ing)?|need)\s+(?:an?\s+)?ambulance\b/],
];

/** "Do you fix gas leaks?" asks about a service; it isn't one. Checked before the hazard, in its sentence. */
const SERVICE_QUESTION =
  /\b(?:do|does|can|could|will|would)\s+(?:you|y'all|your\s+(?:company|team|guys|techs?))\s+(?:guys\s+)?(?:fix|repair|handle|service|work\s+on|install|check|detect|test|inspect|replace|deal\s+with|offer|sell|do|come\s+out\s+for)\b|\bhow\s+much\b|\bwhat\s+(?:does|do)\b[^.?!]*\bcost\b/;

/** What kind of emergency a message describes: a gas smell, carbon monoxide, fire, flooding or someone hurt. */
export function emergencyKind(text: string): EmergencyKind | null {
  for (const sentence of sentences(norm(text)))
    for (const [kind, re] of EMERGENCIES) {
      const m = re.exec(sentence);
      if (m && !SERVICE_QUESTION.test(sentence.slice(0, m.index))) return kind;
    }
  return null;
}

/** The customer describes an emergency: fixed safety text, an urgent alert, and a person takes over. */
export function isEmergency(text: string): boolean {
  return emergencyKind(text) !== null;
}

/** How every safety text ends: the customer knows a person is on it. */
export const EMERGENCY_ALERTED = "We've alerted our team.";

/**
 * The fixed safety text sent for each emergency, whatever the teammate's settings (no AI writes it), in place
 * of the usual hand-off line. Straight apostrophes, so it goes as one plain text, and each ends the same way
 * (EMERGENCY_ALERTED).
 */
export const EMERGENCY_SAFETY_TEXT: Readonly<Record<EmergencyKind, string>> = {
  gas: `If you smell gas, leave the building now. Don't use light switches, phones or anything that could spark inside. Once you're outside, call 911 or your gas company. ${EMERGENCY_ALERTED}`,
  carbon_monoxide: `If a carbon monoxide alarm is going off, get everyone outside into fresh air now and call 911. ${EMERGENCY_ALERTED}`,
  fire: `If there is fire or smoke, get everyone out now and call 911. ${EMERGENCY_ALERTED}`,
  flooding: `Stay away from water near outlets or electrical panels. If it's safe, shut off the main water valve. ${EMERGENCY_ALERTED}`,
  injury: `If someone is hurt, call 911 now. ${EMERGENCY_ALERTED}`,
};

export const SENSITIVE_KINDS = [
  'legal_threat',
  'complaint',
  'refund',
  'cancel_service',
  'custom',
] as const;
export type SensitiveKind = (typeof SENSITIVE_KINDS)[number];

export interface SensitiveTopic {
  readonly kind: SensitiveKind;
  /** For the hand-off note: "a legal threat", or the business's own topic. */
  readonly label: string;
}

const SENSITIVE: readonly (readonly [Exclude<SensitiveKind, 'custom'>, string, RegExp])[] = [
  [
    'legal_threat',
    'a legal threat',
    /\b(?:going\s+to|gonna|will|i'll|plan\s+to|about\s+to|want\s+to)\s+sue\b|\bsue\s+(?:you|your|the\s+company|them)\b|\b(?:my|our)\s+(?:lawyers?|attorneys?)\b|\b(?:contact|call|hire|get)(?:ing)?\s+(?:a|an|my)\s+(?:lawyer|attorney)\b|\blegal\s+action\b|\blawsuit\b|\b(?:see|take)\s+you\s+(?:guys\s+)?(?:to|in)\s+court\b|\bsmall\s+claims\b|\battorney\s+general\b|\bcease\s+and\s+desist\b/,
  ],
  [
    'complaint',
    'a complaint',
    /\b(?:file|filing|make|making|lodge|lodging|submit|submitting|register)\s+(?:a\s+)?(?:formal\s+)?complaint\b|\bcomplain(?:ing)?\s+(?:about|to)\b|\bi\s+have\s+a\s+complaint\b|\b(?:report|reporting)\s+(?:you|this|your\s+(?:company|business))\s+to\b|\b(?:bbb|better\s+business\s+bureau)\b|\b(?:bad|negative|terrible|1[- ]?star|one[- ]star)\s+review\b|\b(?:tech|technician|guy|worker|installer|crew|employee|he|she)\s+(?:was|is|were)\s+(?:so\s+|very\s+|really\s+)?(?:rude|unprofessional|disrespectful)\b|\b(?:you|your\s+(?:tech|technician|guys|crew|installer|worker|team)|the\s+(?:tech|technician|installer|crew|worker))\s+(?:guys\s+)?(?:damaged|broke|ruined|scratched|stained|dented|cracked)\b/,
  ],
  [
    'refund',
    'a refund',
    /\brefund(?:s|ed|ing)?\b|\bmoney\s+back\b|\bcharge\s*back\b|\bdisput(?:e|ing)\s+(?:the|this|a|my)\s+charge\b|\breimburs(?:e|ed|ement)\b/,
  ],
  [
    'cancel_service',
    'cancelling service',
    /\bcancel(?:l?ing|l?ed)?\s+(?:my|our|the)\s+(?:service|services|plan|maintenance\s+plan|membership|contract|agreement|account|subscription|warranty|club|maintenance\s+agreement)\b|\b(?:terminate|end|discontinue)\s+(?:my|our|the)\s+(?:service|services|plan|membership|contract|agreement|account|subscription)\b/,
  ],
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A topic the AI never handles: a legal threat, a complaint, a refund, cancelling service, or one of the
 * business's own topics (handOff.sensitiveTopics). The first found, or null.
 */
export function sensitiveTopic(
  text: string,
  custom: readonly string[] = [],
): SensitiveTopic | null {
  const t = norm(text);
  for (const [kind, label, re] of SENSITIVE) if (re.test(t)) return { kind, label };
  for (const topic of custom) {
    const words = norm(topic);
    if (!words) continue;
    const re = new RegExp(`\\b${escapeRe(words).replace(/ /g, '\\s+')}\\b`);
    if (re.test(t)) return { kind: 'custom', label: topic.trim() };
  }
  return null;
}

// ---- Checking a reply ----

export const REPLY_RULES = [
  'claims_human',
  'disclosure',
  'placeholder',
  'false_claim',
  'money',
  'link',
  'phone',
  'email',
  'length',
] as const;
export type ReplyRule = (typeof REPLY_RULES)[number];

export interface ReplyProblem {
  readonly rule: ReplyRule;
  /** Plain words, for the rewrite and for the person who gets the conversation. */
  readonly message: string;
}

export interface ReplyCheck {
  readonly ok: boolean;
  readonly problems: readonly ReplyProblem[];
}

/** Texts count characters after `plainSmsText`; chat counts characters; email counts words. */
export const REPLY_LIMITS = { sms: 320, chat: 800, emailWords: 200 } as const;

export interface ReplyCheckContext {
  readonly channel: TeammateChannel;
  readonly disclosure: DisclosureMode;
  /** No AI message has gone to this customer in this conversation yet. */
  readonly firstMessage: boolean;
  /** The messages being answered sincerely asked whether it's a bot (`asksIfHuman`). */
  readonly askedIfHuman: boolean;
  readonly allowed: {
    /** The business's website and chat sites: any page on these hosts or their subdomains. */
    readonly domains: readonly string[];
    /** Booking-site addresses: anything under them. */
    readonly urlPrefixes: readonly string[];
    /** Manage links made in this run, exactly. */
    readonly urls: readonly string[];
    /** The business's numbers and this customer's. */
    readonly phones: readonly string[];
    /** The business's addresses and this customer's. */
    readonly emails: readonly string[];
  };
  /** The business profile's allowPrices. */
  readonly allowPrices: boolean;
  /** The text of the knowledge used in this run (items, and the profile's services with prices): prices must come from it. */
  readonly knowledge: readonly string[];
  /** What succeeded in this run. */
  readonly done: {
    readonly booked: boolean;
    readonly rescheduled: boolean;
    readonly cancelled: boolean;
  };
  /** A discount proposed with offer_discount in this run (the reply waits for approval); null when none. */
  readonly discountPercent: number | null;
}

// Placeholders the model left in. "[at]" and "[dot]" disguise an address; the link and email checks catch those.
const PLACEHOLDERS: readonly RegExp[] = [
  /\{\{[^{}]*\}\}/g,
  /\$\{[^{}]*\}/g,
  /\{[A-Za-z_][\w .-]{0,40}\}/g,
  /\[(?!\s*(?:at|dot)\s*\])[^[\]\n]{0,40}[A-Za-z][^[\]\n]{0,40}\]/gi,
  /<[A-Za-z][\w .'-]{0,40}>/g,
  /\bX{2,}(?::X{2})?\b/g,
  /_{3,}/g,
  /%[sd]\b/g,
];

function placeholdersIn(text: string): string[] {
  const found: string[] = [];
  let rest = text;
  for (const re of PLACEHOLDERS)
    rest = rest.replace(re, (m) => {
      found.push(m);
      return ' ';
    });
  return [...new Set(found)];
}

// "You're booked" and friends.
const BOOKED_CLAIMS: readonly RegExp[] = [
  /\bi(?:'ve|\s+have)?\s+(?:just\s+|now\s+|already\s+)?(?:booked|scheduled|reserved)\s+(?:you|your|it|that|the|a|an)\b/,
  /\byou(?:'re|\s+are)\s+(?:now\s+|all\s+)?(?:booked|scheduled|confirmed|reserved)\b/,
  /\byou(?:'re|\s+are)\s+all\s+set\s+for\b/,
  /\byour\s+(?:appointment|visit|booking|service\s+call|tune[- ]?up|time|slot)\s+(?:is|has\s+been|was)\s+(?:now\s+)?(?:booked|confirmed|scheduled|set|reserved)\b/,
  /\b(?:got|have)\s+you\s+(?:down|booked|scheduled|in)\s+for\b/,
  /\bbooked\s+you\s+(?:in|for)\b/,
];
const RESCHEDULED_CLAIMS: readonly RegExp[] = [
  /\bi(?:'ve|\s+have)?\s+(?:just\s+)?(?:moved|rescheduled|changed)\s+(?:your|the)\s+(?:appointment|visit|booking|time)\b/,
  /\byour\s+(?:appointment|visit|booking)\s+(?:is|has\s+been|was)\s+(?:now\s+)?(?:moved|rescheduled|changed)\b/,
];
const CANCELLED_CLAIMS: readonly RegExp[] = [
  /\bi(?:'ve|\s+have)?\s+(?:just\s+)?cancell?ed\s+(?:your|the)\s+(?:appointment|visit|booking)\b/,
  /\byour\s+(?:appointment|visit|booking)\s+(?:is|has\s+been|was)\s+(?:now\s+)?cancell?ed\b/,
];
/** A claim in a sentence that starts "if…", "once…", "before…", or in a question, isn't a claim. */
const HEDGE = /\b(?:if|once|when|whenever|before|after|until|unless|as soon as|so that)\b/;

function claims(text: string, list: readonly RegExp[]): boolean {
  return sentences(text).some((sentence) =>
    list.some((re) => {
      const m = re.exec(sentence);
      if (!m) return false;
      return !HEDGE.test(sentence.slice(0, m.index)) && !sentence.trimEnd().endsWith('?');
    }),
  );
}

// Money.
const AMOUNT_RE =
  /(?:\$|\busd\s?)\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?!\d)|\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?(?:dollars?|bucks|usd)\b/gi;
const PERCENT_RE = /(?<![\d.])(\d+(?:\.\d+)?)\s?(?:%|percent\b|pct\b)/gi;
/** "Free" as money ("free estimates", "at no charge"), not "feel free" or "are you free Thursday". */
const FREE_RE =
  /\bfree\s+(estimates?|quotes?|inspections?|consult(?:ation)?s?|service\s+calls?|diagnostics?|checks?|visits?|trip\s+charges?|installs?|installation|trials?|months?|tune[- ]?ups?|of\s+charge|shipping|delivery|repairs?|labou?r|upgrades?|gifts?|filters?|second\s+opinions?)\b|\bfor\s+free\b|\bno\s+(?:extra\s+|additional\s+)?(?:cost|charge)\b|\bcomplimentary\b|\b(?:is|are|it's|totally|completely|100%)\s+free\b(?!\s+(?:to|of|up|time|now|on|at|this|next|today|tomorrow|all|any|then|after|before|until|anytime|in|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening))/gi;

/** What each "free" is about: 'estimate', 'filter'…, or 'free' when it doesn't say. */
function freeClaims(text: string): string[] {
  return [...text.matchAll(FREE_RE)].map((m) =>
    m[1]
      ? m[1]
          .toLowerCase()
          .replace(/[\s-]+/g, ' ')
          .replace(/s$/, '')
      : 'free',
  );
}
const DISCOUNT_RE =
  /\bdiscount(?:s|ed)?\b|\bcoupons?\b|\bpromo(?:tion)?s?(?:\s+codes?)?\b|(?:\d+\s?(?:%|percent)|\$\s?\d+)\s+off\b/i;
const REFUND_RE = /\brefund(?:s|ed|able|ing)?\b|\bmoney\s+back\b|\breimburs\w*|\bchargebacks?\b/i;

interface Money {
  readonly raw: string;
  readonly cents: number;
}
const cents = (whole: string, frac = '') =>
  Math.round(Number(`${whole.replace(/,/g, '')}${frac ? `.${frac}` : ''}`) * 100);

function amounts(text: string): Money[] {
  return [...text.matchAll(AMOUNT_RE)].map((m) => ({
    raw: m[0].trim(),
    cents: cents(m[1] ?? m[3] ?? '0', m[2] ?? m[4]),
  }));
}
function percents(text: string): Money[] {
  return [...text.matchAll(PERCENT_RE)].map((m) => ({
    raw: m[0].trim(),
    cents: Math.round(Number(m[1]) * 100),
  }));
}

function moneyProblems(text: string, ctx: ReplyCheckContext): string[] {
  const out: string[] = [];
  if (REFUND_RE.test(text)) out.push('It talks about a refund; refunds go to a person');
  const offer = ctx.discountPercent === null ? null : Math.round(ctx.discountPercent * 100);
  if (DISCOUNT_RE.test(text) && offer === null)
    out.push('It offers a discount; only a person can approve one');
  const known = ctx.knowledge.join('\n');
  const knownAmounts = new Set(amounts(known).map((a) => a.cents));
  const knownPercents = new Set(percents(known).map((p) => p.cents));
  const quoted = [
    ...amounts(text).filter((a) => !ctx.allowPrices || !knownAmounts.has(a.cents)),
    ...percents(text).filter(
      (p) => p.cents !== offer && (!ctx.allowPrices || !knownPercents.has(p.cents)),
    ),
  ].map((x) => x.raw);
  if (quoted.length)
    out.push(
      ctx.allowPrices
        ? `It quotes ${[...new Set(quoted)].join(', ')}, which isn’t in the knowledge it used`
        : `It quotes ${[...new Set(quoted)].join(', ')}, and prices aren’t allowed`,
    );
  const free = freeClaims(text);
  const knownFree = freeClaims(known);
  const freeOk =
    ctx.allowPrices &&
    free.every((f) => (f === 'free' ? knownFree.length > 0 : knownFree.includes(f)));
  if (free.length && !freeOk)
    out.push(
      ctx.allowPrices
        ? 'It says something is free, which the knowledge it used doesn’t say'
        : 'It says something is free, and prices aren’t allowed',
    );
  return out;
}

// Links, phone numbers and emails.
const GTLDS =
  'com|net|org|info|biz|io|app|dev|xyz|site|online|store|shop|link|click|top|club|live|page|pro|website|tech|co|us|ai|me|ly';
const TLDS = `${GTLDS}|tv|gl|to|cc|ws|space|fun|life|today|world|email|services|solutions|company|business|agency|digital|media|network|systems|cloud|host|win|bid|loan|work|review|stream|download|men|party|trade|science|mobi|name|travel|jobs|gov|edu|mil|int|[a-z]{2}`;
/** Two-letter endings that are also words: "Thanks.It was great" is a missing space, not a link. */
const SENTENCE_WORDS = new Set(
  'it is in me my no so to we us at be do go hi if or up an as by of on ok am id'.split(' '),
);

/** Writes disguised links and addresses the plain way: "example[.]com", "example dot com", "hxxp://", "name [at] site". */
function unmask(text: string): string {
  return text
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(ODD_DOTS, '.')
    .replace(/\s*[[({<]\s*(?:dot|\.)\s*[\])}>]\s*/gi, '.')
    .replace(/\s*[[({<]\s*at\s*[\])}>]\s*/gi, '@')
    .replace(/\bh(?:xx|\*\*)p(s?):\/\//gi, 'http$1://')
    .replace(
      new RegExp(String.raw`([a-z0-9._%+-]+)\s+at\s+([a-z0-9-]+)\s+dot\s+(${GTLDS})\b`, 'gi'),
      '$1@$2.$3',
    )
    .replace(new RegExp(String.raw`([a-z0-9])\s+dot\s+(?=(?:${GTLDS})\b)`, 'gi'), '$1.')
    .replace(new RegExp(String.raw`([a-z0-9])\s*\.\s+(?=(?:${GTLDS})\b)`, 'g'), '$1.');
}

const URL_RE = /\b(?:https?|ftp):\/\/[^\s<>"'`]+|\bwww\.[^\s<>"'`]+/gi;
const DOMAIN_RE = new RegExp(
  String.raw`(?<![\w@.\-/])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+)(${TLDS})(?![\w-])((?::\d{2,5})?(?:\/[^\s<>"'\`]*)?)`,
  'gi',
);
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
const TRAILING = /[.,!?;:)\]}'"]+$/;

const hostOf = (link: string) =>
  link
    .replace(/^[a-z]+:\/\//i, '')
    .split(/[/?#:]/)[0]!
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.$/, '');
/** https://host/path, lower-case host, no www, no trailing slash. */
function canonical(link: string): string {
  const bare = link.replace(TRAILING, '').replace(/^[a-z]+:\/\//i, '');
  const cut = bare.search(/[/?#]/);
  const host = hostOf(bare);
  const rest = cut < 0 ? '' : bare.slice(cut);
  return `https://${host}${rest}`.replace(/\/$/, '');
}

function linksIn(text: string): string[] {
  const out: string[] = [];
  const rest = text.replace(EMAIL_RE, ' ').replace(URL_RE, (m) => {
    out.push(m.replace(TRAILING, ''));
    return ' ';
  });
  for (const m of rest.matchAll(DOMAIN_RE)) {
    const tld = m[2]!;
    if (/^[A-Z][a-z]$/.test(tld) && SENTENCE_WORDS.has(tld.toLowerCase())) continue;
    out.push(m[0].replace(TRAILING, ''));
  }
  return out;
}

function badLinks(text: string, allowed: ReplyCheckContext['allowed']): string[] {
  const domains = allowed.domains.map(hostOf).filter(Boolean);
  const prefixes = allowed.urlPrefixes.map(canonical);
  const exact = new Set(allowed.urls.map(canonical));
  const bad = new Set<string>();
  for (const link of linksIn(text)) {
    const host = hostOf(link);
    const url = canonical(link);
    const ok =
      domains.some((d) => host === d || host.endsWith(`.${d}`)) ||
      exact.has(url) ||
      prefixes.some((p) => url === p || (url.startsWith(p) && /^[/?#]/.test(url.slice(p.length))));
    if (!ok) bad.add(link);
  }
  return [...bad];
}

const US_PHONE_RE = /(?<![\d+])(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g;
const INTL_PHONE_RE = /(?<![\d+])\+(?!1\b)\d{1,3}[\s.-]?(?:\d[\s.-]?){6,12}\d(?!\d)/g;
const phoneKey = (s: string) => normalizePhone(s) ?? s.replace(/\D/g, '');

function badPhones(text: string, allowed: readonly string[]): string[] {
  const ok = new Set(allowed.map(phoneKey));
  const found = [...text.matchAll(US_PHONE_RE), ...text.matchAll(INTL_PHONE_RE)].map((m) =>
    m[0].trim(),
  );
  return [...new Set(found.filter((p) => !ok.has(phoneKey(p))))];
}

function badEmails(text: string, allowed: readonly string[]): string[] {
  const ok = new Set(allowed.map((e) => e.trim().toLowerCase()));
  const found = [...text.matchAll(EMAIL_RE)].map((m) => m[0].toLowerCase());
  return [...new Set(found.filter((e) => !ok.has(e)))];
}

/**
 * Whether a reply may go to the customer (or be shown as a draft). Every problem is listed, in rule order,
 * in plain words.
 */
export function checkTeammateReply(reply: string, ctx: ReplyCheckContext): ReplyCheck {
  const problems: ReplyProblem[] = [];
  const add = (rule: ReplyRule, message: string) => problems.push({ rule, message });
  const plain = plainSmsText(reply);
  const lower = norm(reply);

  if (claimsHuman(reply)) add('claims_human', 'It claims to be a person; it must say it’s an AI');
  else if (ctx.askedIfHuman && !disclosesAi(reply))
    add('disclosure', 'They asked if it’s a bot, so the reply has to say it’s an AI assistant');
  else if (ctx.disclosure === 'first_message' && ctx.firstMessage && !disclosesAi(reply))
    add('disclosure', 'Its first message has to say it’s an AI assistant');

  const left = placeholdersIn(plain);
  if (left.length)
    add(
      'placeholder',
      `It still has ${left.length === 1 ? 'a placeholder' : 'placeholders'}: ${left.slice(0, 3).join(', ')}`,
    );

  if (claims(lower, BOOKED_CLAIMS) && !ctx.done.booked && !ctx.done.rescheduled)
    add('false_claim', 'It says they’re booked, but nothing was booked');
  if (claims(lower, RESCHEDULED_CLAIMS) && !ctx.done.rescheduled)
    add('false_claim', 'It says the appointment moved, but nothing was rescheduled');
  if (claims(lower, CANCELLED_CLAIMS) && !ctx.done.cancelled)
    add('false_claim', 'It says the appointment is cancelled, but nothing was cancelled');

  for (const message of moneyProblems(plain, ctx)) add('money', message);

  const open = unmask(plain);
  for (const link of badLinks(open, ctx.allowed))
    add('link', `It links to ${link}, which isn’t one of the business’s own links`);
  for (const phone of badPhones(open, ctx.allowed.phones))
    add('phone', `It gives ${phone}, which isn’t the business’s number or this customer’s`);
  for (const email of badEmails(open, ctx.allowed.emails))
    add('email', `It gives ${email}, which isn’t the business’s address or this customer’s`);

  if (ctx.channel === 'sms' && [...plain].length > REPLY_LIMITS.sms)
    add('length', `Texts can be ${REPLY_LIMITS.sms} characters; this one is ${[...plain].length}`);
  if (ctx.channel === 'chat' && [...plain].length > REPLY_LIMITS.chat)
    add(
      'length',
      `Chat replies can be ${REPLY_LIMITS.chat} characters; this one is ${[...plain].length}`,
    );
  const words = plain.split(/\s+/).filter(Boolean).length;
  if (ctx.channel === 'email' && words > REPLY_LIMITS.emailWords)
    add('length', `Emails can be ${REPLY_LIMITS.emailWords} words; this one is ${words}`);

  return { ok: problems.length === 0, problems };
}
