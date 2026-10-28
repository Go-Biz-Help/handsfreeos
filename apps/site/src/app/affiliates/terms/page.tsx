import type { Metadata } from 'next';
import Link from 'next/link';
import { Container, Prose } from '@/components/ui';
import { affiliateRules } from '@/content/affiliates';
import { company, urls } from '@/content/site';

/*
 * The affiliate terms (decision 14): drafted in plain words, and approved by Go Biz Help's lawyer on 28 Oct 2026
 * (the owner). Affiliates agree to them in the app, by version: LAST_UPDATED is the day they were published, and
 * `AFFILIATE_TERMS_VERSION` in packages/core/src/affiliates/terms.ts is the same day. Change one in a way that
 * matters and change the other, and every affiliate agrees again before making codes or setting up payouts.
 *
 * The share isn't written here: staff change it, and the affiliate's own page says what it is.
 */

const LAST_UPDATED = 'October 28, 2026';

export const metadata: Metadata = {
  title: 'Affiliate terms',
  description:
    'The agreement between HandsFreeOS affiliates and Go Biz Help LLC: what you earn, how you’re paid, and how to tell people about HandsFreeOS.',
  alternates: { canonical: '/affiliates/terms' },
};

export default function AffiliateTermsPage() {
  const state = company.governingState || '[STATE — to be confirmed before launch]';
  return (
    <Container className="py-16 sm:py-20">
      <h1 className="text-4xl font-bold sm:text-5xl">Affiliate terms</h1>
      <p className="text-text-3 mt-4 text-base">Last updated {LAST_UPDATED}</p>

      <Prose>
        <p className="mt-8">
          These terms are the agreement between you and {company.legalName} for selling HandsFreeOS
          as an affiliate. You agree to them when you tick the box on your affiliate page, and again
          when they change. They sit beside our <Link href="/terms">terms of service</Link> and{' '}
          <Link href="/privacy">privacy policy</Link>, which cover your HandsFreeOS sign-in.
        </p>

        <h2>1. Who can join</h2>
        <p>
          You must be 18 or over and live in the United States, with a US bank account and a US tax
          id to be paid. You apply on your affiliate page, and we read each application. We may
          approve it or turn it down, and we don’t have to say why. You don’t need to be a
          HandsFreeOS customer.
        </p>

        <h2>2. What you earn</h2>
        <ul>
          <li>
            <strong>Your share</strong> of each payment a business you sent makes for its
            HandsFreeOS plan in its first {affiliateRules.months} months, counted from its first
            paid month or year. Your affiliate page shows your share.
          </li>
          <li>
            <strong>The plan only.</strong> Texts, calls, phone numbers, AI and anything else a
            business pays for as it uses it don’t count, and nor do taxes.
          </li>
          <li>
            <strong>Of what the business actually pays.</strong> If it used a discount, your share
            is of the discounted price.
          </li>
          <li>
            <strong>A business is yours</strong> when it’s made by somebody who signed up within{' '}
            {affiliateRules.clickDays} days of clicking your link, or when it pays for its first
            plan with one of your codes and nobody else has it. If somebody clicks more than one
            affiliate’s link, the last one counts. Once a business is somebody’s, it stays theirs.
          </li>
          <li>
            <strong>Not your own.</strong> You earn nothing on a business you made or run, or one
            that was on HandsFreeOS before it came through you.
          </li>
          <li>
            We may change the share, for everyone or for you. A change counts for payments after it,
            never for what you already earned, and your affiliate page shows it.
          </li>
          <li>
            If a business was credited to you by mistake, we may move it to the right person, or
            take it off you. What we already paid you for it stays yours unless it came from
            breaking these terms.
          </li>
        </ul>

        <h2>3. Codes</h2>
        <p>
          You may make discount and trial codes on your affiliate page, up to the limit it shows. A
          code works for anybody who has it, so share it as carefully as your link. We may turn any
          code off at any time. A business that already used a code keeps what it bought with it.
        </p>

        <h2>4. Refunds</h2>
        <p>
          If a business you sent is refunded, the same share of the refund comes off what you
          earned. If you were already paid for it, it comes off your next payout. If the refund
          fails later, it’s given back to you.
        </p>

        <h2>5. Getting paid</h2>
        <ul>
          <li>
            <strong>Through Stripe.</strong> You set up payouts on Stripe’s own page, from your
            affiliate page. Your bank, tax and identity details go to Stripe, never to us, and
            Stripe’s{' '}
            <a href="https://stripe.com/legal/connect-account" rel="noreferrer">
              Connected Account Agreement
            </a>{' '}
            applies to your Stripe account.
          </li>
          <li>
            <strong>Once a month.</strong> Each share waits {affiliateRules.waitDays} days after the
            payment it’s from, in case of a refund. Then it goes out with the next monthly payout,
            when you’re owed at least {affiliateRules.minPayout}. Less waits for the next month.
          </li>
          <li>
            <strong>We pay Stripe’s fees</strong> on your payouts, so you get all of it.
          </li>
          <li>
            Payouts start once we turn them on for the program. Until then, and until you set up
            payouts with Stripe, what you earn keeps.
          </li>
          <li>
            If Stripe can’t pay you because your account needs something from you, your payout waits
            until it can.
          </li>
        </ul>

        <h2>6. Taxes</h2>
        <p>
          You’re responsible for the taxes on what you earn. If you’re paid enough in a year, Stripe
          sends you a 1099 form for us and files it with the IRS.
        </p>

        <h2>7. How you tell people about HandsFreeOS</h2>
        <ul>
          <li>
            <strong>Say that you earn from it,</strong> clearly and close to your link or code, for
            example “I earn a commission if you sign up.” The FTC requires it.
          </li>
          <li>
            <strong>No spam.</strong> Don’t email, text or call anybody who hasn’t agreed to hear
            from you, and follow the laws on email, texting and calls.
          </li>
          <li>
            <strong>Be accurate.</strong> Don’t promise anything HandsFreeOS doesn’t do, or a price
            or discount we don’t offer.
          </li>
          <li>
            <strong>Don’t look like us.</strong> Don’t pretend to be HandsFreeOS or{' '}
            {company.legalName}, make a website or page that looks like ours, or use HandsFreeOS in
            a web address or account name.
          </li>
          <li>
            <strong>Don’t buy ads on our name.</strong> Don’t bid on “HandsFreeOS” or anything like
            it in search ads.
          </li>
          <li>
            <strong>Real businesses only.</strong> Don’t make businesses yourself to earn from them,
            or pay people to sign up.
          </li>
        </ul>
        <p>
          You may use the HandsFreeOS name and logo to talk about HandsFreeOS, the way this website
          does, and for nothing else.
        </p>

        <h2>8. What you see on your page</h2>
        <p>
          Your affiliate page shows the businesses that pay through you, by name. Keep that to
          yourself: it’s about our customers, not for sharing.
        </p>

        <h2>9. Leaving, and being asked to leave</h2>
        <p>
          You can leave any time by emailing{' '}
          <a href={`mailto:${company.supportEmail}`}>{company.supportEmail}</a>. We may pause or end
          your place in the program at any time. Once you’ve left, your link and codes stop bringing
          you new businesses and you earn nothing on new payments, and we still pay you what you
          earned before.
        </p>
        <p>
          If you break these terms, or we find fraud, we may end your place at once, turn your codes
          off, and not pay what came from it.
        </p>

        <h2>10. You work for yourself</h2>
        <p>
          You’re not our employee, agent or partner, and you can’t make promises or agreements for
          us. You pay your own costs of sharing HandsFreeOS.
        </p>

        <h2>11. If something goes wrong</h2>
        <p>
          We run the program as it is, and we may change how it works. Neither of us is liable to
          the other for indirect or consequential losses. Our total liability to you for anything
          arising out of these terms is limited to what we paid you in the twelve months before it
          happened. Nothing here limits liability that the law does not allow to be limited.
        </p>
        <p>
          If a claim is brought against us because of how you shared HandsFreeOS, you will cover us
          for it.
        </p>

        <h2>12. Changes to these terms</h2>
        <p>
          We may change these terms. When we do, your affiliate page asks you to read and agree to
          the new ones before you make codes or set up payouts. If you don’t agree, you can leave,
          and what you earned before stays yours.
        </p>

        <h2>13. The legal bits</h2>
        <p>
          These terms are governed by the law of the State of {state}, and any dispute goes to the
          courts there. If a part of these terms is unenforceable, the rest still stands. You can’t
          transfer this agreement to anybody else. We may transfer it if the business is sold.
        </p>

        <h2>14. Contact</h2>
        <p>
          {company.legalName}
          <br />
          <a href={`mailto:${company.supportEmail}`}>{company.supportEmail}</a>
          {company.mailingAddress.map((line) => (
            <span key={line}>
              <br />
              {line}
            </span>
          ))}
          <br />
          <Link href={urls.site}>handsfreeos.com</Link>
        </p>
      </Prose>
    </Container>
  );
}
