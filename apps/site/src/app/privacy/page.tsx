import type { Metadata } from 'next';
import Link from 'next/link';
import { Container, Prose } from '@/components/ui';
import { company, urls } from '@/content/site';

/*
 * Reviewed by Chris before launch. Written from what the product actually does, not from a template.
 *
 * Three parts of this page exist because somebody checks them:
 *   - "Google user data" (#google) carries the Limited Use wording Google's OAuth review reads.
 *   - "Texting" (#messaging) carries the opt-in wording the carriers and Twilio's A2P review read.
 *   - "What happens to AI" names Anthropic, because Apple guideline 5.1.2(i) asks us to.
 * Do not trim those sections without checking the reviewer's requirement first.

 */

const LAST_UPDATED = 'September 26, 2026';

export const metadata: Metadata = {
  title: 'Privacy policy',
  description:
    'What HandsFreeOS collects, why, who else sees it, how Google user data is handled under the Limited Use requirements, and how to get everything deleted.',
  alternates: { canonical: '/privacy' },
};

export default function PrivacyPage() {
  return (
    <Container className="py-16 sm:py-20">
      <h1 className="text-4xl font-bold sm:text-5xl">Privacy policy</h1>
      <p className="text-text-3 mt-4 text-base">Last updated {LAST_UPDATED}</p>

      <Prose>
        <p className="mt-8">
          HandsFreeOS is made and run by {company.legalName} (&ldquo;we&rdquo;, &ldquo;us&rdquo;).
          This policy explains what we collect, why, who else sees it, and how to get it back or get
          rid of it. It is written to be read, not to be survived.
        </p>

        <h2>Two different kinds of information</h2>
        <p>
          <strong>Your information, as our customer.</strong> If you sign up, we hold your name,
          email address, phone number, what you do inside HandsFreeOS, and what you pay us. We
          decide how that is handled, and this policy covers it.
        </p>
        <p>
          <strong>Your customers&rsquo; information, as your business.</strong> Everything you put
          into HandsFreeOS about the people you serve — their names, numbers, addresses, the texts
          and emails and calls between you, their appointments, their quotes and invoices — belongs
          to your business. We hold it for you and act on your instructions. We do not decide what
          you do with it, we do not use it to sell anything to them, and we do not sell it to
          anyone. If one of your customers asks us about their information, we point them to you.
        </p>

        <h2>What we collect</h2>
        <table>
          <thead>
            <tr>
              <th>What</th>
              <th>Where it comes from</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                Account details: name, email, phone, password or passkey, photo if you add one
              </td>
              <td>You, when you sign up or are invited</td>
              <td>To let you in and keep others out</td>
            </tr>
            <tr>
              <td>
                Business details: business name, address, hours, services, prices, tax details
              </td>
              <td>You</td>
              <td>To run your calendar, quotes, invoices and the AI&rsquo;s answers</td>
            </tr>
            <tr>
              <td>
                Your customers: names, phone numbers, email and postal addresses, notes, tags, files
                and photos
              </td>
              <td>You, your team, your website forms, imports from another system</td>
              <td>To be the customer record your business works from</td>
            </tr>
            <tr>
              <td>
                Conversations: texts, calls and voicemail (including recordings and transcripts if
                you turn them on), emails, website chats
              </td>
              <td>You and the people who contact your business number, address or website</td>
              <td>To show the whole history in one thread and let the AI answer sensibly</td>
            </tr>
            <tr>
              <td>
                Calendar and jobs: appointments, availability, who is assigned, where and when
              </td>
              <td>You, your customers booking themselves, connected calendars</td>
              <td>To book work without double-booking anyone</td>
            </tr>
            <tr>
              <td>
                Money: estimates, invoices, payments, refunds, plans, and the last four digits and
                card brand of a payment
              </td>
              <td>You, and Stripe or Square when a customer pays</td>
              <td>To show what is owed and what has been paid</td>
            </tr>
            <tr>
              <td>
                Technical: IP address, browser or device type, app version, error reports, times of
                use
              </td>
              <td>Your browser or phone, automatically</td>
              <td>To keep the service up, keep it secure, and find what broke</td>
            </tr>
            <tr>
              <td>
                Usage: which pages of this website and which screens of the apps are opened, how
                often, and from what kind of device
              </td>
              <td>Your browser or phone, automatically, through Matomo</td>
              <td>To see which parts get used, and so what to fix and build next</td>
            </tr>
            <tr>
              <td>
                Marketing: on this website, which search, link or campaign brought you here, the
                pages you read, and — if you type your email into a form here — that address, kept
                only as a one-way hash; later, whether you signed up or bought
              </td>
              <td>Your browser on this website, and our own records, through Opinly</td>
              <td>To learn which articles and campaigns bring people who become customers</td>
            </tr>
          </tbody>
        </table>
        <p>
          <strong>Full card numbers never reach us.</strong> Card details are typed into Stripe or
          Square directly and stay with them.
        </p>

        <h2>Why we are allowed to hold it</h2>
        <p>
          Because we need it to give you the service you asked for, because we have a legitimate
          interest in keeping that service working and secure, because the law requires some of it
          (tax and business records), and — where consent is what matters, such as recording a call
          or texting a customer — because the person gave it.
        </p>

        <h2 id="messaging">Texting, calling and consent</h2>
        <p>
          Business texting in the United States is registered with the mobile carriers, and you
          register as the business that sends the messages. Your business is responsible for having
          the right consent from every person you text, and for honouring STOP.
        </p>
        <p>
          <strong>
            No mobile information will be shared with third parties or affiliates for marketing or
            promotional purposes. Text messaging originator opt-in data and consent are never shared
            with anyone.
          </strong>{' '}
          Phone numbers and consent records are used to deliver the messages you send and nothing
          else.
        </p>
        <p>
          Calls can be recorded and transcribed if your business turns that on. Whether you may
          record a call depends on where you and the other person are, and it is your business that
          has to get that right. HandsFreeOS can play a notice at the start of a call; turning it
          off is your decision and your responsibility.
        </p>

        <h2 id="google">Google user data</h2>
        <p>
          If you connect a Gmail mailbox or a Google Calendar, HandsFreeOS reads what it needs to
          show your email in your inbox and to know when you are busy, and writes what you ask it to
          write — sending a reply you wrote, putting an appointment on your calendar.
        </p>
        <p>
          <strong>
            HandsFreeOS&rsquo;s use of information received from Google APIs follows the{' '}
            <a
              href="https://developers.google.com/terms/api-services-user-data-policy"
              rel="noreferrer noopener"
              target="_blank"
            >
              Google API Services User Data Policy
            </a>
            , including the Limited Use requirements.
          </strong>{' '}
          In plain words, that means:
        </p>
        <ul>
          <li>
            We use Google data only to provide or improve the features you can see in HandsFreeOS —
            your inbox, your calendar, and the AI that drafts replies for you inside them.
          </li>
          <li>We never use Google data for advertising, and we never sell it.</li>
          <li>
            We do not transfer Google data to anyone else, except where we need a service to provide
            a feature to you (see the list below), because you told us to, or because the law
            requires it.
          </li>
          <li>
            We do not use Google data to train generalised artificial intelligence or machine
            learning models. It is never used to train a model that serves anyone but you.
          </li>
          <li>
            No human at {company.legalName} reads your Google data, except with your permission for
            a specific problem you asked us to look at, where it is needed for security, or where
            the law requires it.
          </li>
        </ul>
        <p>
          Disconnecting the mailbox or calendar in Settings stops the access and deletes what we
          stored from it. You can also remove our access at{' '}
          <a
            href="https://myaccount.google.com/permissions"
            rel="noreferrer noopener"
            target="_blank"
          >
            your Google account permissions page
          </a>
          . The same goes for a Microsoft mailbox or calendar.
        </p>

        <h2>What happens with AI</h2>
        <p>
          The Assistant and the AI teammate are built on Claude, made by Anthropic. When they answer
          a question or draft a reply, the part of your business data needed for that answer — the
          conversation, the customer, your services and hours, the relevant notes — is sent to
          Anthropic to produce it.
        </p>
        <ul>
          <li>
            It is used to produce your answer and then it is done. Under our agreement with
            Anthropic, your data is not used to train their models.
          </li>
          <li>
            In the phone app you are asked to agree before anything about a customer is sent to the
            AI for the first time.
          </li>
          <li>
            Your business decides how much the AI does on its own, and can put it back to asking
            first at any time.
          </li>
          <li>
            AI can be wrong. What it sends goes out in your business&rsquo;s name, so the settings
            that decide when it sends on its own are worth reading.
          </li>
        </ul>

        <h2>Who else sees it</h2>
        <p>
          Only the companies that make the service work, each doing one job, and each bound to use
          it only for that job:
        </p>
        <table>
          <thead>
            <tr>
              <th>Company</th>
              <th>What they do</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Supabase</td>
              <td>The database, file storage and sign-in, in the United States</td>
            </tr>
            <tr>
              <td>Fly.io</td>
              <td>Runs the servers behind the app, in the United States</td>
            </tr>
            <tr>
              <td>Vercel</td>
              <td>Serves the web app and this website</td>
            </tr>
            <tr>
              <td>Twilio</td>
              <td>Your business number: texts, calls, voicemail and carrier registration</td>
            </tr>
            <tr>
              <td>Postmark</td>
              <td>Sends and receives email on your behalf</td>
            </tr>
            <tr>
              <td>Anthropic</td>
              <td>The AI that answers questions and drafts replies</td>
            </tr>
            <tr>
              <td>Stripe and Square</td>
              <td>Take card payments into your own account, if you connect one</td>
            </tr>
            <tr>
              <td>Google and Microsoft</td>
              <td>Only the mailbox or calendar you choose to connect</td>
            </tr>
            <tr>
              <td>Expo</td>
              <td>Delivers notifications to the phone app</td>
            </tr>
            <tr>
              <td>Cloudflare</td>
              <td>Sits in front of the service to keep it up and keep attacks out</td>
            </tr>
            <tr>
              <td>Matomo</td>
              <td>Counts visits to this website and which screens of the apps get used</td>
            </tr>
            <tr>
              <td>Opinly</td>
              <td>
                Hosts our blog&rsquo;s articles, and measures which articles and campaigns bring
                visitors who go on to sign up or buy
              </td>
            </tr>
          </tbody>
        </table>
        <p>
          We also share information if the law makes us, to protect someone from harm, or if the
          business is ever sold — in which case the buyer is bound by this policy.
        </p>
        <p>
          <strong>
            We do not sell your personal information, and we do not share it for advertising.
          </strong>{' '}
          We have never done either, and there is no version of this business where we do.
        </p>

        <h2>Cookies and tracking</h2>
        <p>
          The web app uses cookies to keep you signed in and to remember small preferences like
          light or dark. This website uses none of the advertising trackers you would normally
          expect.
        </p>
        <p>
          We count visits with Matomo, on this website, in the web app and in the phone app: which
          pages and screens are opened, how often, and from what kind of device. On the website and
          in the web app, Matomo may set its own cookie so a return visit is not counted as a new
          person; no other website can read it. The apps record the screen, never what is on it: a
          customer&rsquo;s page is counted as &ldquo;a customer&rsquo;s page&rdquo;, not by their
          name, and nothing you type or search for is sent. The pages your customers open &mdash;
          booking pages, invoices, forms &mdash; are not counted at all. None of it is used for
          advertising or shared with anyone else.
        </p>
        <p>
          This website, and only this website, also runs Opinly&rsquo;s measurement script. It sets
          no cookies: it keeps a random visitor number in your browser&rsquo;s own storage, and
          records which search, link or campaign brought you here, which pages you read, what you
          click and how long you stay. Your IP address is used only to work out your country. It
          never reads what you type into a form, with one exception: an email address you enter
          here, such as on the founding application, is sent to Opinly and kept only as a one-way
          hash. When somebody with that address later signs up or pays for HandsFreeOS, we tell
          Opinly too, with the same address, so we can see which article or campaign brought them.
          None of the apps, and none of the pages your customers open, run it. It is not used to
          show you ads anywhere.
        </p>
        <p>
          Some browsers send a &ldquo;Do Not Track&rdquo; signal. We do not need to do anything
          differently when we get one, because we do not track you across other websites in the
          first place.
        </p>

        <h2>How long we keep it</h2>
        <ul>
          <li>
            While your business uses HandsFreeOS, everything in it stays, because a customer record
            with the history cut out of it is not much use.
          </li>
          <li>
            When a business closes its account, its data is deleted within 30 days, apart from what
            we must keep for tax and legal records.
          </li>
          <li>
            When a person deletes their account, their name, email and phone number are removed from
            what stays behind, so the business&rsquo;s own records still add up.
          </li>
          <li>Backups roll off within 30 days.</li>
        </ul>

        <h2>Deleting your account</h2>
        <p>
          You can delete your own account without asking anyone, at{' '}
          <Link href={urls.deleteAccount}>app.handsfreeos.com/delete-account</Link>, in the web app
          under Settings → Account, or in the phone app. The page tells you what happens to each
          business you belong to before you confirm. If you own a business on HandsFreeOS and want
          the whole business deleted, email us at{' '}
          <a href={`mailto:${company.supportEmail}`}>{company.supportEmail}</a>.
        </p>

        <h2>Your rights</h2>
        <p>
          Wherever you are, you can ask us what we hold about you, ask for a copy, ask us to correct
          it, and ask us to delete it. Email{' '}
          <a href={`mailto:${company.supportEmail}`}>{company.supportEmail}</a> and we will answer
          within 30 days. We will never treat you differently for asking.
        </p>
        <p>
          <strong>If you are in California:</strong> you have the right to know what we collect and
          why, to get a copy, to correct it, to delete it, and to opt out of the sale or sharing of
          personal information — which is easy here, because we do neither. You can ask through an
          authorised agent.
        </p>
        <p>
          <strong>If you are in Colorado, Connecticut, Utah, Virginia</strong> or another state with
          its own privacy law: the same rights above are yours, and you do not have to work out
          whether your state&rsquo;s law applies to us before asking. Those laws also give you the
          right to appeal if we turn a request down. We will not, but if we ever do, the refusal
          will say why and how to appeal it, and an appeal goes to the same address and gets an
          answer within 45 days.
        </p>
        <p>
          <strong>If you are in the UK or the EU:</strong> you also have the right to object to some
          processing, to ask us to restrict it, and to complain to your data protection authority.
          Your information is stored in the United States, under the standard contractual clauses
          where they apply.
        </p>
        <p>
          If you are one of <em>our customers&rsquo;</em> customers and want your information
          removed, ask that business. They control it; we will help them do it.
        </p>

        <h2>Keeping it safe</h2>
        <p>
          Everything is encrypted on the way to us and while it is stored. Each business&rsquo;s
          data is separated in the database itself, not just in the app, so one business cannot read
          another&rsquo;s. On phones the local copy is encrypted. Access by our own staff is limited
          to the people who need it and is logged. No system is perfect; if something happens that
          affects you, we will tell you promptly and plainly.
        </p>

        <h2>Children</h2>
        <p>
          HandsFreeOS is a tool for businesses and is not for anyone under 18. We do not knowingly
          collect information from children. If you think a child&rsquo;s information has ended up
          here, email us and it will be removed.
        </p>

        <h2>Changes to this policy</h2>
        <p>
          If we change it in a way that matters, we will email the account owners and change the
          date at the top. Carrying on using HandsFreeOS after that means the new version applies.
        </p>

        <h2>Contact</h2>
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
        </p>
      </Prose>
    </Container>
  );
}
