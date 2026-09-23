/**
 * "Promises not kept", its cheap first look: whether something the team wrote or said might promise a customer
 * something by a time ("I'll send the quote tomorrow", "I'll call you back this afternoon"). Only text that
 * passes this is shown to the AI, which decides whether it really is one and when it's due. Browser-safe and
 * pure. It needs both halves: a promise, and a time.
 */

/** Someone on the team saying they (or the business) will do something. */
const PROMISE =
  /(\b(?:i|we)(?:['’]ll| will| can| am going to| are going to|['’]m going to|['’]re going to|['’]m gonna)\b|\blet me\b|\bcall you back\b|\bget back to you\b|\bsend (?:you|it|that|over|the)\b|\b(?:swing|stop|come) by\b|\bfollow up\b)/i;

/** When: a day, a part of one, or a time. */
const WHEN =
  /\b(today|tonight|tomorrow|tmrw|this (?:morning|afternoon|evening|week|weekend)|next week|later today|end of (?:the )?(?:day|week)|first thing|(?:mon|tues|wednes|thurs|fri|satur|sun)day|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|(?:by|at|before|around) \d{1,2}(?::\d{2})?(?:\s?(?:am|pm))?|in (?:an? )?(?:hour|few|couple)|in \d+ (?:min|minutes|hours|days))\b/i;

/** Whether the team's own words might promise a customer something by a time. */
export function mayPromise(text: string | null | undefined): boolean {
  if (!text) return false;
  return PROMISE.test(text) && WHEN.test(text);
}
