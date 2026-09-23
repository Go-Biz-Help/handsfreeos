/**
 * "Referral mentioned", its cheap first look: whether a customer's message or call might be about somebody else
 * who needs the business ("my neighbor Jan needs her AC looked at"). Only a message that passes this is shown to
 * the AI, which decides whether it really is one and pulls out the name and number. Browser-safe and pure.
 *
 * It errs towards yes: a false match costs one small AI call that says no; a miss costs a customer.
 */

/** Somebody else, as a customer says it. */
const WHO =
  /\b(neighbou?rs?|friends?|family|relatives?|brother|sister|mom|mum|dad|mother|father|son|daughter|aunt|uncle|cousins?|in-laws?|grand(?:ma|pa|mother|father)|co-?workers?|colleagues?|boss|landlord|tenants?|roommates?|buddy|pal)\b/i;

/** Them passing the business on, or somebody else needing it. */
const PASS_ON =
  /\b(recommend(?:ed|ing)? you|refer(?:red|ring)? (?:you|them|her|him)|pass(?:ed|ing)? (?:along|on) your (?:number|name|info|details|card)|gave (?:them|her|him) your (?:number|name|card)|give (?:them|her|him) your (?:number|name|card)|told (?:them|her|him) about you|someone (?:who|that) needs|somebody (?:who|that) needs|knows? (?:someone|somebody) (?:who|that))\b/i;

/** Needing something: "needs", "is looking for", "wants a quote". */
const NEED =
  /\b(needs?|needed|looking for|wants?|wanted|interested|could use|asked about|asking about|quote|estimate|help with)\b/i;

/** Whether a customer's words might mention somebody who needs the business. */
export function mayMentionReferral(text: string | null | undefined): boolean {
  if (!text) return false;
  if (PASS_ON.test(text)) return true;
  return WHO.test(text) && NEED.test(text);
}
