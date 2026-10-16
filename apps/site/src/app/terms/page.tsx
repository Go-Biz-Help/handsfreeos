import type { Metadata } from 'next';
import Link from 'next/link';
import { Container, Prose } from '@/components/ui';
import { company, urls } from '@/content/site';

/*
 * Reviewed by Chris before launch. The governing state and the address come from
 * `src/content/site.ts`; the governing-law section prints a visible placeholder if the state is
 * ever emptied, on purpose.
 */

const LAST_UPDATED = 'October 15, 2026';

export const metadata: Metadata = {
  title: 'Terms of service',
  description:
    'The agreement between your business and Go Biz Help LLC: what we provide, what you pay, who is responsible for the texts you send, and how either of us stops.',
  alternates: { canonical: '/terms' },
};

export default function TermsPage() {
  const state = company.governingState || '[STATE — to be confirmed before launch]';
  return (
    <Container className="py-16 sm:py-20">
      <h1 className="text-4xl font-bold sm:text-5xl">Terms of service</h1>
      <p className="text-text-3 mt-4 text-base">Last updated {LAST_UPDATED}</p>

      <Prose>
        <p className="mt-8">
          These terms are the agreement between your business and {company.legalName} for using
          HandsFreeOS. By making an account, or by using it after someone invited you, you agree to
          them. If you are agreeing for a business, you are saying you are allowed to.
        </p>

        <h2>1. What we provide</h2>
        <p>
          HandsFreeOS is software for running the customer side of a small business: a business
          phone number for texts and calls, a shared inbox, customer records, a calendar and booking
          pages, estimates and invoices, automatic follow-ups, and AI features that answer questions
          and draft or send replies according to the settings you choose. We provide it as it is
          described on this website, and we may change how it works as we improve it. If we remove
          something you rely on, we will tell you first.
        </p>

        <h2>2. Your account</h2>
        <p>
          Keep your sign-in details to yourself and tell us quickly if you think someone else has
          got in. You are responsible for what the people you invite do inside your business.
          Everyone using HandsFreeOS must be 18 or over.
        </p>

        <h2>3. What you pay</h2>
        <ul>
          <li>
            Plans are billed each month, or each year if you choose that, in advance. Prices are on
            the <Link href="/pricing">pricing page</Link>.
          </li>
          <li>
            Texts, calls, phone numbers and AI replies are billed on top, at the per-use rates shown
            in your account. They come out of a usage balance, and every charge appears on the
            statement on your Usage &amp; balance page.
          </li>
          <li>
            <strong>If that balance runs out, outgoing texts and outgoing calls stop</strong>, and
            we tell you why rather than failing quietly. Calls coming <em>in</em> to your number
            keep reaching you, and messages coming in are still received and filed. Nothing is
            deleted, and everything starts again as soon as you top up.
          </li>
          <li>
            <strong>Automatic top-up charges the card you save for it.</strong> It is on unless you
            turn it off: when the balance falls below the amount you set, we charge your card for
            the top-up amount you set. If several top-ups are needed in a short period, we raise the
            amount each time so that it is one larger charge instead of many small ones, up to a cap
            shown on your Usage &amp; balance page. That page says whenever a top-up has been raised
            and why, and{' '}
            <strong>we email you before charging more than twice your own top-up amount</strong>.
            Raising your own amount stops it happening. You can turn automatic top-up off, change
            either amount, or remove the card, at any time.
          </li>
          <li>
            A card that is declined is tried again a few times over the following days. If it keeps
            being declined we stop trying, tell you, and ask for another card. The usage balance is
            separate from your plan, and the card saved for it is never used for money your own
            customers pay you.
          </li>
          <li>
            You can cancel any time and you will not be billed again. We do not refund the part of a
            month you have already paid for, unless we got something wrong.
          </li>
          <li>
            If a payment fails we will tell you and try again. If it stays unpaid we may suspend the
            business until it is settled. Your data is not deleted for non-payment without warning
            you first.
          </li>
          <li>
            If we change a price, you will have at least 30 days&rsquo; notice, and it takes effect
            on your next renewal.
          </li>
          <li>Prices are in US dollars and do not include any tax that applies where you are.</li>
        </ul>

        <h2>4. Your data is yours</h2>
        <p>
          Everything you put into HandsFreeOS — your customers, your conversations, your files, your
          records — stays yours. You give us permission to store it, process it and show it back to
          you, which is what running the service means, and nothing more. We do not sell it, we do
          not use it to advertise to anyone, and we do not use it to train AI models for anyone
          else. You can export it while your account is open, and you can delete it: see the{' '}
          <Link href="/privacy">privacy policy</Link>.
        </p>

        <h2>5. Texting, calling and the law</h2>
        <p>This is the part that gets businesses in trouble, so it is worth reading properly.</p>
        <ul>
          <li>
            <strong>You are the sender.</strong> Messages and calls that go out through HandsFreeOS
            go out as your business. You need the right consent from each person before you text or
            call them for marketing, and you must honor STOP and do-not-call requests. HandsFreeOS
            records consent and handles STOP automatically, but the obligation is yours.
          </li>
          <li>
            <strong>Carrier registration.</strong> US business texting requires registration with
            the carriers. You must give us true information for it. Messages can be blocked or fined
            by the carriers if the registration is wrong, and that is outside our control.
          </li>
          <li>
            <strong>Recording calls.</strong> Where you need someone&rsquo;s permission to record a
            call, getting it is your responsibility.
          </li>
          <li>
            <strong>No spam.</strong> No bought lists, no messaging people who never asked, nothing
            illegal, nothing about the categories carriers forbid. We will suspend an account that
            does this, without notice if the carriers require it.
          </li>
        </ul>

        {/*
          Written to the person receiving the texts, not to the business sending them — which is why it sits
          apart from section 5 and is lettered rather than numbered. A carrier's A2P review reads this
          section, and it reads it looking for these: what the programme is and what it texts about, that
          agreeing is not a condition of buying, STOP, HELP, "Message frequency varies", "Message and data
          rates may apply", that carriers are not liable for delayed or undelivered messages, and a link to
          the privacy policy. The quoted sentences are the industry's own words, kept so a reviewer can tick them.
          Every claim here is something HandsFreeOS actually does — the keywords are in
          packages/core/src/messaging/sms.ts and the opt-out is recorded by message.receive. Do not soften or
          trim it without checking the requirement first.
        */}
        <h2 id="messaging">5A. If a business texts you through HandsFreeOS</h2>
        <p>
          This part is for you if you are a customer of a business that uses HandsFreeOS, and it has
          texted you.
        </p>
        <ul>
          <li>
            <strong>Who is texting you.</strong> The business is. HandsFreeOS is the software it
            uses to send the message, the way an email provider is not the person writing to you.
            The business decided to text you, and it is the business you agreed to hear from.
          </li>
          <li>
            <strong>What the texts are about.</strong> What you asked the business for: answers to
            your questions, appointment confirmations and reminders, estimates, invoices and
            receipts, and updates on the work. Offers and promotions come only if you separately
            agreed to them. Agreeing to get texts is never a condition of buying anything.
          </li>
          <li>
            <strong>Stopping.</strong> Reply <strong>STOP</strong> to any message and that business
            stops texting you. STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, OPTOUT and REVOKE all work
            the same way. You will get one message confirming it, and then nothing more. You can
            also tell the business in any other reasonable way, and it has to stop. If you change
            your mind, reply <strong>START</strong> (or UNSTOP, SUBSCRIBE or OPTIN) and the texts
            start again.
          </li>
          <li>
            <strong>Help.</strong> Reply <strong>HELP</strong> or INFO and you will get a message
            saying who is texting you and how to reach them. You can also write to us at{' '}
            <a href={`mailto:${company.supportEmail}`}>{company.supportEmail}</a>, though for
            anything about the business itself — an appointment, a quote, a bill — that business is
            who you want.
          </li>
          <li>
            <strong>How often, and what it costs.</strong> Message frequency varies. Message and
            data rates may apply. How many messages you get depends on the business and on what you
            are talking to them about; there is no set number. Those rates can apply both to their
            messages and to your replies. If you are not sure what your plan costs, your mobile
            provider is who knows.
          </li>
          <li>
            <strong>Delivery.</strong> Carriers are not liable for delayed or undelivered messages,
            and neither are we. A text is not a reliable way to send something urgent.
          </li>
          <li>
            <strong>Your number.</strong> Your phone number and the record of your agreeing to be
            texted are used to deliver those messages and for nothing else. They are never sold, and
            never shared with anyone else for marketing. Our{' '}
            <Link href="/privacy#messaging">privacy policy</Link> says so in full.
          </li>
        </ul>

        <h2>6. The AI features</h2>
        <ul>
          <li>
            You choose what the AI may do: draft only, or send certain kinds of message on its own
            once you have approved enough of them. You can put it back to asking first at any time.
          </li>
          <li>
            <strong>What the AI sends is sent by your business.</strong> It can be wrong, and you
            are responsible for what goes out under your name. Check the settings before you let it
            send on its own, and read what it sends.
          </li>
          <li>
            Nothing the AI produces is legal, medical, financial or safety advice, and it must not
            be relied on for anything where being wrong would hurt someone.
          </li>
          <li>
            AI replies depend on services we buy from others. If one of them is down or changes,
            those features may pause.
          </li>
        </ul>

        <h2>7. Getting paid through HandsFreeOS</h2>
        <p>
          Card payments run through your own Stripe or Square account, under your agreement with
          them. The money goes to your balance, not ours: we never hold your funds. Refunds,
          disputes and chargebacks are between you, your customer and your payment company. We
          charge no percentage of what you take.
        </p>

        <h2>8. Fair use</h2>
        <p>
          Do not break the law with it, do not try to get into other businesses&rsquo; data, do not
          attack or overload the service, do not resell it as your own product without our written
          agreement, and do not use it to harass anyone. Automated access is fine through the
          features we provide for it, and not fine if it degrades the service for other people.
        </p>

        <h2>9. Stopping</h2>
        <p>
          You can stop whenever you like, from Settings. Export what you want first. We can stop
          providing the service to you with 30 days&rsquo; notice, and immediately if you are doing
          something illegal, harming other users, or leaving a bill unpaid after we have asked. When
          an account closes, data is deleted as described in the privacy policy. If we ever shut
          HandsFreeOS down, you will get at least 90 days&rsquo; notice and a way to take everything
          with you.
        </p>

        <h2>10. Uptime, and what we do not promise</h2>
        <p>
          We work hard to keep HandsFreeOS up, and we will tell you when it is not. But it is
          provided &ldquo;as is&rdquo;: we do not promise it will never be unavailable, never lose a
          message to a carrier, or never make a mistake. To the extent the law allows, we disclaim
          the implied warranties of merchantability, fitness for a particular purpose and
          non-infringement.
        </p>

        <h2>11. If something goes wrong</h2>
        <p>
          Neither of us is liable to the other for indirect or consequential losses — lost profit,
          lost business, lost data beyond what our backups hold. Our total liability to you for
          anything arising out of these terms is limited to what you paid us in the twelve months
          before it happened. Nothing here limits liability that the law does not allow to be
          limited.
        </p>
        <p>
          If a claim is brought against us because of how your business used HandsFreeOS — the
          messages you sent, the consent you did or did not have, the content you put in — you will
          cover us for it.
        </p>

        <h2>12. Changes to these terms</h2>
        <p>
          If we change them in a way that matters, we will email the account owners at least 30 days
          before it takes effect. If you do not agree, cancel before then.
        </p>

        <h2>13. The legal bits</h2>
        <p>
          These terms are governed by the law of the State of {state}, and any dispute goes to the
          courts there. If a part of these terms is unenforceable, the rest still stands. Neither of
          us can transfer this agreement without the other agreeing, except that we may transfer it
          if the business is sold. These terms, plus the privacy policy, are the whole agreement
          between us.
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
