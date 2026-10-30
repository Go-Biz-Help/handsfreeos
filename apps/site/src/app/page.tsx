import Image from 'next/image';
import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { FeatureTour, type TourFeature } from '@/components/feature-tour';
import { FoundingCounter, FoundingPill } from '@/components/founding-counter';
import { HomeTabs } from '@/components/home-tabs';
import { Icons } from '@/components/icons';
import {
  FaqJsonLd,
  OrganizationJsonLd,
  SoftwareApplicationJsonLd,
  WebSiteJsonLd,
} from '@/components/json-ld';
import { ProductMock } from '@/components/product-mock';
import { NightBand } from '@/components/night-band';
import { StickyCta } from '@/components/sticky-cta';
import { Reveal } from '@/components/reveal';
import { BillBuilder } from '@/components/bill-builder';
import { Button, Check, Container, Eyebrow, Section, SectionHeading } from '@/components/ui';
import {
  ActionCenterVisual,
  AssistantVisual,
  BookingVisual,
  BusyTimesVisual,
  InboxVisual,
  MoneyVisual,
  PaymentsVisual,
  TrustLadderVisual,
} from '@/components/visuals';
import {
  MissedLeadForYou,
  TryItOnYourBusiness,
  YourBusinessName,
  YourBusinessProvider,
} from '@/components/your-business';
import { homeFaqs } from '@/content/faqs';
import {
  pricesCheckedOn,
  roughUsd,
  setupFees,
  stack,
  stackSources,
  stackTotal,
  usd,
  yearlySavings,
} from '@/content/savings';
import { company, moneyBack, signUpFor, spotPrices, typicalUsage, urls } from '@/content/site';
import {
  foundingCounts,
  foundingSpotsOnSale,
  hasRoom,
  type FoundingCount,
  type FoundingSpot,
} from '@/lib/founding';

/*
 * The page is written to one person: the owner of a service business with 1 to 20 people, great at the trade and
 * worn down by everything around it, who has tried a CRM before and found it was one more job. It runs in the
 * order they decide in: what they get (hero), what it costs them today (the night band), what life looks like
 * after (next Tuesday), what it costs in money (the bill), why it is safe (it asks first), how fast (this week),
 * and what happens if it is wrong for them (the money back). Since 30 October 2026 the middle of that (next
 * Tuesday, what changes, it asks first, this week, the phone app) is one band of tabs, so the page is short enough
 * to reach the promise. The copy and the reasons behind each section are in
 * the owner's "Home page copy" doc of 28 October 2026.
 *
 * The headline names both rewards in eight words: winning the job, and the evenings back. Variants worth testing
 * against it, each on a different angle, one at a time:
 *   1. "Stop losing jobs to whoever answers first."            (the fear of losing work)
 *   2. "Cancel ten apps. Keep the one that does the work."     (the money)
 *   3. "You can't answer the phone and do the job at the same time." (the owners' own words)
 *   4. "The CRM that doesn't want you to use it."              (the previous headline, now the footer's tagline)
 *
 * There are no customers yet, so nothing here quotes one. Trust comes from what can be checked: the competitors'
 * prices, each linked; the AI asking first; and the 30-day money back. The wording leans on the owner's
 * voice-of-customer research of 28 October 2026 (public posts by service-business owners): "fills itself in",
 * "no add-on to unlock the basics", "never be the bill collector", "gets out of the way". Those posts are for
 * language only; never put one on the site as a testimonial.
 *
 * The page is meant to feel like the product: calm, with things happening on their own. So it shows rather than
 * tells — the conversation in the hero plays itself, the bills cross themselves off, the lead you lost arrives at
 * 8pm — and everything else holds still. Motion lives in globals.css, each piece beside its reason.
 *
 * And it is about the visitor's business, not ours, once they say what it is: "Try it on your business" sits on
 * top of the hero's conversation and asks for its name and trade, then the conversation, the lead lost at 8pm and
 * the last band's question are told in them (components/your-business.tsx, content/trades.ts).
 */

/** The spot counts are live, so the home page is rebuilt at most once a minute rather than at deploy. */
export const revalidate = 60;

/** A step in a staggered arrival: the CSS reads `--i` to wait its turn. */
const nth = (index: number) => ({ '--i': index }) as CSSProperties;

export default async function HomePage() {
  const counts = await foundingCounts();
  const spots = foundingSpotsOnSale(counts);
  // "Claim my founding spot" only while there is one to claim.
  const open = spots.some(hasRoom);
  return (
    <>
      <OrganizationJsonLd />
      <WebSiteJsonLd />
      <SoftwareApplicationJsonLd spots={spots} />
      <FaqJsonLd faqs={homeFaqs} id={`${urls.site}/#faq`} />
      <YourBusinessProvider>
        <Hero counts={counts} open={open} />
        <TheProblem />
        <Inside />
        <TheBill />
        <Features />
        <ConnectedAccounts />
        <Guarantee />
        <Spots spots={spots} />
        <Questions />
        <FinalCta open={open} />
      </YourBusinessProvider>
      <StickyCta open={open} />
    </>
  );
}

function Hero({ counts, open }: { counts: readonly FoundingCount[] | null; open: boolean }) {
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
            <h1 className="mt-8 text-[2.625rem] leading-[0.98] font-bold tracking-[-0.045em] sm:text-6xl lg:text-[4rem]">
              <span className="text-accent-text mb-5 block text-sm leading-5 font-semibold tracking-normal">
                HandsFreeOS
              </span>{' '}
              Answer every lead in seconds. Get your evenings back.
            </h1>
            <p className="text-text-2 mt-7 max-w-xl text-lg sm:text-xl">
              HandsFreeOS picks up your calls, answers your texts and website chats, books the job,
              and chases the quote and the invoice. You step in only when it matters. One app, one
              bill, your whole crew.
            </p>
            {/* The first fear, answered before it forms: what will the AI say to my customers? */}
            <p className="text-text mt-5 max-w-xl text-lg font-semibold sm:text-xl">
              And it asks you first, until it has earned your trust.
            </p>

            <div data-cta="hero" className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button href={urls.signUp} size="lg" arrow>
                {open ? 'Claim my founding spot' : 'Sign up'}
              </Button>
              <Button href="/#tuesday" size="lg" variant="secondary">
                See a day with HandsFreeOS
              </Button>
            </div>

            {/*
             * FUD reducers sit directly under the button, and every one of them is true today. The price is one of
             * them: signing up goes straight on to picking a spot and paying, and nobody should meet that cold.
             */}
            <ul className="text-text-2 mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm">
              {[
                `${spotPrices}, plus what you use`,
                'No contract',
                moneyBack.short,
                'No charge per person',
              ].map((item) => (
                <li key={item} className="flex items-center gap-1.5">
                  <Check className="text-success" />
                  {item}
                </li>
              ))}
            </ul>
          </div>

          <div className="min-w-0 lg:pl-2">
            <TryItOnYourBusiness />
            <ProductMock />
          </div>
        </div>
      </Container>
    </div>
  );
}

/**
 * After hours, drawn as it is: the band is night in both themes. Problem, then the cost of it, then the turn. It
 * says "you're good at the work" before anything else, so the owner is never the one being blamed.
 */
function TheProblem() {
  const points = [
    {
      title: 'The job you never knew you lost',
      body: 'They texted three companies while you were under a sink. The first one to answer got the job.',
    },
    {
      title: 'The money you already earned',
      body: 'It’s sitting in quotes nobody chased and invoices you haven’t had time to follow up.',
    },
    {
      title: 'The bills for apps that still need you',
      body: `A phone app, a booking app, Zoom, forms, email. About ${usd(stackTotal)} a month for a five-person crew, and every one of them waits for you to do the work.`,
    },
  ];
  return (
    <NightBand>
      <div className="grid items-center gap-14 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-16">
        <div>
          <h2 className="text-on-night text-[2.125rem] leading-[1.04] font-bold tracking-[-0.035em] sm:text-5xl md:text-[3.25rem]">
            You didn&rsquo;t start a business to answer texts at 11pm.
          </h2>
          <p className="text-on-night-2 mt-6 max-w-2xl text-lg sm:text-xl">
            You can&rsquo;t answer the phone and do the job at the same time, and the job comes
            first. That&rsquo;s why you&rsquo;re good. So the call you missed on a roof, the quote
            you meant to send on Tuesday and the invoice that&rsquo;s 30 days late all wait for
            tonight, after the kids are down, in a pile of apps that don&rsquo;t talk to each other.
          </p>
        </div>
        <Reveal>
          <MissedLeadForYou />
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
        <span className="text-on-night-accent">HandsFreeOS</span> takes all of it off your plate,
        and it starts this week.
      </p>
    </NightBand>
  );
}

/**
 * The after, told as one ordinary day so the owner can see themselves in it. Every line is something the product
 * does today: the 7am email is the Morning summary, the 10:15 call is the AI teammate on the phone, the 3pm one is
 * the phone app offline. Keep it that way, and keep the note under it: early on, the 6:30pm answer waits for a tap.
 */
function NextTuesday() {
  const day = [
    {
      time: '7:00am',
      body: 'One short email: today’s jobs, the two booked overnight, and the one customer who wants to talk to you.',
    },
    {
      time: '10:15am',
      body: 'A call comes in while you’re under a sink. The AI picks up, gets the address and books Thursday. You find out when you wash your hands.',
    },
    {
      time: '1:30pm',
      body: 'Yesterday’s quote got a reminder on its own. They approve it on their phone by typing their name. It’s an invoice now.',
    },
    {
      time: '3:00pm',
      body: 'Your tech is in a basement with no signal. Notes and photos save anyway, and send when the bars come back.',
    },
    {
      time: '6:30pm',
      body: 'You eat dinner with your phone in your pocket. A new lead texts, gets an answer in seconds, and gets a time on your calendar.',
    },
    { time: '8:00pm', body: 'You’re at your kid’s game. Nothing needs you.' },
  ];
  return (
    <div className="grid gap-12 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-16">
      <div className="lg:sticky lg:top-28 lg:self-start">
        <PanelHeading sub="Same jobs, same crew. The difference is everything you no longer do.">
          Picture next Tuesday.
        </PanelHeading>
      </div>

      <Reveal>
        <ol className="border-border-strong relative border-l pl-7 sm:pl-9">
          {day.map((item, index) => (
            <li key={item.time} className="rise relative pb-8 last:pb-0" style={nth(index)}>
              <span
                aria-hidden="true"
                className="bg-accent ring-bg absolute top-1.5 -left-[calc(1.75rem+4.5px)] h-2 w-2 rounded-full ring-4 sm:-left-[calc(2.25rem+4.5px)]"
              />
              <p className="text-accent-text text-sm font-semibold tabular-nums">{item.time}</p>
              <p className="text-text mt-1.5 text-lg leading-snug">{item.body}</p>
            </li>
          ))}
        </ol>
        <p className="mt-10 text-xl font-semibold tracking-[-0.015em]">
          That&rsquo;s a normal Tuesday on HandsFreeOS.
        </p>
        <p className="text-text-3 mt-2 text-sm">
          In your first weeks, the 6:30pm answer waits for your tap before it goes. That&rsquo;s on
          purpose.
        </p>
      </Reveal>
    </div>
  );
}

/**
 * What the same business pays today, line by line, and the visitor unticks what they don't pay for to see their
 * own total (components/bill-builder.tsx). Every number comes
 * from content/savings.ts, where each is another company's public price with its link and the date it was read.
 * A tool whose HandsFreeOS side is still being built shows as coming and stays out of the total.
 */
function TheBill() {
  const coming = stack.filter((t) => !t.live);
  return (
    <Section id="bill" className="bg-card-2 border-border border-y">
      <div className="grid items-start gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)] lg:gap-16">
        <div>
          <Eyebrow>The bill</Eyebrow>
          <SectionHeading
            sub={`A five-person crew that buys these tools one at a time pays about ${usd(stackTotal)} a month. HandsFreeOS does all of it for $97 a month, plus about $${typicalUsage.low} to $${typicalUsage.high} for the texts, calls and AI you use. That’s ${roughUsd(yearlySavings.low)} to ${roughUsd(yearlySavings.high)} a year back in your pocket.`}
          >
            Stop paying for ten apps to run one business.
          </SectionHeading>
          <p className="text-text mt-6 max-w-2xl text-lg font-semibold sm:text-xl">
            No charge per person, and no add-on to unlock the basics. Hire your next tech and your
            bill stays the same.
          </p>
          <Button href="/pricing" variant="secondary" size="lg" className="mt-9" arrow>
            See what one plan includes
          </Button>
        </div>

        <Reveal className="bg-card border-border rounded-[20px] border p-6 shadow-[var(--shadow-2)] sm:p-8">
          <BillBuilder />
          {coming.length > 0 ? (
            <p className="text-text-3 mt-4 text-sm">
              Coming next, and not counted above:{' '}
              {coming.map((t) => `${t.job} (${t.company}, ${usd(t.monthly)})`).join(', ')}.
            </p>
          ) : null}
        </Reveal>
      </div>

      {/* Every price is linked, so anybody can check it: an open sum earns more trust than any adjective. */}
      <p className="text-text-3 mt-12 max-w-3xl text-sm">
        Each company&rsquo;s public price for the plan shown, checked {pricesCheckedOn}:{' '}
        {stackSources.map((s, index) => (
          <span key={s.source}>
            {index > 0 ? ', ' : ''}
            <a
              href={s.source}
              rel="noreferrer noopener"
              className="underline underline-offset-2"
              target="_blank"
            >
              {s.company}
            </a>
          </span>
        ))}
        . HandsFreeOS is the $97 monthly founding spot plus the usage most businesses see.
      </p>
    </Section>
  );
}

/**
 * The middle of the page, folded into tabs (components/home-tabs.tsx): a day with it, what changes, why the AI can
 * be trusted, how the first week goes, and the phone app. Each was a full section, and folding them brings the
 * bill, the promise, the spots and the questions screens closer to the top. All five are still on the page for
 * anyone, or anything, reading it, and the hero's "See a day with HandsFreeOS" (`/#tuesday`) opens the first.
 */
function Inside() {
  return (
    <Section className="border-border border-t">
      <Eyebrow>What it&rsquo;s like</Eyebrow>
      <SectionHeading className="mb-10">Your business, running on HandsFreeOS.</SectionHeading>
      <HomeTabs
        tabs={[
          { id: 'tuesday', label: 'A day with it', panel: <NextTuesday /> },
          { id: 'changes', label: 'What changes', panel: <Outcomes /> },
          { id: 'trust', label: 'It asks first', panel: <Trust /> },
          { id: 'how', label: 'Up this week', panel: <HowItWorks /> },
          { id: 'pocket', label: 'On the job', panel: <InYourPocket /> },
        ]}
      />
    </Section>
  );
}

/** A tab's own heading: one step under the section's. */
function PanelHeading({ children, sub }: { children: ReactNode; sub?: string }) {
  return (
    <div className="max-w-3xl">
      <h3 className="text-[1.75rem] leading-[1.08] font-bold tracking-[-0.03em] sm:text-4xl">
        {children}
      </h3>
      {sub ? <p className="text-text-2 mt-5 max-w-2xl text-lg">{sub}</p> : null}
    </div>
  );
}

/** One promise per card, then the features that keep it. Every feature named here is in the product today. */
function Outcomes() {
  const outcomes = [
    {
      icon: Icons.bolt,
      title: 'Win the jobs you’ve been losing',
      body: 'Every call picked up, and every text and chat answered in seconds, at 7pm on a Sunday too. Missed calls get a text back before the phone is down. Quotes get a reminder, then a call when you OK it. Be the one who answers first.',
    },
    {
      icon: Icons.card,
      title: 'Keep more of what you make',
      body: 'Invoices chase themselves, politely and on schedule, so you never have to be the bill collector. The money goes into your own Stripe or Square, and we never take a cut. One bill instead of ten, and maintenance plans bill every month on their own.',
    },
    {
      icon: Icons.clock,
      title: 'Get your evenings back',
      body: 'The customer’s record fills itself in: every text, call, booking and payment lands on it as it happens, so nobody types it up after work. Home is a short list of what needs you, money first. The rest is handled, and it tells you what it did.',
    },
    {
      icon: Icons.shield,
      title: 'Look like the best-run company in town',
      body: 'Booking and payment pages on your own web address. Customers asked for a review once the job is done, and any unhappy one brought to you. Your crew looked after, with check-ins when they work alone.',
    },
  ];
  return (
    <>
      <PanelHeading>More jobs. More money kept. More of your life back.</PanelHeading>
      <Reveal className="mt-10 grid gap-5 sm:grid-cols-2 sm:gap-6">
        {outcomes.map((item, index) => (
          <div
            key={item.title}
            className="rise bg-card border-border h-full rounded-[20px] border p-6 shadow-[var(--shadow-1)] sm:p-8"
            style={nth(index)}
          >
            <span className="bg-accent-soft text-accent-text flex h-10 w-10 items-center justify-center rounded-[11px]">
              <item.icon />
            </span>
            <h4 className="mt-5 text-xl leading-snug font-semibold tracking-[-0.015em]">
              {item.title}
            </h4>
            <p className="text-text-2 mt-3">{item.body}</p>
          </div>
        ))}
      </Reveal>
    </>
  );
}

/** The biggest fear in the room is the AI saying something wrong to a customer, so control comes before cleverness. */
function Trust() {
  const promises = [
    'Prices stay locked until you unlock them. Then it quotes only your numbers, word for word.',
    'Anything about money, and any unhappy customer, comes straight to you.',
    'It never claims to be you, and hands over the moment somebody asks for a person.',
    'Everything it knows is written in plain English, where you can read it and change it.',
  ];
  return (
    <>
      <div className="grid items-start gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:gap-16">
        <div>
          <PanelHeading sub="It handles the straightforward work fast, and gets out of the way the moment a person is needed. It starts by writing every reply and waiting for your tap. When a kind of reply has earned enough of your OKs, it sends those on its own. You can take that back any time.">
            It asks before it acts. Until you tell it it doesn&rsquo;t have to.
          </PanelHeading>
          <ul className="mt-10 grid max-w-2xl gap-4">
            {promises.map((item) => (
              <li key={item} className="text-text-2 flex gap-3 text-[1.0625rem]">
                <Check className="text-success mt-0.5" />
                {item}
              </li>
            ))}
          </ul>
        </div>

        <Reveal>
          <div className="rise">
            <TrustLadderVisual />
          </div>
        </Reveal>
      </div>
    </>
  );
}

function HowItWorks() {
  const steps = [
    {
      step: 'This afternoon',
      mode: { label: 'You answer, it sets up', tone: 'bg-card-2 text-text-2' },
      title: 'Answer a few questions. Your customers come with you.',
      body: 'The Assistant sets up your hours, services, prices, reminders and booking page from what you tell it, and reads your website for the rest. Customers come in from a spreadsheet in minutes, or from your old CRM, counted first and undoable.',
    },
    {
      step: 'This week',
      mode: {
        label: 'Drafts every reply · waits for your OK',
        tone: 'bg-warning-soft text-warning-text',
      },
      title: 'Calls, chats and texts start coming through',
      body: 'Keep your number or get a new one, and plug in your Google or Outlook calendar so nothing gets double-booked. Website chat is answered right away. Texting starts once the carriers approve you, usually in a few business days, and we do that paperwork.',
    },
    {
      step: 'From then on',
      mode: {
        label: 'Sends what it has earned · yours to take back',
        tone: 'bg-success-soft text-success-text',
      },
      title: 'It sends what it has earned, and hands you the rest',
      body: 'Each kind of reply it gets right earns the right to send on its own, and you can put that back any time. Anything it is unsure of, anything about money, and any upset customer comes straight to you.',
    },
  ];
  return (
    <>
      <PanelHeading sub="No consultant, no setup fee, and no training for your crew. You answer questions in plain English, and it sets itself up.">
        Up and running this week. Not this quarter.
      </PanelHeading>

      {/* A sequence, so it is drawn as one: a rule the steps sit on, drawing itself the way the days go. */}
      <Reveal className="mt-12">
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
                <h4 className="mt-4 text-xl leading-snug font-semibold tracking-[-0.015em]">
                  {item.title}
                </h4>
                <p className="text-text-2 mt-3">{item.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </Reveal>

      <p className="text-text-3 mt-12 max-w-3xl text-sm">
        {setupFees.map((item, index) => (
          <span key={item.name}>
            {index === 0 ? '' : ', and '}
            <a
              href={item.source}
              rel="noreferrer noopener"
              target="_blank"
              className="underline underline-offset-2"
            >
              {item.name}
            </a>{' '}
            {index === 0 ? `charges a ${item.fee}` : `requires ${item.fee}`}
          </span>
        ))}
        . Moving in to HandsFreeOS is included.
      </p>
    </>
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
            Ten apps and a notepad, replaced by one.
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
    <>
      <div className="grid items-center gap-14 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:gap-16">
        <div>
          <PanelHeading sub="iPhone and Android, working with no signal at all — in a basement, in a crawlspace, an hour out of town. Nothing you type disappears when the bars do: it catches up the moment they come back.">
            In the pocket of whoever is doing the work.
          </PanelHeading>
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
    </>
  );
}

/**
 * The risk, moved from the buyer to us. The 30-day money back is the owner's call of 28 October 2026 and its words
 * live in content/site.ts beside the terms that say the same; everything in the list beside it was true before it.
 */
function Guarantee() {
  const promises = [
    {
      title: 'No contract',
      body: 'Stop it renewing any time in Settings.',
    },
    {
      title: 'Your customers stay yours',
      body: 'Export your customers, conversations and files whenever you like. Leaving is a thing you can actually do.',
    },
    {
      title: 'Your money never touches ours',
      body: 'Customers pay into your own Stripe or Square. We never hold it and never take a cut.',
    },
    {
      title: 'The AI never goes solo without your say',
      body: 'It asks first until you decide it doesn’t have to, and you can put it back any time.',
    },
    {
      title: 'Moving in is included, and undoable',
      body: 'Everything is counted before anything moves, and the move can be taken back.',
    },
  ];
  return (
    <Section id="guarantee" className="border-border border-t">
      <Eyebrow>Our promise</Eyebrow>
      <SectionHeading sub="We’d rather earn your business every month than lock you into it.">
        The risk is ours, not yours.
      </SectionHeading>

      <div className="mt-14 grid items-start gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-16">
        <Reveal className="bg-card border-accent/35 rounded-[20px] border p-6 shadow-[var(--shadow-2)] sm:p-8">
          <span className="bg-accent-soft text-accent-text flex h-10 w-10 items-center justify-center rounded-[11px]">
            <Icons.shield />
          </span>
          <h3 className="mt-5 text-2xl leading-snug font-bold tracking-[-0.02em]">
            {moneyBack.days} days, or your money back
          </h3>
          <p className="text-text-2 mt-3 text-[1.0625rem]">{moneyBack.line}</p>
          <p className="text-text-3 mt-4 text-sm">
            To ask, email{' '}
            <a href={`mailto:${company.supportEmail}`} className="underline underline-offset-2">
              {company.supportEmail}
            </a>{' '}
            within {moneyBack.days} days of your first payment. There&rsquo;s nothing to fill in.
          </p>
        </Reveal>

        <ul className="grid gap-6 sm:grid-cols-2">
          {promises.map((item) => (
            <li key={item.title} className="flex gap-3">
              <Check className="text-success mt-0.5" />
              <p className="text-text-2">
                <span className="text-text font-semibold">{item.title}.</span> {item.body}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}

/**
 * The founding spots on sale, each with its live count. The spots come from the page's own fetch and are passed
 * down rather than fetched here, so the home page makes one request rather than three. The count is the only
 * urgency on the page, because it is the only one that is real.
 */
function Spots({ spots }: { spots: readonly FoundingSpot[] }) {
  // Nothing on sale at all: nothing to show, and the pricing page says so.
  if (spots.length === 0) return null;
  return (
    <Section className="bg-card-2 border-border border-y">
      <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
        <SectionHeading sub="Every feature, your whole crew, and every feature we add to the core product at no extra cost. When the count hits zero, they’re gone. The counts are live.">
          Founding spots are first come, first served.
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
                {room ? `Claim my ${content.priceLabel} spot` : 'See which spot has room'}
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

      <p className="text-text-2 mt-8">
        {`Both: plus the texts, calls and AI you use, usually $${typicalUsage.low} to $${typicalUsage.high} a month. ${moneyBack.days} days, or your money back.`}
      </p>
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

/** The page ends on the question it opened with, and the risk reversal sits right where they decide. */
function FinalCta({ open }: { open: boolean }) {
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
        <h2 className="text-on-night mt-9 text-[2.25rem] leading-[1.04] font-bold tracking-[-0.035em] [overflow-wrap:anywhere] sm:text-5xl">
          The next lead texts <YourBusinessName fallback="you" /> at 7pm. Who answers?
        </h2>
        <p className="text-on-night-2 mt-6 text-lg">
          Set it up this week. Watch every reply before it goes out, and let go of the ones it gets
          right. If it isn&rsquo;t for you within {moneyBack.days} days, you get your money back.
        </p>
        <div data-cta="final" className="mt-9 flex flex-col justify-center gap-3 sm:flex-row">
          <Button href={urls.signUp} size="lg" arrow>
            {open ? 'Claim my founding spot' : 'Sign up'}
          </Button>
          <Button href="/support" size="lg" variant="night">
            Ask us a question first
          </Button>
        </div>
      </Reveal>
    </NightBand>
  );
}
