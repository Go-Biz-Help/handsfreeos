import Image from 'next/image';
import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { FeatureTour, type TourFeature } from '@/components/feature-tour';
import { FoundingCounter, FoundingPill } from '@/components/founding-counter';
import { Icons } from '@/components/icons';
import {
  FaqJsonLd,
  OrganizationJsonLd,
  SoftwareApplicationJsonLd,
  WebSiteJsonLd,
} from '@/components/json-ld';
import { ProductMock } from '@/components/product-mock';
import { Reveal } from '@/components/reveal';
import { Button, Check, Container, Eyebrow, Section, SectionHeading } from '@/components/ui';
import {
  ActionCenterVisual,
  AssistantVisual,
  BookingVisual,
  BusyTimesVisual,
  InboxVisual,
  MissedLeadVisual,
  MoneyVisual,
  PaymentsVisual,
  TrustLadderVisual,
} from '@/components/visuals';
import { homeFaqs } from '@/content/faqs';
import { signUpFor, spotPrices, urls } from '@/content/site';
import {
  foundingCounts,
  foundingSpotsOnSale,
  hasRoom,
  type FoundingCount,
  type FoundingSpot,
} from '@/lib/founding';

/*
 * The headline is a small puzzle on purpose: "the CRM that doesn't want you to use it" makes somebody
 * ask what that means, and the line under it and the section after the hero answer it. Variants worth
 * testing against it, each on a different angle:
 *   1. "Stop losing jobs to the people who called back first."      (problem removal)
 *   2. "Answer every lead in seconds, even at 7pm on a Sunday."     (quantified speed)
 *   3. "Your business keeps answering while you're on the job."     (the previous headline)
 * The headline is the highest-leverage line on the page; change one thing at a time.
 *
 * The page is meant to feel like the product: calm, with things happening on their own. So it shows rather
 * than tells — the conversation in the hero plays itself, the chores cross themselves off, the lead you lost
 * arrives at 8pm — and everything else holds still. Motion lives in globals.css, each piece beside its reason.
 */

/** The spot counts are live, so the home page is rebuilt at most once a minute rather than at deploy. */
export const revalidate = 60;

/** A step in a staggered arrival: the CSS reads `--i` to wait its turn. */
const nth = (index: number) => ({ '--i': index }) as CSSProperties;

export default async function HomePage() {
  const counts = await foundingCounts();
  const spots = foundingSpotsOnSale(counts);
  return (
    <>
      <OrganizationJsonLd />
      <WebSiteJsonLd />
      <SoftwareApplicationJsonLd spots={spots} />
      <FaqJsonLd faqs={homeFaqs} id={`${urls.site}/#faq`} />
      <Hero counts={counts} />
      <WhatThatMeans />
      <TheProblem />
      <HowItWorks />
      <Features />
      <ConnectedAccounts />
      <InYourPocket />
      <WhyDifferent />
      <Spots spots={spots} />
      <Questions />
      <FinalCta />
    </>
  );
}

function Hero({ counts }: { counts: readonly FoundingCount[] | null }) {
  return (
    <div className="relative overflow-hidden">
      <div className="hero-glow pointer-events-none absolute inset-0" aria-hidden="true" />
      <Container className="relative pt-10 pb-20 sm:pt-14 sm:pb-28 lg:pt-20">
        <div className="grid items-center gap-14 lg:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)] lg:gap-14">
          <div>
            <FoundingPill counts={counts} />
            {/*
             * The product name leads the page, inside the <h1> and in its own capitals. Google's
             * OAuth review checks that the name on the consent screen is the name a visitor sees
             * here, and a wordmark in the nav bar, or a label set in all capitals, is not what it
             * reads. Keep this string identical to the consent screen's app name.
             */}
            <h1 className="mt-8 text-[2.75rem] leading-[0.98] font-bold tracking-[-0.045em] sm:text-6xl lg:text-[4.5rem]">
              <span className="text-accent-text mb-5 block text-sm leading-5 font-semibold tracking-normal">
                HandsFreeOS
              </span>{' '}
              The CRM that doesn&rsquo;t want you to use it.
            </h1>
            <p className="text-text-2 mt-7 max-w-xl text-lg sm:text-xl">
              Other CRMs make you remember, look things up, type it in, update it, follow up and
              check again. HandsFreeOS spots the new lead, answers it in seconds, books the job,
              keeps the record current, and brings you in when something actually needs you.
            </p>
            <p className="text-text mt-5 max-w-xl text-lg font-semibold sm:text-xl">
              The less you use it, the better it&rsquo;s working.
            </p>

            <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button href={urls.signUp} size="lg" arrow>
                Sign up
              </Button>
              <Button href="/#how" size="lg" variant="secondary">
                See how it works
              </Button>
            </div>

            {/*
             * FUD reducers sit directly under the button, and every one of them is true today. The price is one of
             * them: signing up goes straight on to picking a spot and paying, and nobody should meet that cold.
             */}
            <ul className="text-text-2 mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm">
              {[spotPrices, 'Keep the number you have', 'Stop it renewing any time'].map((item) => (
                <li key={item} className="flex items-center gap-1.5">
                  <Check className="text-success" />
                  {item}
                </li>
              ))}
            </ul>
          </div>

          <div className="lg:pl-2">
            <ProductMock />
          </div>
        </div>
      </Container>
    </div>
  );
}

/**
 * The answer to the headline's question: what an ordinary CRM waits for you to do, crossed off as it comes into
 * view, and what HandsFreeOS does instead. Every line on the right is something the product does today — keep
 * it that way.
 */
function WhatThatMeans() {
  const youDo = [
    { verb: 'Remember', body: 'who called, and what they wanted' },
    { verb: 'Research', body: 'the job, the price, the last visit' },
    { verb: 'Type', body: 'it all into the system' },
    { verb: 'Update', body: 'the record every time something changes' },
    { verb: 'Follow up', body: 'on the quote, then on the invoice' },
    { verb: 'Check again', body: 'tomorrow, to see if anyone replied' },
  ];
  const itDoes = [
    {
      verb: 'Detects',
      body: 'A missed call, a new lead, a quote going stale, an invoice gone late — it notices without you looking.',
    },
    {
      verb: 'Acts',
      body: 'Texts the missed call back, answers the lead, and books them into your calendar.',
    },
    {
      verb: 'Communicates',
      body: 'Sends the reminders, chases the quote, and chases the invoice until it is paid.',
    },
    {
      verb: 'Updates',
      body: 'Every text, call, booking and payment lands on the customer’s record by itself.',
    },
    {
      verb: 'Escalates',
      body: 'Anything it is unsure of, anything about money, and any upset customer comes straight to you.',
    },
  ];
  return (
    <Section id="what-that-means">
      <Eyebrow>What that means</Eyebrow>
      <SectionHeading sub="A CRM is only as good as the hours you put into it. HandsFreeOS is built the other way round: it does the work, and you only open it when it asks.">
        Most CRMs need you. This one covers for you.
      </SectionHeading>

      <div className="mt-14 grid gap-5 md:grid-cols-2 md:gap-6">
        <Reveal className="border-border h-full rounded-[20px] border p-6 sm:p-8">
          <p className="text-text-3 text-sm font-medium">A normal CRM waits for you to</p>
          <ul className="mt-6 space-y-4">
            {youDo.map((item, index) => (
              <li
                key={item.verb}
                className="chore-text text-text-2 text-[1.0625rem]"
                style={nth(index)}
              >
                <span className="chore-verb text-text relative font-semibold">
                  {item.verb}
                  <span
                    aria-hidden="true"
                    className="chore-strike bg-accent absolute top-1/2 -right-1 -left-1 h-[2px] -translate-y-1/2 rounded-full"
                  />
                </span>{' '}
                {item.body}
              </li>
            ))}
          </ul>
        </Reveal>

        <Reveal className="bg-card border-accent/35 h-full rounded-[20px] border p-6 shadow-[var(--shadow-2)] sm:p-8">
          <p className="text-accent-text text-sm font-semibold">HandsFreeOS does it for you</p>
          <ul className="mt-6 space-y-4">
            {itDoes.map((item, index) => (
              <li key={item.verb} className="flex gap-3" style={nth(index)}>
                <Check className="task-tick text-success mt-0.5" />
                <p className="text-text-2">
                  <span className="text-text font-semibold">{item.verb}.</span> {item.body}
                </p>
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    </Section>
  );
}

/** After hours, drawn as it is: the band is night in both themes. */
function TheProblem() {
  const points = [
    {
      title: 'A lead goes cold in under an hour',
      body: 'People text three businesses and go with whoever answers first. Every hour you take to reply, fewer of them are still listening.',
    },
    {
      title: 'The quote you meant to send on Tuesday',
      body: 'It is still in your head, or half-written on a notepad in the van. Nobody chased it, so it quietly became a no.',
    },
    {
      title: 'Six apps that do not talk to each other',
      body: 'A texting app, a calendar, a spreadsheet, an invoicing tool, a notes app, and a phone with 40 unread messages. Nothing knows what anything else did.',
    },
  ];
  return (
    <NightBand>
      <div className="grid items-center gap-14 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-16">
        <div>
          <h2 className="text-on-night text-[2.125rem] leading-[1.04] font-bold tracking-[-0.035em] sm:text-5xl md:text-[3.25rem]">
            The job you lost last week, you never even knew about.
          </h2>
          <p className="text-on-night-2 mt-6 max-w-2xl text-lg sm:text-xl">
            Not because you&rsquo;re bad at your job. Because you were up a ladder when they texted,
            and by the time you got to your phone at 8pm they&rsquo;d already booked the guy who
            answered.
          </p>
        </div>
        <Reveal>
          <MissedLeadVisual />
        </Reveal>
      </div>

      <div className="border-night-border mt-16 grid gap-10 border-t pt-10 md:grid-cols-3 md:gap-10">
        {points.map((point) => (
          <div key={point.title}>
            <h3 className="text-on-night text-lg font-semibold">{point.title}</h3>
            <p className="text-on-night-2 mt-2.5">{point.body}</p>
          </div>
        ))}
      </div>

      <p className="text-on-night mt-14 max-w-3xl text-2xl leading-snug font-semibold tracking-[-0.02em] sm:text-[1.75rem]">
        <span className="text-on-night-accent">HandsFreeOS</span> answers while you work, writes the
        quote, chases it, takes the payment, and brings you in when something actually needs you.
      </p>
    </NightBand>
  );
}

function HowItWorks() {
  const steps = [
    {
      step: 'Week one',
      mode: { label: 'Moving in', tone: 'bg-card-2 text-text-2' },
      title: 'Your number, your customers, your calendar — moved over',
      body: 'Keep your existing business number or get a new one. Your customers come in from a spreadsheet, or straight out of the CRM you use today. Your Google or Outlook calendar plugs in so nothing gets double-booked.',
    },
    {
      step: 'Week two',
      mode: {
        label: 'Drafts every reply · waits for your OK',
        tone: 'bg-warning-soft text-warning-text',
      },
      title: 'It watches how you answer, and asks before it acts',
      body: 'The AI teammate drafts every reply and waits for your OK. You fix what is wrong. It learns your prices, your service area and the way you talk from a knowledge base you can read and edit.',
    },
    {
      step: 'From then on',
      mode: {
        label: 'Sends what it has earned · yours to take back',
        tone: 'bg-success-soft text-success-text',
      },
      title: 'It answers on its own, and hands you the ones that matter',
      body: 'Once a kind of reply has earned enough of your approvals, it sends on its own — and you can put that back any time. Anything it is unsure of, anything about money, and anything a customer gets upset about comes straight to you.',
    },
  ];
  return (
    <Section id="how" className="border-border border-t">
      <Eyebrow>How it works</Eyebrow>
      <SectionHeading sub="It does not arrive on day one pretending to be you. It earns each job, one at a time, where you can see it.">
        You stay in charge. It just stops being the thing you do at 11pm.
      </SectionHeading>

      {/* A sequence, so it is drawn as one: a rule the weeks sit on, drawing itself the way the weeks go. */}
      <Reveal className="mt-16">
        <ol className="relative grid gap-12 md:grid-cols-3 md:gap-10">
          <span
            aria-hidden="true"
            className="timeline-rule bg-border-strong absolute top-4 bottom-0 left-4 w-px md:right-0 md:bottom-auto md:h-px md:w-auto"
          />
          {steps.map((item, index) => (
            <li key={item.title} className="rise relative" style={nth(index)}>
              <div className="flex items-center gap-3">
                <span className="timeline-node bg-bg ring-border-strong text-text-2 relative z-10 flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold ring-1">
                  {index + 1}
                </span>
                <span className="text-text-3 bg-bg relative z-10 pr-3 text-sm font-medium">
                  {item.step}
                </span>
              </div>
              <div className="mt-5 pl-11 md:pl-0">
                <span
                  className={`inline-block rounded-full px-2.5 py-1 text-xs font-semibold ${item.mode.tone}`}
                >
                  {item.mode.label}
                </span>
                <h3 className="mt-4 text-xl leading-snug font-semibold tracking-[-0.015em]">
                  {item.title}
                </h3>
                <p className="text-text-2 mt-3">{item.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </Reveal>
    </Section>
  );
}

function Features() {
  const tour: TourFeature[] = [
    {
      id: 'inbox',
      icon: <Icons.inbox />,
      title: 'Every text, call and email in one thread',
      body: 'One business number, one inbox the whole team shares. Missed calls turn into a text back before the customer has put their phone down. Voicemail comes through typed out.',
      visual: <InboxVisual />,
    },
    {
      id: 'calendar',
      icon: <Icons.calendar />,
      title: 'Customers book themselves, at hours you set',
      body: 'A booking page for each service, round robin across your crew, or a whole day dispatched. Reminders go out by text and email, so fewer people forget you are coming.',
      visual: <BookingVisual />,
    },
    {
      id: 'quotes',
      icon: <Icons.receipt />,
      title: 'Quotes they approve with their name',
      body: 'Send an estimate from your phone. They accept it on their own screen by typing their name. It becomes an invoice, and the invoice chases itself until it is paid.',
      visual: <MoneyVisual />,
    },
    {
      id: 'payments',
      icon: <Icons.card />,
      title: 'The money lands in your account, not ours',
      body: 'Connect your own Stripe or Square. Card payments, deposits taken at booking, and plans that bill themselves every month settle into your balance. HandsFreeOS never holds your money.',
      visual: <PaymentsVisual />,
    },
    {
      id: 'action-center',
      icon: <Icons.list />,
      title: 'One list of what needs you, money first',
      body: 'Home is not a dashboard of graphs. It is a ranked list: the hot lead waiting eleven minutes, the quote about to go stale, the invoice ten days late. The safe ones it just handles.',
      visual: <ActionCenterVisual />,
    },
    {
      id: 'assistant',
      icon: <Icons.spark />,
      title: 'Ask it anything, in plain English',
      body: '"Who hasn’t paid me?" "Book Dale for Thursday morning." "Text everyone whose service is due." It answers from your real data, and shows you what it is about to change first.',
      visual: <AssistantVisual />,
    },
  ];

  return (
    <Section id="features" className="border-border border-t">
      <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <Eyebrow>What it does</Eyebrow>
          <SectionHeading sub="The parts of running a service business that eat your evenings, in one system that already knows who the customer is.">
            Six apps and a notepad, replaced by one.
          </SectionHeading>
        </div>
        <Button
          href="/features"
          variant="secondary"
          className="shrink-0 self-start lg:self-auto"
          arrow
        >
          Everything it does, in full
        </Button>
      </div>

      <div className="mt-14">
        <FeatureTour features={tour} />
      </div>
    </Section>
  );
}

/*
 * What HandsFreeOS does with a connected Google or Microsoft account, in plain sight on the home
 * page rather than only in the privacy policy. Google's OAuth verification reads this page to
 * decide whether the app's purpose explains the scopes it asks for, so each line here is meant to
 * map onto one: busy times to calendar.freebusy, appointments written back to
 * calendar.events.owned, and the mailbox scopes to the shared inbox. Gmail is marked coming soon:
 * Connect Gmail stays greyed out in the app until Google's Gmail review. The picture beside it draws
 * the same promise, so keep the two in step.
 */
function ConnectedAccounts() {
  const connections = [
    {
      icon: Icons.calendar,
      title: 'Your Google or Outlook calendar',
      body: 'HandsFreeOS reads when you are busy — the times only, never what the events are — so customers booking online and teammates booking for you cannot put a job on top of something you already have. Your HandsFreeOS appointments are written back to that calendar as events with no guests, so the day on your phone is the whole day.',
    },
    {
      icon: Icons.inbox,
      title: 'Your Outlook mailbox, with Gmail coming soon',
      body: 'Email lands in the same thread as that customer’s texts and calls, and replies you write go out from your own address. One place to look, whichever way the customer got in touch.',
    },
    {
      icon: Icons.shield,
      title: 'What it never does',
      body: 'It does not read your event titles, show your other events to anyone, or change anything in your calendar that it did not put there. Nothing is used for advertising and nothing is sold. Disconnect in Settings and the access stops and what was stored is deleted.',
    },
  ];

  return (
    <Section id="connects" className="bg-card-2 border-border border-y">
      <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:gap-16">
        <div>
          <Eyebrow>Connected accounts</Eyebrow>
          <SectionHeading sub="HandsFreeOS is the system a small service business runs its customers on: one business number, one shared inbox, a calendar customers book themselves on, and the quotes and invoices that follow. It connects to the calendar and mailbox you already use so you do not have to keep two of anything in step by hand.">
            It works with the calendar and inbox you already have.
          </SectionHeading>
        </div>
        <Reveal>
          <div className="rise mx-auto max-w-[26rem]">
            <BusyTimesVisual />
          </div>
        </Reveal>
      </div>

      <div className="mt-16 grid gap-10 md:grid-cols-3 md:gap-10">
        {connections.map((item) => (
          <div key={item.title} className="border-border-strong border-t pt-6">
            <span className="text-accent-text">
              <item.icon />
            </span>
            <h3 className="mt-4 text-lg font-semibold">{item.title}</h3>
            <p className="text-text-2 mt-2.5">{item.body}</p>
          </div>
        ))}
      </div>

      <p className="text-text-2 mt-12 max-w-3xl">
        HandsFreeOS&rsquo;s use of information received from Google APIs follows the{' '}
        <Link
          href="/privacy#google"
          className="text-accent-text font-semibold underline underline-offset-2"
        >
          Google API Services User Data Policy
        </Link>
        , including the Limited Use requirements.
      </p>
    </Section>
  );
}

/** Real screens from the app, because the crew using it will never see a desktop. */
function InYourPocket() {
  const shots = [
    { src: '/screenshots/home.png', alt: 'The app showing what needs attention, money first.' },
    {
      src: '/screenshots/offline-queue.png',
      alt: 'The app showing changes made with no signal, waiting to send.',
    },
    { src: '/screenshots/invoice.png', alt: 'An invoice in the app, ready to send to a customer.' },
  ];
  return (
    <Section className="overflow-hidden">
      <div className="grid items-center gap-14 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:gap-16">
        <div>
          <Eyebrow>On the job</Eyebrow>
          <h2 className="text-[2.125rem] leading-[1.04] font-bold tracking-[-0.035em] sm:text-5xl">
            And in the pocket of whoever is doing the work.
          </h2>
          <p className="text-text-2 mt-6 text-lg">
            iPhone and Android, working with no signal at all — in a basement, in a crawlspace, an
            hour out of town — and catching up the moment the bars come back.
          </p>
          <Button href="/app" variant="secondary" size="lg" className="mt-8" arrow>
            See the phone app
          </Button>
        </div>

        <Reveal className="grid grid-cols-3 gap-3 sm:gap-5">
          {shots.map((shot, index) => (
            <div
              key={shot.src}
              className={`rise border-border-strong bg-card overflow-hidden rounded-[22px] border p-1 shadow-[var(--shadow-3)] sm:rounded-[26px] sm:p-1.5 ${
                index === 1 ? '' : 'mt-8 sm:mt-12'
              }`}
              style={nth(index === 1 ? 0 : index + 1)}
            >
              <Image
                src={shot.src}
                alt={shot.alt}
                width={1080}
                height={1920}
                sizes="(max-width: 640px) 30vw, (max-width: 1024px) 28vw, 15rem"
                className="h-auto w-full rounded-[18px] sm:rounded-[20px]"
              />
            </div>
          ))}
        </Reveal>
      </div>
    </Section>
  );
}

function WhyDifferent() {
  const points = [
    {
      icon: Icons.shield,
      title: 'The AI asks first, until you say it does not have to',
      body: 'Most AI tools give you a switch: off, or loose on your customers. This one starts by drafting and waiting, and only sends on its own once that kind of message has earned enough of your approvals.',
    },
    {
      icon: Icons.phone,
      title: 'It works with no signal, in a basement or out of town',
      body: 'The phone app is not a website in a wrapper. Everything can be read and changed offline and syncs when you come back. A text you wrote with no bars sends itself within half an hour, or asks “still send?” if it has been longer.',
    },
    {
      icon: Icons.swap,
      title: 'Your number and your customers stay yours',
      body: 'Keep the number people already have for you. Your customer list, your history and your files export whenever you want. Leaving is a thing you can actually do.',
    },
    {
      icon: Icons.bolt,
      title: 'Registered for texting the way the carriers demand',
      body: 'US business texting has to be registered, with real consent wording, or the carriers quietly drop your messages. That registration is part of setting you up, not a thing you find out about later.',
    },
  ];

  return (
    <Section className="border-border border-t">
      <Eyebrow>Why this one</Eyebrow>
      <SectionHeading sub="Plenty of tools will answer your customers automatically. The question is what happens the first time one of them gets it wrong.">
        Built to be trusted with your customers before it is trusted on its own.
      </SectionHeading>

      <div className="mt-14 grid items-start gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:gap-16">
        <ul className="grid gap-x-10 gap-y-10 sm:grid-cols-2">
          {points.map((point) => (
            <li key={point.title}>
              <span className="bg-accent-soft text-accent-text flex h-10 w-10 items-center justify-center rounded-[11px]">
                <point.icon />
              </span>
              <h3 className="mt-4 text-lg leading-snug font-semibold">{point.title}</h3>
              <p className="text-text-2 mt-2">{point.body}</p>
            </li>
          ))}
        </ul>

        <Reveal className="lg:sticky lg:top-28">
          <div className="rise">
            <TrustLadderVisual />
          </div>
        </Reveal>
      </div>
    </Section>
  );
}

/**
 * The founding spots on sale, each with its live count. The spots come from the page's own fetch and are passed
 * down rather than fetched here, so the home page makes one request rather than three.
 */
function Spots({ spots }: { spots: readonly FoundingSpot[] }) {
  // Nothing on sale at all: nothing to show, and the pricing page says so.
  if (spots.length === 0) return null;
  return (
    <Section className="bg-card-2 border-border border-y">
      <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
        <SectionHeading sub="First come, first served: sign up, pick a spot and pay. One plan, every feature in it, and texts and calls billed for what you use. The counts are live.">
          Founding spots are open.
        </SectionHeading>
        <Button href="/pricing" variant="secondary" size="lg" className="shrink-0" arrow>
          See what is in it
        </Button>
      </div>

      <Reveal
        className={`mt-12 grid gap-4 sm:gap-5 ${spots.length > 1 ? 'sm:grid-cols-2' : 'max-w-xl'}`}
      >
        {spots.map((spot) => {
          const { content, count } = spot;
          const room = hasRoom(spot);
          const lead = room && content.plan === 'yearly';
          return (
            <Link
              key={content.id}
              // A full spot has nothing to sign up for: the pricing page says which one still has room.
              href={room ? signUpFor(content) : '/pricing'}
              className={`group bg-card flex flex-col rounded-[20px] border p-6 transition-[border-color,box-shadow,transform] duration-[150ms,150ms,160ms] ease-[ease,ease,var(--curve-out)] motion-safe:active:scale-[0.99] sm:p-8 ${
                lead
                  ? 'border-accent shadow-[0_0_0_3px_color-mix(in_oklab,var(--accent)_14%,transparent),var(--shadow-2)]'
                  : 'border-border hover:border-border-strong shadow-[var(--shadow-1)]'
              }`}
            >
              <p className="text-text-2 text-sm font-semibold">{content.name}</p>
              <p className="mt-3 text-5xl font-bold tracking-[-0.04em] tabular-nums">
                {content.priceLabel}
                <span className="text-text-3 text-base font-normal tracking-normal">
                  {' '}
                  {content.per}
                </span>
              </p>
              <p className="text-text-2 mt-3">{content.blurb}</p>
              <FoundingCounter count={count} className="mt-6" />
              <span className="text-accent-text mt-auto inline-flex items-center gap-1.5 pt-7 font-semibold">
                {room
                  ? `Sign up for ${content.priceLabel} ${content.per}`
                  : 'See which spot has room'}
                <svg
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                  className="h-4 w-4 transition-transform duration-200 ease-out group-hover:translate-x-0.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3 8h9.5M8.5 4l4 4-4 4" />
                </svg>
              </span>
            </Link>
          );
        })}
      </Reveal>
    </Section>
  );
}

function Questions() {
  return (
    <Section id="faq">
      <SectionHeading sub="The things people actually ask before they sign up.">
        Fair questions.
      </SectionHeading>
      {/* Left open rather than hidden in accordions: what gets collapsed does not get read. */}
      <div className="mt-14 grid gap-x-12 md:grid-cols-2">
        {homeFaqs.map((item) => (
          <div key={item.q} className="border-border border-t py-7">
            <h3 className="text-lg leading-snug font-semibold">{item.q}</h3>
            <p className="text-text-2 mt-3">{item.a}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

function FinalCta() {
  return (
    <NightBand className="text-center">
      <Reveal className="mx-auto max-w-2xl">
        {/* The question, answered before it is asked: the same 9 seconds as the hero. */}
        <div aria-hidden="true" className="flex flex-col items-center gap-2">
          <span className="rise text-on-night-2 border-night-border rounded-full border bg-white/[0.06] px-3.5 py-1.5 text-sm">
            New text · 7:00 PM
          </span>
          <span
            className="rise text-success-text bg-success-soft rounded-full px-3.5 py-1.5 text-sm font-semibold"
            style={nth(3)}
          >
            Answered 9 seconds later
          </span>
        </div>
        <h2 className="text-on-night mt-9 text-[2.25rem] leading-[1.04] font-bold tracking-[-0.035em] sm:text-5xl">
          The next lead texts you at 7pm. What happens?
        </h2>
        <p className="text-on-night-2 mt-6 text-lg">
          Set it up this week, watch every reply before it goes out, and let go of the ones it gets
          right. Founding spots are first come, first served.
        </p>
        <div className="mt-9 flex flex-col justify-center gap-3 sm:flex-row">
          <Button href={urls.signUp} size="lg" arrow>
            Sign up
          </Button>
          <Button href="/support" size="lg" variant="night">
            Ask us a question first
          </Button>
        </div>
      </Reveal>
    </NightBand>
  );
}

/** The after-hours band: night in both themes, with a little light from the top corner. */
function NightBand({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    // The faint edge matters in dark mode, where the page itself is nearly night already.
    <section
      className={`bg-night text-on-night border-night-border relative overflow-hidden border-y ${className}`}
    >
      <div className="night-glow pointer-events-none absolute inset-0" aria-hidden="true" />
      <Container className="relative py-24 sm:py-32">{children}</Container>
    </section>
  );
}
