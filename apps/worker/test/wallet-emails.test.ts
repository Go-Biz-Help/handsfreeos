/**
 * What the two balance emails actually say (M16).
 *
 * These are worth pinning because they are the one channel that reaches a business whatever it has switched
 * off, and because every sentence in them is a claim about what is happening to their phone right now. At
 * `warn` nothing has stopped and saying otherwise would be a lie that costs us trust on the day it matters; at
 * `enforce` it has, and softening it would leave somebody wondering why nobody is replying. The stage is the
 * only thing that tells them apart, so that is what is asserted here.
 */
import { describe, expect, it } from 'vitest';
import { walletCardDeclinedEmail, walletEmptyEmail } from '../src/emails/templates';

const empty = (over: Partial<Parameters<typeof walletEmptyEmail>[0]> = {}) =>
  walletEmptyEmail({
    business: 'Lone Star Plumbing',
    balanceCents: -250,
    hasCard: false,
    autoTopup: true,
    stopping: true,
    link: 'https://app.handsfreeos.com/app/w/w1/settings/usage',
    ...over,
  });

const declined = (over: Partial<Parameters<typeof walletCardDeclinedEmail>[0]> = {}) =>
  walletCardDeclinedEmail({
    business: 'Lone Star Plumbing',
    reason: 'That card was reported lost.',
    stopping: true,
    link: 'https://app.handsfreeos.com/app/w/w1/settings/usage',
    ...over,
  });

/** Both halves go out, so both have to say the same thing. */
const bothWays = (m: { subject: string; text: string; html: string }) => `${m.text}\n${m.html}`;

describe('the empty-balance email', () => {
  it('says things have stopped only when they have', () => {
    expect(empty({ stopping: true }).subject).toMatch(/have stopped/i);
    expect(bothWays(empty({ stopping: true }))).toMatch(/outgoing texts and calls have stopped/i);

    const warning = empty({ stopping: false });
    expect(warning.subject).not.toMatch(/have stopped/i);
    expect(bothWays(warning)).toMatch(/nothing has stopped/i);
    expect(bothWays(warning)).toMatch(/still work for now/i);
  });

  it('promises, both ways, that incoming calls still reach them', () => {
    // The one thing a business panics about, and the one thing that is never true. Terms §3 says it too.
    const stopped = bothWays(empty({ stopping: true }));
    expect(stopped).toMatch(/calls coming in still reach you/i);
    expect(stopped).toMatch(/still received and filed/i);
    expect(stopped).toMatch(/nothing is lost/i);
  });

  it('says the one thing that would fix it, and it differs by what they have', () => {
    expect(bothWays(empty({ hasCard: false }))).toMatch(/no card on this balance yet/i);
    expect(bothWays(empty({ hasCard: true, autoTopup: false }))).toMatch(
      /automatic top-up is off/i,
    );
    expect(bothWays(empty({ hasCard: true, autoTopup: true }))).toMatch(/has not covered it/i);
  });

  it('reads a negative balance as over, not as a minus sign', () => {
    expect(bothWays(empty({ balanceCents: -250 }))).toMatch(/\$2\.50 over/);
    expect(bothWays(empty({ balanceCents: 0 }))).toMatch(/\$0\.00 left/);
  });

  it('never leaves them thinking this is about their own customers’ money', () => {
    expect(bothWays(empty())).toMatch(/not about money your own customers owe you/i);
  });
});

describe('the declined-card email', () => {
  it('carries the bank’s own words when there are any, and says so when there are not', () => {
    expect(bothWays(declined({ reason: 'That card was reported lost.' }))).toMatch(
      /reported lost/i,
    );
    expect(bothWays(declined({ reason: null }))).toMatch(/did not say why/i);
  });

  it('says we have stopped trying, so nobody waits for a retry that is not coming', () => {
    const m = bothWays(declined());
    expect(m).toMatch(/six hours/i);
    expect(m).toMatch(/three days/i);
    expect(m).toMatch(/stopped trying/i);
  });

  it('is honest about whether anything has stopped', () => {
    expect(bothWays(declined({ stopping: true }))).toMatch(
      /have stopped until there is a working card/i,
    );
    expect(bothWays(declined({ stopping: false }))).toMatch(/nothing has stopped yet/i);
  });
});

describe('both', () => {
  it('name the business, so an agency reading four of them can tell them apart', () => {
    expect(empty().subject).toMatch(/Lone Star Plumbing/);
    expect(declined().subject).toMatch(/Lone Star Plumbing/);
  });

  it('give one button, and it goes to the page that fixes it', () => {
    for (const m of [empty(), declined()]) {
      expect(m.text).toContain('/settings/usage');
      expect(m.html).toContain('/settings/usage');
    }
  });

  it('never use banking words at somebody whose phone has stopped', () => {
    for (const m of [empty(), empty({ stopping: false }), declined({ stopping: false })])
      expect(bothWays(m)).not.toMatch(/insufficient funds|delinquent|past due|suspended account/i);
  });
});
